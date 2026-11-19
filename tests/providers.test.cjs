const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../src/providers.js');
const saved = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/examples.json'), 'utf8')).examples;
const weather = saved.find(e => e.productId === 'ghcn_daily');
const coastal = saved.find(e => e.productId === 'noaa_coops_water_level');
const river = saved.find(e => e.productId === 'usgs_streamflow');
const clone = o => JSON.parse(JSON.stringify(o));
const response = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = code => e => e.code === code;

test('GHCN network labels follow the documented numbering system for domestic and international IDs',()=>{
  for (const [id,label] of Object.entries({USW00012918:'WBAN',US1TXHRR204:'CoCoRaHS',USC00414311:'U.S. COOP',CA1ON000001:'CoCoRaHS',KEN00001234:'National met/hydrology center',UKE00107650:'ECA&D',KEM00063741:'WMO',XXZ00001234:'Unclassified Z ID',XXA00001234:'Unclassified A ID',XX000001234:'Unspecified'})) {
    assert.deepEqual(P.ghcnNetwork(id),{networkCode:id[2],networkLabel:label});
  }
  assert.equal(P.ghcnNetwork('bad').networkLabel,'Unclassified ID');
});

test('Jersey Village elevation warning preserves the original value and applies only at the reviewed location',async()=>{
  const query={...weather.query,lat:29.9172,lon:-95.5617};
  async function discover(id,lat,lon) {
    const item={id:'file-'+id,location:{coordinates:[lon,lat]},startDate:'2010-01-01',endDate:'2026-01-01',
      stations:[{id,name:id,dataTypes:[{id:'PRCP',startDate:'2010-01-01',endDate:'2026-01-01'}]}]};
    const found=await P.discover('ghcn_daily',query,{fetchImpl:async()=>response({count:1,results:[item]})});
    return found.stations[0];
  }
  const flagged=await discover('US1TXHRR204',29.9172,-95.5617);
  assert.equal(flagged.elevationM,1035.7);assert.match(flagged.elevationNote,/about 35 m/);assert.match(flagged.elevationCheckUrl,/epqs\.nationalmap\.gov/);
  assert.equal((await discover('US1TXHRR204',29.92,-95.55)).elevationNote,undefined);
  const nearby=await discover('US1TXHRR159',29.9316,-95.5665);
  assert.equal(nearby.elevationM,36.9);assert.equal(nearby.elevationNote,undefined);
});

// Reproduced before implementation: live NCEI metadata on 2026-11-14 reports the
// station file from 1936-09-01 but these three requested elements from 1941-06-16.
const laterWeather = {id:'USW00013743',name:'WASHINGTON REAGAN NATIONAL AIRPORT, VA US',lat:38.84721,lon:-77.03454,start:'1936-09-01',end:'2026-11-10',variables:['TMAX','TMIN','PRCP'].map(key=>({key,start:'1941-06-16',end:'2026-11-10'}))};
const longProject = {mode:'point',lat:38.9,lon:-77.04,radiusKm:100,start:'1900-01-01',end:'2020-12-31'};

test('preview begins at requested-element overlap, not project start or unrelated station variables',()=>{
  const w=P.previewWindow('ghcn_daily',longProject,laterWeather);
  assert.equal(w.start,'1941-06-16');assert.equal(w.end,'1941-07-16');assert.equal(w.shifted,true);assert.equal(w.available,true);
  const request=new URL(P.requestURL('ghcn_daily',laterWeather,longProject));assert.equal(request.searchParams.get('startDate'),w.start);assert.equal(request.searchParams.get('endDate'),w.end);
});

test('known zero overlap cannot issue an observation request',async()=>{
  const q={...longProject,end:'1930-12-31'};let fetched=false;
  const w=P.previewWindow('ghcn_daily',q,laterWeather);assert.equal(w.available,false);assert.equal(w.start,null);assert.equal(w.end,null);
  await assert.rejects(P.retrieve('ghcn_daily',laterWeather,q,{fetchImpl:async()=>{fetched=true;return response([]);}}),failure('NO_OVERLAP'));assert.equal(fetched,false);
});

test('verified Great Lakes station metadata selects IGLD throughout request and result',()=>{
  const station={id:'9063020',name:'Buffalo',lat:42.877445,lon:-78.89047,tidal:false,greatlakes:true},q={...weather.query,end:'2020-07-01'};
  assert.equal(new URL(P.requestURL('noaa_coops_water_level',station,q)).searchParams.get('datum'),'IGLD');
  const raw=JSON.stringify({metadata:{id:station.id},data:[{t:'2020-07-01 00:00',v:'175.003',s:'0.0',f:'0,0,0,0',q:'v'}]});
  const r=P._test.makeResult('noaa_coops_water_level',station,q,JSON.parse(raw),raw,[]);
  assert.match(r.series[0].label,/IGLD/);assert.match(r.provenance.datum,/IGLD/);assert.match(r.notes.join(' '),/IGLD/);assert.equal(r.series[0].points[0].value,175.003);
});

