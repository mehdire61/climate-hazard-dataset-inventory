const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const C=require('../src/coops-availability.js'),P=require('../src/providers.js');
const evidence=path.join(__dirname,'./fixtures/coops');
const real=(name)=>fs.readFileSync(path.join(evidence,name),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const query={mode:'point',lat:38.9,lon:-77.04,radiusKm:100,start:'2020-07-01',end:'2020-07-03'};
const station=(id='8594900')=>({id,name:id,lat:38.8733,lon:-77.0217,greatlakes:false});
const metadata=(id='8594900',rows=[{name:'MSL',value:0},{name:'STND',value:0}],extra={})=>({count:1,units:'meters',stations:[{id,greatlakes:false,details:{id,established:'1924-11-10 00:00:00',removed:''},datums:{datums:rows,units:'meters',epoch:'1983-2001'},...extra}]});
const period=(first='2020-07-01 00:00',last='2020-07-03 23:54',name='Verified 6-Minute Water Level')=>({first,last,name});
const xml=(id='8594900',rows=[period()])=>'<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><DataInventory xmlns="https://opendap.co-ops.nos.noaa.gov/axis/webservices/datainventory/wsdl"><station ID="'+id+'" name="Fixture"><metadata/><!---->'+rows.map(p=>'<parameter first="'+p.first+'" last="'+p.last+'" name="'+p.name+'"/>').join('')+'</station></DataInventory></soap:Body></soap:Envelope>';
const response=(body,status=200)=>new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'content-type':typeof body==='string'?'text/xml':'application/json'}});
const fetchPair=(data=metadata(),inventory=xml())=>async url=>response(url.includes('datainventory')?inventory:data);
async function checked(s=station(),q=query,data=metadata(s.id),inventory=xml(s.id),options={}) {return (await C.checkCoopsStations([s],q,{fetchImpl:fetchPair(data,inventory),requestSpacingMs:0,...options})).stations[0];}

