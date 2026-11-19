const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../src/providers.js'),C=require('../src/coops-availability.js'),D=require('../src/station-download.js'),T=require('../src/coverage-timeline.js');
const q={mode:'point',lat:40.81,lon:-96.70,radiusKm:100,start:'2020-07-01',end:'2020-07-03'};
const item=(id='US10red_015')=>({id:'record-'+id,centroid:[q.lon,q.lat],startDate:'1950-01-01',endDate:'2021-01-01',stations:[{id,name:'Provider station',dataTypes:[{id:'PRCP',startDate:'1950-01-01',endDate:'2021-01-01'}]}]});
const response=body=>new Response(JSON.stringify(body));
const period=(first,last,product='Verified 6-Minute Water Level')=>({first,last,start:first.slice(0,10),end:last.slice(0,10),product});
const station=()=>({id:'8518750',greatlakes:false,coopsAvailability:{schemaVersion:1,stationId:'8518750',inventoryStatus:'ok',metadataStatus:'ok',datumTableStatus:'listed',availableDatums:[{code:'MSL',label:'Mean Sea Level'}],periods:[period('2020-07-01 00:00','2020-07-03 23:54')],hourlyPeriods:[period('1950-01-01 00:00','2020-12-31 23:00','Verified Hourly Height Water Level')],listedProducts:['Verified 6-Minute Water Level','Verified Hourly Height Water Level'],inventoryUrl:'https://tidesandcurrents.noaa.gov/inventory.html?id=8518750'}});