test('all saved examples reproduce from exact raw payloads and SHA-256 hashes', () => {
  assert.equal(saved.length, 3);
  for (const e of saved) {
    const r = P._test.makeResult(e.productId, e.station, e.query, JSON.parse(e.result.rawText), e.result.rawText, e.result.requests);
    assert.deepEqual(r.series, e.result.series);
    assert.deepEqual(r.summaries, e.result.summaries);
    assert.equal(crypto.createHash('sha256').update(e.result.rawText).digest('hex'), e.result.provenance.rawSha256);
    assert.match(e.result.requests[0].retrievedAt, /^2026-11-(13|15)T/);
    assert.equal(e.result.provenance.savedExample, true);
  }
});
test('real GHCN API metric sample has °C/mm values and unmodified attributes', () => {
  const [max, min, rain] = weather.result.series;
  assert.equal(max.unit, '°C'); assert.equal(max.points[0].value, 32.2);
  assert.equal(min.points[0].value, 22.8); assert.equal(rain.unit, 'mm'); assert.equal(rain.points[0].value, 3);
  assert.equal(max.points[0].flags.attributes, ',,W');
  assert.equal(rain.points[0].flags.observationTime, '2400');
});
test('real Sandy sample retains 480 values, MSL/GMT and provider QC fields', () => {
  const s = coastal.result.series[0];
  assert.equal(s.points.length, 480); assert.equal(s.points[0].time, '2012-10-29T00:00:00Z');
  assert.equal(s.points[0].value, 1.471); assert.equal(s.points.at(-1).value, 1.024);
  assert.deepEqual(s.points[0].flags, { quality: 'v', dataFlags: '0,0,0,0', sigma: '0.023' });
  assert.equal(coastal.result.provenance.datum, 'MSL (Mean Sea Level)');
});
test('real USGS unordered features are sorted, with units and flags intact', () => {
  const s = river.result.series[0];
  assert.deepEqual(s.points.map(p => p.time), ['2020-07-01', '2020-07-02', '2020-07-03']);
  assert.equal(s.unit, 'ft^3/s'); assert.equal(s.points[1].value, 4740);
  assert.equal(s.points[0].flags.approvalStatus, 'Approved');
  assert.equal(s.points[0].flags.qualifier, null);
});
test('preview windows cap exact inclusive days across leap day and year boundary', () => {
  const dates = w => ({start:w.start,end:w.end});
  assert.deepEqual(dates(P.previewWindow('ghcn_daily', { start: '2020-02-01', end: '2021-12-31' })), { start: '2020-02-01', end: '2020-03-02' });
  assert.deepEqual(dates(P.previewWindow('noaa_coops_water_level', { start: '2019-12-20', end: '2020-03-01' })), { start: '2019-12-20', end: '2020-01-16' });
  assert.deepEqual(dates(P.previewWindow('usgs_streamflow', { start: '2020-02-29', end: '2020-02-29' })), { start: '2020-02-29', end: '2020-02-29' });
});
test('input rejects impossible dates, reversed periods, strings, nonfinite and out-of-range coordinates', async () => {
  for (const patch of [{ start: '0000-01-01' }, { start: '2020-02-30' }, { start: '1900-02-29' }, { start: '2021-01-01' }, { end: '2999-01-01' }, { lat: 91 }, { lon: -181 }, { lat: NaN }, { lon: '0' }, { lat: null }]) {
    await assert.rejects(P.discover('ghcn_daily', { ...weather.query, ...patch }), failure('INPUT'));
  }
  assert.equal(P._test.dateValid('2000-02-29'), true);
  assert.equal(P._test.numeric('0x10'), null); assert.equal(P._test.numeric([]), null); assert.equal(P._test.numeric('0.0'), 0);
  await assert.rejects(P.discover('no_such_product', weather.query), failure('UNSUPPORTED'));
  await assert.rejects(P.retrieve('ghcn_daily', weather.station, undefined), failure('INPUT'));
});
test('station identifiers cannot inject arbitrary URLs or query arguments', () => {
  for (const id of ['https://example.com', 'USW00013743&units=standard', '../bad']) assert.throws(() => P.requestURL('ghcn_daily', { id }, weather.query), failure('INPUT'));
  const u = new URL(P.requestURL('ghcn_daily', weather.station, weather.query));
  assert.equal(u.origin, 'https://www.ncei.noaa.gov');
  assert.equal(u.searchParams.get('includeAttributes'), 'true');
  assert.equal(u.searchParams.get('units'), 'metric');
});
test('antimeridian search uses two valid bounding boxes and polar search uses all longitudes', () => {
  for (const lon of [-179.9, 179.9]) {
    const boxes = P._test.boxes({ lat: 0, lon }); assert.equal(boxes.length, 2);
    for (const [w, s, e, n] of boxes) { assert.ok(w <= e); assert.ok(w >= -180 && e <= 180); assert.ok(s < n); }
  }
  assert.deepEqual(P._test.boxes({ lat: 90, lon: 150 })[0].filter((_, i) => i % 2 === 0), [-180, 180]);
  assert.ok(P._test.distance({ lat: 0, lon: 179.9 }, { lat: 0, lon: -179.9 }) < 23);
});
test('retrieval retains exact response text; provenance separates full request and bounded preview', async () => {
  const q = { ...weather.query, end: '2021-12-31' };
  let requested;
  const r = await P.retrieve('ghcn_daily', weather.station, q, { fetchImpl: async u => { requested = new URL(u); return response(weather.result.rawText); } });
  assert.equal(r.rawText, weather.result.rawText);
  assert.equal(requested.searchParams.get('endDate'), '2020-07-31');
  assert.equal(r.window.end, '2020-07-31'); assert.equal(r.requestedWindow.end, '2021-12-31');
  assert.equal(r.summaries[0].numericValues, 3); assert.equal(r.summaries[0].expectedSlots, 31);
  assert.match(r.notes.join(' '), /Remaining dates were not retrieved/);
});
test('HTTP errors, rate limiting, API 200 errors, HTML and JSON null are explicit failures', async () => {
  const cases = [[response('{}', 429), 'HTTP_429'], [response('{}', 503), 'HTTP_503'], [response({ error: { message: 'No data was found.' } }), 'NO_DATA'], [response({ errorMessage: 'bad request' }), 'PROVIDER_ERROR'], [response('<html>outage</html>'), 'SCHEMA'], [response('null'), 'SCHEMA']];
  for (const [r, code] of cases) await assert.rejects(P.retrieve('ghcn_daily', weather.station, weather.query, { fetchImpl: async () => r }), failure(code));
});
test('CO-OPS HTTP 400 preserves the provider reason instead of suggesting a blind retry', async () => {
  const message = 'No data was found. This product may not be offered at this station at the requested time.';
  await assert.rejects(P.retrieve('noaa_coops_water_level', coastal.station, coastal.query, {
    fetchImpl: async () => response({error: {message}}, 400)
  }), e => e.code === 'HTTP_400' && e.message.includes(message) && !e.message.includes('Try again'));
});
test('non-JSON HTTP failures keep the status; provider details are bounded plain text', async () => {
  for (const body of ['<html>upstream outage</html>', 'null', '{broken']) {
    await assert.rejects(P.retrieve('noaa_coops_water_level', coastal.station, coastal.query, {
      fetchImpl: async () => response(body, 503)
    }), e => e.code === 'HTTP_503' && !e.message.includes('upstream outage'));
  }
  await assert.rejects(P.retrieve('noaa_coops_water_level', coastal.station, coastal.query, {
    fetchImpl: async () => response({error: {message: 'Bad datum\n' + 'x'.repeat(1000)}}, 400)
  }), e => e.code === 'HTTP_400' && e.message.includes('Bad datum ') && !e.message.includes('\n') && e.message.length < 400);
});
test('coastal CO-OPS request retains product, dates, MSL, metric units and GMT', () => {
  const query = {mode:'point',lat:38.9,lon:-77.04,radiusKm:100,start:'2020-11-07',end:'2020-11-13'};
  for (const id of ['8593005', '8594900']) {
    const request = new URL(P.requestURL('noaa_coops_water_level', {id,greatlakes:false}, query));
    assert.equal(request.origin + request.pathname, 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter');
    assert.deepEqual(Object.fromEntries(request.searchParams), {product:'water_level',application:'climate_inventory_review',begin_date:'20201107',end_date:'20201113',datum:'MSL',station:id,time_zone:'gmt',units:'metric',format:'json'});
  }
});
test('network exceptions are classified without exposing arbitrary details', async () => {
  await assert.rejects(P.retrieve('ghcn_daily', weather.station, weather.query, { fetchImpl: async () => { throw new TypeError('secret-host-detail'); } }), e => e.code === 'NETWORK' && !e.message.includes('secret-host-detail'));
});
test('already aborted request does not call the network', async () => {
  const controller = new AbortController(); controller.abort(); let called = false;
  await assert.rejects(P.retrieve('ghcn_daily', weather.station, weather.query, { signal: controller.signal, fetchImpl: async () => { called = true; } }), e => e.name === 'AbortError');
  assert.equal(called, false);
});
test('active cancellation and timeout release the request with distinct outcomes', async () => {
  const fetchImpl = (_u, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }));
  await assert.rejects(P.retrieve('ghcn_daily', weather.station, weather.query, { fetchImpl, timeoutMs: 5 }), failure('TIMEOUT'));
  const c = new AbortController(); const pending = P.retrieve('ghcn_daily', weather.station, weather.query, { fetchImpl, signal: c.signal }); c.abort();
  await assert.rejects(pending, e => e.name === 'AbortError');
});
test('GHCN missing and failed-QC values are not made zero, filtered or gap-filled', () => {
  const rows = JSON.parse(weather.result.rawText); rows.splice(1, 1); rows[0].TMAX_ATTRIBUTES = ',X,W'; rows[0].TMIN = ''; rows[0].PRCP = '-9999';
  const r = P._test.makeResult('ghcn_daily', weather.station, weather.query, rows, JSON.stringify(rows), []);
  assert.equal(r.series[0].points.length, 2); assert.equal(r.series[0].points[0].value, 32.2);
  assert.equal(r.series[0].points[0].flags.qualityFlag, 'X');
  assert.equal(r.series[1].points[0].value, null); assert.equal(r.series[2].points[0].value, null);
  assert.equal(r.summaries[0].expectedSlots, 3); assert.equal(r.summaries[0].numericValues, 2);
});
test('wrong stations, duplicate daily dates and out-of-window dates fail closed', () => {
  for (const mutate of [r => { r[0].STATION = 'USW00099999'; }, r => r.push(r[0]), r => { r[0].DATE = '2020-08-01'; }, r => r.push(null)]) {
    const rows = JSON.parse(weather.result.rawText); mutate(rows);
    assert.throws(() => P._test.parseGHCN(rows, weather.station, weather.query), failure('SCHEMA'));
  }
});
test('CO-OPS invalid 24:00, wrong station, duplicate times and null rows fail closed', () => {
  for (const mutate of [r => { r.data[0].t = '2012-10-29 24:00'; }, r => { r.metadata.id = '0000000'; }, r => r.data.push(r.data[0]), r => r.data.push(null)]) {
    const data = JSON.parse(coastal.result.rawText); mutate(data);
    assert.throws(() => P._test.parseCOOPS(data, coastal.station, coastal.query), failure('SCHEMA'));
  }
});
test('CO-OPS missing value remains null and preliminary/verified flags remain unmodified', () => {
  const data = JSON.parse(coastal.result.rawText); data.data[0].v = ''; data.data[0].q = 'p'; data.data[0].f = '7,1,0,0';
  const s = P._test.parseCOOPS(data, coastal.station, coastal.query)[0];
  assert.equal(s.points[0].value, null); assert.equal(s.points[0].flags.quality, 'p'); assert.equal(s.points[0].flags.dataFlags, '7,1,0,0');
});
test('USGS units/series remain distinct and missing values/qualifiers remain present', () => {
  const data = JSON.parse(river.result.rawText), extra = clone(data.features[0]);
  extra.properties.unit_of_measure = 'm^3/s'; extra.properties.value = null; extra.properties.approval_status = 'Provisional'; extra.properties.qualifier = 'Ice'; data.features.push(extra); data.numberReturned = data.features.length;
  const groups = P._test.parseUSGS(data, river.station, river.query);
  assert.equal(groups.length, 2); assert.notEqual(groups[0].key, groups[1].key);
  assert.equal(groups[1].points[0].value, null); assert.equal(groups[1].points[0].flags.qualifier, 'Ice');
});
test('USGS rejects wrong parameter/statistic/station, duplicate series dates, malformed rows and incomplete pages', () => {
  for (const mutate of [r => { r.features[0].properties.parameter_code = '00065'; }, r => { r.features[0].properties.statistic_id = '00001'; }, r => { r.features[0].properties.monitoring_location_id = 'USGS-00000000'; }, r => r.features.push(r.features[0]), r => r.features.push(null)]) {
    const data = JSON.parse(river.result.rawText); mutate(data);
    assert.throws(() => P._test.parseUSGS(data, river.station, river.query), failure('SCHEMA'));
  }
  const paged = JSON.parse(river.result.rawText); paged.links.push({ rel: 'next', href: 'https://api.waterdata.usgs.gov/ogcapi/v1/collections/daily/items?cursor=x' });
  assert.throws(() => P._test.parseUSGS(paged, river.station, river.query), failure('PAGINATION'));
});
test('empty observations are no-data, never a claim of zero hazard', async () => {
  await assert.rejects(P.retrieve('ghcn_daily', weather.station, weather.query, { fetchImpl: async () => response([]) }), failure('NO_DATA'));
});
test('NCEI pagination uses matching count, retains full-record coverage and sorts distance', async () => {
  let calls = 0;
  const item = (id, lat) => ({ id: 'file-' + id, location: { coordinates: [-77.04, lat] }, startDate: '1950-01-01', endDate: '2026-01-01', stations: [{ id, name: id, dataTypes: [{ id: 'TMAX', startDate: '1950-01-01', endDate: '2026-01-01', coverage: 100 }] }] });
  const r = await P.discover('ghcn_daily', weather.query, { fetchImpl: async u => { const offset = Number(new URL(u).searchParams.get('offset')); calls++; return response({ count: 2, totalCount: 999999, results: [offset ? item('USW00000002', 38.91) : item('USW00000001', 39.4)] }); } });
  assert.equal(calls, 2); assert.equal(r.stations[0].id, 'USW00000002'); assert.equal(r.truncated, false);
  assert.equal(r.stations[0].variables[0].providerRecordCoveragePercent, 100);
  assert.match(r.stations[0].note, /record spans can include gaps/i);
});
test('absent coordinates are not invented or presented as a spatially complete search', async () => {
  const r = await P.discover('ghcn_daily', weather.query, { fetchImpl: async () => response({ count: 1, results: [{ id: 'file-USW00000001', stations: [{ id: 'USW00000001' }] }] }) });
  assert.equal(r.stations.length, 0); assert.equal(r.unlocatedRecordsTotal, 1);
  assert.equal(r.paginationComplete, true); assert.equal(r.complete, false);
  assert.match(r.notes.join(' '), /could not be classified/);
});
test('CO-OPS discovery keeps historical status unconfirmed and excludes beyond 100 km', async () => {
  const r = await P.discover('noaa_coops_water_level', weather.query, { fetchImpl: async () => response({ count: 3, stations: [{ id: '1234567', name: 'Near', lat: 38.9, lng: -77.04 }, { id: '1234568', name: 'Far', lat: 0, lng: 0 }, { id: '1234569', name: 'Unknown', lat: null, lng: null }] }) });
  assert.equal(r.stations.length, 1); assert.equal(r.stations[0].distanceKm, 0);
  assert.match(r.stations[0].note, /not yet been checked/);
});
test('USGS discovery filters discharge/statistic/date metadata and batches station-name query', async () => {
  const feature = (id, parameter, begin) => ({ properties: { monitoring_location_id: id, parameter_code: parameter, statistic_id: '00003', begin, end: '2026-01-01' }, geometry: { coordinates: [-77.04, 38.9] } });
  let calls = 0;
  const r = await P.discover('usgs_streamflow', weather.query, { fetchImpl: async u => {
    calls++; const parsed = new URL(u);
    if (parsed.pathname.includes('time-series-metadata')) return response({ type: 'FeatureCollection', features: [feature('USGS-01646500', '00060', '1930-01-01'), feature('USGS-01652620', '00065', '1930-01-01'), feature('USGS-01652621', '00060', '2022-01-01'), feature("USGS-0') OR true", '00060', '1930-01-01')], links: [] });
    assert.equal(parsed.searchParams.get('filter'), "id IN ('USGS-01646500')");
    return response({ type: 'FeatureCollection', features: [{ properties: { id: 'USGS-01646500', monitoring_location_name: 'Potomac', site_type: 'Stream' } }] });
  } });
  assert.equal(calls, 2); assert.equal(r.stations.length, 1); assert.equal(r.stations[0].name, 'Potomac');
  assert.match(r.notes.join(' '), /not establish hydrologic connectivity/);
});
test('USGS pagination refuses foreign-host, alternate-path and repeated next links', async () => {
  for (const href of ['https://example.com/leak', 'https://api.waterdata.usgs.gov/other']) {
    await assert.rejects(P.discover('usgs_streamflow', weather.query, { fetchImpl: async () => response({ type: 'FeatureCollection', features: [], links: [{ rel: 'next', href }] }) }), failure('SCHEMA'));
  }
  await assert.rejects(P.discover('usgs_streamflow', weather.query, { fetchImpl: async u => response({ type: 'FeatureCollection', features: [], links: [{ rel: 'next', href: u }] }) }), failure('PAGINATION'));
});

