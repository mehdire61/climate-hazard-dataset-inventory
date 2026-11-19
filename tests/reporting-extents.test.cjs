const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../src/screening'),G=require('../src/geometry');
const {products}=require('../data/catalog.json'),{rules}=require('../data/screening.json');
const catalog=new Map(products.map(p=>[p.product_id,p]));
const point=(lat,lon,radiusKm=0)=>({mode:'point',lat,lon,radiusKm});
const area=(w,s,e,n,bufferKm=0)=>({mode:'area',geometry:G.rectangle(w,s,e,n),bufferKm});
const evaluate=(id,q,dates={})=>S.evaluate(catalog.get(id),rules[id],{start:'2024-06-01',end:'2024-06-05',...q,...dates},'2026-11-17');

test('regional station scope distinguishes domestic land, actual coastal locations, and cross-border searches',()=>{
  const maryland={mode:'area',geometry:G.normalize(require('../data/geography.json').examples.find(e=>e.id==='maryland').geometry),bufferKm:0};
  for(const id of ['usgs_streamflow','noaa_coops_water_level']){
    const row=evaluate(id,maryland);
    assert.equal(row.spatialRelation,'within');assert.equal(row.networkInScope,true);
    assert.equal(row.label,'Find a station');assert.ok(!row.notices.includes('Check extent edge'));
  }
  const bermuda=point(32.37,-64.7,30),station=evaluate('noaa_coops_water_level',bermuda);
  assert.equal(station.spatial,'Mapped water-level station in search area');
  assert.equal(station.spatialRelation,'within');assert.equal(station.networkInScope,true);
  assert.equal(evaluate('usgs_streamflow',bermuda).networkInScope,false);
  assert.equal(evaluate('usgs_streamflow',area(-111,48,-109,50)).spatialRelation,'near');
  assert.equal(evaluate('usgs_streamflow',area(-79.5,43.6,-79.3,43.75)).networkInScope,false);
  const kisumu=point(-.1,34.75,50),dates={start:'2020-04-01',end:'2020-05-31'};
  const group=require('../data/hazard_groups.json').find(g=>g.id==='flood');
  const actual=group.products.filter(id=>{const r=evaluate(id,kisumu,dates);return r.status!=='excluded'&&r.networkInScope!==false;});
  assert.deepEqual(actual,['grdc_discharge','gsim_indices','gesla3','gesla41','psmsl_rlr','dfo_event_archive','fathom_gfm3','cems_rapid_mapping','cems_gfm','c3s_lake_water_level']);
  assert.equal(evaluate('noaa_coops_water_level',kisumu,dates).label,'Find a station');
});

test('MRMS separates grid envelopes from nominal radar range and preserves multisensor gap filling',()=>{
  const dates={start:'2024-08-16',end:'2024-08-19'};
  for(const id of ['mrms_radaronly_qpe','mrms_multisensor_qpe','mrms_mesh']){
    for(const q of [point(32.37,-64.70,30),area(-65,32,-64.3,32.7)]){
      const result=evaluate(id,q,dates);
      assert.equal(result.label,'Check radar coverage');assert.equal(result.spatialRelation,'unknown');
      assert.equal(result.status,'unresolved');
      assert.equal(result.reasons.some(s=>s.includes('gauge or model')),id==='mrms_multisensor_qpe');
    }
    const inland=evaluate(id,point(29.76,-95.37,30),dates);
    assert.equal(inland.spatial,'Inside nominal radar range');assert.equal(inland.status,'possible');
    const subset=area(-76.95,38.7,-76.7,38.9);
    assert.equal(evaluate(id,subset,dates).spatial,'Inside nominal radar range');
    const a=G.rectangle(-65,32,-64.3,32.7),b=G.rectangle(-96,29.5,-95.3,30.1);
    const multi={mode:'area',bufferKm:0,geometry:{type:'MultiPolygon',coordinates:[a.coordinates,b.coordinates]}};
    assert.equal(evaluate(id,multi,dates).status,'unresolved');
    assert.notEqual(evaluate(id,point(53.55,-113.49),dates).status,'excluded'); // Edmonton can have Canadian radar contributions.
    assert.equal(evaluate(id,point(-.1,34.75),dates).status,'excluded');
  }
});

