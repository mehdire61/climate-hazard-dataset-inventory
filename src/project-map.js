(function () {
  'use strict';
  // Draw geographic coordinates in the active CRS. The grid is decorative and
  // never changes the submitted geometry, the station layers, or their bounds.
  function polarGuide(map, container) {
    const host = L.DomUtil.create('div','sc-polar-guide',container);
    host.hidden = true;
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('role','img');host.append(svg);
    let frame = 0;
    const steps = [.00001,.00002,.00005,.0001,.0002,.0005,.001,.002,.005,.01,.02,.05,.1,.2,.5,1,2,5,10,15,30,45,90];
    const stepFor = value => steps.find(step=>step>=value) || 90;
    const degrees = (v,lat) => Math.abs(Number(v.toFixed(5)))+'°'+(v===0?'':lat?(v>0?'N':'S'):(v>0?'E':'W'));
    function element(tag,attrs,text) {
      const el=document.createElementNS(svg.namespaceURI,tag);
      for (const [k,v] of Object.entries(attrs)) el.setAttribute(k,v);
      if (text) el.textContent=text;
      svg.append(el);return el;
    }
    function draw() {
      frame=0;
      if (host.hidden) return;
      const {x:w,y:h}=map.getSize();
      if (w<1||h<1) return;
      const center=map.getCenter(), local=map.options.crs.code==='PROJECT:AEQD';
      const nearest=center.lat>=0?90:-90, pole=map.latLngToContainerPoint([nearest,center.lng]);
      const inView=pole.x>=0 && pole.x<=w && pole.y>=0 && pole.y<=h;
      const latitudes=[], longitudes=[];
      for (const x of [0,w/2,w]) for (const y of [0,h/2,h]) {
        const ll=map.containerPointToLatLng([x,y]);
        if (ll.outsideProjection) continue;
        latitudes.push(Math.max(-90,Math.min(90,ll.lat)));
        longitudes.push(local?center.lng+(((ll.lng-center.lng+540)%360+360)%360-180):ll.lng);
      }
      if (!latitudes.length) {svg.replaceChildren();return;}
      if (inView) latitudes.push(nearest);
      // A visible pole brings every meridian into the local azimuthal view.
      const polarCap=local&&inView;
      let west=polarCap?center.lng-180:Math.max(center.lng-180,Math.min(...longitudes));
      let east=polarCap?center.lng+180:Math.min(center.lng+180,Math.max(...longitudes));
      const south=Math.min(...latitudes), north=Math.max(...latitudes);
      const dy=stepFor((north-south)*62/h), dx=stepFor((east-west)*100/w);
      const low=Math.max(-90,south-dy), high=Math.min(90,north+dy);
      if (!polarCap) {west-=dx;east+=dx;}
      svg.replaceChildren();svg.setAttribute('viewBox','0 0 '+w+' '+h);
      const grid=[], latLabels=[], lonLabels=[];
      function trace(latitude,value,start,end) {
        const count=Math.max(12,Math.ceil((end-start)/4));
        let candidate;
        for(let i=0;i<=count;i++) {
          const v=start+(end-start)*i/count;
          const p=map.latLngToContainerPoint(latitude?[value,v]:[v,value]);
          grid.push((i?'L':'M')+p.x+' '+p.y);
          if(p.x<50||p.x>w-52||p.y<29||p.y>h-36)continue;
          const score=Math.hypot(p.x-(latitude?w*.75:w*.32),p.y-(latitude?h*.67:h*.21));
          if(!candidate||score<candidate.score)candidate={p,value,score};
        }
        if(candidate)(latitude?latLabels:lonLabels).push(candidate);
      }
      for(let i=Math.ceil(low/dy);i<=Math.floor(high/dy);i++) if(Math.abs(i*dy)<90)trace(true,i*dy,west,east);
      for(let i=Math.ceil(west/dx);i<=Math.floor(east/dx);i++)trace(false,i*dx,low,high);
      element('path',{class:'sc-polar-lines',d:grid.join(' ')});
      for(const [candidates,latitude] of [[latLabels,true],[lonLabels,false]]) {
        const best=candidates.sort((a,b)=>a.score-b.score)[0];
        if(best) element('text',{x:best.p.x+3,y:best.p.y-3},degrees(latitude?best.value:((best.value+180)%360+360)%360-180,latitude));
      }
      const poleName=nearest>0?'North Pole':'South Pole';
      if(inView) element('circle',{class:'sc-polar-pole',cx:pole.x,cy:pole.y,r:8});
      const arrows=['→','↘','↓','↙','←','↖','↑','↗'];
      const arrow=arrows[(Math.round(Math.atan2(pole.y-h/2,pole.x-w/2)/(Math.PI/4))+8)%8];
      element('text',{class:'sc-polar-pole-name',x:inView?Math.max(7,Math.min(w-98,pole.x+12)):w-9,
        y:inView?Math.max(17,Math.min(h-32,pole.y-9)):17,'text-anchor':inView?'start':'end'},
        (inView?'':arrow+' ')+poleName+' · '+degrees(nearest,true));
      const span=Math.min(85,w/3), y=h/2;
      const km=map.distance(map.containerPointToLatLng([w/2-span/2,y]),map.containerPointToLatLng([w/2+span/2,y]))/1000;
      let scaleText='';
      if (Number.isFinite(km) && km>.00001) {
        const decade=10**Math.floor(Math.log10(km)), nice=([5,2,1].find(n=>n*decade<=km)||1)*decade;
        const width=span*nice/km;
        scaleText=nice>=1?nice+' km':Math.round(nice*1000)+' m';
        element('path',{class:'sc-polar-scale',d:'M9 '+(h-31)+'v4h'+width+'v-4'});
        element('text',{x:9,y:h-33},scaleText);
      }
      svg.setAttribute('aria-label',poleName+' coordinate grid'+(scaleText?', scale bar '+scaleText:''));
    }
    function update() {
      host.hidden=map.options.crs===L.CRS.EPSG3857;
      if(!host.hidden&&!frame)frame=requestAnimationFrame(draw);
    }
    map.on('move resize projectprojectionchange',update);
    return ()=>{map.off('move resize projectprojectionchange',update);cancelAnimationFrame(frame);host.remove();};
  }
  // This map is an orientation view. All eligibility decisions stay in SiteGeometry.
  window.ProjectMap = {create(container, options = {}) {
    const L = window.L;
    if (!L) throw new Error('The bundled map library is unavailable. Coordinate and geometry controls remain usable.');
    const map = L.map(container, {crs: L.CRS.EPSG3857, preferCanvas: false, zoomControl: true, attributionControl: true, minZoom: 0, maxZoom: 18, scrollWheelZoom: false, worldCopyJump: false});
    map.setView([38.9, -77.04], 6);
    const removeGuide=polarGuide(map,container);
    map.attributionControl.setPrefix('Leaflet');
    const reference = window.ProjectReferenceMap.create(map, options);
    const projectLayer = L.featureGroup().addTo(map), bufferLayer = L.featureGroup().addTo(map), stationLayer = L.layerGroup().addTo(map), drawingLayer = L.layerGroup().addTo(map);
    const renderer = L.svg({padding: .3});
    let query = null, stations = [], selected = '', highlighted = '', referenceLongitude = -77.04, interaction = null, firstCorner = null;
    let candidateSignature = '';
    let renderedStations = null, rendering = false, fitEnvelope = null;
    const wrap = lon => ((lon + 180) % 360 + 360) % 360 - 180;
    const shift = lon => referenceLongitude + wrap(lon - referenceLongitude);
    let projectNeedsPolarView = false;
    let localProjection;
    function centeredProjection(origin) {
      const rad = Math.PI / 180, disk = window.SiteGeometry.limits.maxRadiusKm * 1000;
      const earth = disk / Math.PI, cosine = Math.cos(origin.lat * rad), sine = Math.sin(origin.lat * rad);
      // Spherical azimuthal equidistant. The projected radial distance is in metres;
      // east and north define the bearing at the project origin (Snyder, USGS PP 1395).
      const projection = {
        bounds: L.bounds([-disk, -disk], [disk, disk]),
        project(position) {
          const phi = position.lat * rad, lambda = (position.lng - origin.lon) * rad;
          const east = Math.cos(phi) * Math.sin(lambda);
          const north = cosine * Math.sin(phi) - sine * Math.cos(phi) * Math.cos(lambda);
          const dot = sine * Math.sin(phi) + cosine * Math.cos(phi) * Math.cos(lambda);
          const tangent = Math.hypot(east, north);
          if (tangent < 1e-15) return L.point(0, dot < 0 ? disk : 0);
          const scale = earth * Math.atan2(tangent, dot) / tangent;
          return L.point(east * scale, north * scale);
        },
        unproject(point) {
          const distance = Math.hypot(point.x, point.y);
          if (distance === 0) return L.latLng(origin.lat, origin.lon);
          if (distance > disk + 0.000001) {
            const antipode = L.latLng(-origin.lat, wrap(origin.lon + 180));
            antipode.outsideProjection = true;
            return antipode;
          }
          const angle = distance / earth, scale = Math.sin(angle) / distance;
          const x = cosine * Math.cos(angle) - sine * point.y * scale, y = point.x * scale;
          const z = sine * Math.cos(angle) + cosine * point.y * scale;
          return L.latLng(Math.atan2(z, Math.hypot(x, y)) / rad, origin.lon + Math.atan2(y, x) / rad);
        }
      };
      const scale = 1 / (2 * disk);
      return L.extend(Object.create(L.CRS.Earth), {code:'PROJECT:AEQD', origin, R:earth, projection,
        transformation: new L.Transformation(scale, .5, -scale, .5)});
    }
    function updateProjection() {
      const maxLatitude = L.Projection.SphericalMercator.MAX_LATITUDE;
      const polar = projectNeedsPolarView || stations.some(station => Math.abs(station.lat) > maxLatitude && Number.isFinite(station.lon));
      const center = query ? window.SiteGeometry.center(query) : map.getCenter();
      let crs = polar ? L.CRS.EPSG4326 : L.CRS.EPSG3857;
      if (polar && query && query.mode !== 'area' && (query.radiusKm ?? 100) < window.SiteGeometry.limits.maxRadiusKm / 2) {
        const origin = L.latLng(center.lat, center.lon);
        const distant = stations.some(station => Number.isFinite(station.lat) && Number.isFinite(station.lon) &&
          origin.distanceTo([station.lat, station.lon]) >= Math.PI * L.CRS.Earth.R / 2);
        if (!distant) {
          if (!localProjection || localProjection.origin.lat !== center.lat || localProjection.origin.lon !== center.lon) localProjection = centeredProjection(center);
          crs = localProjection;
        }
      }
      if (crs === map.options.crs) return;
      map.options.crs = crs;
      // EPSG:4326 spans two 256px tiles at z0. A phone can show the whole polar search at z-1.
      map.options.minZoom = crs === L.CRS.EPSG4326 ? -1 : 0;
      map.fire('projectprojectionchange', {polar});
      map.setView([center.lat, center.lon ?? center.lng], Math.max(map.getMinZoom(), map.getZoom()), {reset: true, animate: false});
    }
    function drawRadius(point, radiusKm) {
      if (radiusKm === 0 || radiusKm === window.SiteGeometry.limits.maxRadiusKm) return;
      // Rotate the position vector on the same sphere as SiteGeometry. This remains
      // defined even when the center is exactly a pole.
      const rad = Math.PI / 180, lat = point.lat * rad;
      const angle = Math.PI * (radiusKm / window.SiteGeometry.limits.maxRadiusKm);
      const sinAngle = Math.sin(angle), cosAngle = Math.cos(angle), sinLat = Math.sin(lat), cosLat = Math.cos(lat);
      const samples = [];
      for (let i = 0; i < 256; i++) {
        const bearing = 2 * Math.PI * i / 256;
        const north = sinAngle * Math.cos(bearing), east = sinAngle * Math.sin(bearing);
        const x = cosLat * cosAngle - sinLat * north, z = sinLat * cosAngle + cosLat * north;
        const horizontal = Math.hypot(x, east);
        samples.push([Math.atan2(z, horizontal) / rad, horizontal < 1e-14 ? null : shift(point.lon + Math.atan2(east, x) / rad)]);
      }
      const lines = [[]];
      function append(current) {
        const line = lines[lines.length - 1];
        const previous = line[line.length - 1];
        if (previous && Math.abs(current[1] - previous[1]) > 180) {
          const sign = previous[1] > current[1] ? 1 : -1;
          const edge = referenceLongitude + sign * 180;
          const fraction = (edge - previous[1]) / (current[1] + sign * 360 - previous[1]);
          const crossingLat = previous[0] + fraction * (current[0] - previous[0]);
          line.push([crossingLat, edge]);
          lines.push([[crossingLat, edge - sign * 360]]);
        }
        lines[lines.length - 1].push(current);
      }
      for (let i = 0; i <= samples.length; i++) {
        const current = samples[i % samples.length];
        if (current[1] !== null) {append(current); continue;}
        // Longitude at a geographic pole is arbitrary. End each incident arc at
        // its own meridian instead of drawing a diagonal across the polar view.
        const before = samples[(i + samples.length - 1) % samples.length], after = samples[(i + 1) % samples.length];
        if (i > 0) append([current[0], before[1] ?? referenceLongitude]);
        if (i < samples.length) {
          if (lines[lines.length - 1].length) lines.push([]);
          append([current[0], after[1] ?? referenceLongitude]);
        }
      }
      // An unfilled boundary also represents caps larger than a hemisphere without
      // accidentally shading their smaller antipodal complement.
      L.polyline(lines, {color: '#497866', weight: 1.8, dashArray: '5 4', smoothFactor: 0, interactive: false}).addTo(bufferLayer);
    }
    const pointText = (label, text) => {const n = document.createElement('span'); n.textContent = label + text; return n;};
    function displayGeometry(value, exactPolygon = false) {
      if (!value) return value;
      if (value.type === 'FeatureCollection') return {...value, features: value.features.map(feature => displayGeometry(feature, exactPolygon))};
      if (value.type === 'Feature') return {...value, geometry: displayGeometry(value.geometry, exactPolygon)};
      const line = coordinates => {let previous = shift(coordinates[0][0]), originalPrevious = coordinates[0][0]; return coordinates.map(coordinate => {let delta = coordinate[0] - originalPrevious; while (delta > 180) delta -= 360; while (delta < -180) delta += 360; previous += delta; originalPrevious = coordinate[0]; return [previous, coordinate[1], ...coordinate.slice(2)];});};
      const polygon = coordinates => {
        if (!exactPolygon) return coordinates.map(line);
        // Accepted analytical polygons already have explicit cut edges. Translate
        // the whole part, including every hole, by one integer world width.
        const longitudes = coordinates[0].map(coordinate => coordinate[0]);
        const midpoint = (Math.min(...longitudes) + Math.max(...longitudes)) / 2;
        const offset = 360 * Math.round((referenceLongitude - midpoint) / 360);
        return coordinates.map(ring => ring.map(coordinate => [coordinate[0] + offset, coordinate[1], ...coordinate.slice(2)]));
      };
      let coordinates;
      if (value.type === 'Point') coordinates = [shift(value.coordinates[0]), value.coordinates[1]];
      else if (value.type === 'MultiPoint') coordinates = value.coordinates.map(c => [shift(c[0]), c[1]]);
      else if (value.type === 'LineString') coordinates = line(value.coordinates);
      else if (value.type === 'MultiLineString' || value.type === 'Polygon') coordinates = polygon(value.coordinates);
      else if (value.type === 'MultiPolygon') coordinates = value.coordinates.map(polygon);
      else return value;
      return {...value, coordinates};
    }
    function renderStations() {
      if (rendering) return;
      rendering = true;
      stationLayer.clearLayers();
      const bins = new Map();
      const grouped = stations.length > 800;
      for (const station of stations) {
        if (!Number.isFinite(station.lat) || !Number.isFinite(station.lon)) continue;
        const ll = L.latLng(station.lat, shift(station.lon));
        const pixel = map.latLngToContainerPoint(ll);
        const key = grouped && station.id !== selected && station.id !== highlighted ? Math.floor(pixel.x / 24) + ':' + Math.floor(pixel.y / 24) : 'station:' + station.id;
        if (!bins.has(key)) bins.set(key, []);
        bins.get(key).push({station, ll});
      }
      for (const members of bins.values()) {
        if (members.length > 1) {
          const ll = L.latLng(members.reduce((sum, item) => sum + item.ll.lat, 0) / members.length, members.reduce((sum, item) => sum + item.ll.lng, 0) / members.length);
          const screened = members.some(item => item.station.coopsAvailability);
          const mark = L.circleMarker(ll, {renderer, radius: Math.min(18, 6 + Math.log2(members.length)), color: screened ? '#64716d' : '#3f6f62', fillColor: screened ? '#aeb8b3' : '#83a99a', fillOpacity: .8, weight: 1.5}).addTo(stationLayer);
          mark.bindTooltip(pointText('', members.length + ' loaded candidates grouped here. ' + (screened ? 'Availability varies; inspect the station list. ' : '') + 'Zoom in or use the searchable list.'));
          mark.on('click', () => {if (!interaction) map.setView(ll, Math.min(18, map.getZoom() + 2));});
        } else {
          const {station, ll} = members[0];
          const nearby = query?.mode === 'area' && station.relation === 'nearby';
          const availability = station.coopsAvailability;
          const availabilityColor = availability ? ['match', 'partial'].includes(availability.state) ? '#5b9b80' : ['outside_period', 'product_not_listed'].includes(availability.state) ? '#aeb8b3' : '#d8aa68' : null;
          const mark = L.circleMarker(ll, {renderer, radius: station.id === selected ? 7 : 4.5, color: station.id === selected ? '#173e35' : nearby ? '#9a6c31' : availability ? '#64716d' : '#2b7660', fillColor: availabilityColor || (nearby ? '#d8aa68' : '#5b9b80'), fillOpacity: .95, weight: station.id === selected ? 3 : 1.3}).addTo(stationLayer);
          mark.bindTooltip(pointText('', (station.name || station.id) + ' [' + station.id + ']' + (availability ? ' · ' + availability.label : '') + (nearby ? ' · outside footprint, within buffer' : '')));
          mark.on('click', () => {if (!interaction) options.onStation?.(station.id);});
          if (station.id === selected) {mark.setRadius(8); mark.setStyle({color:'#172f5a',fillColor:'#f5b544',weight:3}); mark.bringToFront();}
          if (station.id === highlighted) {mark.setRadius(9); mark.setStyle({color:'#173e35',weight:3}); mark.bringToFront(); mark.openTooltip();}
        }
      }
      options.onStationSummary?.({loaded: stations.length, markers: bins.size, grouped: bins.size < stations.length});
      renderedStations = stations; rendering = false;
    }
    function setQuery(next) {
      query = next;
      fitEnvelope = null;
      let overlayOmitted = false;
      const center = window.SiteGeometry.center(next);
      referenceLongitude = center.lon;
      const searchBoxes = window.SiteGeometry.searchBoxes(next);
      const maxLatitude = L.Projection.SphericalMercator.MAX_LATITUDE;
      projectNeedsPolarView = searchBoxes.some(([, south, , north]) => south < -maxLatitude || north > maxLatitude);
      updateProjection();
      projectLayer.clearLayers(); bufferLayer.clearLayers();
      const geometry = window.SiteGeometry.mapGeometry(next);
      L.geoJSON(displayGeometry(geometry, true), {style: {color: '#136957', weight: 2.2, fillColor: '#9bc7aa', fillOpacity: .075}, pointToLayer: (_, ll) => L.circleMarker(ll, {radius: 7, color: '#fff', weight: 2, fillColor: '#136957', fillOpacity: 1})}).addTo(projectLayer);
      const useSearchEnvelope = () => {
        fitEnvelope = L.latLngBounds([]);
        for (const [west, south, east, north] of searchBoxes) {
          const offset = east - west === 360 ? referenceLongitude : 360 * Math.round((referenceLongitude - (west + east) / 2) / 360);
          fitEnvelope.extend([south, west + offset]); fitEnvelope.extend([north, east + offset]);
        }
      };
      if (next.mode !== 'area') {
        drawRadius(next, next.radiusKm ?? 100);
        useSearchEnvelope();
      }
      else if (next.bufferKm > 0) {
        const coordinates = window.turf.coordAll(next.geometry), minLon = Math.min(...coordinates.map(c => c[0])), maxLon = Math.max(...coordinates.map(c => c[0]));
        if (maxLon - minLon > 180 || coordinates.some(c => Math.abs(c[1]) >= 80)) {overlayOmitted = true; useSearchEnvelope(); options.onNotice?.('Approximate buffer outline omitted for this dateline-spanning or polar footprint. The original outline is shown; station eligibility still uses polygon-edge distance.');}
        else try {
          const buffered = window.turf.buffer({type: 'Feature', properties: {}, geometry: next.geometry}, next.bufferKm, {units: 'kilometers', steps: 16});
          if (buffered) {
            const bufferedLongitudes = window.turf.coordAll(buffered).map(coordinate => coordinate[0]);
            if (Math.max(...bufferedLongitudes) - Math.min(...bufferedLongitudes) > 180) {overlayOmitted = true; useSearchEnvelope(); options.onNotice?.('Approximate buffer outline omitted because it crosses the dateline. Station eligibility still uses distance to the original polygon boundary.');}
            else L.geoJSON(displayGeometry(buffered, true), {style: {color: '#b68b50', weight: 1.2, dashArray: '5 4', fillColor: '#d8b77f', fillOpacity: .07}, interactive: false}).addTo(bufferLayer);
          } else {overlayOmitted = true; useSearchEnvelope(); options.onNotice?.('Approximate buffer outline was unavailable. Station eligibility still uses polygon-edge distance.');}
        } catch (_) {overlayOmitted = true; useSearchEnvelope(); options.onNotice?.('The approximate buffer outline could not be drawn. Exact eligibility still uses polygon-edge distance.'); }
      }
      bufferLayer.bringToFront(); projectLayer.bringToFront();
      const radiusKm = next.radiusKm ?? 100;
      const pointLegend = radiusKm === 0 ? 'Teal point · 0 km search radius' : radiusKm === window.SiteGeometry.limits.maxRadiusKm ? 'Teal point · search includes the whole Earth' : 'Teal point · dashed outline: ' + radiusKm + ' km station-search radius';
      options.onLegend?.(next.mode === 'area' ? 'Solid teal: project area' + (next.bufferKm > 0 ? overlayOmitted ? ' · buffer outline omitted' : ' · dashed amber: approximate ' + next.bufferKm + ' km buffer' : ' · outside buffer 0 km') : pointLegend);
      renderedStations = null; renderStations();
    }
    function fitAzimuthal(includeStations) {
      const size = map.getSize(), pad = includeStations ? 35 : 24;
      if (!size.x || !size.y) return;
      // Latitude/longitude corner bounds have no unique horizontal span at a pole.
      // Fit the projected circle and any candidate symbols in zoom-zero pixels.
      const center = map.project([query.lat, query.lon], 0);
      const radiusPixels = 128 * (query.radiusKm ?? 100) / window.SiteGeometry.limits.maxRadiusKm;
      const extent = L.point(radiusPixels, radiusPixels);
      const bounds = L.bounds(center.subtract(extent), center.add(extent));
      if (includeStations) {
        for (const station of stations) if (Number.isFinite(station.lat) && Number.isFinite(station.lon)) bounds.extend(map.project([station.lat, station.lon], 0));
      }
      const span = bounds.getSize(), scale = Math.min(Math.max(1, size.x - 2 * pad) / span.x, Math.max(1, size.y - 2 * pad) / span.y);
      const zoom = Math.max(map.getMinZoom(), Math.min(11, Math.floor(Math.log2(scale))));
      map.setView(map.unproject(bounds.getCenter(), 0), zoom, {animate:false});
    }
    function fit() {
      if (!query) return;
      if (map.options.crs.code === 'PROJECT:AEQD') {fitAzimuthal(false); return;}
      let bounds = projectLayer.getBounds();
      const bufferedBounds = bufferLayer.getBounds();
      if (bufferedBounds.isValid()) bounds = bounds.extend(bufferedBounds);
      if (fitEnvelope?.isValid()) bounds = bounds.extend(fitEnvelope);
      if (bounds.isValid()) map.fitBounds(bounds, {padding: [24, 24], maxZoom: query.mode === 'area' ? 12 : 11, animate: false});
    }
    function fitCandidates(){
      if (map.options.crs.code === 'PROJECT:AEQD') {fitAzimuthal(true); return;}
      const bounds=L.latLngBounds(stations.filter(s=>Number.isFinite(s.lat)&&Number.isFinite(s.lon)).map(s=>[s.lat,shift(s.lon)]));
      if(!bounds.isValid()){fit();return;}
      for(const extent of [projectLayer.getBounds(),bufferLayer.getBounds(),fitEnvelope])if(extent?.isValid())bounds.extend(extent);
      if(bounds.isValid())map.fitBounds(bounds,{padding:[35,35],maxZoom:12,animate:false});
    }
    function cancelDrawing() {
      interaction = null; firstCorner = null; drawingLayer.clearLayers(); container.classList.remove('sc-map-picking');
      options.onNotice?.('');
    }
    map.on('click', event => {
      if (interaction && event.latlng.outsideProjection) {options.onNotice?.('Choose a point within the projected Earth, or use Fit project.'); return;}
      if (interaction && Math.abs(event.latlng.lat) > 90) {options.onNotice?.('Choose a location between 90°S and 90°N.'); return;}
      if (interaction === 'point') {
        const point = {lat: Number(event.latlng.lat.toFixed(6)), lon: Number(wrap(event.latlng.lng).toFixed(6))};
        cancelDrawing(); options.onPoint?.(point);
      } else if (interaction === 'rectangle') {
        if (!firstCorner) {firstCorner = event.latlng; L.circleMarker(firstCorner, {radius: 4, color: '#a87536'}).addTo(drawingLayer); options.onNotice?.('Click the opposite corner to finish the rectangle.');}
        else {
          const west = wrap(Math.min(firstCorner.lng, event.latlng.lng)), east = wrap(Math.max(firstCorner.lng, event.latlng.lng));
          const bounds = {west, south: Math.min(firstCorner.lat, event.latlng.lat), east, north: Math.max(firstCorner.lat, event.latlng.lat)};
          cancelDrawing(); options.onRectangle?.(bounds);
        }
      }
    });
    map.on('mousemove', event => {
      if (interaction !== 'rectangle' || !firstCorner) return;
      drawingLayer.clearLayers(); L.rectangle(L.latLngBounds(firstCorner, event.latlng), {color: '#a87536', weight: 1.5, dashArray: '4 3', fillOpacity: .1, interactive: false}).addTo(drawingLayer);
    });
    map.on('moveend zoomend', () => {renderStations();});
    container.addEventListener('keydown', event => {if (event.key === 'Escape') cancelDrawing();});
    return {
      setQuery,
      setStations(next, selectedId) {if (renderedStations === next && selected === selectedId) return; stations = next || []; selected = selectedId || ''; const signature=stations.map(s=>s.id+':'+s.lat+':'+s.lon).join('|'); const changed=signature!==candidateSignature;candidateSignature=signature;updateProjection();renderStations();if(changed&&stations.length)fitCandidates();},
      highlightStation(id) {if (highlighted === id) return; highlighted = id; renderStations();},
      fit, fitCandidates, setOnline:reference.setOnline, setVisible:reference.setVisible,
      invalidate() {map.invalidateSize({pan: false}); renderStations();},
      beginPoint() {cancelDrawing(); interaction = 'point'; container.classList.add('sc-map-picking'); options.onNotice?.('Click the map to set a draft point, then Check site.');},
      beginRectangle() {cancelDrawing(); interaction = 'rectangle'; container.classList.add('sc-map-picking'); options.onNotice?.('Click two opposite corners. This defines a rectangle, not an administrative boundary.');},
      cancelDrawing,
      getDisplayState() {return {geometry: projectLayer.toGeoJSON(), stationCoordinates: stations.map(station => ({id: station.id, lat: station.lat, lon: shift(station.lon)})), referenceLongitude,zoom:map.getZoom(),bounds:map.getBounds(),online:reference.online,selected};},
      destroy() {
        // Release project layers before removing their renderer.
        for(const layer of [projectLayer,bufferLayer,stationLayer,drawingLayer])layer.clearLayers();
        removeGuide();
        reference.destroy();
        map.remove();
      }
    };
  }};
})();