test('saved real Navy Yard inventory retains its exact six-minute range, not installation dates',async()=>{
 const inventory=real('8593005-inventory.xml'),parsed=C._test.parseInventory(inventory,'8593005');
 assert.equal(parsed.periods.length,1);assert.equal(parsed.periods[0].first,'1995-07-17 20:00');assert.equal(parsed.periods[0].last,'1995-11-17 17:00');
 const d=metadata('8593005',JSON.parse(real('8593005-datums.json')).datums,{details:{established:'1974-08-16 00:00:00',removed:'1996-02-01 23:59:00'}});
 const s=await checked(station('8593005'),query,d,inventory);
 assert.equal(s.coopsAvailability.state,'outside_period');assert.equal(s.coopsAvailability.canTryPreview,false);
 assert.equal(P.previewWindow('noaa_coops_water_level',query,s).available,false);
 assert.throws(()=>P.requestURL('noaa_coops_water_level',s,query,{allowUnverified:true}),e=>e.code==='NO_OVERLAP');
});
test('monthly-only valid inventory is distinct from an empty or broken inventory',async()=>{
 const s=station('8638946'),d=metadata(s.id,null,{details:{removed:'1978-01-12 23:59:00'}}),inventory=xml(s.id,[period('1977-12-01 00:00','1977-12-31 23:54','Verified Monthly Mean Water Level')]);
 const result=await checked(s,query,d,inventory);assert.equal(result.coopsAvailability.state,'product_not_listed');assert.deepEqual(result.coopsAvailability.periods,[]);assert.equal(result.coopsAvailability.canTryPreview,false);
 const empty=await checked(s,query,d,xml(s.id,[]));assert.equal(empty.coopsAvailability.state,'unresolved');assert.equal(empty.coopsAvailability.canTryPreview,true);
});
test('real repeated preliminary intervals retain their gap and can be re-assessed with an explicit STND choice',async()=>{
 const id='9752621',q={...query,start:'2024-07-01',end:'2024-07-03'},s=await checked(station(id),q,metadata(id,null),real(id+'-inventory.xml'));
 assert.equal(s.coopsAvailability.periods.length,2);assert.equal(s.coopsAvailability.state,'outside_period');assert.equal(s.coopsAvailability.canTryPreview,false);
 const next={...q,start:'2024-06-01',end:'2024-10-01'};s.coopsAvailability=P.assessCoopsStation(s,next,'STND');assert.equal(s.coopsAvailability.state,'partial');
 const w=P.previewWindow('noaa_coops_water_level',next,s);assert.equal(w.endTime,'2024-06-25T20:42:00.000Z');assert.equal(w.datum,'STND');
});
test('partial first/last days use exact GMT bounds and aligned nominal six-minute slots',async()=>{
 const q={...query,start:'2020-06-30',end:'2020-07-03'},s=await checked(station(),q,metadata(),xml('8594900',[period('2020-07-01 12:00','2020-07-01 12:12')]));
 assert.equal(s.coopsAvailability.state,'partial');const w=P.previewWindow('noaa_coops_water_level',q,s);assert.equal(w.shifted,true);assert.equal(w.startTime,'2020-07-01T12:00:00.000Z');assert.equal(w.endTime,'2020-07-01T12:12:00.000Z');
 const url=new URL(P.requestURL('noaa_coops_water_level',s,q));assert.equal(url.searchParams.get('begin_date'),'20200701 12:00');assert.equal(url.searchParams.get('end_date'),'20200701 12:12');
 const data={metadata:{id:s.id},data:[{t:'2020-07-01 12:00',v:'0',s:'0',q:'v',f:'0,0,0,0'}]},raw=JSON.stringify(data);
 const r=await P.retrieve('noaa_coops_water_level',s,q,{fetchImpl:async()=>response(raw)});assert.equal(r.summaries[0].expectedSlots,3);assert.equal(r.summaries[0].numericValues,1);assert.equal(r.rawText,raw);assert.deepEqual(r.requestedWindow,{start:q.start,end:q.end});
 assert.equal(r.provenance.coopsAvailability.periods[0].first,'2020-07-01 12:00');assert.equal(r.provenance.unverifiedMetadataAttempt,false);
 assert.throws(()=>P._test.parseCOOPS({metadata:{id:s.id},data:[{t:'2020-07-01 00:00',v:'1'}]},s,w,'MSL'),e=>e.code==='SCHEMA');
});
test('overlapping verified and preliminary intervals union without discarding individual evidence',async()=>{
 const s=await checked(station(),query,metadata(),xml('8594900',[period('2020-07-01 00:00','2020-07-02 23:54'),period('2020-07-02 12:00','2020-07-03 23:54','Preliminary 6-Minute Water Level')]));
 assert.equal(s.coopsAvailability.state,'match');assert.equal(s.coopsAvailability.periods.length,2);assert.equal(P.previewWindow('noaa_coops_water_level',query,s).endTime,'2020-07-03T23:54:00.000Z');
});
test('within-day inventory gaps are not bridged and nominal date overlap is partial',async()=>{
 const q={...query,end:query.start},s=await checked(station(),q,metadata(),xml('8594900',[period('2020-07-01 00:00','2020-07-01 00:06'),period('2020-07-01 12:00','2020-07-01 23:54')]));
 assert.equal(s.coopsAvailability.state,'partial');assert.equal(P.previewWindow('noaa_coops_water_level',q,s).endTime,'2020-07-01T00:06:00.000Z');
});
test('long checked previews retain a 28-calendar-day boundary while original project dates persist',async()=>{
 const q={...query,start:'2020-01-01',end:'2020-12-31'},s=await checked(station(),q,metadata(),xml('8594900',[period('2020-01-03 12:00','2020-12-31 23:54')]));
 const w=P.previewWindow('noaa_coops_water_level',q,s);assert.equal(w.start,'2020-01-03');assert.equal(w.end,'2020-01-30');assert.equal(w.requestedStart,'2020-01-01');assert.equal(w.requestedEnd,'2020-12-31');
});
test('Great Lakes IGLD is provider-documented despite missing table entry; known Old Woman Creek exception blocks',async()=>{
 const id='9063020',d=metadata(id,JSON.parse(real(id+'-datums.json')).datums,{greatlakes:true}),s=await checked({...station(id),greatlakes:true},query,d,xml(id));
 assert.equal(s.coopsAvailability.state,'match');assert.equal(s.coopsAvailability.selectedDatum,'IGLD');assert.ok(s.coopsAvailability.availableDatums.some(d=>d.code==='LWD'&&d.sourceName==='GL_LWD'));
 assert.equal(new URL(P.requestURL('noaa_coops_water_level',s,query)).searchParams.get('datum'),'IGLD');
 const special='9063075',blocked=await checked({...station(special),greatlakes:true},query,JSON.parse(real(special+'-station.json')),xml(special));
 assert.equal(blocked.coopsAvailability.state,'datum_required');assert.equal(blocked.coopsAvailability.canTryPreview,false);assert.deepEqual(blocked.coopsAvailability.availableDatums,[]);
 assert.throws(()=>P.requestURL('noaa_coops_water_level',blocked,query,{allowUnverified:true}),e=>e.code==='DATUM_REQUIRED');
});
test('valid zero/negative datum offsets and official aliases survive; tide metrics never become request datums',()=>{
 const rows=[{name:'MSL',value:0},{name:'MLLW',value:-0.179},{name:'NAVD88',value:0.276},{name:'CRD_OFFSET',value:-1},{name:'GT',value:1},{name:'DTL',value:1},{name:'HWI',value:7}];
 const d=C._test.parseMetadata(metadata('8594900',rows),'8594900'),codes=d.availableDatums.map(d=>d.code);
 assert.deepEqual(codes,['MSL','MLLW','NAVD','CRD','STND']);assert.equal(d.datumMetadata.epoch,'1983-2001');
});
test('default datum absent from a valid table requires an explicit supported choice throughout result provenance',async()=>{
 const s=await checked(station(),query,metadata('8594900',[{name:'MLLW',value:0}]),xml());
 assert.equal(s.coopsAvailability.state,'datum_required');assert.equal(s.coopsAvailability.selectedDatum,null);assert.equal(s.coopsAvailability.canTryPreview,false);
 assert.throws(()=>P.requestURL('noaa_coops_water_level',s,query,{allowUnverified:true}),e=>e.code==='DATUM_REQUIRED');
 s.coopsAvailability=P.assessCoopsStation(s,query,'STND');assert.equal(s.coopsAvailability.state,'match');
 const raw=JSON.stringify({metadata:{id:s.id},data:[{t:'2020-07-01 00:00',v:'1.2',q:'p',f:'0,0,0,0'}]}),r=await P.retrieve('noaa_coops_water_level',s,query,{fetchImpl:async url=>{assert.equal(new URL(url).searchParams.get('datum'),'STND');return response(raw);}});
 assert.equal(r.provenance.datumCode,'STND');assert.match(r.provenance.datum,/STND/);assert.match(r.series[0].label,/STND/);assert.equal(r.provenance.datumSelectionMode,'explicit');assert.match(r.notes.join(' '),/not equivalent to MSL/);
 assert.throws(()=>P.assessCoopsStation(s,query,'GT'),e=>e.code==='INPUT');
});
test('null datum table remains unresolved and a deliberate default attempt is separate from explicit STND',async()=>{
 const s=await checked(station(),query,metadata('8594900',null),xml());
 assert.equal(s.coopsAvailability.state,'unresolved');assert.equal(s.coopsAvailability.selectedDatum,null);assert.equal(s.coopsAvailability.tryDatum,'MSL');assert.equal(s.coopsAvailability.canTryPreview,true);
 assert.throws(()=>P.requestURL('noaa_coops_water_level',s,query),e=>e.code==='AVAILABILITY_UNRESOLVED');
 assert.equal(new URL(P.requestURL('noaa_coops_water_level',s,query,{allowUnverified:true})).searchParams.get('datum'),'MSL');
 assert.equal(P.assessCoopsStation(s,query,'STND').selectedDatum,'STND');assert.equal(s.coopsAvailability.selectedDatum,null);
});
test('active latest horizon and contradictory closure remain unresolved, with only a deliberate fallback attempt',async()=>{
 const q={...query,start:'2020-07-04',end:'2020-07-05'};
 for(const [listTypes,removed] of [[['waterlevels'],'1990-01-01 00:00:00'],[[], '1990-01-01 00:00:00'],[['waterlevels'],'2020-07-03 23:59:00'],[[], '']]){
  const s=await checked({...station(),listTypes},q,metadata('8594900',undefined,{details:{removed}}),xml());
  assert.equal(s.coopsAvailability.state,'unresolved');assert.equal(s.coopsAvailability.canTryPreview,true);assert.equal(P.previewWindow('noaa_coops_water_level',q,s).available,false);
  const w=P.previewWindow('noaa_coops_water_level',q,s,{allowUnverified:true});assert.equal(w.available,true);assert.equal(w.start,q.start);assert.equal(w.unverifiedMetadata,true);
 }
 const closed=await checked(station(),q,metadata('8594900',undefined,{details:{removed:'2020-07-03 23:59:00'}}),xml());assert.equal(closed.coopsAvailability.state,'outside_period');assert.equal(closed.coopsAvailability.canTryPreview,false);
});
test('malformed XML, wrong station, foreign namespace and altered six-minute names never establish product absence',async()=>{
 const bad=['',xml('0000000'),xml().replace('</station>',''),xml().replace('name="Verified 6-Minute Water Level"','name="Verified 6-minute water level"'),xml().replace('<parameter ','<parameter xmlns="https://invalid.example/" '),xml().replace('<metadata/>','<!DOCTYPE x [<!ENTITY y SYSTEM "file:///secret">]>'),xml().replace('name="Fixture"','name="&unknown;"'),xml().replace('2020-07-01 00:00','2020-02-30 24:00'),xml().replace('<metadata/>','<metadata/>outside')];
 for(const raw of bad) {const s=await checked(station(),query,metadata(),raw);assert.equal(s.coopsAvailability.state,'unresolved');assert.equal(s.coopsAvailability.inventoryStatus,'unresolved');assert.equal(s.coopsAvailability.canTryPreview,true);}
 assert.throws(()=>C._test.parseInventory(xml().replace('first="2020-07-01 00:00"','first="2020-07-01 00:00" first="2020-07-01 00:06"'),'8594900'));
});
test('missing, reversed and null period metadata remain unknown rather than zero overlap',async()=>{
 for(const raw of [xml().replace('first="2020-07-01 00:00"','first=""'),xml('8594900',[period('2020-07-03 00:00','2020-07-01 00:00')]),xml().replace(' last="2020-07-03 23:54"','')]){
  const s=await checked(station(),query,metadata(),raw);assert.equal(s.coopsAvailability.state,'unresolved');assert.equal(s.coopsAvailability.periods.length,0);
 }
});
test('metadata outage permits a labelled opt-in attempt, retains scoped evidence, and never silently falls back after NO_DATA',async()=>{
 const s=(await C.checkCoopsStations([station()],query,{requestSpacingMs:0,retryDelayMs:0,fetchImpl:async()=>response('{}',503)})).stations[0];
 assert.equal(s.coopsAvailability.state,'unresolved');assert.equal(s.coopsAvailability.requests.length,4);assert.equal(s.coopsAvailability.errors.length,4);assert.equal(s.coopsAvailability.canTryPreview,true);
 let calls=0;await assert.rejects(P.retrieve('noaa_coops_water_level',s,query,{fetchImpl:async()=>{calls++;return response('{}');}}),e=>e.code==='AVAILABILITY_UNRESOLVED');assert.equal(calls,0);
 const raw=JSON.stringify({metadata:{id:s.id},data:[{t:'2020-07-01 00:00',v:'0.1',q:'p',f:'0,0,0,0'}]}),r=await P.retrieve('noaa_coops_water_level',s,query,{allowUnverified:true,fetchImpl:async()=>response(raw)});
 assert.equal(r.provenance.unverifiedMetadataAttempt,true);assert.equal(r.provenance.datumCode,'MSL');assert.deepEqual(r.provenance.query,query);assert.match(r.notes.join(' '),/explicitly requested an unverified/);
 await assert.rejects(P.retrieve('noaa_coops_water_level',s,query,{allowUnverified:true,fetchImpl:async()=>{calls++;return response({error:{message:'No data was found.'}});}}),e=>e.code==='NO_DATA');assert.equal(calls,1);assert.equal(s.coopsAvailability.state,'unresolved');
});
test('station or datum schema errors never become affirmative matches',async()=>{
 for(const d of [metadata('0000000'),{count:0,stations:[]},metadata('8594900',[{name:'MSL',value:null}]),metadata('8594900',[{name:'MSL',value:'0'}]),metadata('8594900',undefined,{greatlakes:'false'})]){
  const s=await checked(station(),query,d,xml());assert.equal(s.coopsAvailability.state,'unresolved');assert.equal(s.coopsAvailability.metadataStatus,'unresolved');
 }
});
test('another station expanded details cannot supply a false historical closure',async()=>{
 const q={...query,start:'2020-07-04',end:'2020-07-05'},d=metadata('8594900',undefined,{details:{id:'8593005',removed:'2020-07-03 23:59:00'}}),s=await checked(station(),q,d,xml());
 assert.equal(s.coopsAvailability.metadataStatus,'unresolved');assert.equal(s.coopsAvailability.state,'unresolved');assert.notEqual(s.coopsAvailability.state,'outside_period');assert.equal(s.coopsAvailability.canTryPreview,true);
});
test('all candidates survive a ten-station batch, ordered progress, bounded concurrency and per-station failures',async()=>{
 const stations=Array.from({length:23},(_,i)=>station(String(8000000+i))),before=clone(stations),counts=[];let active=0,max=0;
 const result=await C.checkCoopsStations(stations,query,{requestSpacingMs:0,onProgress:r=>{assert.equal(r.stations.length,23);counts.push(r.completed);},fetchImpl:async url=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,2));active--;const u=new URL(url),id=u.searchParams.get('stationId')||url.match(/stations\/(\d+)/)[1];return response(url.includes('datainventory')?(id==='8000005'?'broken XML':xml(id)):metadata(id));}});
 assert.equal(result.stations.length,23);assert.deepEqual(result.stations.map(s=>s.id),stations.map(s=>s.id));assert.equal(result.completed,10);assert.equal(result.complete,false);assert.equal(result.batchLimit,10);assert.equal(result.remaining,13);assert.equal(result.stations.filter(s=>s.coopsAvailability.state==='unchecked').length,13);assert.ok(max<=3);assert.ok(max>=2);assert.ok(counts.every((v,i)=>i===0||v>=counts[i-1]));assert.equal(result.stations[5].coopsAvailability.state,'unresolved');assert.deepEqual(stations,before);
});
test('already-cancelled and mid-flight checks retain every candidate and accepted results',async()=>{
 const stations=Array.from({length:8},(_,i)=>station(String(8100000+i))),abort=new AbortController();abort.abort();let calls=0;
 const initial=await C.checkCoopsStations(stations,query,{signal:abort.signal,requestSpacingMs:0,fetchImpl:async()=>{calls++;return response({});}});assert.equal(calls,0);assert.equal(initial.cancelled,true);assert.equal(initial.completed,0);assert.ok(initial.stations.every(s=>s.coopsAvailability.state==='unchecked'));
 const liveAbort=new AbortController();
 const result=await C.checkCoopsStations(stations,query,{signal:liveAbort.signal,requestSpacingMs:0,onProgress:r=>{if(r.completed===1)liveAbort.abort();},fetchImpl:async(url,{signal})=>{const id=new URL(url).searchParams.get('stationId')||url.match(/stations\/(\d+)/)[1];if(id!=='8100000')await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,50);signal.addEventListener('abort',()=>{clearTimeout(timer);const e=new Error('cancel');e.name='AbortError';reject(e);},{once:true});});return response(url.includes('datainventory')?xml(id):metadata(id));}});
 assert.equal(result.stations.length,8);assert.equal(result.cancelled,true);assert.equal(result.complete,false);assert.equal(result.stations[0].coopsAvailability.state,'match');assert.ok(result.stations.some(s=>s.coopsAvailability.state==='unchecked'));assert.equal(result.completed,1);
});
test('HTTP 429 stops additional queue work and preserves unchecked candidates',async()=>{
 const stations=Array.from({length:12},(_,i)=>station(String(8200000+i)));let calls=0;
 const result=await C.checkCoopsStations(stations,query,{requestSpacingMs:0,fetchImpl:async()=>{calls++;return response('{}',429);}});
 assert.equal(result.rateLimited,true);assert.equal(result.complete,false);assert.equal(result.stations.length,12);assert.ok(calls<=3);assert.ok(result.stations.filter(s=>s.coopsAvailability.state==='unchecked').length>=9);assert.equal(result.error.code,'HTTP_429');
});
test('same-query resolved metadata is reused; force refresh preserves explicit datum; unresolved can retry',async()=>{
 let s=await checked();s.coopsAvailability=P.assessCoopsStation(s,query,'STND');let calls=0;
 const cached=await C.checkCoopsStations([s],query,{requestSpacingMs:0,fetchImpl:async()=>{calls++;throw new Error('must not fetch');}});assert.equal(calls,0);assert.equal(cached.completed,1);
 const fresh=await C.checkCoopsStations([s],query,{forceRefresh:true,requestSpacingMs:0,fetchImpl:async url=>{calls++;return fetchPair()(url);}});assert.equal(calls,2);assert.equal(fresh.stations[0].coopsAvailability.selectedDatum,'STND');assert.equal(fresh.stations[0].coopsAvailability.selectionMode,'explicit');
 const q={...query,start:'2020-07-04',end:'2020-07-05'};s=await checked(station(),q);calls=0;await C.checkCoopsStations([s],q,{requestSpacingMs:0,fetchImpl:async url=>{calls++;return fetchPair()(url);}});assert.equal(calls,2);
});
test('timeout and cancellation-aware queue spacing remain unresolved and never create no-data states',async()=>{
 const s=(await C.checkCoopsStations([station()],query,{timeoutMs:10,requestSpacingMs:0,retryDelayMs:0,fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{const e=new Error('timeout');e.name='AbortError';reject(e);},{once:true}))})).stations[0];assert.equal(s.coopsAvailability.state,'unresolved');assert.ok(s.coopsAvailability.errors.every(e=>e.code==='TIMEOUT'));
 const abort=new AbortController(),start=Date.now();setTimeout(()=>abort.abort(),10);
 const result=await C.checkCoopsStations([station(),station('8593005')],query,{signal:abort.signal,requestSpacingMs:1000,fetchImpl:async url=>response(metadata(url.match(/stations\/(\d+)/)[1]))});assert.equal(result.cancelled,true);assert.ok(Date.now()-start<500);assert.equal(result.stations.length,2);
});

