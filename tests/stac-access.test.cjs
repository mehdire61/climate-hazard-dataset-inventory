const test=require('node:test'),assert=require('node:assert/strict');
const stac=require('../src/stac-access.js');
const profile={productId:'cems_gfm',assetKeys:['ensemble_flood_extent','exclusion_mask']};
const query={mode:'point',lat:39,lon:-77,radiusKm:100,start:'2024-01-01',end:'2024-01-02'};
const item=id=>({collection:'GFM',id,properties:{datetime:'2024-01-01T01:00:00Z'},bbox:[-78,38,-76,40],assets:{ensemble_flood_extent:{href:'https://data.eodc.eu/'+id+'.tif',roles:['data']},exclusion_mask:{href:'https://data.eodc.eu/'+id+'-mask.tif',roles:['data']},thumbnail:{href:'https://data.eodc.eu/thumbnail.png',roles:['thumbnail']}}});
const body=(ids,total=ids.length,next=null)=>({type:'FeatureCollection',numberMatched:total,features:ids.map(item),links:next?[{rel:'next',href:'https://stac.eodc.eu/api/v1/collections/GFM/items?token='+next}]:[]});
const response=value=>({ok:true,status:200,text:async()=>JSON.stringify(value)});
test('STAC file search excludes station radius and emits only requested data layers',async()=>{
 let url;const r=await stac.discover(profile,query,{fetchImpl:async u=>{url=u;return response(body(['one']));}});
 assert.equal(r.complete,true);assert.equal(r.files.length,2);assert.equal(new URL(url).searchParams.get('bbox'),'-77,39,-77,39');assert.equal(r.files[0].assetKey,'ensemble_flood_extent');
});
test('STAC continuation traverses pages without an overall cap',async()=>{
 const first=await stac.discover(profile,query,{fetchImpl:async()=>response(body(['one'],2,'next-one'))});assert.equal(first.complete,false);
 const last=await stac.discover(profile,query,{cursor:first.cursor,fetchImpl:async()=>response(body(['two'],2))});assert.equal(last.complete,true);assert.equal(last.files[0].itemId,'two');
});
test('STAC repeated items, changed counts, malicious assets and bad continuation stay incomplete',async()=>{
 const first=await stac.discover(profile,query,{fetchImpl:async()=>response(body(['one'],2,'next-one'))});
 for(const value of [body(['one'],2),body(['two'],3),{...body(['two'],2),links:[{rel:'next',href:'https://evil.example/items?token=x'}]}]){
  const r=await stac.discover(profile,query,{cursor:first.cursor,fetchImpl:async()=>response(value)});assert.ok(r.error);assert.equal(r.complete,false);assert.equal(r.files.length,0);}
 const bad=body(['a']);bad.features[0].assets.ensemble_flood_extent.href='http://127.0.0.1/private';
 const r=await stac.discover(profile,query,{fetchImpl:async()=>response(bad)});assert.ok(r.error);assert.equal(r.files.length,0);
});
test('STAC continuation is bound to the full project query',async()=>{
 const r=await stac.discover(profile,query,{fetchImpl:async()=>response(body(['one'],2,'next-one'))});
 await assert.rejects(stac.discover(profile,{...query,lon:-76},{cursor:r.cursor,fetchImpl:async()=>response(body(['two'],2))}),/continuation/);
});
test('Empty completed STAC metadata search differs from HTTP failure',async()=>{
 const empty=await stac.discover(profile,query,{fetchImpl:async()=>response(body([]))});assert.equal(empty.complete,true);
 const failed=await stac.discover(profile,query,{fetchImpl:async()=>({ok:false,status:503})});assert.equal(failed.complete,false);assert.ok(failed.error);
});
test('STAC cancellation preserves a retryable cursor',async()=>{
 const c=new AbortController();c.abort();const r=await stac.discover(profile,query,{signal:c.signal});assert.equal(r.cancelled,true);assert.equal(r.complete,false);assert.ok(r.cursor);
});
test('Provider timeout is retryable but is not described as user cancellation',async()=>{
 const r=await stac.discover(profile,query,{timeoutMs:5,fetchImpl:async(u,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{const e=new Error('aborted');e.name='AbortError';reject(e);}))});
 assert.equal(r.cancelled,false);assert.equal(r.complete,false);assert.ok(r.cursor);assert.match(r.error.message,/timed out/);
});
test('A missing requested quality layer stays explicit after metadata pagination ends',async()=>{
 const value=body(['one']);delete value.features[0].assets.exclusion_mask;
 const r=await stac.discover(profile,query,{fetchImpl:async()=>response(value)});
 assert.equal(r.paginationComplete,true);assert.equal(r.complete,false);assert.equal(r.missingAssets,1);assert.equal(r.cursor,null);assert.equal(r.files.length,1);assert.ok(r.notes.some(n=>n.includes('layer set is incomplete')));
});
