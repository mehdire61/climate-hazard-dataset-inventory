/* Sourced named boundaries; generalized country shapes are explicitly identified. */
(function (root) {
  'use strict';
  const CENSUS = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS2026/MapServer';
  const LAYERS = Object.freeze({state: [80], county: [82], place: [28, 30]});
  const MAX_BYTES = 8 * 1024 * 1024;
  const geometry = () => root.SiteGeometry || (typeof require === 'function' ? require('./geometry.js') : null);
  let configured = null;
  function configure(data) { configured = data; }
  function catalog(options) { return options.data || configured || root.InventoryApp?.data?.geography || {}; }
  function countryData(options) { return options.boundaries || root.InventoryApp?.data?.countryBoundaries || (typeof require === 'function' ? require('../data/country-boundaries.json') : {}); }
  function url(layer, parameters) { return CENSUS + '/' + layer + '/query?' + new URLSearchParams(parameters); }
  async function sha256(text) {
    if (root.crypto?.subtle) return [...new Uint8Array(await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2,'0')).join('');
    if (typeof require === 'function') return require('node:crypto').createHash('sha256').update(text).digest('hex');
    return null;
  }
  async function request(url, options) {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
    try {
      const response = await (options.fetchImpl || root.fetch)(url, {signal: controller.signal, credentials: 'omit'});
      if (!response.ok) throw new Error('Boundary provider returned HTTP ' + response.status + '. Retry or use a GeoJSON boundary.');
      const tooLarge = () => new Error('Boundary response exceeds the 8 MB browser limit. Use a smaller area or prepare a coarser GeoJSON file.');
      if (Number(response.headers?.get('content-length')) > MAX_BYTES) {await response.body?.cancel(); throw tooLarge();}
      let rawText;
      if (response.body?.getReader) {
        const reader=response.body.getReader(), chunks=[]; let bytes=0;
        while (true) {const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BYTES){await reader.cancel();throw tooLarge();}chunks.push(value);}
        const joined=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}
        rawText=new TextDecoder().decode(joined);
      } else {rawText=await response.text();if(new TextEncoder().encode(rawText).length>MAX_BYTES)throw tooLarge();}
      let data;
      try { data = JSON.parse(rawText); } catch (_) { throw new Error('Boundary provider returned invalid JSON.'); }
      if (data.error) throw new Error('Boundary provider: ' + (data.error.message || 'request failed'));
      return {data, receipt: {url, resolvedUrl: response.url || url, retrievedAt: new Date().toISOString(), rawSha256: await sha256(rawText)}};
    } catch (error) {
      if (controller.signal.aborted) {
        if (options.signal?.aborted) throw new DOMException('Boundary lookup cancelled.', 'AbortError');
        throw new Error('Boundary lookup timed out. Retry or supply a local GeoJSON boundary.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }
  const fold = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘]/g,"'").toLowerCase();
  const aliases = {GBR:['uk','united kingdom','great britain'],USA:['us','usa','united states','united states of america'],TUR:['turkiye','turkey'],COD:['dr congo','drc','democratic republic of the congo'],MMR:['burma','myanmar'],CPV:['cape verde','cabo verde'],VNM:['viet nam','vietnam'],CIV:["cote d'ivoire","ivory coast"]};
  function stateCode(value, data) {
    if (!String(value || '').trim()) return null;
    const term = fold(value).trim();
    const found = (data.states || []).find(s => [s.id,s.name,s.abbreviation].some(x => fold(x) === term));
    if (!found) throw new Error('Choose a U.S. state name, postal abbreviation or two-digit FIPS code from the boundary index.');
    return found.id;
  }
  function censusSource(kind, id, layer) {
    return {provider: 'U.S. Census Bureau', dataset: 'TIGERweb ACS 2026', vintage: '2026-01-01', kind, id, layer,
      url: CENSUS + '/' + layer, coordinateReferenceSystem: 'WGS84 longitude/latitude (EPSG:4326)',
      processing: 'Provider geometry returned with outSR=4326; no simplification or coordinate rounding applied by this tool.',
      terms: 'https://www.census.gov/about/policies/copyright.html'};
  }
  async function search(input, options = {}) {
    const data = catalog(options), kind = input?.kind, term = String(input?.text || '').trim();
    if (kind !== 'country' && !LAYERS[kind]) throw new Error('Select a supported boundary type.');
    if (term.length < 2 || term.length > 80 || /[\x00-\x1f%_]/.test(term)) throw new Error('Enter 2–80 characters without SQL wildcard or control characters.');
    if (kind === 'country') {
      const needle = fold(term);
      const reference=countryData(options), countries=(reference.features || []).map(f=>({...f.properties,iso3:f.properties.id,kind:'country'}));
      const names = c => [c.iso3,c.name,c.alternateName,...(aliases[c.iso3]||[])].map(fold);
      const exact = countries.filter(c => names(c).includes(needle));
      const items = exact.length ? exact : countries.filter(c => names(c).some(name=>name.includes(needle))).sort((a,b)=>Number(names(b).some(name=>name.startsWith(needle)))-Number(names(a).some(name=>name.startsWith(needle)))||a.name.localeCompare(b.name));
      return {items, notes: [reference.source.note], requests: [], complete: true};
    }
    const state = stateCode(input.state, data);
    const escaped = term.toUpperCase().replace(/'/g, "''");
    const where = "UPPER(NAME) LIKE '%" + escaped + "%'" + (state && kind !== 'state' ? " AND STATE='" + state + "'" : '');
    const requests = [], notes = [], items = [];
    let complete = true;
    // Keep place layers distinguishable, including a partial outage of one layer.
    for (const layer of LAYERS[kind]) {
      try {
        const answer = await request(url(layer, {f:'json',where,outFields:'GEOID,NAME,STATE',returnGeometry:'false',orderByFields:'NAME,GEOID',resultRecordCount:'100'}), options);
        requests.push(answer.receipt);
        if (!Array.isArray(answer.data.features)) throw new Error('Boundary search returned no feature array.');
        if (answer.data.exceededTransferLimit || answer.data.features.length >= 100) {
          complete = false; notes.push('Name search returned a first batch of up to 100 matches per layer. Refine the name or state to see a complete selection list.');
        }
        for (const feature of answer.data.features) {
          const a = feature.attributes;
          if (!a || typeof a.GEOID !== 'string' || typeof a.NAME !== 'string') throw new Error('Boundary search metadata are incomplete.');
          const stateName = (data.states || []).find(s => s.id === a.STATE)?.name;
          const name = a.NAME + (kind !== 'state' && stateName ? ', ' + stateName : '');
          items.push({id:a.GEOID,name,kind,layer,state:a.STATE,source:censusSource(kind,a.GEOID,layer)});
        }
      } catch (error) {
        if (error.name === 'AbortError' || LAYERS[kind].length === 1) throw error;
        complete = false; notes.push('The ' + (layer === 28 ? 'incorporated-place' : 'census-designated-place') + ' search was incomplete: ' + error.message);
      }
    }
    return {items:items.sort((a,b) => a.name.localeCompare(b.name)), notes:[...new Set(notes)], requests, complete};
  }
  async function load(item, options = {}) {
    if (!item || typeof item.id !== 'string') throw new Error('Choose a boundary result first.');
    let target, source, name = item.name;
    if (item.kind === 'country') {
      options.signal?.throwIfAborted();
      const reference=countryData(options), known=(reference.features || []).find(f => f.properties.id === item.id);
      if (!known) throw new Error('Country is missing from the sourced boundary index.');
      const shape=geometry().normalize(known.geometry);
      return {name:known.properties.name+' (generalized country boundary)',geometry:shape,
        source:{...reference.source,id:item.id,kind:'country',generalized:true,geometrySha256:await sha256(JSON.stringify(shape)),
          coordinateReferenceSystem:'WGS84 longitude/latitude (EPSG:4326)',featureIds:[item.id]}};
    } else {
      if (!LAYERS[item.kind]?.includes(item.layer) || !new RegExp('^\\d{' + ({state:2,county:5,place:7}[item.kind] || 0) + '}$').test(item.id)) throw new Error('Boundary identifier or layer is invalid.');
      target = url(item.layer, {f:'geojson',where:"GEOID='" + item.id + "'",outFields:'GEOID,NAME,STATE',returnGeometry:'true',outSR:'4326'});
      source = censusSource(item.kind,item.id,item.layer);
    }
    const answer = await request(target, options);
    if (answer.data.exceededTransferLimit) throw new Error('Provider returned a partial boundary. Use a complete GeoJSON boundary.');
    if (answer.data.type !== 'FeatureCollection' || !Array.isArray(answer.data.features) || !answer.data.features.length) throw new Error('Provider returned no polygon boundary.');
    if (item.kind !== 'country' && (answer.data.features.length !== 1 || answer.data.features[0].properties?.GEOID !== item.id)) throw new Error('Returned boundary does not match the selected Census identifier.');
    const shape = geometry().normalize(answer.data);
    return {name, geometry:shape, source:{...source,...answer.receipt,geometrySha256:await sha256(JSON.stringify(shape)),featureIds:answer.data.features.map(feature => feature.properties?.GEOID || feature.properties?.shapeID || null),request:answer.receipt}};
  }
  const api = {search,load,configure};
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SiteAreas = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