test('one bounded retry recovers HTTP503 while retaining each attempt',async()=>{
 let metadataCalls=0;
 const result=await C.checkCoopsStations([station()],query,{requestSpacingMs:0,retryDelayMs:0,fetchImpl:async url=>{
  if(url.includes('datainventory'))return response(xml());
  metadataCalls++;return metadataCalls===1?response('<error>temporary upstream failure</error>',503):response(metadata());
 }});
 const a=result.stations[0].coopsAvailability;
 assert.equal(a.state,'match');assert.equal(metadataCalls,2);assert.equal(a.requests.length,3);assert.deepEqual(a.requests.filter(r=>r.source==='metadata').map(r=>r.attempt),[1,2]);
 assert.equal(a.errors.length,1);assert.equal(a.errors[0].code,'HTTP_503');assert.equal(a.errors[0].recovered,true);assert.match(a.requests[0].rawFailureText,/temporary upstream failure/);
});

test('transient network and timeout failures retry once and retain classified errors',async()=>{
 for(const failure of ['network','coded_network','timeout']) {
  let calls=0;
  const result=await C.checkCoopsStations([station()],query,{requestSpacingMs:0,retryDelayMs:0,timeoutMs:20,fetchImpl:async(url,{signal})=>{
   if(url.includes('datainventory'))return response(xml());
   calls++;if(calls===1) {
    if(failure==='network')throw new TypeError('Failed to fetch');
    if(failure==='coded_network')throw Object.assign(new Error('connection reset'),{code:'ECONNRESET'});
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('timeout','AbortError')),{once:true}));
   }
   return response(metadata());
  }});
  const a=result.stations[0].coopsAvailability;assert.equal(calls,2);assert.equal(a.state,'match');assert.equal(a.errors[0].code,failure==='timeout'?'TIMEOUT':'NETWORK');assert.equal(a.errors[0].recovered,true);
 }
});

