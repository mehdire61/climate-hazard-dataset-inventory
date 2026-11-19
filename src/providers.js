/* Provider adapters preserve raw responses. GHCN station-file units are decoded explicitly. */
(function (root) {
  'use strict';
  const supported = ['ghcn_daily', 'noaa_coops_water_level', 'usgs_streamflow'];
  const ghcnElements = ['TMAX', 'TMIN', 'PRCP', 'SNOW', 'MDPR', 'DAPR', 'MDSF', 'DASF'];
  // GHCN-Daily readme section IV defines position three as the station numbering system.
  const ghcnNetworks = {'1':'CoCoRaHS', C:'U.S. COOP', W:'WBAN', E:'ECA&D', M:'WMO', N:'National met/hydrology center', P:'Pre-COOP', R:'RAWS', S:'SNOTEL', '0':'Unspecified'};
  function ghcnNetwork(id) {
    const code = /^[A-Z]{2}[A-Z0-9]{9}$/.test(id) ? id[2] : '';
    return {networkCode:code, networkLabel:ghcnNetworks[code] || (code ? 'Unclassified '+code+' ID' : 'Unclassified ID')};
  }
  const DAY = 86400000;
  const PAGE_BUDGET = 5;
  const NAME_BATCH_SIZE = 50;
  const COOPS_TYPES = ['historicwl', 'waterlevels'];
  let stationIndex, locationIndex;
  function stationReference() {
    if (!stationIndex) stationIndex=root.InventoryApp?.data?.stationReference || (typeof require==='function'?require('../data/station-reference.json'):{elevationsM:{},locationChecks:[]});
    return stationIndex;
  }
  function nearbyLocationConflicts(query) {
    const envelopes=boxes(query);
    return stationReference().locationChecks.map(group=>({...group,stations:group.stations.filter(s=>envelopes.some(b=>s.lon>=b[0]&&s.lon<=b[2]&&s.lat>=b[1]&&s.lat<=b[3])&&geometry().classify(query,s).included)})).filter(group=>group.stations.length);
  }
  const ENDPOINTS = {
    ghcnSearch: 'https://www.ncei.noaa.gov/access/services/search/v1/data',
    ghcnData: 'https://www.ncei.noaa.gov/access/services/data/v1',
    coopsStations: 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json',
    coopsData: 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter',
    usgsSeries: 'https://api.waterdata.usgs.gov/ogcapi/v1/collections/time-series-metadata/items',
    usgsStations: 'https://api.waterdata.usgs.gov/ogcapi/v1/collections/monitoring-locations/items',
    usgsData: 'https://api.waterdata.usgs.gov/ogcapi/v1/collections/daily/items'
  };
  const DOCS = {
    ghcn_daily: ['https://www.ncei.noaa.gov/access/search/documentation/data-service/', 'https://www.ncei.noaa.gov/pub/data/ghcn/daily/readme.txt'],
    noaa_coops_water_level: ['https://api.tidesandcurrents.noaa.gov/api/prod/', 'https://api.tidesandcurrents.noaa.gov/api/dev/responseHelp.html'],
    usgs_streamflow: ['https://api.waterdata.usgs.gov/docs/ogcapi/', 'https://api.waterdata.usgs.gov/docs/ogcapi/keys/']
  };
  function fail(message, code) { const e = new Error(message); e.code = code || 'PROVIDER_ERROR'; throw e; }
  function dateValid(s) {
    if (typeof s !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return Number.isFinite(+d) && d.toISOString().slice(0, 10) === s;
  }
  function validate(productId, query) {
    if (!supported.includes(productId)) fail('This record has no live station adapter in this inventory.', 'UNSUPPORTED');
    const geometryErrors = geometry().validate(query);
    if (geometryErrors.length) fail(geometryErrors.join(' '), 'INPUT');
    if (!dateValid(query.start) || !dateValid(query.end) || query.start > query.end) fail('Enter valid inclusive dates, with the start on or before the end.', 'INPUT');
    if (query.end > new Date().toISOString().slice(0, 10)) fail('Historical previews cannot request dates after today (UTC).', 'INPUT');
  }
  function coopsAvailability() {
    if (root.SiteCoopsAvailability) return root.SiteCoopsAvailability;
    if (typeof module !== 'undefined' && module.exports) return require('./coops-availability.js');
    fail('CO-OPS availability support is unavailable. Reload the inventory.', 'INPUT');
  }
  function checkCoopsStations(stations, query, options = {}) {validate('noaa_coops_water_level',query); return coopsAvailability().checkCoopsStations(stations,query,options);}
  function assessCoopsStation(station, query, datum) {return coopsAvailability().assessCoopsStation(station,query,datum);}
  function previewWindow(productId, q, station, options = {}) {
    if (!supported.includes(productId)) fail('This record has no live station adapter in this inventory.', 'UNSUPPORTED');
    if (!q || !dateValid(q.start) || !dateValid(q.end) || q.start > q.end) fail('Enter valid inclusive dates, with the start on or before the end.', 'INPUT');
    if (productId === 'noaa_coops_water_level' && station?.coopsAvailability) return coopsAvailability().previewWindow(station,q,options);
    const days = productId === 'noaa_coops_water_level' ? 28 : 31;
    const bounds = item => {
      const start = metadataDate(item?.start), end = metadataDate(item?.end);
      if (start && end && start > end) fail('Station or element metadata has a reversed period; no preview was prepared.', 'SCHEMA');
      return {start, end};
    };
    const envelope = bounds(station), notes = [];
    let entries = [], basis = station ? 'station_metadata' : 'project_dates';
    if (productId === 'ghcn_daily' && Array.isArray(station?.variables)) {
      entries = station.variables.filter(v => v && ghcnElements.includes(v.key));
      if (entries.length) basis = 'element_metadata';
    } else if (productId === 'usgs_streamflow' && Array.isArray(station?.seriesMetadata) && station.seriesMetadata.length) {
      entries = station.seriesMetadata; basis = 'series_metadata';
    }
    if (!entries.length) entries = [envelope];
    let unknown = false;
    const intervals = entries.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('Station element/series metadata contains an invalid record.', 'SCHEMA');
      const b = bounds(item);
      if (!b.start || !b.end) unknown = true;
      return {start: [q.start, envelope.start, b.start].filter(Boolean).sort().at(-1), end: [q.end, envelope.end, b.end].filter(Boolean).sort()[0]};
    }).filter(b => b.start <= b.end).sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end));
    const metadata = {available: !!intervals.length, requestedStart: q.start, requestedEnd: q.end, maxDays: days, shifted: false, basis, coverageStatus: unknown ? 'unknown_boundaries' : 'nominal_overlap', notes};
    if (!intervals.length) {
      notes.push('The requested period has no overlap with the supplied station or relevant element/series periods. No preview request was prepared; this does not establish absence of the hazard.');
      return {start: null, end: null, ...metadata, coverageStatus: 'no_overlap'};
    }
    const first = {...intervals[0]};
    for (const interval of intervals.slice(1)) {
      if (Date.parse(interval.start + 'T00:00:00Z') > Date.parse(first.end + 'T00:00:00Z') + DAY) break;
      if (interval.end > first.end) first.end = interval.end;
    }
    const end = new Date(Math.min(Date.parse(first.end + 'T00:00:00Z'), Date.parse(first.start + 'T00:00:00Z') + (days - 1) * DAY)).toISOString().slice(0, 10);
    metadata.shifted = first.start !== q.start;
    if (metadata.shifted) notes.push(`Preview starts ${first.start}, shifted from project start ${q.start} to intersect the supplied ${basis === 'element_metadata' ? 'requested-element' : basis === 'series_metadata' ? 'daily-mean discharge series' : 'station'} period metadata.`);
    if (unknown) notes.push('Some period boundaries are unknown. The preview uses available metadata bounds; actual observations are not guaranteed.');
    return {start: first.start, end, ...metadata};
  }
  function coopsDatum(station, query, options = {}) {
    if (station.greatlakes !== undefined && station.greatlakes !== null && typeof station.greatlakes !== 'boolean') fail('CO-OPS Great Lakes metadata must be a boolean before selecting a datum.', 'SCHEMA');
    if (station.coopsAvailability && query) {
      const availability = assessCoopsStation(station,query);
      if (['match','partial'].includes(availability.state) && availability.selectedDatum) return availability.selectedDatum;
      if (options.allowUnverified === true && availability.canTryPreview && availability.tryDatum) return availability.tryDatum;
      fail(availability.message, availability.state === 'datum_required' ? 'DATUM_REQUIRED' : 'AVAILABILITY_UNRESOLVED');
    }
    return station.greatlakes === true ? 'IGLD' : 'MSL';
  }
  function url(base, params) { const u = new URL(base); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v)); return u.href; }
  function numeric(v) {
    if (v === null || v === undefined || typeof v === 'boolean' || String(v).trim() === '') return null;
    if (typeof v !== 'number' && (typeof v !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v.trim()))) return null;
    const n = Number(v); return Number.isFinite(n) ? n : null;
  }
  function distance(a, b) {
    const rad = Math.PI / 180, p = (b.lat - a.lat) * rad, l = (b.lon - a.lon) * rad;
    const h = Math.sin(p / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(l / 2) ** 2;
    return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
  }
  let geometryApi;
  function geometry() {
    if (root.SiteGeometry) return root.SiteGeometry;
    if (!geometryApi && typeof module !== 'undefined' && module.exports) geometryApi = require('./geometry.js');
    if (!geometryApi) fail('Project geometry support is not loaded. Reload the inventory.', 'INPUT');
    return geometryApi;
  }
  function boxes(q) { return geometry().searchBoxes(q); }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  async function fingerprint(value) {
    const text = canonical(value);
    if (!root.crypto?.subtle) return text;
    const hash = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function checkedURL(value, expectedBase) {
    const u = new URL(value), base = new URL(expectedBase);
    if (u.protocol !== 'https:' || u.origin !== base.origin || u.username || u.password || !(u.pathname === base.pathname || (expectedBase === ENDPOINTS.usgsStations && u.pathname.startsWith(base.pathname + '/')))) fail('Provider supplied an unexpected pagination URL; lookup stopped.', 'SCHEMA');
    return u.href;
  }
  async function stationFileBytes(response) {
    const limit = 8 * 1024 * 1024;
    const tooLarge = () => fail('The full station file exceeds the 8 MiB preview limit. Open the NOAA station file to inspect it directly.', 'STATION_FILE_LIMIT');
    if (Number(response.headers.get('content-length')) > limit) {await response.body?.cancel(); tooLarge();}
    const reader = response.body?.getReader();
    if (!reader) fail('The browser could not read the NOAA station file.', 'STATION_FILE_READ');
    const chunks = [];
    let length = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {await reader.cancel(); tooLarge();}
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
    return bytes;
  }
  async function request(requestUrl, expectedBase, options, receipts, stationFile = false) {
    checkedURL(requestUrl, expectedBase);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal && options.signal.aborted) { const e = new Error('Request cancelled.'); e.name = 'AbortError'; throw e; }
    if (options.signal) options.signal.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs || 25000);
    try {
      const response = await (options.fetchImpl || root.fetch)(requestUrl, { signal: controller.signal, credentials: 'omit', redirect: 'error', headers: { Accept: stationFile ? 'text/plain' : 'application/json' } });
      if (!response.ok) {
        let detail = '';
        try {
          const body = JSON.parse(await response.text());
          const reason = body?.error?.message || body?.error || body?.errorMessage || body?.description;
          if (typeof reason === 'string') detail = reason.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 240);
        } catch (_) { /* An unreadable error body must not hide the HTTP status. */ }
        const message = response.status === 429 ? 'Provider rate limit reached (HTTP 429). Wait and retry, or use the provider website.' : `Provider request failed (HTTP ${response.status}).`;
        fail(message + (detail ? ' Provider response: ' + detail : response.status === 429 ? '' : ' Try again or open the provider request.'), 'HTTP_' + response.status);
      }
      const rawBytes=stationFile?await stationFileBytes(response):typeof response.arrayBuffer==='function'?new Uint8Array(await response.arrayBuffer()):new TextEncoder().encode(await response.text());
      let rawText;
      try {rawText=new TextDecoder('utf-8',{fatal:true}).decode(rawBytes);} catch (_) {fail('Provider response contains invalid UTF-8. No observations were accepted or silently repaired.','SCHEMA');}
      const receipt = { url: requestUrl, retrievedAt: new Date().toISOString(), httpStatus: response.status, contentType: response.headers.get('content-type') || (stationFile ? 'text/plain' : 'application/json') };
      if (stationFile) {receipts.push(receipt); return {rawText, rawBytes, receipt};}
      let data;
      try { data = JSON.parse(rawText); } catch (_) { fail('Provider returned an unreadable response instead of JSON. No data were accepted.', 'SCHEMA'); }
      if (!data || typeof data !== 'object') fail('Provider returned an unexpected response. No data were accepted.', 'SCHEMA');
      if (data.error || data.errorMessage || data.code === 'InvalidParameterValue' || data.type === 'error') {
        const message = String(data.error?.message || data.error || data.errorMessage || data.description || 'Request rejected').replace(/[\u0000-\u001f]/g, ' ').slice(0, 240);
        const noData = /^no data(?:(?: (?:was|were))? found|(?: (?:is|are))? available)?[.!]?(?:\s+This product may not be offered at this station at the requested time\.?)?$/i.test(message.trim());
        if (noData) receipts.push(receipt);
        fail('Provider response: ' + message, noData ? 'NO_DATA' : 'PROVIDER_ERROR');
      }
      receipts.push(receipt);
      return { data, rawText, rawBytes, receipt };
    } catch (e) {
      if (timedOut) fail('Provider timed out after ' + Math.round((options.timeoutMs || 25000) / 1000) + ' seconds. No data were accepted.', 'TIMEOUT');
      if (e.name === 'AbortError') throw e;
      if (options.signal?.aborted) { const cancelled = new Error('Request cancelled.'); cancelled.name = 'AbortError'; throw cancelled; }
      if (e.code) throw e;
      fail('Could not reach the provider. Check the connection or try the provider request directly; browser access may be restricted.', 'NETWORK');
    } finally {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', abort);
    }
  }
  function coordinates(c) { return Array.isArray(c) && numeric(c[0]) !== null && numeric(c[1]) !== null && Math.abs(Number(c[0])) <= 180 && Math.abs(Number(c[1])) <= 90; }
  function mergeStations(stations) {
    const unique = new Map();
    for (const item of stations) {
      const previous = unique.get(item.id);
      if (!previous) unique.set(item.id, { ...item });
      else {
        if (item.start && (!previous.start || item.start < previous.start)) previous.start = item.start;
        if (item.end && (!previous.end || item.end > previous.end)) previous.end = item.end;
        for (const field of ['variables', 'seriesMetadata', 'listTypes']) {
          if (item[field]) previous[field] = [...new Map([...(previous[field] || []), ...item[field]].map(v => [canonical(v), v])).values()];
        }
      }
    }
    for (const station of unique.values()) if (station.seriesMetadata) station.dailyRecordUndated=station.seriesMetadata.every(s=>!s.start&&!s.end);
    return [...unique.values()].sort((a, b) => Number(a.dailyRecordUndated===true)-Number(b.dailyRecordUndated===true) || Number(b.relation === 'inside') - Number(a.relation === 'inside') || a.distanceKm - b.distanceKm || a.id.localeCompare(b.id));
  }
  async function choose(stations, q, options) {
    const accepted = [], envelopes = boxes(q);
    const inLongitude = (lon, b) => lon >= b[0] - 1e-7 && lon <= b[2] + 1e-7;
    for (let i = 0; i < stations.length; i++) {
      if (i % 128 === 0) {
        if (i) await new Promise(resolve => setTimeout(resolve, 0));
        if (options.signal?.aborted) { const e = new Error('Station lookup cancelled.'); e.name = 'AbortError'; throw e; }
      }
      const s = stations[i];
      if (!coordinates([s.lon, s.lat]) || !s.id) continue;
      // CO-OPS provides a global list; reject distant envelope misses before exact edge-distance work.
      if (!envelopes.some(b => s.lat >= b[1] - 1e-7 && s.lat <= b[3] + 1e-7 && (inLongitude(s.lon, b) || Math.abs(s.lon) === 180 && inLongitude(-s.lon, b)))) continue;
      const match = geometry().classify(q, s);
      if (match.included) accepted.push({ ...s, relation: match.relation, distanceKm: match.distanceKm });
    }
    return mergeStations(accepted);
  }
  function periodOverlap(start, end, q) { return (!start || start.slice(0, 10) <= q.end) && (!end || end.slice(0, 10) >= q.start); }
  function metadataDate(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !dateValid(value.slice(0, 10))) fail('Provider station metadata contains an invalid period date; lookup is incomplete.', 'SCHEMA');
    return value.slice(0, 10);
  }
  function initialState(productId, queryKey) { return { version: 3, productId, queryKey, boxIndex: 0, offset: 0, token: null, seenTokens: [], seenRecords: [], expectedCount: null, splitPaths: [], countMayBeCapped: false, searchedRecordsTotal: 0, unlocatedRecordsTotal: 0, malformedRecordsTotal: 0 }; }
  function splitTile(tile) {
    const [w,s,e,n] = tile.box, x = (w+e)/2, y = (s+n)/2;
    return [[w,s,x,y],[x,s,e,y],[w,y,x,n],[x,y,e,n]].map((box,i) => ({box,path:tile.path+i}));
  }
  function searchTiles(searchBoxes, splitPaths, productId) {
    const tiles = searchBoxes.map((box,i) => ({box,path:i+':'}));
    if (!Array.isArray(splitPaths) || splitPaths.length > 85 || productId !== 'ghcn_daily' && splitPaths.length) fail('Invalid search subdivision cursor.', 'CURSOR');
    for (const path of splitPaths) {
      const index = tiles.findIndex(tile => tile.path === path);
      if (typeof path !== 'string' || index < 0 || path.split(':')[1].length >= 8) fail('Invalid search subdivision cursor.', 'CURSOR');
      tiles.splice(index,1,...splitTile(tiles[index]));
    }
    return tiles;
  }
  function readState(cursor, productId, queryKey, searchBoxes) {
    if (!cursor) return initialState(productId, queryKey);
    const s = copy(cursor);
    const tiles = searchTiles(searchBoxes,s.splitPaths,productId);
    if (s.version !== 3 || s.productId !== productId || s.queryKey !== queryKey ||
      !Number.isInteger(s.boxIndex) || s.boxIndex < 0 || s.boxIndex >= tiles.length ||
      !Number.isSafeInteger(s.offset) || s.offset < 0 || !Number.isSafeInteger(s.searchedRecordsTotal) || s.searchedRecordsTotal < 0 ||
      !Number.isSafeInteger(s.unlocatedRecordsTotal) || s.unlocatedRecordsTotal < 0 ||
      !Number.isSafeInteger(s.malformedRecordsTotal) || s.malformedRecordsTotal < 0 ||
      typeof s.countMayBeCapped !== 'boolean' ||
      !(s.token === null || typeof s.token === 'string' && s.token.length > 0 && s.token.length <= 8192 && !/[\u0000-\u001f]/.test(s.token)) ||
      !Array.isArray(s.seenTokens) || !s.seenTokens.every(t => typeof t === 'string') ||
      !Array.isArray(s.seenRecords) || !s.seenRecords.every(t => typeof t === 'string') ||
      new Set(s.seenRecords).size !== s.seenRecords.length || s.seenRecords.length !== s.offset ||
      !(s.expectedCount === null ? s.offset === 0 : Number.isSafeInteger(s.expectedCount) && s.expectedCount >= s.offset)) fail('The continuation belongs to a different query/provider or is invalid. Start a new station lookup.', 'CURSOR');
    return s;
  }
  function advanceBox(state) { state.boxIndex++; state.offset = 0; state.token = null; state.seenRecords = []; state.expectedCount = null; }
  function ghcnCandidates(data) {
    if (!Array.isArray(data.results) || !Number.isSafeInteger(data.count) || data.count < 0) fail('NCEI station-search response changed; results could not be interpreted.', 'SCHEMA');
    const stations = []; let unlocatedRecords = 0, malformedRecords = 0;
    for (const item of data.results) {
      // A stable record identity is still required to detect missing/repeated pages.
      if (!item || typeof item.id !== 'string' || !item.id.trim()) fail('NCEI returned malformed station metadata or a missing record identity.', 'SCHEMA');
      if (!Array.isArray(item.stations) || !item.stations.length) {malformedRecords++; continue;}
      const c = item.location?.coordinates || item.centroid;
      if (!coordinates(c)) { unlocatedRecords++; continue; }
      for (const s of item.stations) {
        try {
        if (!s || !/^[A-Za-z0-9_]{11}$/.test(s.id) || !Array.isArray(s.dataTypes)) fail('NCEI returned malformed station/element metadata.', 'SCHEMA');
        const variables = s.dataTypes.filter(d => d && ghcnElements.includes(d.id)).map(d => ({ key: d.id, start: metadataDate(d.startDate), end: metadataDate(d.endDate), providerRecordCoveragePercent: numeric(d.coverage) }));
        const start = metadataDate(item.startDate), end = metadataDate(item.endDate);
        if (start && end && start > end || variables.some(v => v.start && v.end && v.start > v.end)) fail('Reversed station/element period.', 'SCHEMA');
        stations.push({ id: s.id, name: s.name || s.id, lat: Number(c[1]), lon: Number(c[0]), start, end, variables, note: 'Station record spans can include gaps.' });
        } catch (error) {if (error.code !== 'SCHEMA') throw error; malformedRecords++;}
      }
    }
    for (const station of stations) {
      Object.assign(station, ghcnNetwork(station.id));
      const conflict=knownLocationConflict(station);if(conflict) station.locationConflict=conflict;
      station.elevationM=stationReference().elevationsM[station.id]??null;
      if(station.elevationM!==null)station.elevationSource={url:stationReference().source.url,checkedAt:stationReference().source.checkedAt,sha256:stationReference().source.sha256};
      if (station.id === 'US1TXHRR204' && station.elevationM === 1035.7 && Math.abs(station.lat-29.9172)<0.0002 && Math.abs(station.lon+95.5617)<0.0002) {
        station.elevationNote = 'NOAA lists 1,035.7 m. USGS terrain at the listed coordinates is about 35 m. Confirm the station elevation before use.';
        station.elevationCheckUrl = 'https://epqs.nationalmap.gov/v1/json?x=-95.5617&y=29.9172&wkid=4326&units=Meters&includeDate=true';
      }
    }
    return { stations, unlocatedRecords, malformedRecords };
  }
  function validateUSGSCollection(data) {
    if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features) || !Array.isArray(data.links))
      fail('Expected a USGS FeatureCollection with features and links arrays; completeness is unresolved.', 'SCHEMA');
    if (Object.hasOwn(data, 'numberReturned') && (!Number.isSafeInteger(data.numberReturned) || data.numberReturned !== data.features.length))
      fail('USGS numberReturned differs from the feature count.', 'SCHEMA');
    if (data.features.some(f => !f || typeof f !== 'object' || Array.isArray(f)) ||
        data.links.some(l => !l || typeof l.rel !== 'string' || typeof l.href !== 'string' || !l.href))
      fail('USGS returned an invalid feature or pagination link.', 'SCHEMA');
    if (data.links.filter(l => l.rel === 'next').length > 1) fail('USGS returned ambiguous continuation links.', 'PAGINATION');
  }
  function knownLocationConflict(station) {
    if (station.id !== 'UKE00107650') {
      if (!locationIndex) locationIndex=new Map(stationReference().locationChecks.flatMap(group=>group.stations.map(s=>[s.id,group])));
      const group=locationIndex.get(station.id);if(!group)return null;
      return {stationId:station.id,providerCoordinates:{lat:station.lat,lon:station.lon},relatedRecords:group.stations,
        checkedOn:stationReference().source.checkedAt.slice(0,10),effectivePeriod:null,source:stationReference().source.url,
        message:`Possible coordinate sign conflict: ${group.name} has same-country, similar-elevation records that nearly coincide after a latitude or longitude sign flip. Check the station history and related IDs. Provider coordinates are unchanged; neither location is assumed correct.`};
    }
    return {stationId:station.id,providerCoordinates:{lat:station.lat,lon:station.lon},
      alternativeCoordinates:{lat:51.479,lon:-0.449},checkedOn:'2026-11-14',effectivePeriod:null,
      source:'https://www.metoffice.gov.uk/pub/data/weather/uk/climate/stationdata/heathrowdata.txt',
      message:'Known Heathrow coordinate conflict: NCEI reported longitude +0.4489; the Met Office lists -0.449 (about 62 km apart). Provider coordinates are preserved. Distance and spatial inclusion need review; the applicable station-history period is not established.'};
  }
  function usgsCandidates(data) {
    validateUSGSCollection(data);
    const stations = []; let unlocatedRecords = 0;
    for (const f of data.features) {
      if (!f || !f.properties) fail('USGS returned malformed time-series metadata.', 'SCHEMA');
      const p = f.properties, c = f.geometry?.coordinates;
      if (p.parameter_code !== '00060' || p.statistic_id !== '00003' || !/^USGS-\d{8,15}$/.test(p.monitoring_location_id)) continue;
      if (!coordinates(c)) { unlocatedRecords++; continue; }
      const start = metadataDate(p.begin), end = metadataDate(p.end);
      stations.push({ id: p.monitoring_location_id, name: p.monitoring_location_id, lat: Number(c[1]), lon: Number(c[0]), start, end, seriesMetadata: [{ id: p.id || f.id || null, start: p.begin || null, end: p.end || null, unit: p.unit_of_measure || null, primary: p.primary || null }], note: start && end ? '' : 'Incomplete USGS record dates. Check the series for overlap.' });
    }
    return { stations, unlocatedRecords };
  }
  function enrichStation(station, p) {
    const name=p.monitoring_location_name || station.id;
    return { ...station, name, siteType: p.site_type, drainageArea: p.drainage_area, hydrologicUnitCode: p.hydrologic_unit_code, timeZone: p.time_zone_abbreviation, adjustedRecord:/\bADJUSTED\b/i.test(name) };
  }
  async function describeStation(productId, station, options = {}) {
    const requests = [];
    if (productId !== 'usgs_streamflow') return { station: { ...station }, requests, notes: [] };
    if (!station || !/^USGS-\d{8,15}$/.test(station.id)) fail('A valid USGS station identifier is required.', 'INPUT');
    const r = await request(url(ENDPOINTS.usgsStations + '/' + station.id, { f: 'json' }), ENDPOINTS.usgsStations, options, requests);
    if (r.data.properties?.id !== station.id) fail('USGS returned unexpected station metadata.', 'SCHEMA');
    return { station: { ...enrichStation(station, r.data.properties), metadataRequests: requests }, requests, notes: [] };
  }
  async function enrichBatch(stations, options, requests, notes) {
    const selected = stations.filter(s => s.name === s.id).slice(0, NAME_BATCH_SIZE);
    if (!selected.length || options.signal?.aborted) return;
    try {
      const filter = 'id IN (' + selected.map(s => "'" + s.id + "'").join(',') + ')';
      const r = await request(url(ENDPOINTS.usgsStations, { f: 'json', filter, 'filter-lang': 'cql2-text', limit: NAME_BATCH_SIZE }), ENDPOINTS.usgsStations, options, requests);
      if (!Array.isArray(r.data.features)) fail('USGS returned unexpected station metadata.', 'SCHEMA');
      const names = new Map(r.data.features.filter(f => f && f.properties).map(f => [f.properties.id, f.properties]));
      for (const s of stations) if (names.has(s.id)) Object.assign(s, enrichStation(s, names.get(s.id)));
    } catch (e) {
      notes.push('Station-name enrichment did not complete: ' + e.message + ' All located candidate IDs have been retained.');
    }
    if (stations.some(s => s.name === s.id)) notes.push('Some candidates are identified by station ID. Names/details can be loaded for a selected station; no candidates were removed to limit name requests.');
  }
  async function describeStations(productId, stations, options = {}) {
    if (productId !== 'usgs_streamflow' || !Array.isArray(stations) || stations.length > NAME_BATCH_SIZE || stations.some(s => !/^USGS-\d{8,15}$/.test(s.id))) fail('Choose up to 50 USGS stations for a detail check.', 'INPUT');
    const result = {stations: copy(stations), requests: [], notes: []};
    await enrichBatch(result.stations, options, result.requests, result.notes);
    return result;
  }
  const discoveryNotes = {
    ghcn_daily: ['Candidates include stations whose temperature, precipitation, snowfall or multi-day amount or duration metadata could overlap the project. Retrieve observations to check the amounts, flags and reporting intervals.', 'Nearby climate stations may differ in elevation, exposure, observation time and representativeness.'],
    noaa_coops_water_level: ['Both active and historical water-level station lists are searched and deduplicated; active IDs can be absent from the historical list. Listing does not establish observations during your dates.', 'Preview requests IGLD for stations marked Great Lakes by NOAA metadata, otherwise MSL; metres, UTC. The exact datum is retained with the response. Datum availability, reference epoch and hydrologic setting require review.'],
    usgs_streamflow: ['Search is restricted to USGS daily mean discharge (parameter 00060, statistic 00003) with metadata period overlap.', 'Polygon membership or distance does not establish hydrologic connectivity or catchment suitability. Daily means do not represent instantaneous flood peaks. Anonymous API requests can be rate limited.']
  };
  async function discover(productId, submittedQuery, options = {}) {
    validate(productId, submittedQuery);
    const query = copy(submittedQuery);
    if (query.mode === 'area') query.geometry = geometry().normalize(query.geometry);
    const queryKey = await fingerprint({ productId, query });
    const searchBoxes = productId === 'noaa_coops_water_level' ? COOPS_TYPES.map(() => [-180, -90, 180, 90]) : boxes(query);
    const state = readState(options.cursor, productId, queryKey, searchBoxes);
    const tiles = searchTiles(searchBoxes,state.splitPaths,productId);
    const budget = options.pageBudget === undefined ? PAGE_BUDGET : options.pageBudget;
    if (!Number.isInteger(budget) || budget < 1 || budget > 20) fail('A station lookup batch must contain 1 to 20 provider pages.', 'INPUT');
    const requests = [], candidates = [], notes = [...discoveryNotes[productId]];
    let pagesAccepted = 0, searchedRecords = 0, unlocatedRecords = 0, error = null, cancelled = false;
    for (let page = 0; page < budget && state.boxIndex < tiles.length; page++) {
      const checkpoint = copy(state), tile = tiles[state.boxIndex], b = tile.box;
      try {
        if (productId === 'noaa_coops_water_level') {
          const type = COOPS_TYPES[state.boxIndex];
          const r = await request(url(ENDPOINTS.coopsStations, { type }), ENDPOINTS.coopsStations, options, requests);
          if (!Array.isArray(r.data.stations) || !Number.isSafeInteger(r.data.count) || r.data.count < 0) fail('CO-OPS station-list response changed; results could not be interpreted.', 'SCHEMA');
          const list = r.data.stations.map(s => {
            if (!s || !/^\d{7}$/.test(s.id)) fail('CO-OPS returned malformed station metadata.', 'SCHEMA');
            return { id: s.id, name: s.name || s.id, lat: numeric(s.lat), lon: numeric(s.lng), tidal: s.tidal, greatlakes: s.greatlakes, listTypes: [type], note: 'CO-OPS station metadata listing; availability during your dates has not yet been checked.' };
          });
          candidates.push(...await choose(list, query, options));
          const missing = list.filter(s => !coordinates([s.lon, s.lat])).length;
          unlocatedRecords += missing; state.unlocatedRecordsTotal += missing;
          pagesAccepted++; searchedRecords += list.length; state.searchedRecordsTotal += list.length;
          if (r.data.count !== r.data.stations.length) {
            error = { code: 'INCOMPLETE_LIST', message: 'CO-OPS returned a list length different from its reported count. Located candidates are retained; retry before treating the listing as complete.' };
            break;
          }
          advanceBox(state);
        } else if (productId === 'ghcn_daily') {
          const parameters = { dataset: 'daily-summaries', bbox: [b[3], b[0], b[1], b[2]].join(','), startDate: query.start, endDate: query.end, limit: 1000, offset: state.offset };
          let r = await request(url(ENDPOINTS.ghcnSearch, parameters), ENDPOINTS.ghcnSearch, options, requests);
          let parsed = ghcnCandidates(r.data);
          if (r.data.count < state.offset + r.data.results.length) fail('NCEI returned more metadata records than its reported count. Lookup remains incomplete.', 'PAGINATION');
          if (state.expectedCount !== null && r.data.count !== state.expectedCount) fail('NCEI changed its reported metadata count during pagination. Accepted earlier pages are retained; start a fresh lookup for the changed archive.', 'PAGINATION');
          if (r.data.count >= 10000 && state.offset === 0 && state.splitPaths.length < 85 && tile.path.split(':')[1].length < 8) {
            state.splitPaths.push(tile.path); tiles.splice(state.boxIndex,1,...splitTile(tile));
            pagesAccepted++; searchedRecords += r.data.results.length; state.searchedRecordsTotal += r.data.results.length;
            continue; // Discard the capped parent sample; classify only child-tile results.
          }
          let recordIds = r.data.results.map(x => canonical(x.id));
          const seen = new Set(state.seenRecords);
          if (new Set(recordIds).size !== recordIds.length) fail('NCEI repeated a metadata record within a page. Lookup remains incomplete.', 'PAGINATION');
          // Offset ordering is unstable for some broad searches. Reconcile one complete
          // same-query response, below the observed suspicious 10000-record window.
          // This is not a station cap: larger queries keep normal paging and its guards.
          if (recordIds.some(id => seen.has(id)) && state.expectedCount > 1000 && state.expectedCount < 10000) {
            r = await request(url(ENDPOINTS.ghcnSearch, { ...parameters, offset: 0, limit: state.expectedCount }), ENDPOINTS.ghcnSearch, options, requests);
            parsed = ghcnCandidates(r.data);
            recordIds = r.data.results.map(x => canonical(x.id));
            const reconciled = new Set(recordIds);
            if (r.data.count !== state.expectedCount || recordIds.length !== r.data.count || reconciled.size !== recordIds.length || state.seenRecords.some(id => !reconciled.has(id)))
              fail('NCEI overlapping pages could not be reconciled with a complete same-query response. Accepted candidates remain available; lookup is incomplete.', 'PAGINATION');
            seen.clear(); state.seenRecords = []; state.offset = 0;
            notes.push('NCEI returned overlapping offset pages. A complete single response for the same bounding box and dates reconciled the reported count, unique record IDs and all previously accepted IDs. Provider records examined include rereads; candidates are deduplicated.');
          }
          for (const id of recordIds) {
            if (seen.has(id)) fail('NCEI repeated a metadata record within or across pages. Located candidates are retained; lookup is incomplete.', 'PAGINATION');
            seen.add(id);
          }
          if (!r.data.results.length && state.offset < r.data.count) fail('NCEI returned an empty page before its reported result count. Lookup remains incomplete.', 'PAGINATION');
          const list = parsed.stations.filter(s => s.variables.some(v => periodOverlap(v.start, v.end, query)));
          candidates.push(...await choose(list, query, options));
          unlocatedRecords += parsed.unlocatedRecords; state.unlocatedRecordsTotal += parsed.unlocatedRecords;
          state.malformedRecordsTotal += parsed.malformedRecords;
          if (r.data.count >= 10000) state.countMayBeCapped = true;
          pagesAccepted++; searchedRecords += r.data.results.length; state.searchedRecordsTotal += r.data.results.length;
          state.seenRecords.push(...recordIds); state.expectedCount = r.data.count; state.offset += r.data.results.length;
          if (state.offset >= r.data.count || r.data.count >= 10000) advanceBox(state);
        } else {
          const params = { f: 'json', bbox: b.join(','), parameter_code: '00060', statistic_id: '00003', limit: 1000 };
          if (state.token) params.cursor = state.token;
          const currentUrl = url(ENDPOINTS.usgsSeries, params);
          const r = await request(currentUrl, ENDPOINTS.usgsSeries, options, requests);
          const parsed = usgsCandidates(r.data), list = parsed.stations.filter(s => periodOverlap(s.start, s.end, query));
          const nextLink = (r.data.links || []).find(l => l && l.rel === 'next')?.href;
          let nextToken = null;
          if (nextLink) {
            const next = new URL(checkedURL(nextLink, ENDPOINTS.usgsSeries));
            nextToken = next.searchParams.get('cursor');
            if (!nextToken || nextToken.length > 8192 || /[\u0000-\u001f]/.test(nextToken)) fail('USGS returned an invalid pagination cursor; lookup is incomplete.', 'PAGINATION');
            if (nextToken === state.token || state.seenTokens.includes(state.boxIndex + ':' + nextToken)) fail('USGS repeated a pagination cursor; lookup is incomplete.', 'PAGINATION');
          }
          if (!r.data.features.length && nextToken) fail('USGS returned an empty page with another page pending; lookup is incomplete.', 'PAGINATION');
          candidates.push(...await choose(list, query, options));
          unlocatedRecords += parsed.unlocatedRecords; state.unlocatedRecordsTotal += parsed.unlocatedRecords;
          pagesAccepted++; searchedRecords += r.data.features.length; state.searchedRecordsTotal += r.data.features.length;
          if (nextToken) { state.seenTokens.push(state.boxIndex + ':' + nextToken); state.token = nextToken; }
          else advanceBox(state);
        }
      } catch (e) {
        Object.assign(state, checkpoint);
        if (!pagesAccepted && !options.cursor) throw e;
        cancelled = e.name === 'AbortError'; error = { code: cancelled ? 'CANCELLED' : (e.code || 'PROVIDER_ERROR'), message: cancelled ? 'Station lookup cancelled. Accepted earlier pages are retained; continue to resume.' : e.message };
        break;
      }
    }
    const stations = mergeStations(candidates);
    if (productId === 'usgs_streamflow' && !error) await enrichBatch(stations, options, requests, notes);
    const continuation = state.boxIndex < tiles.length ? copy(state) : null;
    if (state.unlocatedRecordsTotal) notes.push(`${state.unlocatedRecordsTotal} provider metadata records lacked valid coordinates and could not be classified against the project. Spatial search completeness is unresolved even if all pages have been read.`);
    if (state.malformedRecordsTotal) notes.push(`${state.malformedRecordsTotal} malformed station/element entries were skipped. Valid candidates are retained; metadata completeness remains unresolved.`);
    if (state.splitPaths.length) notes.push(`Capped NCEI bounding boxes were subdivided ${state.splitPaths.length} time(s). Child boxes cover the original search envelope; exact project geometry still controls inclusion. Boundary stations are deduplicated. Counts include discarded parent responses and rereads.`);
    const complete = !continuation && !error && !state.unlocatedRecordsTotal && !state.malformedRecordsTotal && !state.countMayBeCapped;
    notes.unshift(query.mode === 'area' ? `Project polygon membership is checked against the exact submitted geometry. Area buffer: ${query.bufferKm ?? 0} km from polygon edges. Inside/on-boundary and nearby candidates are labeled separately.` : `Point search radius: ${query.radiusKm ?? 100} km. All returned candidates within that radius are retained; distance is not a suitability ranking.`);
    notes.push('There is no overall station-count cap. Each action reads a manageable batch of provider pages; continue while another page is available. Provider metadata rows read may include repeated station IDs across series, lists or boxes.');
    if (state.countMayBeCapped) notes.push('NCEI still reported at least 10000 records after bounded subdivision (at most 85 splits and 8 levels). Loaded candidates are a nonrepresentative partial result. Narrow the project area or date range; search completeness remains unresolved.');
    if (!complete && (error || continuation)) notes.push(error ? error.message : 'More provider pages remain. The loaded candidates are a partial search result, not a complete station census.');
    return { stations, requests, continuation, complete, paginationComplete: !continuation && !state.countMayBeCapped, countMayBeCapped: state.countMayBeCapped, subdivisions: state.splitPaths.length, malformedRecordsTotal: state.malformedRecordsTotal, truncated: !complete, cancelled, error, searchedRecords, searchedRecordsTotal: state.searchedRecordsTotal, unlocatedRecords, unlocatedRecordsTotal: state.unlocatedRecordsTotal, candidateCount: stations.length, radiusKm: query.mode === 'area' ? null : (query.radiusKm ?? 100), bufferKm: query.mode === 'area' ? (query.bufferKm ?? 0) : null, query, notes };
  }
  function sorted(points) { return points.sort((a, b) => a.time.localeCompare(b.time)); }
  function assertDate(date, w) { if (!dateValid(date) || date < w.start || date > w.end) fail('Provider returned a date outside the requested preview window; no preview was accepted.', 'SCHEMA'); }
  function ghcnStationFileUrl(id) {
    if (!/^[A-Za-z0-9_]{11}$/.test(id)) fail('Invalid GHCN station identifier.', 'INPUT');
    return 'https://www.ncei.noaa.gov/pub/data/ghcn/daily/all/' + id + '.dly';
  }
  function ghcnArchive() {
    return root.SiteGhcnArchive || require('./ghcn-archive.js');
  }
  function stationFileRows(text, station, w) {
    // NOAA GHCN-Daily .dly: 21 header characters, then 31 eight-character daily fields.
    const divisors = ghcnArchive().units;
    const rows = new Map(), seen = new Set();
    const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
    for (const line of lines) {
      const year = line.slice(11, 15), month = line.slice(15, 17), element = line.slice(17, 21);
      const prefix = year + '-' + month;
      if (line.length !== 269 || line.slice(0, 11) !== station.id || !dateValid(prefix + '-01') || !/^[A-Z0-9]{4}$/.test(element))
        fail('NOAA station file has an unexpected station, date or record format.', 'SCHEMA');
      if (!Object.hasOwn(divisors, element) || prefix < w.start.slice(0,7) || prefix > w.end.slice(0,7)) continue;
      const key = prefix + element;
      if (seen.has(key)) fail('NOAA station file repeats a month and element.', 'SCHEMA');
      seen.add(key);
      for (let day = 1; day <= 31; day++) {
        const start = 21 + (day - 1) * 8, field = line.slice(start, start + 5).trim();
        const flags = line.slice(start + 5, start + 8);
        if (!/^-?\d+$/.test(field) || !/^[ -~]{3}$/.test(flags)) fail('NOAA station file has an unreadable daily field.', 'SCHEMA');
        const value = Number(field);
        if (value === -9999 && !flags.trim()) continue;
        const date = prefix + '-' + String(day).padStart(2, '0');
        if (!dateValid(date)) fail('NOAA station file has a value on an invalid date.', 'SCHEMA');
        if (date < w.start || date > w.end) continue;
        if (!rows.has(date)) rows.set(date, {STATION:station.id, DATE:date});
        const row = rows.get(date);
        row[element] = value === -9999 ? value : value / divisors[element];
        row[element + '_ATTRIBUTES'] = Array.from(flags, flag => flag.trim()).join(',');
      }
    }
    return [...rows.values()];
  }
  function parseGHCN(data, station, w) {
    if (!Array.isArray(data)) fail('NCEI data response is not an observation array.', 'SCHEMA');
    const seen = new Set();
    for (const row of data) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) fail('NCEI returned an invalid observation record.', 'SCHEMA');
      if (row.STATION !== station.id) fail('NCEI returned observations for an unexpected station.', 'SCHEMA');
      assertDate(row.DATE, w);
      if (seen.has(row.DATE)) fail('NCEI returned duplicate daily dates; no preview was accepted.', 'SCHEMA');
      seen.add(row.DATE);
    }
    const elements=[['TMAX', 'Daily maximum temperature', '°C'], ['TMIN', 'Daily minimum temperature', '°C'], ['PRCP', 'Daily precipitation', 'mm']];
    if(data.some(r=>['SNOW','MDSF'].some(k=>numeric(r[k])!==null&&numeric(r[k])!==-9999)))elements.push(['SNOW','Daily snowfall','mm']);
    return elements.map(([key, label, unit]) => ({ key, label, unit, cadenceMs: DAY, points: sorted(data.map(r => {
      const attr = r[key + '_ATTRIBUTES'] ?? null, parts = typeof attr === 'string' ? attr.split(',') : [];
      const value = numeric(r[key]);
      const totalKey=key==='PRCP'?'MDPR':key==='SNOW'?'MDSF':null,daysKey=key==='PRCP'?'DAPR':'DASF';
      const total=totalKey?numeric(r[totalKey]):null,days=totalKey?numeric(r[daysKey]):null;
      const multiDay=total!==null&&total!==-9999?{element:totalKey,value:total,days:Number.isInteger(days)&&days>0?days:null,attributes:r[totalKey+'_ATTRIBUTES']??null,daysAttributes:r[daysKey+'_ATTRIBUTES']??null}:null;
      return { time: r.DATE, value: value === -9999 ? null : value, ...(multiDay?{multiDay}:{}), flags: { attributes: attr, measurementFlag: parts[0] ?? null, qualityFlag: parts[1] ?? null, sourceFlag: parts[2] ?? null, observationTime: parts[3] ?? null, ...(value === -9999 ? { missingSentinel: '-9999' } : {}) } };
    })) }));
  }
  function parseCOOPS(data, station, w, datum = coopsDatum(station)) {
    const spec = coopsAvailability().productSpec(station);
    if (!Array.isArray(data.data) || String(data.metadata?.id) !== station.id) fail('CO-OPS data response is missing observations or has an unexpected station.', 'SCHEMA');
    const seen = new Set();
    return [{ key: spec.id, label: (spec.id === 'hourly_height' ? 'Verified hourly height · ' : 'Observed water level · ') + datum, unit: 'm', cadenceMs: spec.cadenceMs, points: sorted(data.data.map(r => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) fail('CO-OPS returned an invalid observation record.', 'SCHEMA');
      if (typeof r.t !== 'string' || !/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/.test(r.t)) fail('CO-OPS returned an unexpected timestamp.', 'SCHEMA');
      assertDate(r.t.slice(0, 10), w);
      if (w.startTime && (Date.parse(r.t.replace(' ','T') + ':00Z') < Date.parse(w.startTime) || Date.parse(r.t.replace(' ','T') + ':00Z') > Date.parse(w.endTime))) fail('CO-OPS returned a timestamp outside the precise requested interval.', 'SCHEMA');
      const time = r.t.replace(' ', 'T') + ':00Z';
      if (!Number.isFinite(Date.parse(time)) || seen.has(time)) fail('CO-OPS returned an invalid or duplicate timestamp.', 'SCHEMA');
      seen.add(time);
      return { time, value: numeric(r.v), flags: { quality: r.q ?? null, dataFlags: r.f ?? null, sigma: r.s ?? null } };
    })) }];
  }
  function parseUSGS(data, station, w) {
    validateUSGSCollection(data);
    if ((data.links || []).some(l => l.rel === 'next')) fail('USGS returned more than one page of observations. This bounded preview refuses an incomplete export; use the provider request.', 'PAGINATION');
    const groups = new Map(), seen = new Set();
    for (const f of data.features) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) fail('USGS returned an invalid observation record.', 'SCHEMA');
      const p = f.properties || {};
      if (p.monitoring_location_id !== station.id || p.parameter_code !== '00060' || p.statistic_id !== '00003' || !p.time_series_id || !p.unit_of_measure) fail('USGS returned an unexpected location, parameter, statistic, unit or series.', 'SCHEMA');
      assertDate(p.time, w);
      const key = p.time_series_id + '|' + p.unit_of_measure;
      if (seen.has(key + '|' + p.time)) fail('USGS returned duplicate dates within one series; no preview was accepted.', 'SCHEMA');
      seen.add(key + '|' + p.time);
      if (!groups.has(key)) groups.set(key, { key, label: 'Daily mean discharge', unit: p.unit_of_measure, cadenceMs: DAY, points: [] });
      groups.get(key).points.push({ time: p.time, value: numeric(p.value), flags: { approvalStatus: p.approval_status ?? null, qualifier: p.qualifier ?? null, lastModified: p.last_modified ?? null, timeSeriesId: p.time_series_id } });
    }
    const result = [...groups.values()];
    for (const s of result) { sorted(s.points); if (result.length > 1) s.label += ' · series ' + s.key.slice(0, 8); }
    return result;
  }
  function requestURL(productId, station, query, options = {}) {
    validate(productId, query);
    const patterns = { ghcn_daily: /^[A-Za-z0-9_]{11}$/, noaa_coops_water_level: /^\d{7}$/, usgs_streamflow: /^USGS-\d{8,15}$/ };
    if (!station || !patterns[productId].test(station.id)) fail('Select a valid provider station before requesting a preview.', 'INPUT');
    const w = previewWindow(productId, query, station, options);
    if (!w.available) fail(w.notes.join(' '), w.coverageStatus === 'datum_required' ? 'DATUM_REQUIRED' : ['unchecked','unresolved'].includes(w.coverageStatus) ? 'AVAILABILITY_UNRESOLVED' : 'NO_OVERLAP');
    if (productId === 'ghcn_daily') return url(ENDPOINTS.ghcnData, { dataset: 'daily-summaries', stations: station.id, startDate: w.start, endDate: w.end, dataTypes: ghcnElements.join(','), units: 'metric', includeAttributes: true, includeStationName: true, includeStationLocation: true, format: 'json' });
    if (productId === 'noaa_coops_water_level') return url(ENDPOINTS.coopsData, { product: coopsAvailability().productSpec(station).id, application: 'climate_inventory_review', begin_date: w.startTime ? w.startTime.slice(0,16).replace(/-/g,'').replace('T',' ') : w.start.replace(/-/g, ''), end_date: w.endTime ? w.endTime.slice(0,16).replace(/-/g,'').replace('T',' ') : w.end.replace(/-/g, ''), datum: coopsDatum(station,query,options), station: station.id, time_zone: 'gmt', units: 'metric', format: 'json' });
    return url(ENDPOINTS.usgsData, { f: 'json', monitoring_location_id: station.id, parameter_code: '00060', statistic_id: '00003', time: w.start + '/' + w.end, limit: 10000 });
  }
  function usgsStationLinks(stationId, query = {}) {
    if (!/^USGS-\d{8,15}$/.test(stationId || '')) return [];
    const params={monitoring_location_id:stationId,f:'html',limit:100};
    // USGS limits a continuous-data query to three years. Longer projects open the site's unfiltered collection.
    const dated=dateValid(query.start)&&dateValid(query.end)&&query.start<=query.end&&Date.parse(query.end)-Date.parse(query.start)<1095*DAY;
    const interval=dated?{time:query.start+'T00:00:00Z/'+query.end+'T23:59:59.999Z'}:{};
    const continuous='https://api.waterdata.usgs.gov/ogcapi/v1/collections/continuous/items';
    return [
      {label:'Continuous discharge',url:url(continuous,{...params,parameter_code:'00060',...interval}),projectDates:dated},
      {label:'Gage height (stage)',url:url(continuous,{...params,parameter_code:'00065',...interval}),projectDates:dated},
      {label:'Annual peak discharge',url:url('https://api.waterdata.usgs.gov/ogcapi/v1/collections/peaks/items',{...params,parameter_code:'00060'})}
    ];
  }
  function makeResult(productId, station, query, data, rawText, requests, options = {}, stationFile = false) {
    const w = previewWindow(productId, query, station, options), requestedWindow = { start: query.start, end: query.end };
    if (!w.available) fail(w.notes.join(' '), 'NO_OVERLAP');
    const datum = productId === 'noaa_coops_water_level' ? coopsDatum(station,query,options) : null;
    const availability = productId === 'noaa_coops_water_level' && station.coopsAvailability ? assessCoopsStation(station,query) : null;
    const datumLabel = datum === 'IGLD' ? 'IGLD (International Great Lakes Datum; epoch not inferred)' : datum === 'MSL' ? 'MSL (Mean Sea Level)' : datum ? datum + ' (' + (availability?.availableDatums.find(item => item.code === datum)?.label || 'requested NOAA reference') + '; no local datum conversion)' : null;
    const series = ({ ghcn_daily: parseGHCN, noaa_coops_water_level: parseCOOPS, usgs_streamflow: parseUSGS })[productId](data, station, w, datum);
    const observationCount = series.reduce((n, s) => n + s.points.filter(p => p.value !== null).length, 0);
    const multiDayObservationCount=series.reduce((n,s)=>n+s.points.filter(p=>Number.isFinite(p.multiDay?.value)).length,0);
    if (!observationCount&&!multiDayObservationCount) fail('No numeric observations were returned for this station and preview window. This does not mean the hazard was absent.', 'NO_DATA');
    const days = (Date.parse(w.end + 'T00:00:00Z') - Date.parse(w.start + 'T00:00:00Z')) / DAY + 1;
    const slot = productId === 'noaa_coops_water_level' ? coopsAvailability().productSpec(station).cadenceMs : DAY;
    const summaries = series.map(s => ({ key: s.key, numericValues: s.points.filter(p => p.value !== null).length, returnedRows: s.points.length, expectedSlots: w.startTime ? Math.max(0,Math.floor(Date.parse(w.endTime)/slot)-Math.ceil(Date.parse(w.startTime)/slot)+1) : days * DAY / slot, definition: 'Numeric returned values / nominal ' + (slot === 3600000 ? 'hourly' : 'daily or six-minute') + ' slots in the preview window. Flags are retained; this is not a count of quality-approved values.' }));
    const specificNotes = {
      ghcn_daily: ['Metric units were requested from NCEI: temperature °C, precipitation mm. Provider attribute strings are retained, including measurement, quality, source and observation-time fields.', 'A nonblank GHCN quality flag marks a value that failed a provider quality check; it remains visible here. Daily dates follow provider observation-day conventions, not a guaranteed UTC day.'],
      noaa_coops_water_level: [`${slot === 3600000 ? 'Verified hourly' : 'Six-minute'} observed total water level, in metres relative to ${datum}, with timestamps requested in UTC. This is not a surge residual, wave height or flood depth.`, station.coopsAvailability ? `Requested datum ${datum}; selection mode: ${station.coopsAvailability.explicitDatum ? 'explicit user choice' : 'default'}. The provider returned the requested reference; this tool applied no local datum conversion or automatic substitution. STND is station-specific and is not equivalent to MSL; IGLD, LWD and NAVD are distinct references. Review epoch compatibility separately.` : datum === 'IGLD' ? 'IGLD was selected because NOAA station metadata marks this as a Great Lakes station. The datum epoch is not inferred or converted by this tool.' : station.greatlakes === false ? 'MSL was selected for the station marked non-Great-Lakes by NOAA metadata. MSL is not the API STND (station datum) reference.' : 'Great Lakes classification is absent from the supplied station metadata. MSL is the existing default attempt; datum availability remains unverified.', 'CO-OPS q=v means provider verified and q=p preliminary. Data flags and sigma are retained. The meaning of the first flag differs between preliminary and verified data; see the provider response guide. Datum suitability and epoch alignment require separate review.'],
      usgs_streamflow: ['USGS daily mean discharge (00060 / 00003), retaining the returned unit and provider date labels. Daily mean values are not instantaneous flood peaks.', 'Approval status and qualifiers are retained. Different time-series IDs or units are kept separate. Hydrologic connectivity, catchment suitability and datum checks are not performed.']
    };
    if (productId === 'noaa_coops_water_level' && slot === 3600000) specificNotes.noaa_coops_water_level[2] = 'Verified hourly heights retain NOAA flags: inferred value (I) and limits exceeded (L). The hourly product need not include a q quality field; no quality value is invented. Hourly samples can miss sub-hourly peaks. Datum suitability and epoch alignment require separate review.';
    const archive = typeof stationFile === 'object' ? stationFile : null;
    const processing = archive
      ? (archive.rawFormat==='csv.gz' ? 'The original compressed NOAA station CSV is available byte-for-byte.' : 'The preview CSV is a station and date extract of NOAA annual Parquet files, with native integer values. Source file URLs, checksums and object versions are in the receipt.') +
        ' Charts convert native tenths of °C or mm to °C or mm. Snowfall stays in whole mm. Observation times, measurement, quality and source flags are retained.'
      : stationFile
      ? 'NOAA’s full station file is preserved byte-for-byte. Only the preview dates and supported elements are parsed. Native tenths of °C and tenths of mm are divided by ten for temperature and precipitation. Snowfall uses whole mm. Duration uses days. Measurement, quality and source flags are retained. The station file has no observation-time field.'
      : 'Provider response-body bytes exposed by Fetch are retained separately from decoded UTF-8 text. Parsed rows preserve values and flags without interpolation, resampling, quality filtering or local unit conversion. Displayed statistics separately use the stated trace and QC rules; HTTP content decoding precedes the captured body bytes.';
    if (stationFile) specificNotes.ghcn_daily.shift();
    const notes = [stationFile ? processing : 'Only the displayed preview window was downloaded. Original responses and parsed rows retain all values and flags without interpolation, resampling or local unit conversion. Displayed statistics separately calculate completeness, applicable daily subtotals and maxima using the stated trace and QC rules.', ...w.notes, ...(w.end !== query.end ? [`Requested period ends ${query.end}; this bounded preview ends ${w.end}. Remaining dates were ${stationFile ? 'not analyzed' : 'not retrieved'}.`] : []), ...specificNotes[productId]];
    const dailyCoverage = productId === 'ghcn_daily' ? {observationSource: archive?.observationSource || (stationFile ? 'NOAA GHCN-Daily station file' : 'NOAA Daily Summaries API'), reportingDays: new Set(series.flatMap(s => s.points.filter(p => Number.isFinite(p.value) || Number.isFinite(p.multiDay?.value)).map(p => p.time))).size, windowDays: days} : {};
    if (archive) Object.assign(dailyCoverage,{sourceFiles:archive.sourceUrls,downloadScope:archive.rawFormat==='csv.gz'?'Original full NOAA station archive':'Station and date extract from NOAA annual files'});
    const site = query.mode === 'area' ? { mode: 'area', geometry: copy(query.geometry), areaName: query.areaName || '', areaSource: copy(query.areaSource || {}), bufferKm: query.bufferKm ?? 0 } : { mode: 'point', lat: query.lat, lon: query.lon, radiusKm: query.radiusKm ?? 100 };
    return { station: { ...station }, series, rawText, rawFormat: archive?.rawFormat || (stationFile ? 'dly' : 'json'), rawMime: archive?.rawMime || (stationFile ? 'text/plain' : 'application/json'), requests, provenance: { schemaVersion: '1.1', toolVersion: 'v0.3', productId, site, query: copy(query), station: { ...station }, requestedWindow, retrievedWindow: w, requests, processing, ...dailyCoverage, units: series.map(s => ({ key: s.key, unit: s.unit })), timeConvention: productId === 'noaa_coops_water_level' ? 'UTC' : 'Provider daily date labels; not normalized to UTC observation days', datum: datumLabel, datumCode: datum, coopsAvailability: availability, unverifiedMetadataAttempt: w.unverifiedMetadata === true, datumSelectionMode: availability?.selectionMode || null, summaries, documentation: DOCS[productId], qualification: 'Data retrieval and software checks only; scientific suitability is not established.' }, notes, summaries, observationCount, multiDayObservationCount, window: w, requestedWindow };
  }
  async function retrieve(productId, submittedStation, submittedQuery, options = {}) {
    validate(productId, submittedQuery);
    const query = copy(submittedQuery), requests = [], metadataNotes = [];
    let station = { ...submittedStation };
    const requestUrl = requestURL(productId, station, query, options);
    if (productId === 'usgs_streamflow' && station.name === station.id) {
      try {
        const detail = await describeStation(productId, station, options);
        station = detail.station; requests.push(...detail.requests);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        metadataNotes.push('Station-name details could not be enriched: ' + e.message + ' The observation request still uses the explicit station ID.');
      }
    }
    const base = ({ ghcn_daily: ENDPOINTS.ghcnData, noaa_coops_water_level: ENDPOINTS.coopsData, usgs_streamflow: ENDPOINTS.usgsData })[productId];
    let r, result;
    try {
      r = await request(requestUrl, base, options, requests);
      result = makeResult(productId, station, query, r.data, r.rawText, requests, options);
    } catch (primary) {
      if (primary.code === 'NO_DATA') primary.requests = requests;
      const unavailable = e => ['NETWORK','TIMEOUT','HTTP_500','HTTP_502','HTTP_503','HTTP_504'].includes(e.code);
      if (productId !== 'ghcn_daily' || options.checkStationFile !== true ||
          (primary.code!=='NO_DATA' && !unavailable(primary))) throw primary;
      if (primary.code==='NO_DATA') requests.at(-1).outcome = 'No numeric preview values in Daily Summaries';
      else requests.push({url:requestUrl,retrievedAt:new Date().toISOString(),outcome:primary.code});
      const fileUrl = ghcnStationFileUrl(station.id);
      const w = previewWindow(productId, query, station);
      options.onStationFile?.();
      try {
        r = await request(fileUrl, fileUrl, {...options,timeoutMs:Math.min(options.timeoutMs || 25000,5000)}, requests, true);
        const rows = stationFileRows(r.rawText, station, w);
        result = makeResult(productId, station, query, rows, r.rawText, requests, options, true);
      } catch (archive) {
        if (archive.name === 'AbortError') throw archive;
        if (archive.code === 'NO_DATA') {
          requests.at(-1).outcome = 'No numeric preview values in station file';
          archive.message = primary.code==='NO_DATA' ? 'NOAA Daily Summaries and the original GHCN-Daily station file both returned no numeric values for the previewed elements and dates.' : 'The original NOAA station file contains no numeric values for these elements and dates.';
          archive.requests = requests;
          throw archive;
        }
        if (!unavailable(archive) && !['HTTP_404','STATION_FILE_LIMIT'].includes(archive.code))
          fail('The original NOAA station file could not be checked. '+archive.message, archive.code || 'STATION_FILE_READ');
        requests.push({url:fileUrl,retrievedAt:new Date().toISOString(),outcome:archive.code});
        options.onOpenArchive?.();
        try {
          r = await ghcnArchive().read(station,w,options,requests);
          result = makeResult(productId,station,query,r.rows,r.rawText ?? null,requests,options,r);
          result.previewCsv = r.previewCsv;
        } catch (error) {
          if (error.name==='AbortError') throw error;
          if (error.code==='NO_DATA') {
            error.message = 'NOAA’s GHCN-Daily archive contains no numeric reports for these elements and preview dates.';
            error.requests=requests;
            throw error;
          }
          fail('The NOAA observations could not be verified. '+(error.code?error.message:'The NOAA Open Data archive could not be read. Retry the preview.'),error.code || 'ARCHIVE_ACCESS');
        }
      }
    }
    // A full compressed station file can be megabytes. Keep its exact bytes for the
    // original download; JSON summaries retain the preview, URL, byte count and digest.
    Object.defineProperty(result,'rawBytes',{value:r.rawBytes,enumerable:result.rawFormat!=='csv.gz'});
    const extracted=result.rawFormat==='csv' && productId==='ghcn_daily';
    result.provenance[extracted?'extractByteLength':'rawByteLength']=r.rawBytes.byteLength;
    result.notes.push(...metadataNotes);
    if (root.crypto?.subtle) {
      const hash = await root.crypto.subtle.digest('SHA-256', r.rawBytes);
      result.provenance[extracted?'extractSha256':'rawSha256'] = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return result;
  }
  const api = { supported, discover, retrieve, describeStation, describeStations, requestURL, usgsStationLinks, ghcnStationFileUrl, ghcnNetwork, previewWindow, checkCoopsStations, assessCoopsStation, knownLocationConflict, nearbyLocationConflicts };
  root.SiteProviders = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { ...api, _test: { dateValid, numeric, distance, boxes, checkedURL, parseGHCN, parseCOOPS, parseUSGS, makeResult } };
})(typeof window !== 'undefined' ? window : globalThis);