// Synthetic station metadata below tests filtering and failure behavior only; it is never displayed as a saved example.
const ghcnItem = (n, lat = 38.9, lon = -77.04) => ({ id: 'record-' + n, location: { coordinates: [lon, lat] }, startDate: '1950-01-01', endDate: '2026-01-01', stations: [{ id: 'USW' + String(n).padStart(8, '0'), name: 'Synthetic test ' + n, dataTypes: [{ id: 'TMAX', startDate: '1950-01-01', endDate: '2026-01-01', coverage: 90 }] }] });
const usgsFeature = (n, lat = 38.9, lon = -77.04) => ({ id: 'series-' + n, properties: { id: 'series-' + n, monitoring_location_id: 'USGS-' + String(n).padStart(8, '0'), parameter_code: '00060', statistic_id: '00003', begin: '1950-01-01', end: '2026-01-01', unit_of_measure: 'ft^3/s' }, geometry: { type: 'Point', coordinates: [lon, lat] } });
const rectangle = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const areaQuery = geometry => ({ mode: 'area', geometry, areaName: 'Test geometry', areaSource: { kind: 'test-fixture', vintage: 'test-only' }, bufferKm: 0, start: '2020-07-01', end: '2020-07-03' });

test('more than ten candidates survive NCEI discovery without a hidden total cap', async () => {
  const r = await P.discover('ghcn_daily', weather.query, { fetchImpl: async () => response({ count: 57, results: Array.from({ length: 57 }, (_, n) => ghcnItem(n + 1)) }) });
  assert.equal(r.stations.length, 57); assert.equal(r.complete, true); assert.equal(r.continuation, null);
  assert.equal(r.searchedRecords, 57);
});
test('NCEI discovery includes a precipitation-only station and does not impose an all-variable API filter', async () => {
  const item = ghcnItem(1); item.stations[0].dataTypes[0].id = 'PRCP';
  const r = await P.discover('ghcn_daily', weather.query, { fetchImpl: async u => { assert.equal(new URL(u).searchParams.has('dataTypes'), false); return response({ count: 1, results: [item] }); } });
  assert.equal(r.stations.length, 1); assert.deepEqual(r.stations[0].variables.map(v => v.key), ['PRCP']); assert.equal(r.complete, true);
});
test('each requested weather element can establish a candidate and preview period independently', async () => {
  const query = {...weather.query, start: '2020-07-01', end: '2020-07-03'};
  for (const element of ['SNOW', 'MDPR', 'DAPR', 'MDSF', 'DASF']) {
    const record = ghcnItem(1);
    record.stations[0].dataTypes = [
      {id:'PRCP', startDate:'2019-01-01', endDate:'2020-06-30'},
      {id:element, startDate:'2020-07-02', endDate:'2020-07-03'}
    ];
    const result = await P.discover('ghcn_daily', query, {fetchImpl:async () => response({count:1,results:[record]})});
    assert.equal(result.stations.length, 1, element);
    const window = P.previewWindow('ghcn_daily', query, result.stations[0]);
    assert.deepEqual([window.start, window.end], ['2020-07-02', '2020-07-03'], element);
  }
});
test('invalid metadata dates remain explicitly incomplete instead of producing false no-match results', async () => {
  const item = ghcnItem(1); item.stations[0].dataTypes[0].startDate = 20200101;
  const result = await P.discover('ghcn_daily', weather.query, { fetchImpl: async () => response({ count: 1, results: [item] }) });
  assert.equal(result.complete,false); assert.equal(result.malformedRecordsTotal,1); assert.equal(result.stations.length,0);
  const feature = usgsFeature(1); feature.properties.begin = 'not-a-date';
  await assert.rejects(P.discover('usgs_streamflow', weather.query, { fetchImpl: async () => response({ type: 'FeatureCollection', features: [feature], links: [] }) }), failure('SCHEMA'));
});
test('NCEI batched continuation traverses every page and preserves exact offsets', async () => {
  const offsets = [], fetchImpl = async u => {
    const offset = Number(new URL(u).searchParams.get('offset')); offsets.push(offset);
    return response({ count: 7, results: [ghcnItem(offset + 1)] });
  };
  const first = await P.discover('ghcn_daily', weather.query, { fetchImpl });
  assert.equal(first.stations.length, 5); assert.equal(first.complete, false); assert.equal(first.continuation.offset, 5);
  const rest = await P.discover('ghcn_daily', weather.query, { fetchImpl, cursor: JSON.parse(JSON.stringify(first.continuation)) });
  assert.equal(rest.stations.length, 2); assert.equal(rest.complete, true); assert.equal(rest.searchedRecordsTotal, 7);
  assert.deepEqual(offsets, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(new Set([...first.stations, ...rest.stations].map(s => s.id)).size, 7);
});
test('continuation cannot cross provider, edited geometry, radius, buffer, source or dates', async () => {
  const q = areaQuery(rectangle(-77.2, 38.8, -76.9, 39.1));
  const first = await P.discover('ghcn_daily', q, { pageBudget: 1, fetchImpl: async () => response({ count: 2, results: [ghcnItem(1)] }) });
  for (const changed of [{ ...q, end: '2020-07-04' }, { ...q, bufferKm: 1 }, { ...q, areaSource: { kind: 'different' } }, { ...q, geometry: rectangle(-77.3, 38.8, -76.9, 39.1) }]) {
    await assert.rejects(P.discover('ghcn_daily', changed, { cursor: first.continuation }), failure('CURSOR'));
  }
  await assert.rejects(P.discover('usgs_streamflow', q, { cursor: first.continuation }), failure('CURSOR'));
  const point = await P.discover('ghcn_daily', weather.query, { pageBudget: 1, fetchImpl: async () => response({ count: 2, results: [ghcnItem(1)] }) });
  await assert.rejects(P.discover('ghcn_daily', { ...weather.query, radiusKm: 200 }, { cursor: point.continuation }), failure('CURSOR'));
});
test('later-page HTTP failure retains valid pages and retry resumes the failed offset', async () => {
  const first = await P.discover('ghcn_daily', weather.query, { fetchImpl: async u => {
    const offset = Number(new URL(u).searchParams.get('offset'));
    return offset === 2 ? response('{}', 503) : response({ count: 3, results: [ghcnItem(offset + 1)] });
  } });
  assert.equal(first.stations.length, 2); assert.equal(first.complete, false); assert.equal(first.error.code, 'HTTP_503'); assert.equal(first.continuation.offset, 2);
  let retryOffset;
  const last = await P.discover('ghcn_daily', weather.query, { cursor: first.continuation, fetchImpl: async u => { retryOffset = Number(new URL(u).searchParams.get('offset')); return response({ count: 3, results: [ghcnItem(3)] }); } });
  assert.equal(retryOffset, 2); assert.equal(last.complete, true); assert.equal(last.searchedRecordsTotal, 3);
});
test('failed first page of a continuation returns a retry cursor instead of losing earlier batches', async () => {
  const first = await P.discover('ghcn_daily', weather.query, { pageBudget: 1, fetchImpl: async () => response({ count: 2, results: [ghcnItem(1)] }) });
  const failed = await P.discover('ghcn_daily', weather.query, { cursor: first.continuation, fetchImpl: async () => response('{}', 429) });
  assert.equal(failed.stations.length, 0); assert.equal(failed.continuation.offset, 1); assert.equal(failed.error.code, 'HTTP_429'); assert.equal(failed.complete, false);
});
test('cancel after a successful page retains candidates and a resumable cursor', async () => {
  const controller = new AbortController();
  const first = await P.discover('ghcn_daily', weather.query, { signal: controller.signal, fetchImpl: async u => {
    if (new URL(u).searchParams.get('offset') === '0') return response({ count: 2, results: [ghcnItem(1)] });
    controller.abort(); const e = new Error('Aborted'); e.name = 'AbortError'; throw e;
  } });
  assert.equal(first.stations.length, 1); assert.equal(first.cancelled, true); assert.equal(first.complete, false); assert.equal(first.continuation.offset, 1);
  const rest = await P.discover('ghcn_daily', weather.query, { cursor: first.continuation, fetchImpl: async () => response({ count: 2, results: [ghcnItem(2)] }) });
  assert.equal(rest.complete, true);
});
test('large classification batches yield so cancellation preserves the prior complete page', async () => {
  const controller = new AbortController(); let cancellationRan = false;
  const r = await P.discover('ghcn_daily', weather.query, { signal: controller.signal, fetchImpl: async u => {
    if (new URL(u).searchParams.get('offset') === '0') return response({ count: 257, results: [ghcnItem(1)] });
    setTimeout(() => { cancellationRan = true; controller.abort(); }, 0);
    return response({ count: 257, results: Array.from({ length: 256 }, (_, n) => ghcnItem(n + 2)) });
  } });
  assert.equal(cancellationRan, true); assert.equal(r.cancelled, true); assert.equal(r.stations.length, 1);
  assert.equal(r.continuation.offset, 1); assert.equal(r.searchedRecordsTotal, 1);
});
test('repeated NCEI pages and empty early pages do not create false completion', async () => {
  const repeated = await P.discover('ghcn_daily', weather.query, { fetchImpl: async () => response({ count: 50, results: [ghcnItem(1)] }) });
  assert.equal(repeated.stations.length, 1); assert.equal(repeated.complete, false); assert.equal(repeated.error.code, 'PAGINATION');
  await assert.rejects(P.discover('ghcn_daily', weather.query, { fetchImpl: async () => response({ count: 10, results: [] }) }), failure('PAGINATION'));
});
test('partially overlapping NCEI pages retain accepted records and retry without false completion', async () => {
  const first = await P.discover('ghcn_daily', weather.query, { fetchImpl: async u => {
    const offset = Number(new URL(u).searchParams.get('offset'));
    return response({ count: 4, results: offset ? [ghcnItem(2), ghcnItem(3)] : [ghcnItem(1), ghcnItem(2)] });
  } });
  assert.equal(first.complete, false); assert.equal(first.paginationComplete, false); assert.equal(first.error.code, 'PAGINATION');
  assert.deepEqual(first.stations.map(s => s.id), ['USW00000001', 'USW00000002']);
  assert.equal(first.searchedRecordsTotal, 2); assert.equal(first.continuation.offset, 2);
  const retry = await P.discover('ghcn_daily', weather.query, { cursor: clone(first.continuation), fetchImpl: async u => {
    assert.equal(new URL(u).searchParams.get('offset'), '2');
    return response({ count: 4, results: [ghcnItem(3), ghcnItem(4)] });
  } });
  assert.equal(retry.complete, true); assert.equal(retry.searchedRecordsTotal, 4);
  assert.equal(new Set([...first.stations, ...retry.stations].map(s => s.id)).size, 4);
});

test('NCEI overlap detection survives separate continuation actions', async () => {
  const first = await P.discover('ghcn_daily', weather.query, { pageBudget: 1, fetchImpl: async () => response({ count: 4, results: [ghcnItem(1), ghcnItem(2)] }) });
  const next = await P.discover('ghcn_daily', weather.query, { cursor: clone(first.continuation), fetchImpl: async () => response({ count: 4, results: [ghcnItem(2), ghcnItem(3)] }) });
  assert.equal(next.complete, false); assert.equal(next.error.code, 'PAGINATION'); assert.equal(next.stations.length, 0);
  assert.deepEqual(next.continuation, first.continuation); assert.equal(next.searchedRecordsTotal, 2);
});

test('duplicate NCEI records within a page and counts smaller than returned rows fail closed', async () => {
  for (const body of [
    { count: 2, results: [ghcnItem(1), ghcnItem(1)] },
    { count: 0, results: [ghcnItem(1)] },
    { count: 1, results: [ghcnItem(1), ghcnItem(2)] }
  ]) await assert.rejects(P.discover('ghcn_daily', weather.query, { fetchImpl: async () => response(body) }), failure('PAGINATION'));
  const empty = await P.discover('ghcn_daily', weather.query, { fetchImpl: async () => response({ count: 0, results: [] }) });
  assert.equal(empty.complete, true); assert.equal(empty.stations.length, 0);
});

test('missing NCEI record identity cannot bypass the duplicate-page guard', async () => {
  const first = await P.discover('ghcn_daily', weather.query, { pageBudget: 1, fetchImpl: async () => response({ count: 2, results: [ghcnItem(1)] }) });
  for (const id of [undefined, '', null, 123]) {
    const item = ghcnItem(1); item.id = id;
    const next = await P.discover('ghcn_daily', weather.query, { cursor: clone(first.continuation), fetchImpl: async () => response({ count: 2, results: [item] }) });
    assert.equal(next.complete, false); assert.equal(next.error.code, 'SCHEMA'); assert.equal(next.stations.length, 0);
    assert.deepEqual(next.continuation, first.continuation);
  }
});

test('a changing NCEI count leaves the original accepted page and continuation intact', async () => {
  const first = await P.discover('ghcn_daily', weather.query, { pageBudget: 1, fetchImpl: async () => response({ count: 4, results: [ghcnItem(1), ghcnItem(2)] }) });
  for (const count of [3, 5]) {
    const next = await P.discover('ghcn_daily', weather.query, { cursor: clone(first.continuation), fetchImpl: async () => response({ count, results: [ghcnItem(3)] }) });
    assert.equal(next.complete, false); assert.equal(next.error.code, 'PAGINATION');
    assert.equal(next.stations.length, 0); assert.deepEqual(next.continuation, first.continuation);
    assert.match(next.error.message, /start a fresh lookup/);
  }
});

test('NCEI identity and count checks reset for a distinct antimeridian search box', async () => {
  const q = { ...weather.query, lat: 0, lon: 179.9, radiusKm: 50 };
  const first = await P.discover('ghcn_daily', q, { pageBudget: 1, fetchImpl: async () => response({ count: 1, results: [ghcnItem(1, 0, 180)] }) });
  assert.equal(first.continuation.boxIndex, 1); assert.equal(first.continuation.expectedCount, null); assert.deepEqual(first.continuation.seenRecords, []);
  const next = await P.discover('ghcn_daily', q, { cursor: clone(first.continuation), fetchImpl: async () => response({ count: 2, results: [ghcnItem(1, 0, 180), ghcnItem(2, 0, -179.9)] }) });
  assert.equal(next.complete, true); assert.equal(next.searchedRecordsTotal, 3);
  assert.equal(new Set([...first.stations, ...next.stations].map(s => s.id)).size, 2);
});

test('incomplete identity/count cursors cannot bypass NCEI pagination checks', async () => {
  const first = await P.discover('ghcn_daily', weather.query, { pageBudget: 1, fetchImpl: async () => response({ count: 2, results: [ghcnItem(1)] }) });
  for (const patch of [{ version: 1 }, { seenRecords: [] }, { expectedCount: null }, { expectedCount: 0 }, { seenRecords: ['duplicate', 'duplicate'], offset: 2 }]) {
    await assert.rejects(P.discover('ghcn_daily', weather.query, { cursor: { ...first.continuation, ...patch }, fetchImpl: () => assert.fail('Invalid cursor reached network') }), failure('CURSOR'));
  }
});

test('adjustable point radius changes membership without a ten-station truncation', async () => {
  const fetchImpl = async () => response({ count: 2, stations: [{ id: '1234567', name: 'Exact', lat: 38.9, lng: -77.04 }, { id: '1234568', name: 'Nearby', lat: 39.1, lng: -77.04 }] });
  const zero = await P.discover('noaa_coops_water_level', { ...weather.query, radiusKm: 0 }, { fetchImpl });
  const wide = await P.discover('noaa_coops_water_level', { ...weather.query, radiusKm: 30 }, { fetchImpl });
  assert.equal(zero.stations.length, 1); assert.equal(zero.stations[0].relation, 'inside');
  assert.equal(wide.stations.length, 2); assert.equal(wide.stations[1].relation, 'nearby');
  assert.ok(wide.stations[1].distanceKm > 22 && wide.stations[1].distanceKm < 23);
});
test('polygon holes and edge buffers use actual geometry rather than a centroid radius', async () => {
  const poly = rectangle(0, 0, 2, 2); poly.coordinates.push([[0.5, 0.5], [0.5, 1.5], [1.5, 1.5], [1.5, 0.5], [0.5, 0.5]]);
  const q = areaQuery(poly);
  const stations = [{ id: '1234561', name: 'Inside', lat: 1, lng: 0.25 }, { id: '1234562', name: 'Hole', lat: 1, lng: 1 }, { id: '1234563', name: 'Outside', lat: 1, lng: 2.5 }, { id: '1234564', name: 'Boundary', lat: 1, lng: 0 }];
  const fetchImpl = async () => response({ count: stations.length, stations });
  const exact = await P.discover('noaa_coops_water_level', q, { fetchImpl });
  assert.deepEqual(exact.stations.map(s => s.name).sort(), ['Boundary', 'Inside']);
  assert.ok(exact.stations.every(s => s.relation === 'inside' && s.distanceKm === 0));
  const buffered = await P.discover('noaa_coops_water_level', { ...q, bufferKm: 60 }, { fetchImpl });
  assert.equal(buffered.stations.length, 4);
  assert.ok(buffered.stations.filter(s => ['Hole', 'Outside'].includes(s.name)).every(s => s.relation === 'nearby' && s.distanceKm > 55 && s.distanceKm < 56));
});
test('multipart area keeps disjoint components and excludes a station at its centroid gap', async () => {
  const q = areaQuery({ type: 'MultiPolygon', coordinates: [rectangle(0, 0, 1, 1).coordinates, rectangle(3, 0, 4, 1).coordinates] });
  const stations = [{ id: '1234561', name: 'West', lat: 0.5, lng: 0.5 }, { id: '1234562', name: 'Gap', lat: 0.5, lng: 2 }, { id: '1234563', name: 'East', lat: 0.5, lng: 3.5 }];
  const r = await P.discover('noaa_coops_water_level', q, { fetchImpl: async () => response({ count: stations.length, stations }) });
  assert.deepEqual(r.stations.map(s => s.name).sort(), ['East', 'West']);
});
test('antimeridian continuation advances to the other search box without dropping candidates', async () => {
  const q = { ...weather.query, lat: 0, lon: 179.9, radiusKm: 50 };
  const seen = [];
  const fetchImpl = async u => {
    const b = new URL(u).searchParams.get('bbox').split(',').map(Number); seen.push(b);
    const east = b[1] > 0; return response({ count: 1, results: [ghcnItem(east ? 1 : 2, 0, east ? 179.9 : -179.9)] });
  };
  const first = await P.discover('ghcn_daily', q, { pageBudget: 1, fetchImpl });
  assert.equal(first.complete, false); assert.equal(first.continuation.boxIndex, 1);
  const second = await P.discover('ghcn_daily', q, { cursor: first.continuation, fetchImpl });
  assert.equal(second.complete, true); assert.equal(new Set([...first.stations, ...second.stations].map(s => s.id)).size, 2); assert.equal(seen.length, 2);
});
test('USGS all candidates survive name-enrichment limits and name-service failure', async () => {
  let namesRequested = 0;
  const r = await P.discover('usgs_streamflow', weather.query, { fetchImpl: async u => {
    const parsed = new URL(u);
    if (parsed.pathname.includes('time-series-metadata')) return response({ type: 'FeatureCollection', features: Array.from({ length: 125 }, (_, n) => usgsFeature(n + 1)), links: [] });
    namesRequested = (parsed.searchParams.get('filter').match(/USGS-/g) || []).length;
    return response('{}', 429);
  } });
  assert.equal(r.stations.length, 125); assert.equal(r.complete, true); assert.equal(namesRequested, 50);
  assert.match(r.notes.join(' '), /All located candidate IDs have been retained/);
});
test('USGS continuation keeps fixed spatial/parameter filters and uses only the opaque next cursor', async () => {
  const requests = [], fetchImpl = async u => {
    const parsed = new URL(u); if (parsed.pathname.includes('monitoring-locations')) return response({ type: 'FeatureCollection', features: [] });
    requests.push(parsed); const token = parsed.searchParams.get('cursor');
    return token ? response({ type: 'FeatureCollection', features: [usgsFeature(2)], links: [] }) : response({ type: 'FeatureCollection', features: [usgsFeature(1)], links: [{ rel: 'next', href: 'https://api.waterdata.usgs.gov/ogcapi/v1/collections/time-series-metadata/items?cursor=second-page&parameter_code=00065&bbox=0,0,1,1' }] });
  };
  const first = await P.discover('usgs_streamflow', weather.query, { pageBudget: 1, fetchImpl });
  const last = await P.discover('usgs_streamflow', weather.query, { cursor: first.continuation, fetchImpl });
  assert.equal(last.complete, true); assert.equal(last.stations[0].id, 'USGS-00000002');
  assert.equal(requests[1].searchParams.get('parameter_code'), '00060'); assert.equal(requests[1].searchParams.get('bbox'), requests[0].searchParams.get('bbox'));
});
test('CO-OPS list count mismatch retains candidates but requires retry', async () => {
  const r = await P.discover('noaa_coops_water_level', weather.query, { fetchImpl: async () => response({ count: 2, stations: [{ id: '1234567', lat: 38.9, lng: -77.04 }] }) });
  assert.equal(r.stations.length, 1); assert.equal(r.complete, false); assert.equal(r.error.code, 'INCOMPLETE_LIST'); assert.ok(r.continuation);
});
test('area sample provenance retains exact geometry, source, buffer and period', async () => {
  const q = areaQuery(rectangle(-77.1, 38.8, -76.9, 39)); q.bufferKm = 3;
  const r = await P.retrieve('ghcn_daily', weather.station, q, { fetchImpl: async () => response(weather.result.rawText) });
  assert.deepEqual(r.provenance.query, q); assert.deepEqual(r.provenance.site.geometry, q.geometry);
  assert.deepEqual(r.provenance.site.areaSource, q.areaSource); assert.equal(r.provenance.site.bufferKm, 3);
  assert.equal(r.rawText, weather.result.rawText); assert.equal(r.provenance.rawSha256, weather.result.provenance.rawSha256);
});
test('selected USGS station details can fail without discarding a valid observation response', async () => {
  const station = { ...river.station, name: river.station.id };
  const r = await P.retrieve('usgs_streamflow', station, river.query, { fetchImpl: async u => new URL(u).pathname.includes('monitoring-locations') ? response('{}', 503) : response(river.result.rawText) });
  assert.equal(r.observationCount, 3); assert.equal(r.station.id, river.station.id);
  assert.match(r.notes.join(' '), /Station-name details could not be enriched/);
});

test('preview respects distinct USGS series windows instead of bridging a station-envelope gap',()=>{
  const station={...river.station,start:'1950-01-01',end:'2026-01-01',seriesMetadata:[{id:'old',start:'1950-01-01',end:'1980-12-31'},{id:'later',start:'2005-02-28T00:00:00Z',end:'2005-03-02T00:00:00Z'}]};
  const q={...weather.query,start:'1990-01-01',end:'2020-12-31'},w=P.previewWindow('usgs_streamflow',q,station);
  assert.equal(w.start,'2005-02-28');assert.equal(w.end,'2005-03-02');assert.equal(w.basis,'series_metadata');assert.equal(w.shifted,true);
  assert.equal(new URL(P.requestURL('usgs_streamflow',station,q)).searchParams.get('time'),'2005-02-28/2005-03-02');
});

test('preview keeps precipitation-only overlap, merges contiguous periods and stops before a known gap',()=>{
  const station={...laterWeather,start:'1900-01-01',variables:[{key:'TMAX',start:'2000-01-01',end:'2000-01-03'},{key:'PRCP',start:'1999-12-30',end:'1999-12-31'},{key:'TMIN',start:'2000-02-01',end:'2000-12-31'}]};
  const w=P.previewWindow('ghcn_daily',longProject,station);assert.equal(w.start,'1999-12-30');assert.equal(w.end,'2000-01-03');
  const single=P.previewWindow('ghcn_daily',{...longProject,start:'2000-01-03',end:'2000-01-03'},station);assert.equal(single.start,'2000-01-03');assert.equal(single.end,'2000-01-03');assert.equal(single.available,true);
});

test('unknown preview boundaries remain uncertain; malformed or reversed metadata are not guessed',()=>{
  const w=P.previewWindow('ghcn_daily',weather.query,{id:weather.station.id,variables:[{key:'PRCP',start:null,end:null}]});
  assert.equal(w.available,true);assert.equal(w.start,weather.query.start);assert.equal(w.coverageStatus,'unknown_boundaries');assert.match(w.notes.join(' '),/not guaranteed/);
  for(const item of [{key:'TMAX',start:20000101,end:'2020-12-31'},{key:'TMAX',start:'2020-02-30',end:null},{key:'PRCP',start:'2020-01-02',end:'2020-01-01'}])assert.throws(()=>P.previewWindow('ghcn_daily',weather.query,{variables:[item]}),failure('SCHEMA'));
  assert.throws(()=>P.previewWindow('usgs_streamflow',weather.query,{seriesMetadata:[null]}),failure('SCHEMA'));
});

test('shifted retrieval preserves the original query, selected metadata and exact raw bytes',async()=>{
  const raw='[ {"STATION":"USW00013743","DATE":"1941-06-16","TMAX":"25.6","TMAX_ATTRIBUTES":",,Z"} ]';
  const r=await P.retrieve('ghcn_daily',laterWeather,longProject,{fetchImpl:async()=>response(raw)});
  assert.equal(r.rawText,raw);assert.deepEqual(r.provenance.query,longProject);assert.equal(r.provenance.requestedWindow.start,'1900-01-01');assert.equal(r.provenance.retrievedWindow.start,'1941-06-16');assert.equal(r.provenance.retrievedWindow.shifted,true);
  assert.equal(r.provenance.rawSha256,crypto.createHash('sha256').update(raw).digest('hex'));assert.deepEqual(r.station.variables,laterWeather.variables);assert.match(r.notes.join(' '),/shifted from project start/);
});

test('coastal and unclassified CO-OPS metadata preserve MSL explicitly, while invalid Great Lakes flags fail',()=>{
  for(const station of [{...coastal.station,greatlakes:false},coastal.station])assert.equal(new URL(P.requestURL('noaa_coops_water_level',station,coastal.query)).searchParams.get('datum'),'MSL');
  assert.throws(()=>P.requestURL('noaa_coops_water_level',{...coastal.station,greatlakes:'true'},coastal.query),failure('SCHEMA'));
  const r=P._test.makeResult('noaa_coops_water_level',{...coastal.station,greatlakes:false},coastal.query,JSON.parse(coastal.result.rawText),coastal.result.rawText,[]);
  assert.equal(r.provenance.datumCode,'MSL');assert.equal(r.provenance.datum,'MSL (Mean Sea Level)');assert.equal(r.series[0].points[0].value,1.471);
});

test('CO-OPS includes active IDs absent from historicwl without duplicate candidates',async()=>{
  const s=id=>({id,name:id,lat:38.9,lng:-77.04,greatlakes:false});let types=[];
  const r=await P.discover('noaa_coops_water_level',weather.query,{fetchImpl:async u=>{const type=new URL(u).searchParams.get('type');types.push(type);return response({count:2,stations:type==='historicwl'?[s('1234567'),s('1234568')]:[s('1234568'),s('9752621')]});}});
  assert.deepEqual(types,['historicwl','waterlevels']);assert.equal(r.stations.length,3);assert.equal(r.complete,true);assert.deepEqual(r.stations.find(s=>s.id==='1234568').listTypes,['historicwl','waterlevels']);
});

test('second CO-OPS list failure preserves earlier candidates and resumes that list',async()=>{
  const first=await P.discover('noaa_coops_water_level',weather.query,{fetchImpl:async u=>new URL(u).searchParams.get('type')==='historicwl'?response({count:1,stations:[{id:'1234567',lat:38.9,lng:-77.04}]}):response('{}',503)});
  assert.equal(first.complete,false);assert.equal(first.stations.length,1);assert.equal(first.error.code,'HTTP_503');assert.ok(first.continuation);
  let called;
  const last=await P.discover('noaa_coops_water_level',weather.query,{cursor:first.continuation,fetchImpl:async u=>{called=new URL(u).searchParams.get('type');return response({count:1,stations:[{id:'9752621',lat:38.9,lng:-77.04}]});}});
  assert.equal(called,'waterlevels');assert.equal(last.complete,true);assert.equal(last.stations[0].id,'9752621');
});

test('NCEI subdivision is bounded and a persistently capped response cannot establish completeness',async()=>{
  let cursor,result,loaded=0,calls=0;
  const fetchImpl=async()=>{calls++;return response({count:10000,results:[ghcnItem(1)]});};
  do {result=await P.discover('ghcn_daily',weather.query,{cursor,pageBudget:20,fetchImpl});loaded+=result.stations.length;cursor=result.continuation;}while(cursor);
  assert.ok(loaded>0);assert.equal(calls,341);assert.equal(result.subdivisions,85);assert.equal(result.complete,false);assert.equal(result.paginationComplete,false);assert.match(result.notes.join(' '),/10000/);assert.match(result.notes.join(' '),/narrow/i);
});

test('NCEI uses supported1000-record pages without a1000-station total cap',async()=>{
 const calls=[];
 const result=await P.discover('ghcn_daily',weather.query,{fetchImpl:async u=>{
  const params=new URL(u).searchParams,limit=Number(params.get('limit')),offset=Number(params.get('offset'));calls.push({limit,offset});
  assert.equal(limit,1000);
  return response({count:1203,results:Array.from({length:Math.min(limit,1203-offset)},(_,i)=>ghcnItem(offset+i+1))});
 }});
 assert.equal(result.complete,true);assert.equal(result.stations.length,1203);assert.deepEqual(calls,[{limit:1000,offset:0},{limit:1000,offset:1000}]);
});

test('1000-row NCEI continuation retains offset and duplicate-page safety',async()=>{
 const first=await P.discover('ghcn_daily',weather.query,{pageBudget:1,fetchImpl:async()=>response({count:1203,results:Array.from({length:1000},(_,i)=>ghcnItem(i+1))})});
 assert.equal(first.stations.length,1000);assert.equal(first.complete,false);assert.equal(first.continuation.offset,1000);
 const duplicate=await P.discover('ghcn_daily',weather.query,{cursor:clone(first.continuation),fetchImpl:async u=>{assert.ok(['1000','0'].includes(new URL(u).searchParams.get('offset')));return response({count:1203,results:Array.from({length:203},(_,i)=>ghcnItem(i+1000))});}});
 assert.equal(duplicate.complete,false);assert.equal(duplicate.error.code,'PAGINATION');assert.equal(duplicate.stations.length,0);assert.equal(duplicate.continuation.offset,1000);
 const resumed=await P.discover('ghcn_daily',weather.query,{cursor:duplicate.continuation,fetchImpl:async()=>response({count:1203,results:Array.from({length:203},(_,i)=>ghcnItem(i+1001))})});
 assert.equal(resumed.complete,true);assert.equal(resumed.stations.length,203);assert.equal(resumed.searchedRecordsTotal,1203);
});

test('overlapping large searches recover through a complete same-query response for points and polygons',async()=>{
 for(const q of [weather.query,areaQuery(rectangle(-77.2,38.8,-76.9,39.1))]){
  const urls=[],all=Array.from({length:1203},(_,i)=>ghcnItem(i+1));
  const result=await P.discover('ghcn_daily',q,{fetchImpl:async u=>{
   const p=new URL(u).searchParams;urls.push(new URL(u));
   return response({count:1203,results:p.get('limit')==='1203'?all:p.get('offset')==='0'?all.slice(0,1000):all.slice(999,1202)});
  }});
  assert.equal(result.complete,true);assert.equal(result.stations.length,1203);assert.equal(new Set(result.stations.map(s=>s.id)).size,1203);
  assert.deepEqual(urls.map(u=>[u.searchParams.get('offset'),u.searchParams.get('limit')]),[['0','1000'],['1000','1000'],['0','1203']]);
  for(const key of ['bbox','startDate','endDate','dataset'])assert.equal(new Set(urls.map(u=>u.searchParams.get(key))).size,1);
  assert.equal(result.searchedRecordsTotal,2203);assert.match(result.notes.join(' '),/reconciled/);
 }
});

test('reconciliation rejects changed counts, duplicate IDs, dropped accepted IDs and short responses',async()=>{
 const all=Array.from({length:1203},(_,i)=>ghcnItem(i+1));
 const first=await P.discover('ghcn_daily',weather.query,{pageBudget:1,fetchImpl:async()=>response({count:1203,results:all.slice(0,1000)})});
 const cases=[{count:1204,results:all},{count:1203,results:[...all.slice(1),all[1]]},{count:1203,results:[...all.slice(1),ghcnItem(9999)]},{count:1203,results:all.slice(0,1000)}];
 for(const body of cases){
  const result=await P.discover('ghcn_daily',weather.query,{cursor:clone(first.continuation),fetchImpl:async u=>response(new URL(u).searchParams.get('limit')==='1203'?body:{count:1203,results:all.slice(999,1202)})});
  assert.equal(result.complete,false);assert.equal(result.error.code,'PAGINATION');assert.equal(result.stations.length,0);assert.deepEqual(result.continuation,first.continuation);
 }
});

test('reconciliation HTTP failure and cancellation retain accepted candidates and a retryable cursor',async()=>{
 const all=Array.from({length:1203},(_,i)=>ghcnItem(i+1));
 const first=await P.discover('ghcn_daily',weather.query,{pageBudget:1,fetchImpl:async()=>response({count:1203,results:all.slice(0,1000)})});
 for(const kind of ['429','cancel']){
  const controller=new AbortController();let calls=0;
  const result=await P.discover('ghcn_daily',weather.query,{cursor:clone(first.continuation),signal:controller.signal,fetchImpl:async u=>{
   calls++;if(new URL(u).searchParams.get('limit')==='1203'){
    if(kind==='429')return response('{}',429);
    controller.abort();throw new DOMException('Aborted','AbortError');
   }return response({count:1203,results:all.slice(999,1202)});
  }});
  assert.equal(calls,2);assert.equal(result.complete,false);assert.equal(result.error.code,kind==='429'?'HTTP_429':'CANCELLED');assert.deepEqual(result.continuation,first.continuation);
 }
});
