/* One OpenMapTiles reference map for both local and network tiles. */
(function () {
  'use strict';
  const tileJSON = 'https://tiles.openfreemap.org/planet';
  const attribution = '<a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> · <a href="https://openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>';
  let archive;
  const chunks = new Map(), pendingChunks = new Map();
  function overview() {
    if (!archive) archive = JSON.parse(document.getElementById('reference-map-data').textContent);
    return archive;
  }
  function receive(key, tiles) {
    chunks.delete(key);
    chunks.set(key,tiles);
    if (chunks.size > 48) chunks.delete(chunks.keys().next().value);
  }
  async function loadChunk(key) {
    if (chunks.has(key)) return chunks.get(key);
    if (pendingChunks.has(key)) return pendingChunks.get(key);
    const hash = overview().shards?.[key];
    if (!hash) throw new Error('Missing regional tile group');
    const promise = new Promise((resolve,reject)=>{
      const script = document.createElement('script');
      script.src = 'data/map-tiles/'+key+'.'+hash.slice(0,16)+'.js';
      script.onload = () => {script.remove();chunks.has(key)?resolve(chunks.get(key)):reject(new Error('Invalid regional tile archive'));};
      script.onerror = () => {script.remove();reject(new Error('Regional tile archive unavailable'));};
      document.head.append(script);
    }).finally(()=>pendingChunks.delete(key));
    pendingChunks.set(key,promise);
    return promise;
  }
  async function localTile(z, x, y) {
    const pack = overview();
    const entries = z <= (pack.embeddedZoom ?? pack.maxZoom) ? pack.tiles : await loadChunk([z,Math.floor(x/4),Math.floor(y/4)].join('-'));
    const packed = entries[[z, x, y].join('/')];
    if (!packed) throw new Error('Missing regional tile');
    const bytes = Uint8Array.from(atob(packed), char => char.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return {data: await new Response(stream).arrayBuffer()};
  }
  function cartography(source, maxDataZoom, className) {
    const p = window.protomapsL;
    const polygon = fill => new p.PolygonSymbolizer({fill});
    const line = (color, width) => new p.LineSymbolizer({color, width});
    const place = new p.CenteredTextSymbolizer({labelProps:['name:en','name'],font:'500 12px system-ui, sans-serif',fill:'#364950',stroke:'#fff',width:2.8});
    const settlements = ['city','town','village','hamlet','suburb','neighbourhood','isolated_dwelling'];
    const placeLabel = {place(layout, geom, feature) {
      const labels = place.place(layout,geom,feature);
      const kind = feature.props.class, name = feature.props['name:en'] || feature.props.name;
      if (name && settlements.includes(kind)) for (const label of labels || []) {
        label.deduplicationKey = 'settlement:' + name;
        label.deduplicationDistance = 150;
      }
      return labels;
    }};
    const waterName = new p.CenteredTextSymbolizer({labelProps:['name:en','name'],font:'italic 11px system-ui, sans-serif',fill:'#32667c',stroke:'#e7f6fb',width:2});
    const layer = p.leafletLayer({url:{getZxy:source}, maxDataZoom, levelDiff:0, className, attribution,
      backgroundColor:'#f6f4ed', minZoom:0, maxZoom:18, keepBuffer:1, updateWhenIdle:true, tileDelay:0,
      paintRules:[
        {dataLayer:'landcover',minzoom:8,symbolizer:polygon('#e3eadd'),filter:(_,f)=>['wood','grass'].includes(f.props.class)},
        {dataLayer:'park',minzoom:10,symbolizer:polygon('#e0eadc')},
        {dataLayer:'water',symbolizer:polygon('#a9d4e5')},
        {dataLayer:'waterway',symbolizer:line('#84bed4',z=>z<9?0.85:z<13?1.25:1.8)},
        {dataLayer:'transportation',minzoom:11,symbolizer:line('#d6d1c7',z=>z<14?0.7:1.3),filter:(_,f)=>!['ferry','aerialway','rail','transit'].includes(f.props.class)},
        {dataLayer:'transportation',minzoom:7,symbolizer:line('#d9c7a8',z=>z<11?0.75:1.8),filter:(z,f)=>['motorway','trunk'].includes(f.props.class) || (z>=9 && f.props.class==='primary')},
        {dataLayer:'boundary',symbolizer:line('#99959e',(_,f)=>Number(f.props.admin_level)<=2?1.15:0.65),filter:(z,f)=>Number(f.props.admin_level)<= (z<5?2:z<9?4:6)}
      ],labelRules:className==='sc-basemap-world'?[]:[
        {dataLayer:'place',symbolizer:placeLabel,sort:(a,b)=>(a.rank??99)-(b.rank??99) || settlements.indexOf(a.class)-settlements.indexOf(b.class),filter:(z,f)=>f.geomType===1 && (z>=8 || ['country','state','city','town'].includes(f.props.class))},
        {dataLayer:'water_name',symbolizer:waterName,filter:(_,f)=>f.geomType===1}
      ]});
    // The renderer defaults a zero option to a distance-based delay. Wrapped
    // neighbour tiles at 180° must paint as promptly as either side of Greenwich.
    layer.tileDelay = 0;
    return layer;
  }
  window.ProjectReferenceMap = {receive, create(map, options) {
    let visible = false, requested = false, failed = false;
    let world, local, live, owner, pending = false, worldOnly = false;
    const isPolar = () => map.options.crs !== L.CRS.EPSG3857;
    const detailNeeded = () => map.getZoom() > overview().maxZoom;
    function status() {
      const status = isPolar() ? (map.options.crs.code==='PROJECT:AEQD'?'Local distance view':'Geographic view')+' · beyond basemap latitude limit' :
        failed ? (worldOnly?'World overview':'Regional overview')+' · online map unavailable' :
        pending ? 'Loading map detail…' :
        live ? 'Online detail' : worldOnly ? 'World overview · regional files unavailable' : visible && detailNeeded() ? 'Offline overview · generalized at this zoom' : 'Regional overview';
      options.onBasemapState?.(requested, status, failed, isPolar());
    }
    function stop() {
      owner?.abort(); owner = null;
      if (live) map.removeLayer(live);
      live = null; pending = false;
    }
    async function start() {
      const controller = new AbortController();
      owner = controller; pending = true; status();
      function fallback() {
        if (owner !== controller || controller.signal.aborted) return;
        failed = true; stop(); status();
      }
      const read = async url => {
        const response = await fetch(url,{credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])});
        if (!response.ok) throw new Error('Basemap HTTP '+response.status);
        return response;
      };
      try {
        const metadata = await (await read(tileJSON)).json();
        const template = metadata.tiles?.find(url=>typeof url==='string' && /^https:\/\/tiles\.openfreemap\.org\//.test(url) && ['{z}','{x}','{y}'].every(key=>url.includes(key)));
        if (!template || !Number.isInteger(metadata.maxzoom) || metadata.maxzoom < 1 || metadata.maxzoom > 22) throw new Error('Invalid basemap metadata');
        if (controller.signal.aborted) return;
        const remoteTile = async (z,x,y,signal) => {
          if (signal?.aborted || controller.signal.aborted) return undefined;
          try {
            const url = template.replace('{z}',z).replace('{x}',x).replace('{y}',y);
            const response = await fetch(url,{credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.any([controller.signal,signal,AbortSignal.timeout(12000)].filter(Boolean))});
            if (response.status===204) return undefined;
            if (!response.ok) throw new Error('Basemap tile HTTP '+response.status);
            const data = await response.arrayBuffer();
            if (!data.byteLength) return undefined;
            // A captive portal can return an HTML page with HTTP 200.
            if ((response.headers.get('content-type')||'').includes('text/html')) throw new Error('Invalid basemap tile');
            return {data};
          } catch {
            if (!signal?.aborted) fallback();
            return undefined;
          }
        };
        live = cartography(remoteTile, metadata.maxzoom,'sc-basemap-live').setZIndex(2).addTo(map);
        live.on('load',()=>{if(owner===controller){pending=false;status();}});
        status();
      } catch { fallback(); }
    }
    function sync() {
      map.getContainer().classList.toggle('sc-polar-view',isPolar());
      if (!visible || isPolar()) {
        stop();
        if (local) map.removeLayer(local);
        if (world) map.removeLayer(world);
        local = null; world = null; status(); return;
      }
      const pack = overview();
      // Keep the embedded land and water painted while the regional files arrive.
      if (!worldOnly && map.getZoom() > pack.embeddedZoom) {
        if (!world) world = cartography(localTile,pack.embeddedZoom,'sc-basemap-world').setZIndex(0).addTo(map);
      } else if (world) {map.removeLayer(world);world=null;}
      if (!local) {
        const load = async (...args) => {
          try {return await localTile(...args);}
          catch {
            if (!worldOnly && local && visible) {
              worldOnly=true;map.removeLayer(local);local=null;sync();
            }
            return undefined;
          }
        };
        local = cartography(load,worldOnly ? pack.embeddedZoom : pack.maxZoom,'sc-basemap-offline').setZIndex(1).addTo(map);
      }
      if (!requested || !detailNeeded()) stop();
      else if (!owner && !failed) start();
      status();
    }
    function offline(){stop();failed=requested;status();}
    function online(){failed=false;sync();}
    map.on('projectprojectionchange zoomend',sync);
    window.addEventListener('offline',offline);window.addEventListener('online',online);
    return {
      setVisible(value){visible=value;sync();},
      setOnline(value){requested=value;failed=false;sync();},
      get online(){return !!live;},
      destroy(){visible=false;stop();map.off('projectprojectionchange zoomend',sync);if(local)map.removeLayer(local);if(world)map.removeLayer(world);window.removeEventListener('offline',offline);window.removeEventListener('online',online);}
    };
  }};
})();
