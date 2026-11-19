const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const vm = require('node:vm');
const screen = require('../src/screening.js');
const geometry = require('../src/geometry.js');
const read = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '../data', name), 'utf8'));
const catalog = read('catalog.json');
const rules = read('screening.json').rules;
const sourceIds = new Set(read('sources.json').map((source) => source.evidence_id));
const products = Object.fromEntries(catalog.products.map((product) => [product.product_id, product]));
const base = {lat: 38.9, lon: -77.04, start: '2020-07-01', end: '2020-07-03'};
const evaluate = (id, query = {}, rule = rules[id]) => screen.evaluate(products[id], rule, {...base, ...query});

test('all 53 catalog records have explicit rules and existing source evidence', () => {
  assert.equal(Object.keys(rules).length, 53);
  assert.deepEqual(Object.keys(rules).sort(), Object.keys(products).sort());
  for (const [id, rule] of Object.entries(rules)) {
    assert.ok(rule.evidence_ids.length, id);
    assert.ok(rule.evidence_ids.every((evidence) => sourceIds.has(evidence)), id);
    assert.deepEqual(rule.evidence_ids, products[id].evidence_ids);
    assert.ok(rule.support_type && rule.time_step && rule.access_requirement && rule.note, id);
    assert.equal(rule.catalog_documentation_checked_on, products[id].last_checked_date);
    assert.ok(!evaluate(id).reasons.some((reason) => reason.includes('metadata is missing or invalid')), id);
  }
});
test('strict numeric WGS84 coordinates reject coercion and nonfinite values', () => {
  for (const value of [null, '', '38.9', NaN, Infinity, -Infinity, undefined]) {
    assert.ok(screen.validate({...base, lat: value}).length);
    assert.ok(screen.validate({...base, lon: value}).length);
  }
  for (const lat of [-90, 90]) for (const lon of [-180, 180]) assert.deepEqual(screen.validate({...base, lat, lon}), []);
  assert.ok(screen.validate({...base, lat: 90.0001}).length);
  assert.ok(screen.validate({...base, lon: -180.0001}).length);
});
test('Gregorian dates reject impossible days, year zero, timestamps and inverted ranges', () => {
  for (const start of ['1900-02-29', '2023-02-29', '2020-04-31', '0000-01-01', '2020-2-01', '2020-01-01T00:00:00Z', '2020-00-01']) {
    assert.ok(screen.validate({...base, start}).length, start);
  }
  assert.deepEqual(screen.validate({...base, start:'2000-02-29', end:'2000-02-29'}), []);
  assert.deepEqual(screen.validate({...base, start:'0001-01-01', end:'0001-01-01'}), []);
  assert.ok(screen.validate({...base, start:'2020-07-04'}).length);
});
test('historical mode has an explicit UTC future-date boundary', () => {
  assert.deepEqual(screen.validate({...base, start:'2026-11-13', end:'2026-11-13'}, '2026-11-13'), []);
  assert.match(screen.validate({...base, start:'2026-11-14', end:'2026-11-14'}, '2026-11-13').join(' '), /Historical/);
});
test('invalid input and absent/malformed rules fail closed to unresolved', () => {
  assert.equal(evaluate('era5_t2m', {lat:NaN}).status, 'unresolved');
  assert.equal(evaluate('era5_t2m', {}, null).status, 'unresolved');
  const bad = structuredClone(rules.era5_t2m);
  bad.time.intervals[0].start = '1940-02-31';
  assert.equal(evaluate('era5_t2m', {}, bad).status, 'unresolved');
  for (const patch of [{support_type:'not-a-real-kind'}, {evidence_ids:[]}, {evidence_ids:null}, {evidence_ids:['']},
    {curation_reviewed_on:'2026-02-30'}, {time_step:''}, {time_step:'every_42_minutes'}, {access_requirement:null}, {access_requirement:'definitely_free'}]) {
    assert.equal(evaluate('era5_t2m', {}, {...rules.era5_t2m,...patch}).status,'unresolved');
  }
});
test('station products need station/element checks even inside their country', () => {
  for (const id of ['usgs_streamflow', 'ghcn_daily', 'noaa_coops_water_level']) {
    assert.equal(evaluate(id).status, 'unresolved');
    assert.equal(evaluate(id, {lat:35.7, lon:51.4}).status, 'unresolved');
    assert.match(evaluate(id).temporal, /station/);
  }
});
test('land masks never become affirmative site coverage', () => {
  const ocean = evaluate('chirps_v3_daily_rnl', {lat:0, lon:-140});
  assert.equal(ocean.status, 'unresolved');
  assert.match(ocean.label, /Check/);
  assert.match(ocean.reasons.join(' '), /check the provider land mask/);
  assert.match(ocean.reasons.join(' '), /not a no-land or no-data finding/);
});
test('CHIRPS versions use different nominal latitude limits with inclusive edges', () => {
  assert.equal(evaluate('chirps_v2_daily', {lat:55}).status, 'excluded');
  assert.equal(evaluate('chirps_v3_daily_rnl', {lat:55}).status, 'possible');
  assert.equal(evaluate('chirps_v3_daily_rnl', {lat:60}).status, 'possible');
  assert.equal(evaluate('chirps_v3_daily_rnl', {lat:60.0001}).status, 'excluded');
  assert.equal(evaluate('chirps_v3_daily_rnl', {lat:-60.0001}).status, 'excluded');
});
test('CHIRPS sat official readme settles its 1998 start', () => {
  assert.equal(evaluate('chirps_v3_daily_sat', {start:'1999-01-01', end:'1999-12-31'}).status, 'possible');
  assert.equal(evaluate('chirps_v3_daily_sat', {start:'2000-12-31', end:'2001-01-01'}).status, 'possible');
  assert.equal(evaluate('chirps_v3_daily_sat', {start:'1997-01-01', end:'1997-12-31'}).status, 'excluded');
  assert.equal(evaluate('chirps_v3_daily_sat', {start:'2001-01-01', end:'2001-12-31'}).status, 'possible');
});
test('SPEI conflicting outer years and frozen endpoint are handled separately', () => {
  for (const year of [1982,2021]) assert.equal(evaluate('spei_gd_v1', {start:`${year}-01-01`,end:`${year}-12-31`}).status,'unresolved');
  assert.equal(evaluate('spei_gd_v1', {start:'1981-01-01',end:'1981-12-31'}).status,'excluded');
  assert.equal(evaluate('spei_gd_v1', {start:'2022-01-01',end:'2022-12-31'}).status,'excluded');
  assert.equal(evaluate('spei_gd_v1', {start:'1990-01-01',end:'1990-12-31'}).status,'possible');
});
test('event archives do not become continuous coverage or no-event evidence', () => {
  const flood = evaluate('gfd_modis_v1', {start:'2012-01-01',end:'2012-12-31'});
  assert.equal(flood.status,'event');
  assert.match(flood.reasons.join(' '), /not evidence.*dry/);
  assert.equal(evaluate('gfd_modis_v1').status,'excluded');
  assert.equal(evaluate('nasa_coolr').status,'event');
  assert.equal(evaluate('cems_rapid_mapping').status,'event');
});
test('a climate-state map does not use daily observation overlap', () => {
  assert.equal(evaluate('fathom_gfm3', {start:'1850-01-01',end:'1850-12-31'}).status,'special');
  assert.match(evaluate('fathom_gfm3').temporal,/Choose a scenario/);
});
test('known-through dates are soft, while frozen versions have hard endpoints', () => {
  for (const id of ['stage_iv','grace_jpl_mascon_cri_rl063_v04']) {
    const result = evaluate(id,{start:'2026-10-01',end:'2026-10-03'});
    assert.equal(result.status,'unresolved',id);
    assert.match(result.reasons.join(' '),/last checked date|Newer files may exist/,id);
  }
  assert.equal(evaluate('esa_cci_sm_combined_v09_2',{start:'2025-01-01',end:'2025-01-02'}).status,'excluded');
  assert.equal(evaluate('isd_global_hourly',{start:'2025-08-25',end:'2025-08-26'}).status,'excluded');
});
test('partial nominal overlap is disclosed and never promises the full window', () => {
  const result=evaluate('era5_t2m',{start:'1930-01-01',end:'1950-12-31'});
  assert.equal(result.status,'possible');
  assert.equal(result.temporal,'Dates partly fit');
  assert.match(result.reasons.join(' '),/Other requested dates are outside/);
});
test('precise MODIS start dates exclude earlier months', () => {
  assert.equal(evaluate('mcd64a1',{start:'2000-01-01',end:'2000-02-01'}).status,'excluded');
  assert.equal(evaluate('mcd64a1',{start:'1999-01-01',end:'1999-12-31'}).status,'excluded');
});
test('acquisition and approximate orbit metadata do not promise valid pixels', () => {
  assert.equal(evaluate('swot_raster_d',{start:'2024-01-01',end:'2024-01-02'}).status,'unresolved');
  const polar=evaluate('swot_riversp_d',{lat:89,start:'2024-01-01',end:'2024-01-02'});
  assert.equal(polar.status,'excluded');
  assert.equal(polar.spatialRelation,'outside');
  assert.match(polar.reasons.join(' '),/prior river database/);
});
test('NH IMS rejects southern latitudes and records grid-specific start limitations', () => {
  assert.equal(evaluate('ims_snow_ice',{lat:-0.0001}).status,'excluded');
  assert.equal(evaluate('ims_snow_ice',{lat:0}).status,'possible');
  assert.equal(evaluate('ims_snow_ice',{lat:0}).label,'Dates and area fit');
  assert.equal(evaluate('ims_snow_ice',{start:'1997-02-04',end:'1997-02-04'}).status,'excluded');
  assert.match(evaluate('ims_snow_ice').reasons.join(' '),/finer grids start later/);
});
test('antimeridian envelopes and equivalent meridian endpoints behave consistently', () => {
  const rule=structuredClone(rules.era5_t2m);
  rule.domain={kind:'envelope',bounds:[170,-20,-170,20],hard_bounds:true};
  for (const lon of [170,179.9,180,-180,-179.9,-170]) assert.equal(evaluate('era5_t2m',{lat:0,lon},rule).status,'possible',String(lon));
  for (const lon of [0,169.9,-169.9]) assert.equal(evaluate('era5_t2m',{lat:0,lon},rule).status,'excluded',String(lon));
  rule.domain.bounds=[-180,-20,-170,20];
  assert.equal(evaluate('era5_t2m',{lat:0,lon:180},rule).status,'possible');
});
test('separate encoded time windows do not fill temporal gaps', () => {
  const rule=structuredClone(rules.era5_t2m);
  rule.time.intervals=[{start:'2000-01-01',end:'2000-12-31'},{start:'2010-01-01',end:'2010-12-31'}];
  assert.equal(evaluate('era5_t2m',{start:'2005-01-01',end:'2005-12-31'},rule).status,'excluded');
  assert.equal(evaluate('era5_t2m',{start:'2000-01-01',end:'2010-12-31'},rule).temporal,'Dates partly fit');
});
test('the first reason explains exclusions or uncertainty before background context', () => {
  assert.match(evaluate('gfd_modis_v1').reasons[0], /selected dates do not overlap/);
  assert.equal(evaluate('chirps_v3_daily_sat',{start:'1999-01-01',end:'1999-01-03'}).status,'possible');
  assert.match(evaluate('gpm_imerg_final_v07b',{start:'1990-01-01',end:'2026-10-03'}).reasons[0], /Documented date overlap: 1998-01-01 to 2025-09-30/);
  assert.match(evaluate('chirps_v3_daily_sat',{lat:80,start:'1999-01-01',end:'1999-01-03'}).reasons[0], /outside the documented/);
});
test('rule evaluation is deterministic, does not mutate inputs, and always returns traceable results', () => {
  const before=JSON.stringify(rules);
  for (const lat of [-90,-65,-50,0,38.9,60,90]) for (const lon of [-180,-77.04,0,179.99,180]) {
    for (const year of [1800,1900,1982,1999,2012,2020,2025]) {
      const results=screen.evaluateAll(catalog.products,rules,{lat,lon,start:`${year}-01-01`,end:`${year}-12-31`});
      assert.equal(results.length,53);
      for (const result of results) {
        assert.ok(['possible','excluded','unresolved','event','special'].includes(result.status));
        assert.ok(result.productId && result.label && result.spatial && result.temporal && result.reasons.length);
        assert.ok(!/confirmed|suitable|retrieved/i.test(result.label));
      }
    }
  }
  assert.equal(JSON.stringify(rules),before);
});
test('area screening accepts geometry without point coordinates and returns all52 relationships',()=>{
  const query={mode:'area',geometry:geometry.rectangle(-10,55,10,65),bufferKm:0,start:'2020-01-01',end:'2020-12-31'};
  assert.deepEqual(screen.validate(query),[]);
  const results=screen.evaluateAll(catalog.products,rules,query);assert.equal(results.length,53);
  assert.ok(results.every(result=>['within','partial','outside','unknown','near'].includes(result.spatialRelation)));
  const chirps=results.find(result=>result.productId==='chirps_v3_daily_rnl');
  assert.equal(chirps.status,'possible');assert.equal(chirps.spatialRelation,'partial');assert.match(chirps.reasons[0],/Only part/);
  assert.equal(results.find(result=>result.productId==='chirps_v2_daily').status,'excluded');
  assert.equal(results.find(result=>result.productId==='ghcn_daily').spatialRelation,'within');
});
test('area buffer cannot change catalog-domain eligibility or erase a partial overlap',()=>{
  const query={mode:'area',geometry:geometry.rectangle(0,61,10,65),bufferKm:1000,start:'2020-01-01',end:'2020-12-31'};
  const result=screen.evaluate(products.chirps_v3_daily_rnl,rules.chirps_v3_daily_rnl,query);
  assert.equal(result.status,'excluded');assert.equal(result.spatialRelation,'outside');
  assert.match(result.reasons.join(' '),/project is outside/);
});
test('area temporal conflict and scenario distinctions remain intact',()=>{
  const query={mode:'area',geometry:geometry.rectangle(-10,0,10,10),bufferKm:0,start:'1999-01-01',end:'1999-12-31'};
  assert.equal(screen.evaluate(products.chirps_v3_daily_sat,rules.chirps_v3_daily_sat,query).status,'possible');
  assert.equal(screen.evaluate(products.fathom_gfm3,rules.fathom_gfm3,query).status,'special');
  assert.equal(screen.evaluateAll(catalog.products,rules,{...query,geometry:{type:'Polygon',coordinates:[]}}).every(r=>r.status==='unresolved'),true);
});

