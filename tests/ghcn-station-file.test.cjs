const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const providers = require('../src/providers.js');
const chart = require('../src/observation-chart.js');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'ghcn-station-file', name));
const dc = {id:'US1DCDC0009', start:'2008-01-14', end:'2026-11-12', variables:[{key:'PRCP',start:'2008-01-14',end:'2026-11-12'}]};
const project = {mode:'point',lat:38.9,lon:-77.04,radiusKm:100,start:'2026-10-18',end:'2026-11-16'};
const fairfax = {id:'US1VAFX0117'};
const november = {...project,start:'2026-11-04',end:'2026-11-13'};
const noaaCsv = () => new Response(fixture('US1VAFX0117.csv.gz'),{headers:{'last-modified':'Wed, 18 Nov 2026 02:26:26 GMT'}});
const original = fixture('US1DCDC0009.dly');
const empty = () => new Response(fixture('US1DCDC0009-20261018-20261112.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function retrieve(station, query, responses, urls = [], options = {}) {
  return providers.retrieve('ghcn_daily', station, query, {checkStationFile:true, fetchImpl:async (url, init) => {
    urls.push(url);
    assert.ok(responses.length, 'unexpected extra provider call');
    return responses.shift()(url, init);
  }, ...options});
}

test('Washington: one reporting date in 26 days, two measured zeros, exact original file', async () => {
  const urls = [];
  const result = await retrieve(dc, project, [empty, () => new Response(original)], urls);
  assert.deepEqual(urls, [providers.requestURL('ghcn_daily',dc,project), providers.ghcnStationFileUrl(dc.id)]);
  assert.deepEqual([result.window.start, result.window.end], ['2026-10-18','2026-11-12']);
  assert.equal(result.requestedWindow.end, '2026-11-16');
  assert.equal(result.provenance.reportingDays, 1);
  assert.equal(result.provenance.windowDays, 26);
  assert.equal(result.observationCount, 2);
  for (const key of ['PRCP','SNOW']) {
    const series = result.series.find(s => s.key === key);
    assert.deepEqual(series.points, [{time:'2026-11-12',value:0,flags:{attributes:',,N',measurementFlag:'',qualityFlag:'',sourceFlag:'N',observationTime:null}}]);
    const plotted = chart.model(series,result.window,'ghcn_daily');
    assert.equal(plotted.absent,25);
    assert.equal(plotted.sum,0);
    assert.ok(plotted.lowerBound && !plotted.complete);
  }
  assert.equal(result.rawFormat,'dly');
  assert.equal(result.rawMime,'text/plain');
  assert.equal(result.provenance.rawSha256,hash(original));
  assert.equal(result.provenance.rawByteLength,original.length);
  assert.ok(original.equals(Buffer.from(result.rawBytes)));
  assert.match(result.provenance.processing,/tenths/);
  assert.match(result.requests[0].outcome,/No numeric/);
  assert.match(result.provenance.observationSource,/station file/);
  assert.doesNotMatch(result.notes.join(' '),/Only the displayed preview window was downloaded|Metric units were requested from NCEI/);
});

test('Denver cross-source check: temperatures, rainfall, two-day snow and source flags agree', async () => {
  const station = {id:'USW00023062'}, query = {...project,start:'2022-01-21',end:'2022-01-21'};
  const primary = fixture('USW00023062-20220121.json'), monthly = fixture('USW00023062-202201.dly');
  const nativeResult = await retrieve(station,query,[empty,() => new Response(monthly)]);
  const api = await retrieve(station,query,[() => new Response(primary)]);
  assert.equal(api.rawFormat,'json');
  assert.equal(api.provenance.observationSource,'NOAA Daily Summaries API');
  assert.equal(api.provenance.reportingDays,1);
  for (const [i, value] of [0.6,-6.1,1.5,null].entries()) {
    const a = api.series[i].points[0], b = nativeResult.series[i].points[0];
    assert.equal(a.value,value);
    assert.equal(b.value,a.value);
    for(const key of ['qualityFlag','sourceFlag','measurementFlag']) assert.equal(b.flags[key],a.flags[key]);
    assert.equal(b.flags.observationTime,null);
    assert.deepEqual(b.multiDay,a.multiDay);
  }
  assert.equal(api.series[2].points[0].flags.observationTime,'2400');
  assert.equal(nativeResult.series[3].points[0].multiDay.value,8);
  assert.equal(nativeResult.series[3].points[0].multiDay.days,2);
});

test('both sources can be empty within a valid metadata span', async () => {
  await assert.rejects(retrieve(dc,{...project,end:'2026-11-11'},[empty,() => new Response(original)]),
    e => e.code === 'NO_DATA' && e.requests.length === 2 && /both returned no numeric values/.test(e.message));
});

test('well-formed provider no-data message and null-only rows can also be checked', async () => {
  for (const payload of [{error:{message:'No data available'}}, [{STATION:dc.id,DATE:'2026-11-12',PRCP:'-9999'}]]) {
    const r = await retrieve(dc, project, [() => Response.json(payload), () => new Response(original)]);
    assert.equal(r.provenance.reportingDays,1);
    assert.equal(r.requests.length,2);
  }
});

test('primary-only requests retain transport errors; schema, provider and rate-limit errors stay explicit in recovery mode', async () => {
  for (const [response,code] of [
    [() => new Response('unavailable',{status:503}),'HTTP_503'], [() => new Response('',{status:429}),'HTTP_429'],
    [() => Response.json([{STATION:'US1DCDC0043',DATE:'2026-11-12',PRCP:1}]),'SCHEMA'],
    [() => Response.json({incorrect:[]}), 'SCHEMA'], [() => Response.json({error:{message:'No data server is available due to an outage.'}}), 'PROVIDER_ERROR'],
    [() => {throw new TypeError('Network failed');},'NETWORK']
  ]) {
    const urls = [];
    const recoverableTransport=['HTTP_503','NETWORK'].includes(code);
    await assert.rejects(retrieve(dc,project,[response],urls,{checkStationFile:!recoverableTransport}),e => e.code === code);
    assert.equal(urls.length,1);
  }
});

test('archive failures, wrong stations, truncation and duplicate elements never certify an empty window', async () => {
  const sampleLine = original.toString().split(/\r?\n/).find(l => l.startsWith(dc.id+'202611PRCP'));
  for (const response of [
    () => new Response('rate limited',{status:429}),
    () => new Response(''), () => new Response('<html/>'), () => new Response(sampleLine.slice(0,-1)),
    () => new Response(sampleLine.replace(dc.id,'US1DCDC0043')), () => new Response(sampleLine+'\n'+sampleLine),
    () => new Response(sampleLine.slice(0,21)+'    ?'+sampleLine.slice(26))
  ]) await assert.rejects(retrieve(dc,project,[empty,response]),e => e.code !== 'NO_DATA' && /could not be checked/.test(e.message));
});

test('file size limit is enforced both on the header and on the decoded response stream', async () => {
  for (const response of [
    () => new Response(original,{headers:{'content-length':String(9*1024*1024)}}),
    () => new Response(new Uint8Array(8*1024*1024+1))
  ]) {
    const urls=[];
    const recovered=await retrieve(fairfax,november,[empty,response,noaaCsv],urls);
    assert.equal(recovered.requests[1].outcome,'STATION_FILE_LIMIT');
    assert.equal(urls.length,3);
    assert.equal(recovered.rawFormat,'csv.gz');
  }
});

test('a cancelled archive request stays cancelled', async () => {
  const stop = new AbortController();
  await assert.rejects(retrieve(dc,project,[empty,(_url,init) => new Promise((_ok,reject) => {
    init.signal.addEventListener('abort',() => reject(new DOMException('Cancelled','AbortError')));
    stop.abort();
  })],[],{signal:stop.signal}),e => e.name === 'AbortError');
});

test('Fairfax original NOAA archive recovers exact native observations after an empty API or a transient service failure',async()=>{
  for (const primary of [empty,()=>new Response('',{status:503}),()=>{throw new TypeError('network down');}]) {
    const result=await retrieve(fairfax,november,[primary,()=>new Response('',{status:503}),noaaCsv]);
    const rain=result.series.find(s=>s.key==='PRCP'), model=chart.model(rain,result.window,'ghcn_daily');
    assert.deepEqual(rain.points.map(p=>p.value),[0,.8,4.8,1.8,0,0,0,0,0,.5]);
    assert.equal(rain.points[1].flags.observationTime,'0748');
    assert.equal(rain.points[1].flags.sourceFlag,'N');
    assert.equal(result.provenance.reportingDays,10);
    assert.ok(Math.abs(model.sum-7.9)<1e-8);
    assert.equal(result.rawFormat,'csv.gz');
    assert.equal(result.provenance.rawSha256,hash(fixture('US1VAFX0117.csv.gz')));
    assert.equal(result.requests.at(-1).url,'https://noaa-ghcn-pds.s3.amazonaws.com/csv.gz/by_station/US1VAFX0117.csv.gz');
    assert.match(result.previewCsv,/US1VAFX0117,20261106,PRCP,48,,,N,0750/);
    assert.doesNotMatch(result.previewCsv,/20261103|20261114/);
    assert.ok(!JSON.stringify(result).includes('"rawBytes"'));
  }
});

test('an outdated station object switches to annual NOAA records and retains native CSV and source hashes',async()=>{
  const bytes=fixture('2026-11-PRCP-test.parquet'), station={id:'USW00093721'};
  const prefix='parquet/by_year/YEAR=2026/',key=prefix+'ELEMENT=PRCP/sample.snappy.parquet',etag='"frozen"';
  const list='<ListBucketResult><Name>noaa-ghcn-pds</Name><Prefix>'+prefix+'</Prefix><KeyCount>1</KeyCount><IsTruncated>false</IsTruncated><Contents><Key>'+key+'</Key><Size>'+bytes.length+'</Size><ETag>&quot;frozen&quot;</ETag></Contents></ListBucketResult>';
  const responses=()=>[empty,()=>new Response('',{status:404}),
    ()=>new Response('old snapshot',{headers:{'last-modified':'Sun, 09 Feb 2025 07:53:34 GMT'}}),()=>new Response(list)];
  const payload=()=>new Response(bytes,{headers:{etag}});
  const result=await retrieve(station,november,[...responses(),payload,payload]);
  assert.equal(result.rawFormat,'csv');
  assert.deepEqual(result.series.find(s=>s.key==='PRCP').points.map(p=>p.value),[0,4.1,29,0,0,0,0,0,.3,0]);
  assert.equal(result.requests.at(-1).sha256,hash(bytes));
  assert.equal(result.provenance.extractSha256,hash(Buffer.from(result.previewCsv)));
  assert.ok(!result.provenance.rawSha256 && result.provenance.downloadScope.includes('extract'));
  assert.doesNotMatch(result.previewCsv,/US1VAFX0117/);
  assert.match(result.previewCsv,/USW00093721,20261106,PRCP,290,,,1,/);
  await assert.rejects(retrieve(station,november,[...responses(),payload,()=>new Response(bytes,{headers:{etag:'"new"'}})]),e=>e.code==='ARCHIVE_ACCESS');
});

test('unreadable NOAA archive, a station mismatch and a true empty window remain distinct',async()=>{
  const down=()=>new Response('',{status:503}), {gzipSync}=require('node:zlib');
  const head={'last-modified':'Wed, 18 Nov 2026 02:26:26 GMT'};
  for(const line of ['','US1DCDC0009,20261112,PRCP,0,,,N,0700','US1VAFX0117,20261112,PRCP,5,,,N,0700\nUS1VAFX0117,20261112,PRCP,6,,,N,0700']){
    await assert.rejects(retrieve(fairfax,november,[empty,down,()=>new Response(gzipSync(line),{headers:head})]),e=>e.code==='ARCHIVE_SCHEMA');
  }
  await assert.rejects(retrieve(fairfax,november,[empty,down,()=>new Response(gzipSync('US1VAFX0117,20261012,PRCP,0,,,N,0700'),{headers:head})]),e=>e.code==='NO_DATA' && e.requests.length===3);
  await assert.rejects(retrieve(fairfax,november,[empty,down,down,down]),e=>e.code==='ARCHIVE_ACCESS');
});

test('multi-member NOAA gzip records include later members and reject a damaged final member',async()=>{
  const {gzipSync}=require('node:zlib');
  const first=gzipSync('US1VAFX0117,20261104,PRCP,0,,,N,0700\n');
  const last=gzipSync('US1VAFX0117,20261105,PRCP,8,,,N,0748\n');
  const bytes=Buffer.concat([first,last]), damaged=Buffer.from(bytes);
  damaged[damaged.length-8]^=1;
  const read=body=>retrieve(fairfax,november,[empty,()=>new Response('',{status:503}),
    ()=>new Response(body,{headers:{'last-modified':'Wed, 18 Nov 2026 02:26:26 GMT'}})]);
  const result=await read(bytes);
  assert.deepEqual(result.series.find(s=>s.key==='PRCP').points.map(p=>p.value),[0,0.8]);
  assert.equal(result.provenance.rawSha256,hash(bytes));
  for(const broken of [damaged,bytes.subarray(0,-4)]) await assert.rejects(read(broken),e=>e.code==='ARCHIVE_SCHEMA');
});

test('NOAA archive recovery preserves trace, failed QC, missing sentinel, snowfall and accumulation duration across New Year',async()=>{
  const id=fairfax.id, {gzipSync}=require('node:zlib');
  const lines=['20251231,PRCP,0,T,,N,0700','20251231,TMIN,-25,,X,1,2400','20251231,SNOW,3,,,N,0700',
    '20260101,PRCP,-9999,,X,N,0700','20260101,MDPR,74,,,N,1911','20260101,DAPR,7,,,N,1911'];
  const bytes=gzipSync(lines.map(s=>id+','+s).join('\n'));
  const result=await retrieve(fairfax,{...project,start:'2025-12-31',end:'2026-01-01'},[empty,()=>new Response('',{status:503}),()=>new Response(bytes,{headers:{'last-modified':'Wed, 18 Nov 2026 02:26:26 GMT'}})]);
  const rain=result.series.find(s=>s.key==='PRCP').points;
  assert.equal(rain[0].flags.measurementFlag,'T');
  assert.equal(rain[1].value,null);
  assert.equal(rain[1].flags.missingSentinel,'-9999');
  assert.equal(rain[1].multiDay.value,7.4);
  assert.equal(rain[1].multiDay.days,7);
  assert.equal(result.series.find(s=>s.key==='TMIN').points[0].value,-2.5);
  assert.equal(result.series.find(s=>s.key==='TMIN').points[0].flags.qualityFlag,'X');
  assert.equal(result.series.find(s=>s.key==='SNOW').points[0].value,3);
});

test('cancel during the Open Data fallback never completes the superseded station',async()=>{
  const stop=new AbortController();
  const blocked=(_url,init)=>new Promise((_resolve,reject)=>{
    init.signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')));
    stop.abort();
  });
  await assert.rejects(retrieve(fairfax,november,[empty,()=>new Response('',{status:503}),blocked],[],{signal:stop.signal}),e=>e.name==='AbortError');
});

test('native scaling and flags retain measured, trace, presumed-zero, failed-QC and multi-day information', async () => {
  const line = (key,values) => dc.id+'202611'+key+Array.from({length:31},(_,i) => {
    const [v,flags] = values[i+1] || [-9999,'   '];
    return String(v).padStart(5)+flags;
  }).join('');
  const rows = [
    line('PRCP',{7:[0,'T N'],8:[0,'P N'],9:[121,' XN'],10:[-9999,'  N']}),
    line('MDPR',{10:[252,'  N']}),line('DAPR',{10:[3,'  N']}),line('SNOW',{11:[7,'  N']})
  ];
  const r = await retrieve(dc,{...project,start:'2026-11-07',end:'2026-11-11'},[empty,() => new Response(rows.join('\r\n')+'\r\n')]);
  const rain = r.series.find(s => s.key === 'PRCP');
  const m = chart.model(rain,r.window,'ghcn_daily');
  assert.deepEqual(rain.points.map(p => p.value),[0,0,12.1,null,null]);
  assert.equal(rain.points[3].multiDay.value,25.2);
  assert.equal(rain.points[3].multiDay.days,3);
  assert.equal(rain.points[3].flags.missingSentinel,'-9999');
  assert.deepEqual([m.traceCount,m.presumedZeroCount,m.failedCount,m.multiDayMissing],[1,1,1,1]);
  assert.equal(r.series.find(s => s.key === 'SNOW').points.at(-1).value,7);
});
