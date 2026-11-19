const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../src/earth-access.js');
const G = require('../src/geometry.js');
const collection = {id:'C2271754179-LPCLOUD',shortName:'MOD14',version:'061',label:'Terra MOD14',authRequired:true};
const profile = {productId:'modis_active_fire_standard',kind:'cmr',collections:[collection]};
const query = {mode:'point',lat:38.9,lon:-77.04,radiusKm:100,start:'2020-07-01',end:'2020-07-02'};
const clone = v=>JSON.parse(JSON.stringify(v));
const dataLink = url=>({href:url,rel:'http://esipfed.org/ns/fedsearch/1.1/data#',type:'application/x-hdf'});
const entry = (n=1,c=collection)=>({id:'G'+n+'-LPCLOUD',collection_concept_id:c.id,title:'Granule '+n,time_start:'2020-07-01T00:00:00Z',time_end:'2020-07-01T00:05:00Z',granule_size:'12.5',original_format:'ECHO10',links:[dataLink('https://data.lpdaac.earthdatacloud.nasa.gov/protected/'+n+'.hdf')]});
const response=(entries,hits,next=null,extra={})=>new Response(JSON.stringify({feed:{entry:entries}}),{status:200,headers:{'Content-Type':'application/json','CMR-Hits':String(hits),...(next?{'CMR-Search-After':next}:{}),...extra}});
const code = expected=>e=>e.code===expected;
const fetches = responses=>{const calls=[];return {calls,fetchImpl:async(url,options)=>{calls.push({url,options});const r=responses.shift();if(r instanceof Error)throw r;assert.ok(r,'Unexpected extra request');return r;}};};

test('a 30-second CMR response remains eligible and a caller can impose a shorter timeout',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const fetchImpl=async(_url,{signal})=>{
    t.mock.timers.tick(30000);
    signal.throwIfAborted();
    return response([entry()],1);
  };
  assert.equal((await E.discover(profile,query,{fetchImpl})).complete,true);
  await assert.rejects(E.discover(profile,query,{fetchImpl,timeoutMs:1000}),code('TIMEOUT'));
});