test('repeated HTTP5xx stops at two attempts per endpoint, retains unknown evidence and all candidates',async()=>{
 const stations=[station(),station('8593005')];let calls=0;
 const result=await C.checkCoopsStations(stations,query,{requestSpacingMs:0,retryDelayMs:0,fetchImpl:async()=>{calls++;return response('temporary upstream error',502);}});
 assert.equal(calls,8);assert.equal(result.stations.length,2);assert.equal(result.complete,true);
 for(const {coopsAvailability:a} of result.stations) {
  assert.equal(a.state,'unresolved');assert.equal(a.requests.length,4);assert.equal(a.errors.length,4);assert.ok(a.errors.every(e=>e.code==='HTTP_502'&&!e.recovered));
  assert.deepEqual(a.errors.map(e=>e.retryScheduled),[true,false,true,false]);assert.deepEqual(a.requests.map(r=>r.attempt),[1,2,1,2]);assert.ok(a.requests.every(r=>r.outcome==='failed'&&r.rawFailureText==='temporary upstream error'));
 }
});

test('HTTP4xx including429 and schema failures are never automatically retried',async()=>{
 for(const status of [400,403,404,429]) {
  let calls=0;const result=await C.checkCoopsStations([station()],query,{requestSpacingMs:0,retryDelayMs:0,fetchImpl:async()=>{calls++;return response('provider error',status);}});
  const a=result.stations[0].coopsAvailability;assert.equal(calls,status===429?1:2);assert.equal(a.state,'unresolved');assert.ok(a.requests.every(r=>r.attempt===1));assert.ok(a.errors.every(e=>!e.retryScheduled));assert.equal(result.rateLimited,status===429);
 }
 let calls=0;const result=await C.checkCoopsStations([station()],query,{requestSpacingMs:0,retryDelayMs:0,fetchImpl:async url=>{calls++;return response(url.includes('datainventory')?'<invalid/>':metadata());}});
 const a=result.stations[0].coopsAvailability;assert.equal(calls,2);assert.equal(a.state,'unresolved');assert.equal(a.errors[0].code,'SCHEMA');assert.equal(a.errors[0].retryScheduled,false);assert.equal(a.requests[1].rawFailureText,'<invalid/>');
});

