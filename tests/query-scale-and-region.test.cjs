const test=require('node:test');
const assert=require('node:assert/strict');
const screen=require('../src/screening.js');
const geo=require('../src/geometry.js');
const {products}=require('../data/catalog.json');
const {rules}=require('../data/screening.json');
const county=require('../data/geography.json').examples.find(e=>e.id==='montgomery-md').geometry;
const harvey={mode:'point',lat:29.76,lon:-95.37,radiusKm:25,start:'2017-08-24',end:'2017-09-03'};
const queryFor=g=>({...harvey,mode:'area',geometry:g,bufferKm:0});
function check(id,q){return screen.evaluate(products.find(p=>p.product_id===id),rules[id],q,'2026-11-17');}

test('a contained county has ordinary regional eligibility without implying observations, marks or valid pixels',()=>{
  const results=screen.evaluateAll(products,rules,queryFor(county),'2026-11-17');
  for(const id of ['usgs_streamflow','noaa_coops_water_level','stage_iv','mtbs','ncei_storm_events_hail']){
    const r=results.find(r=>r.productId===id);
    assert.equal(r.spatialRelation,'within',id);
    assert.equal(r.spatial,'Inside mapped provider region',id);
    assert.ok(r.reasons.some(reason=>reason.includes('Verify local stations')),id);
  }
  assert.equal(results.find(r=>r.productId==='usgs_streamflow').label,'Find a station');
});

test('border crossing, foreign land in a broad box, offshore, and distant foreign network lookup retain qualifications',()=>{
  for(const shape of [geo.rectangle(-111,48,-109,50),geo.rectangle(-79.5,43.6,-79.3,43.75),geo.rectangle(-75.5,37,-74.5,38)]){
    for(const id of ['usgs_streamflow','stage_iv'])assert.equal(check(id,queryFor(shape)).spatialRelation,'near',id);
  }
  assert.equal(check('usgs_streamflow',{...harvey,lat:-1.2921,lon:36.8219}).spatialRelation,'unknown');
  const coast=geo.rectangle(-77.4,38.8,-77.2,39);
  const outside=geo.rectangle(-75.2,37.2,-75,37.5);
  const multipart={type:'MultiPolygon',coordinates:[coast.coordinates,outside.coordinates]};
  assert.equal(check('stage_iv',queryFor(multipart)).spatialRelation,'near');
});

test('a project can touch the generalized provider boundary without extending across it',()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const ref={type:'Feature',properties:{id:'USA'},geometry:geo.rectangle(-96,29,-95,30)};
  const context={SiteGeometry:geo,turf:require('../vendor/turf.min.js'),InventoryApp:{data:{countryBoundaries:{features:[ref]}}},Date,URL};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/screening.js'),'utf8'),context);
  const p=products.find(x=>x.product_id==='stage_iv');
  const relation=shape=>context.SiteScreening.evaluate(p,rules.stage_iv,queryFor(shape),'2026-11-17').spatialRelation;
  assert.equal(relation(geo.rectangle(-95.9,29.3,-95.4,29.6)),'within');
  assert.equal(relation(geo.rectangle(-95.9,29.3,-95,29.6)),'near');
});

test('short submonthly requests preserve archive dates and distinguish aggregate statistics from within-file daily data',()=>{
  for(const [id,label] of [['gpcc_monthly_v2025','Monthly totals only'],['hadex3','Monthly or coarser indices']]){
    const r=check(id,harvey);
    assert.equal(r.label,label);assert.equal(r.status,'possible');
    assert.ok(r.temporalSegments.every(s=>s.kind==='documented'));
    assert.equal(r.resolutionChecks[0].dimension,'time');
    assert.equal(check(id,{...harvey,start:'2016-02-01',end:'2016-02-29'}).resolutionChecks.length,0);
    assert.equal(check(id,{...harvey,start:'2016-02-01',end:'2016-02-28'}).resolutionChecks.length,1);
  }
  assert.equal(check('mcd64a1',harvey).resolutionChecks.length,0);
  assert.equal(check('stage_iv',harvey).resolutionChecks.length,0);
});

test('GRACE warns about point and small-polygon support independently of monthly solutions',()=>{
  const id='grace_jpl_mascon_cri_rl063_v04';
  const period={start:'2020-07-01',end:'2020-07-31'};
  const r=check(id,{...queryFor(county),...period});
  assert.equal(r.label,'Monthly solution documented');assert.equal(r.temporalSegments[0].kind,'documented');
  const space=r.resolutionChecks.find(c=>c.dimension==='space');
  assert.ok(space.projectAreaKm2>1300&&space.projectAreaKm2<1320);
  assert.ok(space.nativeMeanAreaKm2>112000&&space.nativeMeanAreaKm2<113000);
  assert.equal(space.evidenceId,'GRACE_GUIDE');
  const point=check(id,{...harvey,start:'2020-07-01',end:'2020-07-03'});
  assert.deepEqual(point.resolutionChecks.map(c=>c.dimension),['time','space']);
  assert.equal(point.resolutionChecks[1].projectAreaKm2,null);
  const large=geo.rectangle(-110,28,-90,43);
  assert.equal(check(id,{...queryFor(large),...period}).resolutionChecks.length,0);
  const outer=geo.rectangle(170,-20,-170,-10);
  assert.ok(geo.areaKm2(outer)>2000000);
  const hole=geo.rectangle(-108,29,-100,35);
  assert.ok(Math.abs(geo.areaKm2({type:'Polygon',coordinates:[large.coordinates[0],hole.coordinates[0]]})-(geo.areaKm2(large)-geo.areaKm2(hole)))<0.01);
});