test('retained grid horizons warn about access and never become hard dataset endpoints',()=>{
  const index=read('grid-access-index.json');
  for(const id of ['chirps_v2_daily','chirps_v3_daily_rnl','chirps_v3_daily_sat','gpcc_monthly_v2025']){
    const snapshot=screen.deriveIndexSnapshot(index,id);
    const r=screen.evaluate(products[id],rules[id],{...base,start:'2026-11-01',end:'2026-11-13'},'2026-11-14');
    assert.equal(r.status,'unresolved',id);assert.equal(r.label,'Check recent files',id);
    assert.match(r.reasons[0],/Files were listed/);assert.ok(r.reasons[0].includes(snapshot.last_file_end));assert.ok(r.reasons[0].includes(snapshot.checked_on));assert.match(r.reasons[0],/Newer files may exist/);
    assert.ok(snapshot.source_urls.every(url=>url.startsWith('https://')));
  }
  assert.equal(evaluate('esa_cci_sm_combined_v09_2',{start:'2025-01-01',end:'2025-01-02'}).status,'excluded');
});

test('build-derived rules and direct Node source rules produce identical snapshot screening',()=>{
  const code="import json,build; original=build.load('screening.json'); before=json.dumps(original,sort_keys=True); derived=build.derive_screening_index_metadata(original,build.load('grid-access-index.json')); assert before==json.dumps(original,sort_keys=True); assert all(build.rule_is_valid(v) for v in derived['rules'].values()); print(json.dumps({k:v for k,v in derived['rules'].items() if v['time'].get('index_reference')}))";
  const result=cp.spawnSync('python',['-B','-X','utf8','-c',code],{cwd:path.join(__dirname,'..'),encoding:'utf8'});assert.equal(result.status,0,result.stderr);const derived=JSON.parse(result.stdout),index=read('grid-access-index.json');
  for(const[id,rule]of Object.entries(derived)){
    assert.deepEqual(rule.time.index_snapshot,screen.deriveIndexSnapshot(index,id));
    for(const period of [{start:'1999-01-01',end:'1999-12-31'},{start:'2020-01-01',end:'2020-12-31'},{start:'2026-11-01',end:'2026-11-13'}]){
      assert.deepEqual(screen.evaluate(products[id],rule,{...base,...period},'2026-11-14'),screen.evaluate(products[id],rules[id],{...base,...period},'2026-11-14'));
    }
  }
  const updated=structuredClone(derived.chirps_v2_daily);updated.time.known_through='2026-11-30';updated.time.index_snapshot.last_file_end='2026-11-30';
  assert.equal(screen.evaluate(products.chirps_v2_daily,updated,{...base,start:'2026-11-01',end:'2026-11-13'},'2026-11-14').status,'possible');
});