test('cancellation during retry backoff sends no second request and preserves the first failure',async()=>{
 const controller=new AbortController();let calls=0;
 const result=await C.checkCoopsStations([station()],query,{signal:controller.signal,requestSpacingMs:0,retryDelayMs:200,fetchImpl:async()=>{calls++;setTimeout(()=>controller.abort(),10);return response('temporary',503);}});
 const a=result.stations[0].coopsAvailability;assert.equal(calls,1);assert.equal(result.cancelled,true);assert.equal(result.complete,false);assert.equal(a.state,'unresolved');assert.equal(a.requests.length,1);assert.equal(a.errors[0].code,'HTTP_503');assert.equal(a.errors[1].code,'ABORTED');assert.equal(a.errors[1].phase,'waiting');assert.equal(a.errors[1].attempt,2);
});

test('failed HTTP diagnostics retain only a bounded response prefix',async()=>{
 let calls=0;
 const result=await C.checkCoopsStations([station()],query,{requestSpacingMs:0,retryDelayMs:0,fetchImpl:async url=>{if(url.includes('datainventory'))return response(xml());calls++;return calls===1?response('x'.repeat(100000),503):response(metadata());}});
 const a=result.stations[0].coopsAvailability,r=a.requests[0];assert.equal(a.state,'match');assert.equal(r.rawFailureText.length,65536);assert.equal(r.rawFailureBytes,65536);assert.equal(r.rawFailureTruncated,true);assert.equal(a.requests[1].rawFailureText,undefined);
});

