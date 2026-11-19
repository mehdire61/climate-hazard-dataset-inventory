const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const areas = require('../src/areas.js');
const geography = require('../data/geography.json');
const opts = {data:geography};
const polygon = {type:'Polygon',coordinates:[[[-77,38],[-76,38],[-76,39],[-77,39],[-77,38]]]};
const payload = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const censusItem = {id:'24031',name:'Montgomery County, Maryland',kind:'county',layer:82};

test('country lookup uses sourced names/ISO; no network request until selection',async () => {
  const result = await areas.search({kind:'country',text:'IRN'}, {...opts,fetchImpl:() => assert.fail('unexpected network')});
  assert.equal(result.items.length,1); assert.equal(result.items[0].iso3,'IRN');
  assert.equal(result.items[0].kind,'country');
});
test('Census search uses fixed vintage and state, escapes apostrophe without SQL wildcard expansion',async () => {
  const result = await areas.search({kind:'county',text:"O'Brien",state:'MD'},{...opts,fetchImpl:async target => {
    const u = new URL(target); assert.match(u.pathname,/tigerWMS_ACS2026\/MapServer\/82\/query/);
    assert.equal(u.searchParams.get('where'),"UPPER(NAME) LIKE '%O''BRIEN%' AND STATE='24'");
    return payload({features:[{attributes:{GEOID:'24031',NAME:'Montgomery County',STATE:'24'}}]});
  }});
  assert.equal(result.items[0].name,'Montgomery County, Maryland');
  assert.equal(result.items[0].source.vintage,'2026-01-01');
  assert.ok(result.requests[0].rawSha256);
});
test('invalid names and states fail before network',async () => {
  for(const input of [{kind:'county',text:'%all'}, {kind:'county',text:'a'}, {kind:'county',text:'Rockville',state:'not-a-state'}])
    await assert.rejects(areas.search(input,{...opts,fetchImpl:() => assert.fail('network')}));
});
test('truncated name results and partial place-layer failure are explicit',async () => {
  const result = await areas.search({kind:'place',text:'Rockville'},{...opts,fetchImpl:async target => {
    if(target.includes('/30/')) throw new Error('offline');
    return payload({features:[{attributes:{GEOID:'2467675',NAME:'Rockville city',STATE:'24'}}],exceededTransferLimit:true});
  }});
  assert.equal(result.items.length,1); assert.equal(result.complete,false);
  assert.match(result.notes.join(' '),/incomplete/); assert.match(result.notes.join(' '),/Refine/);
});
test('loaded boundary retains full geometry, fixed vintage, exact response hash and query',async () => {
  const body = {type:'FeatureCollection',features:[{type:'Feature',properties:{GEOID:'24031'},geometry:polygon}]};
  const result = await areas.load(censusItem,{...opts,fetchImpl:async target => {
    const u = new URL(target); assert.equal(u.searchParams.get('outSR'),'4326');
    assert.equal(u.searchParams.get('maxAllowableOffset'),null);
    return payload(body);
  }});
  assert.deepEqual(result.geometry,polygon); assert.equal(result.source.vintage,'2026-01-01');
  assert.equal(result.source.rawSha256,crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'));
  assert.equal(result.source.geometrySha256,crypto.createHash('sha256').update(JSON.stringify(polygon)).digest('hex'));
});
test('wrong or partial Census geometry cannot become a project boundary',async () => {
  for (const body of [{type:'FeatureCollection',features:[]}, {type:'FeatureCollection',exceededTransferLimit:true,features:[{geometry:polygon}]}, {type:'FeatureCollection',features:[{properties:{GEOID:'other'},geometry:polygon}]}])
    await assert.rejects(areas.load(censusItem,{...opts,fetchImpl:async () => payload(body)}));
});
test('bundled countries preserve source coordinates and need no download',async()=>{
  const reference=require('../data/country-boundaries.json');
  for(const feature of reference.features){
    const before=JSON.stringify(feature.geometry);
    const result=await areas.load({id:feature.properties.id,kind:'country'}, {fetchImpl:()=>assert.fail('unexpected network')});
    assert.deepEqual(result.geometry,feature.geometry,feature.properties.id);
    assert.equal(JSON.stringify(feature.geometry),before);
    assert.equal(result.source.generalized,true);
    assert.equal(result.source.geometrySha256,crypto.createHash('sha256').update(before).digest('hex'));
  }
  assert.equal(reference.features.length,242);
});
test('unknown country IDs and cancelled loads fail without network',async()=>{
  const options={fetchImpl:()=>assert.fail('unexpected network')};
  await assert.rejects(areas.load({id:'unknown',kind:'country'},options),/missing/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(areas.load({id:'IRN',kind:'country'},{...options,signal:controller.signal}),{name:'AbortError'});
});
test('cancellation and provider errors are not empty successful area searches',async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(areas.search({kind:'county',text:'Montgomery'},{...opts,signal:controller.signal,fetchImpl:async (_target,{signal}) => { signal.throwIfAborted(); }}), {name:'AbortError'});
  await assert.rejects(areas.search({kind:'state',text:'Maryland'},{...opts,fetchImpl:async () => payload({error:{message:'service error'}})}), /service error/);
});