test('lowercase and underscore NCEI IDs survive discovery, preview and full-period plans unchanged',async()=>{
 for(const id of ['US10red_015','US10perk001']){
  const r=await P.discover('ghcn_daily',q,{fetchImpl:async()=>response({count:1,results:[item(id)]})});
  assert.equal(r.complete,true);assert.equal(r.stations[0].id,id);
  assert.equal(new URL(P.requestURL('ghcn_daily',r.stations[0],q)).searchParams.get('stations'),id);
  const plan=D.prepare('ghcn_daily',r.stations[0],q);assert.deepEqual(plan.errors,[]);assert.equal(new URL(plan.directUrl).searchParams.get('stations'),id);
 }
});
test('one malformed station is counted without discarding valid rows or claiming completeness',async()=>{
 const bad=item('../unsafe'),badDate=item('US10perk001');badDate.stations[0].dataTypes[0].startDate='bad-date';
 const r=await P.discover('ghcn_daily',q,{fetchImpl:async()=>response({count:3,results:[bad,badDate,item()]})});
 assert.equal(r.stations.length,1);assert.equal(r.malformedRecordsTotal,2);assert.equal(r.complete,false);assert.equal(r.paginationComplete,true);assert.match(r.notes.join(' '),/2 malformed/);
});
test('capped NCEI parent is replaced by four complete child boxes with boundary deduplication',async()=>{
 const urls=[];
 const r=await P.discover('ghcn_daily',q,{fetchImpl:async u=>{urls.push(new URL(u));return response({count:urls.length===1?10000:1,results:[item()]});}});
 assert.equal(r.subdivisions,1);assert.equal(r.complete,true);assert.equal(r.stations.length,1);assert.equal(urls.length,5);
 const [north,west,south,east]=urls[0].searchParams.get('bbox').split(',').map(Number);
 const boxes=urls.slice(1).map(u=>u.searchParams.get('bbox').split(',').map(Number));
 assert.equal(Math.min(...boxes.map(b=>b[1])),west);assert.equal(Math.max(...boxes.map(b=>b[3])),east);
 assert.equal(Math.min(...boxes.map(b=>b[2])),south);assert.equal(Math.max(...boxes.map(b=>b[0])),north);
 const area=boxes.reduce((sum,[n,w,s,e])=>sum+(e-w)*(n-s),0);assert.ok(Math.abs(area-(east-west)*(north-south))<1e-9);
});
test('subdivision survives continuation and child failure without changing the original query',async()=>{
 const first=await P.discover('ghcn_daily',q,{pageBudget:1,fetchImpl:async()=>response({count:10000,results:[item()]})});
 assert.equal(first.stations.length,0);assert.deepEqual(first.continuation.splitPaths,['0:']);
 const failed=await P.discover('ghcn_daily',q,{cursor:first.continuation,fetchImpl:async()=>new Response('{}',{status:503})});
 assert.deepEqual(failed.continuation,first.continuation);assert.equal(failed.error.code,'HTTP_503');
 const resumed=await P.discover('ghcn_daily',q,{cursor:failed.continuation,fetchImpl:async()=>response({count:1,results:[item()]})});
 assert.equal(resumed.complete,true);assert.deepEqual(resumed.query,q);
 await assert.rejects(P.discover('ghcn_daily',q,{cursor:{...first.continuation,splitPaths:['99:']}}),e=>e.code==='CURSOR');
});
test('historic hourly availability is explicit and never changes a six-minute request silently',()=>{
 const s=station(),historical={...q,start:'1960-01-01',end:'1960-01-03'};
 const six=C.assessCoopsStation(s,historical);assert.equal(six.state,'outside_period');assert.equal(six.alternativeProduct.id,'hourly_height');
 assert.throws(()=>P.requestURL('noaa_coops_water_level',s,historical));
 s.coopsProduct='hourly_height';const hourly=C.assessCoopsStation(s,historical);assert.equal(hourly.state,'match');assert.equal(hourly.cadenceMs,3600000);
 const u=new URL(P.requestURL('noaa_coops_water_level',s,historical));assert.equal(u.searchParams.get('product'),'hourly_height');assert.equal(u.searchParams.get('end_date'),'19600103 23:00');
});
test('hourly preview uses hourly slots and preserves two-field flags without inventing quality',()=>{
 const s={...station(),coopsProduct:'hourly_height'},historical={...q,start:'1960-01-01',end:'1960-01-03'};
 const payload={metadata:{id:s.id},data:[{t:'1960-01-01 00:00',v:'1.2',f:'0,1'}]};
 const r=P._test.makeResult('noaa_coops_water_level',s,historical,payload,JSON.stringify(payload),[]);
 assert.equal(r.summaries[0].expectedSlots,72);assert.equal(r.series[0].cadenceMs,3600000);assert.equal(r.series[0].key,'hourly_height');
 assert.deepEqual(r.series[0].points[0].flags,{quality:null,dataFlags:'0,1',sigma:null});assert.equal(r.provenance.toolVersion,'v0.3');
});
test('full hourly plans cover historical leap years in bounded requests and preserve product gaps',()=>{
 const s={...station(),coopsProduct:'hourly_height'},historical={...q,start:'1959-01-01',end:'1961-12-31'};
 s.coopsAvailability.hourlyPeriods=[period('1959-01-01 00:00','1960-02-29 23:00','Verified Hourly Height Water Level'),period('1960-03-02 00:00','1961-12-31 23:00','Verified Hourly Height Water Level')];
 const plan=D.prepare('noaa_coops_water_level',s,historical);assert.deepEqual(plan.errors,[]);
 assert.equal(plan.unrequestedIntervals.length,1);assert.equal(plan.unrequestedIntervals[0].startTime,'1960-03-01T00:00:00.000Z');assert.equal(plan.unrequestedIntervals[0].endTime,'1960-03-01T23:00:00.000Z');
 for(const r of plan.requests){assert.equal(new URL(r.url).searchParams.get('product'),'hourly_height');assert.ok(Date.parse(r.endTime)-Date.parse(r.startTime)<365*86400000);}
 assert.equal(plan.transferEstimate.nominalSlots,(365+366+365-1)*24);assert.match(plan.folderName,/hourly_height/);
});
test('CO-OPS size estimate scales by actual scheduled slots and leaves other unknown routes unknown',()=>{
 const plan=D.prepare('noaa_coops_water_level',station(),q);
 assert.equal(plan.transferEstimate.nominalSlots,720);assert.equal(plan.transferEstimate.minBytes,720*50+128);assert.equal(plan.transferEstimate.maxBytes,720*110+1024);
 assert.equal(plan.manifest.transferSummary.requiresConfirmation,true);assert.match(plan.transferEstimate.basis,/not a provider quote/);
});
test('timeline includes distinct hourly rows and round year ticks without changing project bounds',()=>{
 const s=station(),long={...q,start:'1990-01-01',end:'2020-12-31'};
 const model=T.model(long,{time:{kind:'station',intervals:[]}},s);
 assert.equal(model.project.start,long.start);assert.ok(model.rows.some(r=>r.id==='coops-hourly'));assert.ok(model.axis.ticks.length>=3);assert.ok(model.axis.ticks.every(t=>/^\d{4}$/.test(t.label)));
});
test('short timelines keep date ticks readable at narrow widths',()=>{
 const model=T.model(q,{time:{kind:'station',intervals:[]}},null);
 assert.ok(model.axis.ticks.length<=4);assert.ok(model.axis.ticks.length>=2);
});
test('retained real NOAA metadata exposes hourly periods and does not infer a common product envelope',()=>{
 const s=require('./fixtures/coops/battery-metadata.json');
 const historical={...q,start:'1960-01-01',end:'1960-01-03'};
 assert.equal(C.assessCoopsStation(s,historical).state,'outside_period');
 assert.equal(C.assessCoopsStation({...s,coopsProduct:'hourly_height'},historical).state,'match');
 const plan=D.prepare('noaa_coops_water_level',{...s,coopsProduct:'hourly_height'},historical);
 const payload=require('./fixtures/coops/battery-hourly-preview.json');
 assert.equal(payload.series[0].points.length,72);assert.equal(plan.transferEstimate.nominalSlots,72);
 const bytes=Buffer.byteLength(payload.rawText);assert.ok(bytes>=plan.transferEstimate.minBytes&&bytes<=plan.transferEstimate.maxBytes);
});
test('malformed entry accounting survives continuation and rejects unsupported products before a request',async()=>{
 const first=await P.discover('ghcn_daily',q,{pageBudget:1,fetchImpl:async()=>response({count:2,results:[item('bad')]})});
 const second=await P.discover('ghcn_daily',q,{cursor:first.continuation,fetchImpl:async()=>response({count:2,results:[item()]})});
 assert.equal(second.malformedRecordsTotal,1);assert.equal(second.stations.length,1);assert.equal(second.complete,false);
 assert.throws(()=>P.requestURL('noaa_coops_water_level',{...station(),coopsProduct:'monthly_mean'},q),e=>e.code==='INPUT');
});