test('recovered checks reuse metadata and preserve the visible failure history',async()=>{
 let calls=0;const first=await C.checkCoopsStations([station()],query,{requestSpacingMs:0,retryDelayMs:0,fetchImpl:async url=>{if(url.includes('datainventory'))return response(xml());calls++;return calls===1?response('{}',503):response(metadata());}});
 const s=first.stations[0];s.coopsAvailability=C.assessCoopsStation(s,query,'STND');
 const cached=await C.checkCoopsStations([s],query,{fetchImpl:async()=>{throw new Error('recovered metadata must remain cached');}});
 assert.equal(cached.complete,true);assert.equal(cached.stations[0].coopsAvailability.selectedDatum,'STND');assert.equal(cached.stations[0].coopsAvailability.errors[0].recovered,true);assert.equal(cached.stations[0].coopsAvailability.requests.length,3);
});

test('observationIntervals exposes the existing union without mutating retained product evidence',()=>{
 const parsed=C._test.parseInventory(xml('8594900',[period('2020-07-01 00:00','2020-07-01 00:06'),period('2020-07-01 00:12','2020-07-01 00:18','Preliminary 6-Minute Water Level'),period('2020-07-01 12:00','2020-07-01 12:06')]),'8594900');
 const before=clone(parsed.periods),union=C.observationIntervals(parsed.periods);
 assert.deepEqual(union,[{start:Date.parse('2020-07-01T00:00:00Z'),end:Date.parse('2020-07-01T00:18:00Z')},{start:Date.parse('2020-07-01T12:00:00Z'),end:Date.parse('2020-07-01T12:06:00Z')}]);assert.deepEqual(parsed.periods,before);assert.equal(parsed.periods.length,3);
});