test('point metadata query retains exact coordinates/dates and ignores station radius',async()=>{
  const mock=fetches([response([entry()],1)]),r=await E.discover(profile,query,mock),u=new URL(mock.calls[0].url);
  assert.equal(u.searchParams.get('point'),'-77.04,38.9');assert.equal(u.searchParams.get('temporal'),'2020-07-01T00:00:00Z,2020-07-02T23:59:59.999Z');
  assert.equal(u.searchParams.get('page_size'),'1000');
  assert.equal(u.searchParams.get('collection_concept_id'),collection.id);assert.equal(u.searchParams.has('radius'),false);assert.equal(mock.calls[0].options.credentials,'omit');
  assert.equal(r.complete,true);assert.equal(r.continuation,null);assert.equal(r.files[0].authRequired,true);assert.equal(r.files[0].format,'HDF');assert.equal(r.files[0].sizeMB,12.5);assert.deepEqual(r.query,query);
});
test('area searches retain holes and dateline parts; station buffer is excluded',async()=>{
  const geometry=G.rectangle(170,-10,-170,10),q={mode:'area',geometry,bufferKm:500,start:query.start,end:query.end};
  const scopes=E.scopes(profile,q);assert.equal(scopes.length,2);assert.deepEqual(scopes.map(s=>s.bounding_box).sort(),['-180,-10,-170,10','170,-10,180,10']);
  const mock=fetches(scopes.map(()=>response([],0))),r=await E.discover(profile,q,{...mock,pageBudget:2});assert.deepEqual(r.query.geometry,geometry);assert.equal(r.scope.stationBufferApplied,false);assert.equal(r.complete,true);assert.match(r.notes[0],/not exact polygon clips/);
});
test('global-temporal exception omits spatial filters rather than trusting malformed provider bounds',async()=>{
  const p={...profile,spatialMode:'global'},mock=fetches([response([entry()],1)]),r=await E.discover(p,query,mock),u=new URL(mock.calls[0].url);
  assert.equal(u.searchParams.has('point'),false);assert.equal(u.searchParams.has('bounding_box'),false);assert.match(r.scope.spatial,/Whole-domain/);assert.match(r.notes[0],/No project spatial filter/);
});
test('all noninherited HTTPS data links are retained; metadata encoding and total sizes are not mislabeled',()=>{
  const e=entry();e.links.push(dataLink('https://data.example.org/second.nc'),dataLink('https://data.example.org/second.nc'),{...dataLink('https://data.example.org/inherited.nc'),inherited:true},{href:'https://data.example.org/browse.jpg',rel:'http://esipfed.org/ns/fedsearch/1.1/browse#'},dataLink('http://insecure.example.org/data.hdf'),dataLink('https://name:password@example.org/a.hdf'),dataLink('https://data.example.org/check.sha256'));
  const r=E._test.parseEntries([e],collection);assert.equal(r.files.length,3);assert.deepEqual(r.files.map(f=>f.format),['HDF','NetCDF','SHA-256 checksum']);assert.ok(r.files.every(f=>f.sizeMB===null&&f.granuleSizeMB===12.5));assert.equal(r.files[2].role,'checksum');assert.ok(r.files.every(f=>f.metadataOnly));
});
test('malformed percent encoding in provider basename remains escaped and safe',()=>{const e=entry();e.links=[dataLink('https://data.example.org/%XX.hdf')];assert.equal(E._test.parseEntries([e],collection).files[0].name,'%XX.hdf');});
test('verified public ORNL checksum route is distinguished from protected GFED payload',()=>{
  const c={id:'C2763353619-ORNL_CLOUD',shortName:'fire_emissions_v4_R1_1293',version:'4.1',authRequired:true},e=entry(1,c);e.links=[dataLink('https://data.ornldaac.earthdata.nasa.gov/protected/global_vegetation/a.hdf5'),dataLink('https://data.ornldaac.earthdata.nasa.gov/public/global_vegetation/a.hdf5.sha256')];const r=E._test.parseEntries([e],c);assert.equal(r.files[0].authRequired,true);assert.equal(r.files[1].authRequired,false);assert.equal(r.files[1].role,'checksum');
});
test('missing eligible data links do not count as complete file access',async()=>{const e=entry();e.links=[];const r=await E.discover(profile,query,fetches([response([e],1)]));assert.equal(r.paginationComplete,true);assert.equal(r.complete,false);assert.equal(r.missingLinksTotal,1);assert.equal(r.files.length,0);});
test('checksum-only granules complete metadata traversal without claiming a scientific payload link',async()=>{
 const e=entry();e.links=[dataLink('https://data.example.org/check.sha256')];const r=await E.discover(profile,query,fetches([response([e],1)]));assert.equal(r.paginationComplete,true);assert.equal(r.complete,false);assert.equal(r.missingLinksTotal,1);assert.equal(r.files.length,1);assert.equal(r.files[0].role,'checksum');
});
test('continuation is query-bound; original parameters and only server search-after are replayed',async()=>{
  const mock=fetches([response([entry(1)],2,'["token1"]'),response([entry(2)],2,'["end"]')]);
  const a=await E.discover(profile,query,mock);assert.equal(a.complete,false);assert.equal(a.granulesReadTotal,1);
  const b=await E.discover(profile,query,{...mock,cursor:a.continuation});assert.equal(b.complete,true);assert.equal(b.granulesReadTotal,2);assert.equal(mock.calls[1].url,mock.calls[0].url);assert.equal(mock.calls[1].options.headers['CMR-Search-After'],'["token1"]');
  await assert.rejects(E.discover(profile,{...query,lon:0},{...mock,cursor:a.continuation}),code('CURSOR'));
  await assert.rejects(E.discover({...profile,spatialMode:'global'},query,{...mock,cursor:a.continuation}),code('CURSOR'));
});
test('multiple platform collections are independently traversed without dropping platforms',async()=>{
  const second={...collection,id:'C2278858993-LPCLOUD',shortName:'MYD14',label:'Aqua MYD14'},p={...profile,collections:[collection,second]},mock=fetches([response([entry(1)],1),response([entry(2,second)],1)]);
  const a=await E.discover(p,query,mock);assert.equal(a.continuation.scopeIndex,1);assert.equal(a.continuation.after,null);
  const b=await E.discover(p,query,{...mock,cursor:a.continuation});assert.equal(b.complete,true);assert.equal(b.files[0].platform,'Aqua MYD14');assert.equal(new URL(mock.calls[1].url).searchParams.get('collection_concept_id'),second.id);
});
test('there is no hidden total file cap across continuation actions',async()=>{
  let cursor,read=0,calls=0;do{const r=await E.discover(profile,query,{cursor,fetchImpl:async()=>{const n=calls++;return response([entry(n+1)],103,n<102?'page'+n:null);}});read+=r.files.length;cursor=r.continuation;}while(cursor);assert.equal(read,103);assert.equal(calls,103);
});

