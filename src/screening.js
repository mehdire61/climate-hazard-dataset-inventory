/* Conservative catalog screening; this module never claims that data were retrieved. */
(function (root) {
  'use strict';
  const geometry = root.SiteGeometry || (typeof require === 'function' ? require('./geometry.js') : null);

  const domainKinds = new Set(['global', 'envelope', 'station', 'regional', 'unknown']);
  const timeKinds = new Set(['range', 'station', 'event', 'scenario', 'unknown']);
  const supportTypes = new Set(['station', 'grid', 'area', 'event', 'track', 'climate_state', 'acquisition', 'model']);
  const timeSteps = new Set(['accumulation_specific', 'acquisition', 'annual_monthly_seasonal', 'daily', 'daily_accumulations', 'daily_index',
    'daily_monthly', 'event', 'half_hourly', 'hourly', 'hourly_interval', 'hourly_or_finer', 'hourly_synoptic', 'irregular_track',
    'weekly', 'eight_day', 'mixed', 'monthly', 'monthly_annual', 'monthly_irregular', 'monthly_seasonal_annual', 'overpass', 'return_period_scenario',
    'six_minute_hourly', 'three_hourly', 'two_minute']);
  const accessRequirements = new Set(['cds_account_and_terms', 'commercial_licence', 'earthdata_account', 'platform_account',
    'provider_terms', 'public_api', 'registration_or_terms', 'request', 'route_dependent']);
  const indexedProducts = new Set(['chirps_v2_daily', 'chirps_v3_daily_rnl', 'chirps_v3_daily_sat', 'gpcc_monthly_v2025']);
  const snapshotCache = new Map();
  function validDate(value) {
    if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(value + 'T00:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  function validate(query, today = new Date().toISOString().slice(0, 10)) {
    const errors = [];
    if (!query || typeof query !== 'object') return ['Enter a location and historical period.'];
    errors.push(...(geometry ? geometry.validate(query) : ['The project geometry module is unavailable.']));
    if (!validDate(query.start)) errors.push('Start date must be a real calendar date in YYYY-MM-DD form.');
    if (!validDate(query.end)) errors.push('End date must be a real calendar date in YYYY-MM-DD form.');
    if (validDate(query.start) && validDate(query.end)) {
      if (query.start > query.end) errors.push('End date must be on or after start date.');
      if (query.end > today || query.start > today) errors.push('Historical screening requires dates no later than today (UTC).');
    }
    return errors;
  }
  function validInterval(interval) {
    return interval && (interval.start === null || validDate(interval.start)) &&
      (interval.end === null || validDate(interval.end)) &&
      !(interval.start && interval.end && interval.start > interval.end);
  }
  function validSources(value) {
    return Array.isArray(value) && value.length > 0 && value.every(value => {
      try {const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password;} catch (_) {return false;}
    });
  }
  function validSnapshot(snapshot) {
    return snapshot && validDate(snapshot.first_file_start) && validDate(snapshot.last_file_end) &&
      snapshot.first_file_start <= snapshot.last_file_end && validDate(snapshot.checked_on) &&
      snapshot.source === 'data/grid-access-index.json' && Number.isInteger(snapshot.file_count) && snapshot.file_count > 0 && validSources(snapshot.source_urls);
  }
  function deriveIndexSnapshot(index, reference) {
    if (!indexedProducts.has(reference)) return null;
    const product = index?.products?.[reference], files = product?.files, checks = product?.listingChecks;
    if (!Array.isArray(files) || !files.length || !files.every(file => file && validDate(file.start) && validDate(file.end) && file.start <= file.end) ||
      !Array.isArray(checks) || !checks.length || !checks.every(check => check && typeof check.metadataCheckedAt === 'string' && validDate(check.metadataCheckedAt.slice(0, 10))) || !validSources(checks.map(check => check.url))) return null;
    return {source: 'data/grid-access-index.json', first_file_start: files.map(file => file.start).sort()[0],
      last_file_end: files.map(file => file.end).sort().at(-1), checked_on: checks.map(check => check.metadataCheckedAt.slice(0, 10)).sort()[0],
      source_urls: [...new Set(checks.map(check => check.url))], file_count: files.length};
  }
  function snapshotFor(period) {
    if (period.index_snapshot) return period.index_snapshot;
    if (!period.index_reference) return null;
    if (!snapshotCache.has(period.index_reference)) {
      let index = root.InventoryApp?.data?.gridAccess;
      if (!index && typeof module !== 'undefined' && module.exports) {
        try {index = require('../data/grid-access-index.json');} catch (_) {}
      }
      snapshotCache.set(period.index_reference, deriveIndexSnapshot(index, period.index_reference));
    }
    return snapshotCache.get(period.index_reference);
  }
  function validRule(rule) {
    if (!rule || !rule.domain || !rule.time || !domainKinds.has(rule.domain.kind) || !timeKinds.has(rule.time.kind)) return false;
    if (!supportTypes.has(rule.support_type) || !Array.isArray(rule.evidence_ids) || !rule.evidence_ids.length ||
      !rule.evidence_ids.every((id) => typeof id === 'string' && id.trim()) || !validDate(rule.curation_reviewed_on) ||
      !timeSteps.has(rule.time_step) || !accessRequirements.has(rule.access_requirement)) return false;
    const bounds = rule.domain.bounds;
    if (bounds !== null && bounds !== undefined && (!Array.isArray(bounds) || bounds.length !== 4 ||
      !bounds.every(Number.isFinite) || bounds[0] < -180 || bounds[0] > 180 || bounds[2] < -180 || bounds[2] > 180 ||
      bounds[1] < -90 || bounds[3] > 90 || bounds[1] > bounds[3])) return false;
    if (rule.domain.kind === 'envelope' && !bounds) return false;
    if (rule.domain.regions !== undefined && (!Array.isArray(rule.domain.regions) || !rule.domain.regions.length || !rule.domain.regions.every(r=>r && Array.isArray(r.bounds) && r.bounds.length===4 && r.bounds.every(Number.isFinite) && Math.abs(r.bounds[0])<=180 && Math.abs(r.bounds[2])<=180 && r.bounds[1]>=-90 && r.bounds[3]<=90 && r.bounds[1]<=r.bounds[3] && (!r.start || validDate(r.start)) && (!r.end || validDate(r.end))))) return false;
    if (rule.time.solution_calendar !== undefined && (!Array.isArray(rule.time.solution_calendar) || !rule.time.solution_calendar.length)) return false;
    if (rule.time.return_period_years !== undefined && (rule.time.kind !== 'scenario' || !Number.isSafeInteger(rule.time.return_period_years) || rule.time.return_period_years <= 0)) return false;
    if (rule.time.access_route_start !== undefined && !validDate(rule.time.access_route_start)) return false;
    if (rule.time.index_reference !== undefined && !indexedProducts.has(rule.time.index_reference)) return false;
    if (rule.time.index_snapshot !== undefined && (!rule.time.index_reference || !validSnapshot(rule.time.index_snapshot) || rule.time.known_through !== rule.time.index_snapshot.last_file_end)) return false;
    if (rule.time.access_route_end !== undefined && (!validDate(rule.time.access_route_end) || typeof rule.time.access_route_note !== 'string' || !rule.time.access_route_note)) return false;
    const policy = rule.time.publication_policy;
    if (rule.time.latest_availability !== undefined && rule.time.latest_availability !== 'unchecked') return false;
    if (policy !== undefined && (!policy || !['era5_cds', 'merra2_monthly', 'mcd64a1_monthly'].includes(policy.kind) || !validDate(policy.checked_on) || !validSources(policy.source_urls))) return false;
    return Array.isArray(rule.time.intervals) && rule.time.intervals.every(validInterval) &&
      Array.isArray(rule.time.uncertain_windows) && rule.time.uncertain_windows.every(validInterval) &&
      (rule.time.known_through == null || validDate(rule.time.known_through));
  }
  function overlaps(query, interval) {
    return (!interval.start || query.end >= interval.start) && (!interval.end || query.start <= interval.end);
  }
  function covers(query, interval) {
    return (!interval.start || query.start >= interval.start) && (!interval.end || query.end <= interval.end);
  }
  function containsFullMonth(query) {
    const last=new Date(query.start+'T00:00:00Z');
    last.setUTCMonth(last.getUTCMonth()+(last.getUTCDate()===1?1:2),0);
    return last.toISOString().slice(0,10)<=query.end;
  }
  function resolutionChecks(product,rule,query) {
    const checks=[];
    // Package cadence is distinct from observation cadence. MCD64A1's monthly
    // file, for example, carries a day-of-year estimate for each burned pixel.
    const aggregates={
      gpcc_monthly_v2025:['Monthly totals only','GPCC reports a calendar-month precipitation total in mm/month. It cannot isolate rainfall during these dates.'],
      hadex3:['Monthly or coarser indices','HadEX3 reports annual indices and selected monthly indices. Event-scale observations are needed to characterize these dates.'],
      psmsl_rlr:['Monthly or annual means','PSMSL monthly and annual mean sea levels cannot resolve a tide or surge during this interval.'],
      gsim_indices:['Monthly or coarser indices','GSIM publishes monthly, seasonal and annual streamflow indices. Use a discharge series to investigate this shorter period.'],
      grace_jpl_mascon_cri_rl063_v04:['Monthly storage estimates','A GRACE solution integrates observations over its sampling interval. It cannot isolate storage change over these shorter dates.']
    };
    const aggregate=aggregates[product.product_id];
    if(aggregate&&!containsFullMonth(query))checks.push({dimension:'time',label:aggregate[0],detail:aggregate[1]});
    if(rule.time.solution_calendar){
      // JPL solves 4,551 equal-area mascons. Mean spherical area provides a
      // screening comparison independent of latitude or the 0.5° output grid.
      const nativeAreaKm2=4*Math.PI*6371.0088**2/4551;
      const projectAreaKm2=query.mode==='area'?geometry.areaKm2(query.geometry):null;
      if(projectAreaKm2===null||projectAreaKm2<nativeAreaKm2){
        const size=projectAreaKm2===null?'A point has no averaging area.':'The project covers about '+(projectAreaKm2<1?'<1':Math.round(projectAreaKm2).toLocaleString('en-US'))+' km².';
        checks.push({dimension:'space',label:projectAreaKm2===null?'Regional storage scale':'Area smaller than one mascon',
          detail:size+' JPL estimates storage over 3° equal-area mascons (about 112,000 km² each, roughly 335 km across an equal-area square). The 0.5° reporting grid shares the regional signal. Use the estimate as regional context and assess leakage before interpreting local changes.',
          projectAreaKm2,nativeMeanAreaKm2:nativeAreaKm2,method:'Project polygon spherical area on a sphere of mean radius 6371.0088 km, excluding holes and summing parts. Native mean area is Earth surface area divided by 4551 equal-area mascons.',evidenceId:'GRACE_GUIDE'});
      }
    }
    return checks;
  }
  const landCache = new WeakMap();
  const polygonCache = new WeakMap();
  function preparedPolygons(query) {
    const normalized=geometry.normalize(query.geometry);
    // Cache only immutable validated geometry, never a caller's mutable GeoJSON.
    if (!polygonCache.has(normalized)) polygonCache.set(normalized,normalized.type==='Polygon'?[normalized]:normalized.coordinates.map(coordinates=>geometry.normalize({type:'Polygon',coordinates})));
    return polygonCache.get(normalized);
  }
  let landParts;
  function landCheck(query) {
    if (landCache.has(query)) return landCache.get(query);
    const turf = root.turf || (typeof require === 'function' ? require('../vendor/turf.min.js') : null);
    const reference = root.InventoryApp?.data?.countryBoundaries || (typeof require === 'function' ? require('../data/country-boundaries.json') : null);
    if (!turf || !reference?.features) return {land: null, iceRegion: false};
    if (!landParts) landParts = reference.features.flatMap(f => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)
      .map(coordinates => {const shape=turf.polygon(coordinates);return {shape,box:turf.bbox(shape),countryId:f.properties.id,iceRegion:['ATA','GRL'].includes(f.properties.id)};}));
    const area = query.mode === 'area', shape = area ? turf.feature(query.geometry) : turf.point([query.lon,query.lat]);
    const areaParts=area?preparedPolygons(query).map(part=>{const shape=turf.feature(part);return {shape,box:turf.bbox(shape)};}):[];
    const boxesOverlap=(a,b)=>a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];
    // A generalized coastline cannot resolve a coastal point. Include its search radius
    // and a 25 km minimum margin, using split search boxes across the date line.
    const marginKm=area?0:Math.max(25,query.radiusKm||0);
    // Prune disjoint polygon parts before exact intersection, including split date-line areas.
    const boxes=area?areaParts.map(p=>p.box):geometry.searchBoxes({...query,radiusKm:marginKm});
    const candidates=landParts.filter(p=>boxes.some(b=>boxesOverlap(b,p.box)));
    const exact=candidates.filter(p=>area?areaParts.some(a=>boxesOverlap(a.box,p.box)&&turf.booleanIntersects(a.shape,p.shape)):turf.booleanPointInPolygon(shape,p.shape));
    const hits=area?exact:candidates.filter(p=>exact.includes(p)||p.shape.geometry.coordinates.some(ring=>turf.pointToLineDistance(shape,turf.lineString(ring),{units:'kilometers'})<=marginKm));
    const polar=!area&&query.lat<=-85;
    let areaLandCoverage=null,majorityLand=false;
    let touchesMappedBoundary=!area&&exact.some(p=>!turf.booleanPointInPolygon(shape,p.shape,{ignoreBoundary:true}));
    if(area&&exact.length){
      // Compare project polygons against the union of the intersecting generalized
      // land polygons. Administrative borders and polygon holes are retained.
      try {
        let knownLandM2=0;
        const mixed=areaParts.some(part=>{
          const neighbors=exact.filter(p=>boxesOverlap(part.box,p.box));
          if(!neighbors.length)return true;
          if(neighbors.some(p=>p.box.every((v,i)=>v===part.box[i])&&
            JSON.stringify(p.shape.geometry.coordinates)===JSON.stringify(part.shape.geometry.coordinates))){
            knownLandM2+=turf.area(part.shape);touchesMappedBoundary=true;return false;
          }
          const water=turf.difference(turf.featureCollection([part.shape,...neighbors.map(p=>p.shape)]));
          knownLandM2+=Math.max(0,turf.area(part.shape)-(water?turf.area(water):0));
          if(water)return true;
          if(!touchesMappedBoundary)touchesMappedBoundary=neighbors.some(p=>turf.booleanIntersects(part.shape,turf.polygonToLine(p.shape)));
          return false;
        });
        areaLandCoverage=mixed?'partial':'within';
        // On mixed multipart projects the short-circuit above only counts land
        // already inspected. This lower bound can qualify a mostly land area.
        majorityLand=!mixed||knownLandM2>turf.area(shape)/2;
      } catch {
        areaLandCoverage='unknown';
      }
    }
    const result={land:polar||hits.length>0,iceRegion:polar||hits.some(p=>p.iceRegion),nearCoast:!exact.length&&hits.length>0,marginKm,countryIds:[...new Set(exact.map(p=>p.countryId))],nearCountryIds:[...new Set(hits.map(p=>p.countryId))],areaLandCoverage,majorityLand,touchesMappedBoundary};
    landCache.set(query,result);return result;
  }
  function regionRelation(query, domain) {
    if (domain.reporting_zones==='nws_public_coastal') return stormZoneRelation(query);
    if (domain.orbit_margin_degrees) {
      const queries=query.mode==='area'?preparedPolygons(query).map(part=>({...query,geometry:part})):[query];
      const [south,north]=[domain.bounds[1],domain.bounds[3]], margin=domain.orbit_margin_degrees;
      const spans=queries.map(q=>geometry.searchBoxes(q)[0]);
      if (spans.every(b=>b[1]>north+margin||b[3]<south-margin)) return 'outside';
      if (spans.every(b=>b[1]>=south&&b[3]<=north)) return 'within';
      return spans.some(b=>b[1]<=north&&b[3]>=south)?'partial':'unknown';
    }
    const boxes=domain.regions?.map(r=>r.bounds) || (domain.bounds ? [domain.bounds] : []);
    if (!boxes.length) return domain.regions ? 'outside' : 'unknown';
    if (domain.kind==='station') {
      const searches=geometry.searchBoxes(query);
      if (searches.some(search=>boxes.some(box=>search[0]<=box[2]&&search[2]>=box[0]&&search[1]<=box[3]&&search[3]>=box[1]))) return 'within';
      return domain.hard_bounds?'outside':'unknown';
    }
    if (query.mode !== 'area') return boxes.some(box=>geometry.domainRelation(query,box,true) === 'within') ? 'within' : domain.hard_bounds ? 'outside' : 'unknown';
    const relations=preparedPolygons(query).map(part=>{
      // Reuse the immutable prepared polygon across coverage boxes; retain every vertex.
      const q={...query,geometry:part};
      const candidates=boxes.map(box=>geometry.domainRelation(q,box,true));
      return candidates.includes('within')?'within':candidates.includes('partial')?'partial':candidates.includes('unknown')?'unknown':'outside';
    });
    return relations.every(r=>r==='within')?'within':relations.every(r=>r==='outside')?'outside':relations.includes('unknown')?'unknown':'partial';
  }
  const stormZoneCache=new WeakMap();
  function stationReference() {
    return root.InventoryApp?.data?.stationReference ||
      (typeof require==='function'?require('../data/station-reference.json'):null);
  }
  function indexedCoastalStation(query) {
    const locations=stationReference()?.coopsLocationIndex?.coordinates;
    if(!locations?.length)return null;
    const boxes=geometry.searchBoxes(query);
    return locations.some(([lon,lat])=>boxes.some(([w,s,e,n])=>lon>=w&&lon<=e&&lat>=s&&lat<=n)&&geometry.includesStation(query,{lon,lat}));
  }
  const radarRangeCache=new WeakMap();
  function insideRadarRange(query) {
    if(radarRangeCache.has(query))return radarRangeCache.get(query);
    const reference=stationReference()?.mrmsRadarReference;
    if(!reference?.stations?.length)return false;
    // A point screens its grid cell. For a polygon, qualify only when the
    // bounding box of every part fits in the union of listed radar ranges.
    // The meridian + parallel path bounds the distance to any point in a box.
    const boxes=query.mode==='area'?preparedPolygons(query).flatMap(part=>geometry.searchBoxes({mode:'area',geometry:part,bufferKm:0})):
      [[query.lon,query.lat,query.lon,query.lat]];
    const turf=root.turf || (typeof require==='function'?require('../vendor/turf.min.js'):null);
    function covered([w,s,e,n],depth) {
      const center=[(w+e)/2,(s+n)/2],closestLatitude=Math.max(0,s,-n);
      const lonSpan=(e-w)*Math.cos(closestLatitude*Math.PI/180);
      const margin=6371.0088*Math.PI/360*((n-s)+lonSpan);
      let nearest=Infinity;
      for(const [,lon,lat] of reference.stations){
        nearest=Math.min(nearest,turf.distance(center,[lon,lat]));
        if(nearest+margin<=reference.nominalKm)return true;
      }
      if(nearest>reference.nominalKm||depth===8)return false;
      return lonSpan>n-s ?
        covered([w,s,center[0],n],depth+1)&&covered([center[0],s,e,n],depth+1) :
        covered([w,s,e,center[1]],depth+1)&&covered([w,center[1],e,n],depth+1);
    }
    const result=!!turf&&boxes.every(b=>covered(b,0));
    radarRangeCache.set(query,result);return result;
  }
  function withinConusGrid(query,grid) {
    // Polar stereographic x/y extrema on a geographic box lie at its limiting
    // latitudes and end or cardinal meridians. Reserve two cells at every edge.
    const rad=Math.PI/180;
    const project=(lon,lat)=>{
      const rho=grid.radiusKm*(1+Math.sin(60*rad))*Math.tan(Math.PI/4-lat*rad/2);
      return [rho*Math.sin((lon-grid.centralMeridian)*rad),-rho*Math.cos((lon-grid.centralMeridian)*rad)];
    };
    const [x0,y0]=project(grid.firstLon,grid.firstLat),margin=2*grid.spacingKm;
    return geometry.searchBoxes({...query,bufferKm:0}).every(([w,s,e,n])=>{
      const meridians=[w,e,...[-180,-90,0,90,180,270].map(a=>grid.centralMeridian+a).filter(a=>w<a&&a<e)];
      return [s,n].every(lat=>meridians.every(lon=>{
        const [x,y]=project(lon,lat);
        return x>=x0+margin&&x<=x0+(grid.nx-1)*grid.spacingKm-margin&&y>=y0+margin&&y<=y0+(grid.ny-1)*grid.spacingKm-margin;
      }));
    });
  }
  function stormZoneRelation(query) {
    if(stormZoneCache.has(query))return stormZoneCache.get(query);
    const reference=root.InventoryApp?.data?.screening?.storm_reporting_zones||
      (typeof require==='function'?require('../data/screening.json').storm_reporting_zones:null);
    if(!reference?.bounds?.length)return 'unknown';
    // These rectangles are disjoint runs of grid cells intersecting official NWS
    // zones. Geometry.searchBoxes splits buffered projects at the date line.
    const area=query.mode==='area';
    const parts=area?preparedPolygons(query).map(geometry=>({...query,geometry})):[query];
    const states=parts.map(part=>{
      const windows=geometry.searchBoxes(part);
      if(windows.some(b=>b[0]===-180))windows.push([180,windows[0][1],180,windows[0][3]]);
      if(windows.some(b=>b[2]===180))windows.push([-180,windows[0][1],-180,windows[0][3]]);
      const candidates=reference.bounds.filter(b=>windows.some(w=>w[0]<=b[2]&&w[2]>=b[0]&&w[1]<=b[3]&&w[3]>=b[1]));
      if(candidates.some(b=>geometry.domainRelation(part,b,true)!=='outside'))return 'within';
      if(!area&&query.radiusKm>0){
        // On a sphere the nearest point on a meridian can be poleward of the
        // search center. Optimize latitude on the bounded meridian segment.
        const rad=Math.PI/180;
        for(const [w,s,e,n] of candidates){
          const lon=Math.max(w,Math.min(e,query.lon+360*Math.round(((w+e)/2-query.lon)/360)));
          const phi=Math.atan2(Math.sin(query.lat*rad),Math.cos(query.lat*rad)*Math.cos((query.lon-lon)*rad))/rad;
          if(geometry.classify(query,{lon,lat:Math.max(s,Math.min(n,phi))}).included)return 'near';
        }
      }
      // A buffered area crossing the conservative cell cover needs a source check.
      return area&&part.bufferKm>0&&candidates.length?'near':'outside';
    });
    const value=states.every(s=>s==='outside')?'outside':states.every(s=>s==='within')?'within':
      states.includes('outside')?'partial':'near';
    stormZoneCache.set(query,value);return value;
  }
  function temporalSegments(period, regions, query, confirmedThrough, uncheckedFrom) {
    const day=86400000,start=Date.parse(query.start),end=Date.parse(query.end)+day;
    const range=i=>({start:i.start?Date.parse(i.start):start,end:i.end?Date.parse(i.end)+day:end});
    const nominal=period.intervals.map(range),uncertain=period.uncertain_windows.map(range);
    const regional=regions?.some(r=>r.start||r.end)?regions.map(range):[];
    const tail=confirmedThrough?Date.parse(confirmedThrough)+day:uncheckedFrom?Date.parse(uncheckedFrom):null;
    const boundaries=new Set([start,end]);
    for(const interval of [...nominal,...uncertain,...regional])for(const value of [interval.start,interval.end])if(value>start&&value<end)boundaries.add(value);
    if(tail!==null&&tail>start&&tail<end)boundaries.add(tail);
    const points=[...boundaries].sort((a,b)=>a-b),segments=[];
    const contains=(interval,a,b)=>interval.start<=a&&interval.end>=b,date=ms=>new Date(ms).toISOString().slice(0,10);
    for(let i=0;i<points.length-1;i++){
      const a=points[i],b=points[i+1],hasNominal=nominal.some(r=>contains(r,a,b)),hasUncertainty=uncertain.some(r=>contains(r,a,b));
      const regionalCount=regional.filter(r=>contains(r,a,b)).length;
      let kind='outside',reason='Outside documented dates or in a documented gap.';
      if(period.kind==='scenario'||!nominal.length){kind='unresolved';reason=period.return_period_years ? 'A fixed return-period layer has no observation dates.' : 'Calendar support requires the selected scenario, station, event or source record.';}
      else if(hasNominal){
        if(regional.length&&!regionalCount)reason='Outside the documented dates of all intersecting regional screening boxes.';
        else if(regional.length&&regionalCount<regional.length){kind='uncertain';reason='Documented date support differs between intersecting regional screening boxes.';}
        else if(period.kind==='station'){kind='unresolved';reason='The network archive can overlap these dates. A station and element record must establish local availability.';}
        else {kind='documented';reason=period.solution_calendar?'Nominal months with a JPL storage solution. Sampling spans vary by month; these are monthly estimates.':'Nominal documented date overlap; observations and valid cells are not verified.';}
      }
      if(hasUncertainty&&(hasNominal?kind!=='outside':true)){kind='uncertain';reason='Explicit source uncertainty; this is not a confirmed record interval.';}
      if(kind==='documented'&&tail!==null&&a>=tail){kind='unchecked';reason=confirmedThrough?'Dates are beyond the checked endpoint or stated publication horizon.':'Dates are inside the application reminder window; the archive endpoint is unverified.';}
      const previous=segments.at(-1);
      if(previous&&previous.kind===kind&&previous.reason===reason)previous.end=date(b-day);
      else segments.push({start:date(a),end:date(b-day),kind,reason});
    }
    return segments;
  }
  function evaluate(product, rule, query, today = new Date().toISOString().slice(0, 10)) {
    const errors = validate(query, today);
    if (errors.length) return {status:'unresolved',label:'Check inputs',reasons:errors,spatial:'Not evaluated',spatialRelation:'unknown',temporal:'Not evaluated'};
    if (!validRule(rule) || rule.time.index_reference && rule.time.index_reference!==product.product_id) return {status:'unresolved',label:'Check screening metadata',reasons:['Screening metadata is missing or invalid. Open the cited documentation.'],spatial:'Unknown',spatialRelation:'unknown',temporal:'Unknown'};
    const domain=rule.domain, period=rule.time, snapshot=snapshotFor(period), reasons=[], decisions=[];
    let spatial='Global documented extent', spatialRelation='within', temporal='Dates need a data check';
    let spatialExcluded=false,timeExcluded=false,uncertain=false,uncertainOnly=false,partial=false,areaPartial=false,datesPartial=false,recent=false,confirmedThrough=null,uncheckedFrom=null,checkLabel='',landResult=null;
    const uncertainPeriods=period.uncertain_windows.filter(interval=>overlaps(query,interval));
    const usgs=product.product_id==='usgs_streamflow',coops=product.product_id==='noaa_coops_water_level';
    const indexedStation=coops?indexedCoastalStation(query):null;
    let networkInScope;
    if(indexedStation){
      spatial='Mapped water-level station in search area';
      reasons.push('NOAA lists a station inside this search area. Check the product, record dates and vertical datum at the station.');
    } else if (domain.bounds || domain.regions || domain.reporting_zones) {
      spatialRelation=regionRelation(query,domain);
      if (spatialRelation==='outside') {spatialExcluded=true;spatial='Outside documented area';decisions.push('The project is outside the documented geographic regions.');}
      else if (spatialRelation==='partial') {partial=true;areaPartial=true;spatial='Part of the area fits';decisions.push('Only part of the project footprint or search radius intersects the documented extent.');}
      else if (spatialRelation==='within') spatial='Inside documented extent';
      else if (domain.kind==='station') decisions.push('Outside the usual network area. Search the provider for stations, including historical records.');
      else {uncertain=true;checkLabel='Check extent edge';spatial='Approximate extent; check coverage';decisions.push('The documented boundary is approximate; check the selected files or observations.');}
    } else if (['regional','unknown'].includes(domain.kind)) {uncertain=true;spatial='Detailed extent not documented';}
    if (domain.approximate_bounds && !indexedStation && !spatialExcluded && !(domain.kind==='station' && spatialRelation==='unknown')) {
      const land=landCheck(query), countries=land.countryIds||[];
      const mappedInterior=countries.length&&countries.every(id=>domain.country_ids?.includes(id))&&!land.touchesMappedBoundary&&
        (query.mode!=='area'||land.areaLandCoverage==='within')&&spatialRelation==='within';
      if(usgs)networkInScope=land.land===null||land.nearCountryIds?.some(id=>domain.country_ids.includes(id))===true;
      const coastalNetwork=usgs&&query.mode==='area'&&spatialRelation==='within'&&land.majorityLand&&
        countries.length&&countries.every(id=>domain.country_ids.includes(id));
      const coastalGrid=domain.conus_grid&&query.mode==='area'&&spatialRelation==='within'&&land.areaLandCoverage==='partial'&&land.majorityLand&&
        countries.length===1&&countries[0]==='USA'&&withinConusGrid(query,domain.conus_grid);
      if(coastalNetwork&&!mappedInterior){
        spatial='Project land within the usual USGS region';
        reasons.push('The mapped land in this mostly land project belongs to the USGS service region. Search for a streamgage and verify its drainage basin and record.');
      }else if(coastalGrid){
        spatial='Inside CONUS grid footprint';
        reasons.push('The project intersects U.S. land and water inside the nominal CONUS grid. Check coastal cells and valid precipitation values in the selected files.');
      }else if (!mappedInterior) {
        uncertain=true;checkLabel='Check extent edge';spatialRelation='near';spatial='Near documented extent';
        decisions.push('Broad screening boxes overlap this project, but its footprint crosses or touches a mapped boundary, or lies outside the mapped interior of the provider region. Check the actual grid, station or event locations.');
      } else {
        spatial='Inside mapped provider region';
        reasons.push('The project lies inside the generalized provider region. Verify local stations, event locations or valid grid cells for the requested dates.');
      }
    }
    if (usgs)networkInScope=networkInScope??false;
    if (coops)networkInScope=indexedStation??(spatialRelation!=='unknown');
    if (product.product_id==='nrcs_snotel_daily_swe') networkInScope=['within','partial'].includes(spatialRelation);
    if (rule.support_type==='station' && !spatialExcluded && spatialRelation!=='near'&&!indexedStation&&
        spatial!=='Inside mapped provider region'&&spatial!=='Project land within the usual USGS region') spatial='Search the station network';
    if(domain.radar_range_check&&!spatialExcluded){
      if(insideRadarRange(query)){
        if(spatialRelation==='within')spatial='Inside nominal radar range';
        reasons.push('The project is within the nominal 300 km range of listed WSR-88D radars. Check beam blockage, operating status and valid product cells for the requested time.');
      }else{
        uncertain=true;checkLabel='Check radar coverage';
        if(spatialRelation==='within'){spatialRelation='unknown';spatial='Grid footprint only; radar coverage unchecked';}
        decisions.push('The archive grid extends beyond radar coverage. The U.S. WSR-88D site list does not establish 300 km coverage across this project. Partner radars can contribute. Check the local field for these dates.'+
          (product.product_id==='mrms_multisensor_qpe'?' MultiSensor precipitation can also use gauge or model estimates in radar gaps.':''));
      }
    }
    if (domain.mask && !spatialExcluded) {
      const land=landCheck(query);
      landResult=land;
      if(land.areaLandCoverage==='partial'){
        partial=true;areaPartial=true;spatialRelation='partial';spatial='Partial overlap with mapped land';
        decisions.push('Part of the project lies outside the generalized land footprint. Check the selected file and variable for valid cells before calculating regional coverage or statistics.');
      }
      if (land.land===false || land.iceRegion || land.land===null) {
        uncertain=true;checkLabel='Check land mask';
        decisions.push(land.iceRegion ? 'The project is in or near Antarctica or Greenland. Check the product ice/land mask and valid cells.' : land.land===false ? 'Land was not resolved within the coarse screening margin. This may be ocean or an omitted small island; check the provider land mask. This is not a no-land or no-data finding.' : 'The coarse land check is unavailable. Check the product mask.');
      } else if(land.areaLandCoverage==='unknown'){
        uncertain=true;checkLabel='Check land coverage';spatialRelation='unknown';spatial='Land intersects; valid area unchecked';
        decisions.push('The project intersects the generalized land footprint, but full containment could not be established. Inspect the provider mask.');
      } else if(!areaPartial) reasons.push(land.nearCoast ? `Land is within the ${land.marginKm} km coastal screening margin. Check whether the product masks the exact location.` : 'Land intersects the generalized country layer. Product masks and valid cells still need checking.');
    }
    if (domain.note) reasons.push(domain.note);
    if (period.kind==='scenario') temporal=period.return_period_years ? period.return_period_years+'-year scenario independent of project dates' : period.frequency_estimate ? 'Choose a duration and annual exceedance probability; project dates do not select an estimate' : 'Choose a scenario instead of calendar dates';
    else if (period.intervals.length) {
      const matches=period.intervals.filter(interval=>overlaps(query,interval));
      if (!matches.length && uncertainPeriods.length) {
        uncertainOnly=true;temporal='Dates need a source check';checkLabel='Check documented dates';
        datesPartial=!uncertainPeriods.some(interval=>covers(query,interval));partial=datesPartial||partial;
        decisions.unshift('The selected dates overlap an explicitly uncertain period. Inspect the source before deciding whether data exist.'+(datesPartial?' Other requested dates fall outside the stated documented and uncertain periods.':''));
      }
      else if (!matches.length) {timeExcluded=true;temporal='Outside documented dates';decisions.unshift('The selected dates do not overlap the documented periods for this dataset.');}
      else {
        datesPartial=!matches.some(interval=>covers(query,interval));
        partial=datesPartial || partial;
        temporal=datesPartial?'Dates partly fit':'Dates fit';
        if (datesPartial) decisions.push('Documented date overlap: '+matches.map(interval=>[interval.start&&interval.start>query.start?interval.start:query.start,interval.end&&interval.end<query.end?interval.end:query.end].join(' to ')).join('; ')+(uncertainPeriods.length?'. Other requested dates include an explicitly uncertain period; inspect the source. Dates beyond both documented and uncertain periods remain outside the stated scope.':'. Other requested dates are outside these periods or in a documented gap.'));
      }
    }
    const localRegions=domain.regions?.filter(r=>geometry.domainRelation(query,r.bounds,true)!=='outside');
    if (!timeExcluded && localRegions?.length && localRegions.some(r=>r.start||r.end)) {
      // A covering region cannot confer its dates on a different region of the project.
      // Overlapping screening boxes are ambiguous, so disagreement requires a source check.
      const regional=localRegions.map(r=>({name:r.name||'Regional record',start:r.start||null,end:r.end||null}));
      const supported=regional.filter(r=>overlaps(query,r));
      if (!supported.length) {timeExcluded=true;temporal='Outside documented dates for this area';decisions.unshift('The selected regional archive does not overlap the requested dates. This does not exclude other historical archives.');}
      else if (!regional.every(r=>covers(query,r))) {
        uncertain=true;checkLabel='Check regional dates';
        datesPartial=datesPartial||query.mode==='area'||supported.some(r=>!covers(query,r));partial=partial||datesPartial;
        temporal=query.mode==='area'?'Dates partly fit across the area':'Regional dates need checking';
        const periods=[...new Set(regional.map(r=>r.name+': '+(r.start||'start unspecified')+' to '+(r.end||'open end')))];
        decisions.unshift('Regional date support differs within the intersecting screening boxes. '+periods.join('; ')+'. Check the selected archive for each part of the project; overlapping boxes do not establish which regional record applies.');
      }
    }
    const markRecent=(boundary,message)=>{
      if (query.end<=boundary || timeExcluded) return;
      recent=true;confirmedThrough=confirmedThrough&&confirmedThrough<boundary?confirmedThrough:boundary;
      temporal=query.start<=confirmedThrough?'Dates partly fit':'Recent dates need checking';
      const firstUnchecked=query.start>boundary?query.start:new Date(Date.parse(boundary+'T00:00:00Z')+86400000).toISOString().slice(0,10);
      const days=Math.round((Date.parse(query.end)-Date.parse(firstUnchecked))/86400000)+1;
      decisions.push((query.start<=boundary ? `The documented date fit extends through ${boundary}; the last ${days} requested days need checking. ` : `All ${days} requested days are after the checked date ${boundary} and need a current-file check. `)+message);
    };
    const knownThrough=snapshot?.last_file_end || period.known_through;
    if (knownThrough) markRecent(knownThrough,snapshot?`Files were listed on ${snapshot.checked_on}. Newer files may exist.`:'This is the last checked date, not a permanent archive end.');
    for (const interval of uncertainPeriods) if (!timeExcluded) {uncertain=true;checkLabel=checkLabel||'Check variable dates';decisions.push(interval.reason || 'The documented start or end date is uncertain for part of this period.');}
    if (snapshot) {
      reasons.push(`Files listed on ${snapshot.checked_on} span ${snapshot.first_file_start} to ${snapshot.last_file_end}.`);
      const firmStart=period.intervals.map(i=>i.start).filter(Boolean).sort()[0];
      if (!timeExcluded && query.start<snapshot.first_file_start && (!firmStart || query.start>=firmStart)) {if(!firmStart)uncertain=true;reasons.push(`This file-format listing begins ${snapshot.first_file_start}; use other provider formats or archives for earlier documented dates.`);}
    } else if (period.index_reference) {uncertain=true;checkLabel=checkLabel||'Check provider files';decisions.push('The dated file listing is unavailable or invalid. Check the provider listing.');}
    if (period.access_route_start && query.start<period.access_route_start && !timeExcluded) {uncertain=true;checkLabel=checkLabel||'Use another archive';decisions.push(`This download archive begins ${period.access_route_start}. Earlier data require another provider archive.`);}
    if (period.access_route_end) markRecent(period.access_route_end,period.access_route_note);
    const policy=period.publication_policy;
    if (policy && !timeExcluded) {
      const now=new Date(today+'T00:00:00Z'), monthStart=new Date(today.slice(0,7)+'-01T00:00:00Z');
      if (policy.kind==='era5_cds') {
        monthStart.setUTCMonth(monthStart.getUTCMonth()-3);
        markRecent(new Date(+monthStart-86400000).toISOString().slice(0,10),'Recent ERA5T can be preliminary and is normally replaced after two to three months. The newest data are typically about five days behind real time.');
      } else if (policy.kind==='merra2_monthly') {
        if(now.getUTCDate()<=21)monthStart.setUTCMonth(monthStart.getUTCMonth()-1);
        markRecent(new Date(+monthStart-86400000).toISOString().slice(0,10),'MERRA-2 is normally released by month about three weeks after month end.');
      } else if (policy.kind==='mcd64a1_monthly') markRecent(new Date(+monthStart-86400000).toISOString().slice(0,10),'The current monthly burned-area product needs a published-file check.');
    }
    if (!timeExcluded && period.intervals.some(i=>!i.end) && !knownThrough && !policy && !period.access_route_end && !period.index_reference) {
      const days=period.recent_window_days;
      if (!Number.isInteger(days)||days<1||days>366) {uncertain=true;checkLabel=checkLabel||'Check screening metadata';decisions.push('The archive has no checked endpoint and its recent-date reminder policy is missing.');}
      else {
        const reminderStart=new Date(Date.parse(today+'T00:00:00Z')-(days-1)*86400000).toISOString().slice(0,10);
        if(query.end>=reminderStart){uncheckedFrom=reminderStart;uncertain=true;checkLabel=checkLabel||'Latest dates unchecked';if(temporal==='Dates fit')temporal='Recent dates require file lookup';
          decisions.push('No checked archive endpoint is available. Requested dates overlap the '+days+'-day reminder window beginning '+reminderStart+'. This is an application reminder, not a provider latency estimate or proof that older files exist. Inspect current files or station/event records.');}
        else reasons.push('Archive endpoint not verified. Historical dates are screened against the documented interval only; individual files and observations still require checking.');
      }
    }
    if (period.note) reasons.push(period.note);
    if (rule.note) reasons.push(rule.note);
    let status='possible', label='Dates and area fit';
    if (spatialExcluded || timeExcluded) {status='excluded';label=spatialExcluded&&timeExcluded?'Outside area and dates':spatialExcluded?'Outside documented area':'Outside documented dates';}
    else if (period.kind==='scenario') {status='special';label=period.return_period_years ? period.return_period_years+'-year scenario' : period.frequency_estimate ? 'Choose duration and probability' : 'Choose a scenario';}
    else if (uncertainOnly) {status='unresolved';label='Check documented dates';}
    else if (rule.support_type==='station') {status='unresolved';label='Find a station';temporal='Check each station and variable period';}
    else if (product.product_id==='c3s_lake_water_level') {status='unresolved';label='Choose a monitored lake';}
    else if (['event','track','acquisition'].includes(rule.support_type)) {status=rule.support_type==='acquisition'?'unresolved':'event';label=rule.support_type==='acquisition'?'Find a satellite pass':'Find an event';}
    else if (recent) {status='unresolved';label=query.start<=confirmedThrough?'Latest dates unchecked':'Check recent files';}
    else if (uncertain || period.kind==='unknown' || !period.intervals.length) {status='unresolved';label=checkLabel||'Check documented dates';}
    else if (partial) label=areaPartial&&datesPartial?'Part of area and dates fit':areaPartial?'Part of area fits':'Part of dates fit';
    let monthlyEvidence = {};
    if (period.solution_calendar) {
      const firstMonth = query.start.slice(0,7), lastMonth = query.end.slice(0,7);
      const solutions = period.solution_calendar.filter(s => s.month >= firstMonth && s.month <= lastMonth);
      const adjacent = period.solution_calendar.filter(s => (s.month < firstMonth || s.month > lastMonth) &&
        s.samplingStart && s.samplingEnd && s.samplingStart <= query.end && s.samplingEnd >= query.start);
      monthlyEvidence = {temporalResolution:'monthly_solution', monthlySolutions:solutions, adjacentSamplingWindows:adjacent};
      if (status === 'possible' && !partial) label = solutions.length === 1 ? 'Monthly solution documented' : 'Monthly solutions documented';
      if (!recent) temporal = solutions.length ? 'Monthly solutions overlap the project' : 'No nominal monthly solution in the requested period';
      if (solutions.length) {
        const first = solutions[0];
        const detail = solutions.length === 1 ? ' Its timestamp is '+first.timestamp+'. '+
          (first.samplingStart ? 'JPL lists sampling bounds '+first.samplingStart+' to '+first.samplingEnd+'.' : 'The processing-day table has no sampling bounds for this month.') : '';
        decisions.unshift(solutions.length+' nominal monthly solution'+(solutions.length===1?'':'s')+' in the requested months.'+detail+' These estimates integrate irregular sampling over time.');
      } else if (!recent) decisions.unshift('JPL lists no nominal monthly solution for the requested period.');
      if (adjacent.length) decisions.push('The processing window for a neighboring monthly solution overlaps the requested dates. Its nominal month is '+adjacent.map(s=>s.month).join(', ')+'. Individual days may be missing.');
    } else if (status==='possible') reasons.unshift(partial?'The documented dates and footprint overlap part of this request. Data presence still needs checking.':'Inside the documented dates and extent; data presence has not been checked.');
    const notices=[datesPartial?'Part of dates fit':'',areaPartial?'Part of area fits':'',recent?(query.start<=confirmedThrough?'Latest dates unchecked':'Check recent files'):'',checkLabel].filter(text=>text&&text!==label);
    const resolution=spatialExcluded||timeExcluded?[]:resolutionChecks(product,rule,query);
    if(resolution.length){
      // Preserve documented date coverage and any lookup action independently
      // of whether the product can resolve the requested time and footprint.
      if(label==='Dates and area fit')label=resolution[0].label;
      notices.push(...resolution.map(c=>c.label).filter(value=>value!==label));
      reasons.unshift(...resolution.map(c=>c.detail));
    }
    const event=rule.shortlist_event;
    let eventStudyMatch=false;
    if(event&&status==='event'&&period.intervals.some(interval=>covers(query,interval))&&overlaps(query,event)){
      const turf=root.turf||(typeof require==='function'?require('../vendor/turf.min.js'):null);
      if(query.mode!=='area')eventStudyMatch=geometry.classify({mode:'area',geometry:event.studyFootprint,bufferKm:0},query).included;
      else if(turf)eventStudyMatch=preparedPolygons(query).every(part=>turf.booleanWithin(turf.feature(part),turf.feature(event.studyFootprint)));
    }
    return {status,label,reasons:[...decisions,...reasons],spatial,spatialRelation,temporal,partial,confirmedThrough,uncheckedFrom,notices,resolutionChecks:resolution,temporalSegments:temporalSegments(period,localRegions,query,confirmedThrough,uncheckedFrom),...monthlyEvidence,...(eventStudyMatch?{eventStudyMatch:true}:{}),...(networkInScope===undefined?{}:{networkInScope}),landCheck:landResult};
  }
  function evaluateAll(products, rules, query, today = new Date().toISOString().slice(0, 10)) {
    let normalized=query;
    if (query?.mode === 'area') {
      try {normalized={...query,geometry:geometry.normalize(query.geometry)};}
      catch(error) {return products.map(product=>({productId:product.product_id,status:'unresolved',label:'Check inputs',reasons:[error.message],spatial:'Not evaluated',spatialRelation:'unknown',temporal:'Not evaluated'}));}
    }
    return products.map((product) => ({...evaluate(product, rules && rules[product.product_id], normalized, today), productId: product.product_id}));
  }
  const api = Object.freeze({validate, evaluate, evaluateAll, deriveIndexSnapshot});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SiteScreening = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