test('invalid retry delays fail before any metadata request',async()=>{
 for(const retryDelayMs of [-1,Infinity,10001,'750'])await assert.rejects(C.checkCoopsStations([station()],query,{retryDelayMs,fetchImpl:async()=>{throw new Error('must not fetch');}}),e=>e.code==='INPUT');
});


test('SOAP server fault retains its bounded diagnosis and recovers after one retry',async()=>{
  const fault='<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>java.lang.NumberFormatException: service failure</faultstring></soap:Fault></soap:Body></soap:Envelope>';
  let calls=0;const r=await C.checkCoopsStations([station()],query,{requestSpacingMs:0,retryDelayMs:0,fetchImpl:async url=>response(url.includes('datainventory')?(++calls===1?fault:xml()):metadata())});
  const a=r.stations[0].coopsAvailability;assert.equal(calls,2);assert.equal(a.inventoryStatus,'ok');
  assert.equal(a.errors[0].code,'SOAP_SERVER_FAULT');assert.equal(a.errors[0].recovered,true);assert.match(a.errors[0].message,/NumberFormatException/);
  assert.ok(a.requests.some(r=>r.rawFailureText===fault));
  for(const code of ['Client','Unknown']){
    calls=0;const malformed=fault.replace('soap:Server','soap:'+code);
    const result=await C.checkCoopsStations([station()],query,{requestSpacingMs:0,retryDelayMs:0,fetchImpl:async url=>response(url.includes('datainventory')?(calls++,malformed):metadata())});
    assert.equal(calls,1);assert.equal(result.stations[0].coopsAvailability.inventoryStatus,'unresolved');
  }
});