test('one bounded action covers a month of half-hourly granules and larger searches resume without loss',async()=>{
  for(const total of [1488,5001]){
    let offset=0,calls=0;
    const fetchImpl=async(url,options)=>{
      assert.equal(new URL(url).searchParams.get('page_size'),'1000');
      if(offset)assert.equal(options.headers['CMR-Search-After'],'after-'+offset);
      const count=Math.min(1000,total-offset),entries=Array.from({length:count},(_,i)=>entry(offset+i+1));
      offset+=count;calls++;
      return response(entries,total,offset<total?'after-'+offset:null);
    };
    const first=await E.discover(profile,query,{fetchImpl,pageBudget:5});
    assert.equal(first.files.length,Math.min(total,5000));
    assert.equal(first.complete,total<=5000);
    if(first.continuation){
      const next=await E.discover(profile,query,{fetchImpl,pageBudget:5,cursor:first.continuation});
      assert.equal(first.files.length+next.files.length,total);assert.equal(next.complete,true);
    }
    assert.equal(calls,Math.ceil(total/1000));
  }
});
test('later HTTP failure retains accepted pages and resumes the failed page',async()=>{
  const mock=fetches([response([entry(1)],2,'next'),new Response('unavailable',{status:503})]);const r=await E.discover(profile,query,{...mock,pageBudget:2});assert.equal(r.files.length,1);assert.equal(r.error.code,'HTTP_503');assert.equal(r.continuation.after,'next');assert.equal(r.granulesReadTotal,1);assert.equal(r.complete,false);
  const b=await E.discover(profile,query,{cursor:r.continuation,...fetches([response([entry(2)],2)])});assert.equal(b.complete,true);assert.equal(b.granulesReadTotal,2);
});
test('cancellation after one accepted page preserves its data and checkpoint',async()=>{
  const controller=new AbortController();let n=0;const r=await E.discover(profile,query,{signal:controller.signal,pageBudget:2,fetchImpl:async()=>{n++;const r=response([entry()],2,'next');controller.abort();return r;}});assert.equal(n,1);assert.equal(r.files.length,1);assert.equal(r.cancelled,true);assert.equal(r.error.code,'CANCELLED');assert.equal(r.continuation.after,'next');
});
test('repeated granules do not create false complete; the previous page remains',async()=>{
  const r=await E.discover(profile,query,{...fetches([response([entry()],2,'one'),response([entry()],2,'two')]),pageBudget:2});assert.equal(r.files.length,1);assert.equal(r.error.code,'PAGINATION');assert.equal(r.continuation.after,'one');assert.equal(r.granulesReadTotal,1);
});
test('changed count, repeated token, missing continuation and inconsistent lengths fail conservatively',async()=>{
  for(const second of [response([entry(2)],3,'two'),response([],2,'two')]){const r=await E.discover(profile,query,{...fetches([response([entry()],2,'one'),second]),pageBudget:2});assert.equal(r.complete,false);assert.equal(r.files.length,1);assert.ok(r.error);}
  await assert.rejects(E.discover(profile,query,fetches([response([entry()],2)])),code('PAGINATION'));
  await assert.rejects(E.discover(profile,query,fetches([response([entry(),entry(2)],1)])),code('PAGINATION'));
  const r=await E.discover(profile,query,{...fetches([response([entry()],3,'one'),response([entry(2)],3,'one')]),pageBudget:2});assert.equal(r.error.code,'PAGINATION');assert.equal(r.files.length,1);
});
test('missing count headers, timeout and malformed metadata cannot be successful empties',async()=>{
  await assert.rejects(E.discover(profile,query,fetches([new Response('{"feed":{"entry":[]}}')])),code('SCHEMA'));
  await assert.rejects(E.discover(profile,query,fetches([response([],0,null,{'CMR-Timed-Out':'true'})])),code('TIMEOUT'));
  const e=entry();e.collection_concept_id='C1-WRONG';await assert.rejects(E.discover(profile,query,fetches([response([e],1)])),code('SCHEMA'));
  const date=entry();date.time_start='not a date';assert.throws(()=>E._test.parseEntries([date],collection),code('SCHEMA'));
});
test('invalid dates, geometry, profile and forged continuation fail before network calls',async()=>{
  const noFetch=()=>{throw new Error('must not fetch');};
  for(const q of [{...query,start:'2020-02-30'},{...query,lat:100},{...query,end:'2100-01-01'}])await assert.rejects(E.discover(profile,q,{fetchImpl:noFetch}),code('INPUT'));
  await assert.rejects(E.discover({...profile,collections:[{...collection,id:'https://attacker.example'}]},query,{fetchImpl:noFetch}),code('INPUT'));
  await assert.rejects(E.discover(profile,query,{fetchImpl:noFetch,cursor:{url:'https://attacker.example'}}),code('CURSOR'));
});
test('inconsistent continuation counts, IDs and search-after state are rejected',async()=>{
  const a=await E.discover(profile,query,fetches([response([entry()],2,'next')]));
  for(const patch of [{hits:1},{granulesReadTotal:0},{missingLinksTotal:2},{seenIds:['invalid']},{seenTokens:['wrong']},{seenTokens:['next','next']},{read:0,seenIds:[]}])await assert.rejects(E.discover(profile,query,{cursor:{...a.continuation,...patch},fetchImpl:()=>{throw Error('must not fetch');}}),code('CURSOR'));
});
test('observed official granules parse as exact metadata files across NASA families',()=>{
  const evidence=path.join(__dirname,'./fixtures/cmr');
  const cases=[['MOD14','C2271754179-LPCLOUD','061'],['MCD64A1','C2565786756-LPCLOUD','061'],['MOD10A1','C2565093311-NSIDC_CPRD','61'],['GPM_3IMERGHH','C2723754847-GES_DISC','07'],['M2I1NXASM','C1276812820-GES_DISC','5.12.4'],['SWOT_L2_HR_Raster_D','C3233944993-POCLOUD','D'],['SWOT_L2_HR_RiverSP_D','C3233944997-POCLOUD','D']];
  for(const [shortName,id,version] of cases){const receipt=JSON.parse(fs.readFileSync(path.join(evidence,shortName+'-granules.json'))),j=JSON.parse(receipt.rawText),p=E._test.parseEntries(j.feed.entry,{id,shortName,version});assert.ok(p.files.length,shortName);assert.ok(p.files.every(f=>f.collectionId===id&&f.version===version&&f.authRequired&&f.metadataOnly),shortName);assert.equal(receipt.status,200);}
});