test('unavailable or malformed file-index evidence fails conservatively in browser and builder',()=>{
  const context={SiteGeometry:geometry,URL,Date};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/screening.js'),'utf8'),context);
  const r=context.SiteScreening.evaluate(products.chirps_v2_daily,rules.chirps_v2_daily,base,'2026-11-14');assert.equal(r.label,'Check land mask');assert.match(r.reasons.join(' '),/unavailable or invalid/);
  const index=read('grid-access-index.json');for(const patch of [{files:[]},{listingChecks:[]},{listingChecks:[null]},{listingChecks:[{metadataCheckedAt:123,url:'https://example.org'}]}]){
    const bad=structuredClone(index);Object.assign(bad.products.chirps_v2_daily,patch);assert.equal(screen.deriveIndexSnapshot(bad,'chirps_v2_daily'),null);
  }
  for(const patch of [{publication_policy:null},{publication_policy:{kind:'invented',checked_on:'2026-11-14',source_urls:['https://example.org']}},{access_route_end:'2016-02-30'},{known_through:''},{index_reference:'unreviewed'}]){
    const bad=structuredClone(rules.era5_t2m);Object.assign(bad.time,patch);assert.match(evaluate('era5_t2m',{},bad).reasons[0],/missing or invalid/);
  }
  const wrong=structuredClone(rules.chirps_v2_daily);wrong.time.index_reference='gpcc_monthly_v2025';assert.match(evaluate('chirps_v2_daily',{},wrong).reasons[0],/missing or invalid/);
  const code="import build; s=build.load('screening.json'); i=build.load('grid-access-index.json'); i['products']['chirps_v2_daily']['listingChecks']=[]\ntry: build.derive_screening_index_metadata(s,i)\nexcept ValueError: print('rejected')\nelse: raise AssertionError('invalid index accepted')";
  const result=cp.spawnSync('python',['-B','-X','utf8','-c',code],{cwd:path.join(__dirname,'..'),encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/rejected/);
});

test('GFED4 pinned ORNL route ends 2016 without excluding documented later producer extensions',()=>{
  assert.equal(evaluate('gfed4_1s_legacy',{start:'2014-01-01',end:'2014-12-31'}).status,'possible');
  const r=evaluate('gfed4_1s_legacy',{start:'2020-01-01',end:'2020-12-31'});assert.equal(r.status,'unresolved');assert.equal(r.label,'Check recent files');assert.match(r.reasons[0],/2016-12-31/);assert.match(r.reasons[0],/2025/);assert.match(r.reasons[0],/active-fire/);assert.match(r.reasons[0],/not excluded/);assert.equal(rules.gfed4_1s_legacy.time.intervals[0].end,null);
});

test('CHIRPS sat earlier files and current readme settle the older documentation conflict',()=>{
  for(const period of [{start:'1999-01-01',end:'1999-12-31'},{start:'2000-06-01',end:'2000-06-30'}]) assert.equal(evaluate('chirps_v3_daily_sat',period).status,'possible');
  assert.equal(evaluate('chirps_v3_daily_sat',{start:'1997-01-01',end:'1997-12-31'}).status,'excluded');
  assert.equal(rules.chirps_v3_daily_sat.time.uncertain_windows.length,0);
});

test('ERA5 publication delay and provisional status use reproducible UTC dates without exclusion',()=>{
  for(const id of ['era5_t2m','era5_t2m_interval_extrema','era5_wind10','era5_gust10']){
    for(const day of ['2026-11-09','2026-11-13']){const r=screen.evaluate(products[id],rules[id],{...base,start:day,end:day},'2026-11-14');assert.equal(r.status,'unresolved');assert.equal(r.label,'Check recent files');assert.match(r.reasons[0],/about five days/);}
    const recent=screen.evaluate(products[id],rules[id],{...base,start:'2026-10-01',end:'2026-10-02'},'2026-11-14');assert.equal(recent.label,'Check recent files');assert.match(recent.reasons[0],/ERA5T can be preliminary/);
    const old=screen.evaluate(products[id],rules[id],{...base,start:'2026-06-01',end:'2026-06-02'},'2026-11-14');assert.equal(old.status,'possible');
  }
});

test('MERRA-2 monthly release guidance handles month/year transitions and remains soft',()=>{
  const id='merra2_wind10';
  for(const[today,start,end,expected]of[['2026-11-14','2026-10-01','2026-10-31','unresolved'],['2026-11-22','2026-10-01','2026-10-31','possible'],['2026-11-22','2026-11-01','2026-11-02','unresolved'],['2026-01-15','2025-12-01','2025-12-31','unresolved'],['2024-03-14','2024-02-01','2024-02-29','unresolved']]){
    const r=screen.evaluate(products[id],rules[id],{...base,start,end},today);assert.equal(r.status,expected,today);if(expected==='unresolved'){assert.equal(r.label,'Check recent files');assert.match(r.reasons[0],/three weeks after month end/);}
  }
});

test('MCD64A1 current calendar month needs access verification without a fabricated release deadline',()=>{
  const id='mcd64a1';
  for(const [today,start,end] of [['2026-11-14','2026-11-11','2026-11-13'],['2026-11-14','2026-10-20','2026-11-02'],['2026-01-01','2026-01-01','2026-01-01'],['2024-02-29','2024-02-01','2024-02-29']]){
    const r=screen.evaluate(products[id],rules[id],{...base,start,end},today);
    assert.equal(r.status,'unresolved');assert.equal(r.label,start<=r.confirmedThrough?'Latest dates unchecked':'Check recent files');assert.ok(r.confirmedThrough<end);assert.match(r.reasons.join(' '),/current monthly burned-area product/);
  }
  for(const [today,start,end]of [['2026-11-14','2026-09-01','2026-09-30'],['2026-01-01','2025-12-01','2025-12-31'],['2024-03-01','2024-02-01','2024-02-29']]){
    const r=screen.evaluate(products[id],rules[id],{...base,start,end},today);
    assert.equal(r.status,'possible');assert.match(r.reasons.join(' '),/data presence has not been checked/);
  }
  assert.equal(screen.evaluate(products[id],rules[id],{...base,start:'1999-01-01',end:'1999-01-02'},'2026-11-14').status,'excluded');
  const later=screen.evaluate(products[id],rules[id],{...base,start:'2026-10-01',end:'2026-10-31'},'2026-11-14');
  assert.equal(later.status,'unresolved');assert.equal(later.label,'Check recent files');assert.equal(later.temporal,'Recent dates need checking');
  assert.match(later.reasons.join(' '),/last checked date/);
  assert.equal(rules[id].time.intervals[0].end,null);
});

test('partial nominal area/time support receives a distinct label without changing the status enum',()=>{
  const time=evaluate('era5_t2m',{start:'1930-01-01',end:'1950-12-31'});assert.equal(time.status,'possible');assert.equal(time.label,'Part of dates fit');
  const area=screen.evaluate(products.chirps_v3_daily_rnl,rules.chirps_v3_daily_rnl,{mode:'area',geometry:geometry.rectangle(-10,55,10,65),bufferKm:0,start:'2020-01-01',end:'2020-12-31'});assert.equal(area.status,'possible');assert.equal(area.label,'Part of area fits');
});