test('exact retained NOAA Server.userException retries once and preserves distinct hourly and six-minute inventories',async()=>{
  const retained=name=>fs.readFileSync(path.join(__dirname,'fixtures/coops',name),'utf8');
  const fault=retained('noaa-battery-soap-fault.xml'), inventory=retained('noaa-battery-inventory.xml');
  for(const product of ['water_level','hourly_height']){
    let calls=0;
    const r=await C.checkCoopsStations([{...station('8518750'),coopsProduct:product}],query,{requestSpacingMs:0,retryDelayMs:0,fetchImpl:async url=>response(url.includes('datainventory')?(++calls===1?fault:inventory):metadata('8518750'))});
    const a=r.stations[0].coopsAvailability;
    assert.equal(calls,2);assert.equal(a.inventoryStatus,'ok');assert.equal(a.errors[0].code,'SOAP_SERVER_FAULT');assert.equal(a.errors[0].recovered,true);
    assert.ok(a.requests.some(request=>request.rawFailureText===fault));
    assert.equal(a.product,product);
    assert.ok(a.selectedPeriods.length>0);
    assert.ok(a.selectedPeriods.every(period=> product==='water_level' ? /^(Preliminary|Verified) 6-Minute Water Level$/.test(period.product) : period.product==='Verified Hourly Height Water Level'));
  }
});
