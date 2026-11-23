const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {gunzipSync} = require('node:zlib');
const {createHash} = require('node:crypto');
const areas = require('../src/areas.js');
const geometry = require('../src/geometry.js');
require('../src/screening.js');
const projects = require('../src/project-state.js');
const trials = require('../docs/evidence/wbd/boundary-trial.json');
const raw = gunzipSync(readFileSync(join(__dirname, 'fixtures/wbd/pimmit-huc12-screening.geojson.gz')));
const feature = JSON.parse(raw).features[0];
const item = {kind:'huc12', id:'020700100103'};
const json = body => new Response(JSON.stringify(body));
const noNetwork = () => assert.fail('Invalid input must be rejected before requesting data');

test('HUC12, HUC10 and HUC8 query the correct WBD layer and preserve leading zeros', async () => {
  for (const [kind, id, layer] of [['huc12',item.id,6], ['huc10','0207001001',5], ['huc8','02070010',4]]) {
    const result = await areas.search({kind, text:id}, {fetchImpl:async target => {
      const url = new URL(target);
      assert.ok(url.pathname.endsWith('/' + layer + '/query'));
      assert.equal(url.searchParams.get('where'), kind + "='" + id + "'");
      assert.equal(url.searchParams.get('returnGeometry'), 'false');
      return json({features:[{attributes:{[kind]:id, name:'Potomac', states:'DC,MD,VA'}}]});
    }});
    assert.equal(result.items[0].id, id);
    assert.match(result.items[0].name, /DC,MD,VA/);
  }
});

test('name and point searches present ambiguous or truncated matches for explicit selection', async () => {
  const features = [item.id,'020700100104'].map(id => ({attributes:{huc12:id,name:"King's Run",states:'VA'}}));
  for (const input of [{text:"King's"},{point:{lon:-77.04,lat:38.9}}]) {
    const result = await areas.search({kind:'huc12', ...input}, {fetchImpl:async target => {
      const q = new URL(target).searchParams;
      if (input.point) {
        assert.equal(q.get('geometry'),'-77.04,38.9');
        assert.equal(q.get('spatialRel'),'esriSpatialRelIntersects');
      } else assert.equal(q.get('where'),"UPPER(name) LIKE '%KING''S%'");
      return json({features, exceededTransferLimit:true});
    }});
    assert.equal(result.items.length,2);
    assert.equal(result.complete,false);
  }
  const empty = await areas.search({kind:'huc12',point:{lon:0,lat:0}},{fetchImpl:async()=>json({features:[]})});
  assert.deepEqual(empty.items,[]);
});

test('invalid codes, wildcard searches and invalid coordinates are rejected', async () => {
  for (const input of [{text:'20700100103'},{text:'12%_'},{point:{lon:190,lat:30}}]) {
    await assert.rejects(areas.search({kind:'huc12',...input},{fetchImpl:noNetwork}));
  }
  await assert.rejects(areas.search({kind:'huc12',text:item.id},{fetchImpl:async()=>json({features:[{attributes:{huc12:'020700100104',name:'Other',states:'VA'}}]})}),/different/);
});

test('WBD geometry must match one complete selected unit, including on retry or cancellation', async () => {
  for (const data of [{features:[]},{features:[feature,feature]},{features:[feature],exceededTransferLimit:true},
    {features:[{...feature,properties:{...feature.properties,huc12:'020700100104'}}]}]) {
    await assert.rejects(areas.load(item,{fetchImpl:async()=>json({type:'FeatureCollection',...data})}));
  }
  await assert.rejects(areas.load(item,{wbdDetail:'other',fetchImpl:noNetwork}),/detail/);
  await assert.rejects(areas.load(item,{fetchImpl:async()=>new Response('',{status:503})}),/503/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(areas.load(item,{signal:controller.signal,fetchImpl:async(_url,{signal})=>signal.throwIfAborted()}), {name:'AbortError'});
});

test('the provider screening geometry, precision, reported area and digest travel together', async () => {
  const baseline = trials.cases.find(c => c.code === item.id);
  assert.equal(createHash('sha256').update(raw).digest('hex'), baseline.general.sha256);
  const area = await areas.load(item,{fetchImpl:async target => {
    const q = new URL(target).searchParams;
    assert.equal(q.get('maxAllowableOffset'),'0.00001');
    assert.equal(q.get('outSR'),'4326');
    return new Response(raw);
  }});
  const {source,geometry:shape} = area;
  assert.deepEqual(shape,geometry.normalize(feature));
  assert.equal(source.geometrySha256,createHash('sha256').update(JSON.stringify(shape)).digest('hex'));
  assert.equal(source.request.rawSha256,baseline.general.sha256);
  assert.equal(source.featureLoadDate,'2024-08-15');
  assert.equal(source.providerAreaKm2,102.85);
  assert.equal(new URL(source.fullGeometryUrl).searchParams.has('maxAllowableOffset'),false);
  const project = {schema:'climate-inventory-project/1',selectedId:'usgs_streamflow',hazard:'flood',
    query:{mode:'area',geometry:shape,areaName:area.name,areaSource:source,bufferKm:0,start:'2020-01-01',end:'2020-01-02'}};
  assert.throws(()=>projects.fragment(project),/project file/);
  const reopen = p => projects.parse(JSON.stringify(p),['usgs_streamflow'],['flood']);
  const restored = reopen(project);
  assert.deepEqual(restored.query.geometry,shape);
  assert.equal(restored.query.areaSource.id,item.id);
  assert.equal(restored.query.areaSource.featureLoadDate,source.featureLoadDate);
  assert.equal(restored.query.areaSource.maxAllowableOffsetDegrees,0.00001);
  assert.equal(restored.query.areaSource.reportedGeometrySha256,source.geometrySha256);
  assert.equal(restored.query.areaSource.reportedResponseSha256,source.request.rawSha256);
  assert.equal(restored.query.areaSource.reportedRetrievedAt,source.retrievedAt);
  assert.deepEqual(reopen(restored),restored);
  project.query.geometry = geometry.rectangle(-80,37,-79,38);
  const edited = reopen(project).query.areaSource;
  assert.equal(edited.kind,'project-link');
  assert.equal(edited.provider,undefined);
});

test('full detail omits the generalization parameter and enforces the same geometry limits', async () => {
  const area = await areas.load(item,{wbdDetail:'full',fetchImpl:async target => {
    assert.equal(new URL(target).searchParams.has('maxAllowableOffset'),false);
    return json({type:'FeatureCollection',features:[{...feature,geometry:geometry.rectangle(-78,38,-77,39)}]});
  }});
  assert.equal(area.source.generalized,false);
  assert.equal(area.source.maxAllowableOffsetDegrees,0);
  await assert.rejects(areas.load(item,{wbdDetail:'full',fetchImpl:async()=>new Response('',{headers:{'content-length':9000000}})}),/8 MB/);
});