test('NWS public and coastal zones distinguish international date-line sites, island jurisdictions, and marine water',()=>{
  const excluded=[point(-16.85,-179.97,10),point(-16.85,179.97,10),point(-16.85,180),point(-16.85,-180),
    area(179.7,-17,-179.7,-16.5,50),point(-21.14,-175.2),point(-13.83,-171.75),point(-19.83,34.84),point(-.1,34.75),point(90,0)];
  const included=[point(38.9,-77.04),point(61.2,-149.9),point(21.3,-157.85),point(-14.28,-170.70),
    point(-14.6,-170.7),point(-14.54,-168.15),point(13.47,144.75),point(15.18,145.75),point(6.95,158.21),
    point(7.1,171.36),point(7.34,134.47),point(18.45,-66.1),point(18.34,-64.93),point(43,-87.1),area(-170.85,-14.4,-170.7,-14.27)];
  for(const id of ['ncei_storm_events_hail','ncei_storm_events_thunderstorm_wind','ncei_storm_events_tornado']){
    for(const q of excluded)assert.equal(evaluate(id,q).status,'excluded',id+' '+JSON.stringify(q));
    for(const q of included)assert.notEqual(evaluate(id,q).status,'excluded',id+' '+JSON.stringify(q));
    assert.equal(evaluate(id,point(-16,-170.7)).status,'excluded');
    assert.equal(evaluate(id,point(-16,-170.7,170)).spatialRelation,'near');
    assert.notEqual(evaluate(id,area(-170.8,-16.25,-170.6,-16,170)).status,'excluded');
  }
});
test('SWOT latitude screening honors search radius, buffered areas, both hemispheres and the approximate edge',()=>{
  for(const id of ['swot_raster_d','swot_riversp_d']){
    for(const q of [point(87.5,40,200),point(-87.5,40,200),area(20,86,21,87,40)])assert.equal(evaluate(id,q).status,'excluded');
    assert.equal(evaluate(id,point(78.5,40)).spatialRelation,'unknown');
    assert.equal(evaluate(id,point(77,40)).spatialRelation,'within');
    assert.equal(evaluate(id,point(80,40,280)).spatialRelation,'partial');
    assert.equal(evaluate(id,area(20,79.4,21,80,200)).spatialRelation,'partial');
    const separated={mode:'area',bufferKm:0,geometry:{type:'MultiPolygon',coordinates:[G.rectangle(20,85,21,86).coordinates,G.rectangle(20,-86,21,-85).coordinates]}};
    assert.equal(evaluate(id,separated).status,'excluded');
  }
});
test('fixed-event relevance requires the survey region and Harvey event dates',()=>{
  const id='usgs_hwm_harvey_2017',dates={start:'2017-08-25',end:'2017-08-31'};
  assert.equal(evaluate(id,point(29.76,-95.37),dates).eventStudyMatch,true);
  assert.equal(evaluate(id,area(-95.4,29.75,-95.35,29.8),dates).eventStudyMatch,true);
  assert.ok(!evaluate(id,point(32.78,-96.8),dates).eventStudyMatch);
  assert.ok(!evaluate(id,point(29.76,-95.37),{start:'2017-08-01',end:'2017-08-05'}).eventStudyMatch);
  assert.ok(!evaluate(id,area(-101,26,-92,32),dates).eventStudyMatch);
});
test('Stage IV distinguishes mostly onshore projects inside the decoded CONUS grid from marginal coastal or foreign areas',()=>{
  const geometry=require('../data/geography.json').examples.find(e=>e.id==='maryland').geometry;
  const dates={start:'2018-07-01',end:'2018-07-07'};
  const r=evaluate('stage_iv',{mode:'area',bufferKm:0,geometry},dates);
  assert.equal(r.spatial,'Inside CONUS grid footprint');
  assert.equal(r.status,'possible');
  assert.match(r.reasons.join(' '),/coastal cells/);
  assert.equal(evaluate('stage_iv',area(-75.5,37,-74.5,38),dates).spatialRelation,'near');
  assert.equal(evaluate('stage_iv',area(-111,48,-109,50),dates).spatialRelation,'near');
});
