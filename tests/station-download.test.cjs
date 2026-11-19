const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const D = require('../src/station-download.js'), A = require('../src/access.js');
const examples = require('../data/examples.json').examples;
const weather = examples.find(e => e.productId === 'ghcn_daily'), river = examples.find(e => e.productId === 'usgs_streamflow');
const candidates = require('./fixtures/coops/candidates.json').candidateSearch.stations;
const navy = candidates.find(s => s.id === '8593005');

test('GHCN direct CSV and yearly script cover the original period with provider flags and units', () => {
  const q = {...weather.query, start:'2019-12-31', end:'2021-01-01'}, plan = D.prepare('ghcn_daily', weather.station, q);
  assert.deepEqual(plan.errors, []); assert.equal(plan.requestCount, 3);
  assert.deepEqual(plan.requests.map(r => [r.start,r.end]), [['2019-12-31','2019-12-31'],['2020-01-01','2020-12-31'],['2021-01-01','2021-01-01']]);
  const url = new URL(plan.directUrl);
  assert.equal(url.searchParams.get('startDate'), q.start); assert.equal(url.searchParams.get('endDate'), q.end);
  assert.equal(url.searchParams.get('format'), 'csv'); assert.equal(url.searchParams.get('includeAttributes'), 'true');
  assert.equal(url.searchParams.get('units'), 'metric'); assert.equal(url.searchParams.get('dataTypes'), 'TMAX,TMIN,PRCP,SNOW,MDPR,DAPR,MDSF,DASF');
  assert.equal(plan.estimatedTotalBytes, null); assert.equal(plan.manifest.transferSummary.requiresConfirmation, true);
});

test('CO-OPS schedules all real listed overlap with exact endpoints and explicit unscheduled project dates', () => {
  const q = {...weather.query,start:'1995-07-01',end:'1995-11-30'}, plan = D.prepare('noaa_coops_water_level', navy, q);
  assert.deepEqual(plan.errors, []); assert.ok(plan.requestCount > 1);
  assert.equal(plan.requests[0].startTime, '1995-07-17T20:00:00.000Z');
  assert.equal(plan.requests.at(-1).endTime, '1995-11-17T17:00:00.000Z');
  assert.equal(plan.unrequestedIntervals[0].startTime,'1995-07-01T00:00:00.000Z');
  assert.equal(plan.unrequestedIntervals.at(-1).endTime,'1995-11-30T23:54:00.000Z');
  for (let i=0;i<plan.requests.length;i++) {
    const r=plan.requests[i]; assert.ok((Date.parse(r.end+'T00:00:00Z')-Date.parse(r.start+'T00:00:00Z'))/86400000 <28);
    assert.equal(new URL(r.url).searchParams.get('datum'),'MSL');
    if(i) assert.equal(Date.parse(r.startTime)-Date.parse(plan.requests[i-1].endTime),360000);
  }
  assert.deepEqual(plan.manifest.requestedWindow,{start:q.start,end:q.end});
});

test('CO-OPS disjoint and overlapping metadata rows preserve real gaps without duplicate boundary requests', () => {
  const s=structuredClone(navy), q={...weather.query,start:'2020-07-01',end:'2020-07-03'};
  s.coopsAvailability.periods=[['2020-07-01 00:00','2020-07-01 00:12'],['2020-07-01 00:06','2020-07-01 00:18'],['2020-07-03 12:00','2020-07-03 12:06']].map(([first,last])=>({first,last,product:'Verified 6-Minute Water Level',kind:'verified',start:first.slice(0,10),end:last.slice(0,10)}));
  const plan=D.prepare('noaa_coops_water_level',s,q);assert.deepEqual(plan.errors,[]);assert.equal(plan.requestCount,2);
  assert.equal(plan.requests[0].endTime,'2020-07-01T00:18:00.000Z');assert.equal(plan.requests[1].startTime,'2020-07-03T12:00:00.000Z');
  assert.equal(plan.unrequestedIntervals[0].startTime,'2020-07-01T00:24:00.000Z');
});

test('known CO-OPS mismatches and unchecked datum metadata cannot prepare a full-period transfer', () => {
  assert.ok(D.prepare('noaa_coops_water_level',navy,weather.query).errors.length);
  const s=structuredClone(navy);delete s.coopsAvailability;
  assert.ok(D.prepare('noaa_coops_water_level',s,{...weather.query,start:'1995-07-20',end:'1995-07-21'}).errors.length);
  assert.ok(D.prepare('ghcn_daily',{id:'../../other'},weather.query).errors.length);
});

test('USGS plans original project dates and keeps total page count unknown',()=>{
  const q={...river.query,end:'2021-07-03'},plan=D.prepare('usgs_streamflow',river.station,q);
  assert.deepEqual(plan.errors,[]);assert.equal(plan.requestCount,1);assert.equal(plan.manifest.transferSummary.totalPagesKnown,false);
  const url=new URL(plan.requests[0].url);assert.equal(url.searchParams.get('time'),q.start+'/'+q.end);
  assert.equal(url.searchParams.get('parameter_code'),'00060');assert.equal(url.searchParams.get('statistic_id'),'00003');
});

test('public file checkbox scripts preserve full loaded order and refuse authenticated or unknown-auth discoveries',()=>{
  const files=[{name:'two.nc',url:'https://example.org/two.nc',sizeBytes:5},{name:'one.nc',url:'https://example.org/one.nc',sizeBytes:2}];
  const result=A.fileScript('chirps_v2_daily',files);assert.ok(result.artifact);assert.equal(result.reason,null);
  assert.ok(result.artifact.text.indexOf('two.nc')<result.artifact.text.indexOf('one.nc'));
  assert.equal(A.fileScript('chirps_v2_daily',[{...files[0],authRequired:true}]).artifact,null);
  const id=Object.keys(require('../data/access.json').profiles).find(id=>require('../data/access.json').profiles[id].strategy==='cmr');
  assert.equal(A.fileScript(id,files).artifact,null);
  assert.equal(A.fileScript(id,files.map(f=>({...f,authRequired:false}))).reason,null);
});

const runner=String.raw`
import contextlib, importlib.util, io, json, sys
from pathlib import Path
payload=json.load(sys.stdin)
spec=importlib.util.spec_from_file_location('station_download',payload['script'])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
calls=[]
class Response:
    status=200
    def __init__(self,body):
        self.body=io.BytesIO(body.encode());self.headers={'Content-Type':'application/json','Content-Length':str(len(body.encode()))}
    def read(self,n): return self.body.read(n)
    def __enter__(self): return self
    def __exit__(self,*args): pass
class Opener:
    def open(self,request,timeout):
        calls.append(request.full_url)
        entry=payload['responses'][len(calls)-1]
        if isinstance(entry,dict) and 'httpError' in entry:
            body=io.BytesIO(b'provider fixture')
            if entry.get('brokenBody'):
                class BrokenBody(io.BytesIO):
                    def read(self,*args): raise OSError('Diagnostic stream failed')
                body=BrokenBody()
            raise m.HTTPError(request.full_url,entry['httpError'],'fixture failure',{},body)
        if entry=='CANCEL': raise KeyboardInterrupt()
        return Response(entry)
m.build_opener=lambda *args:Opener()
m.time.sleep=lambda seconds:None
sys.argv=[payload['script'],*payload['args'],'--output',payload['output']]
if payload.get('existing'):
    target=Path(payload['output'])/m.CONFIG['requests'][0]['name'];target.parent.mkdir(parents=True);target.write_text('KEEP')
log=io.StringIO()
with contextlib.redirect_stdout(log),contextlib.redirect_stderr(log):
    try: status=m.main()
    except SystemExit as e: status=e.code
folder=Path(payload['output'])
receipts=list(folder.glob('receipt-*.json'))
receipt=json.loads(receipts[0].read_text()) if receipts else None
print(json.dumps({'exit':status,'calls':calls,'receipt':receipt,'files':{p.name:p.read_bytes().decode('utf-8') for p in sorted(folder.glob('*'), reverse=True) if p.is_file() and not p.name.startswith('receipt-')},'log':log.getvalue()}))
`;
function execute(plan,responses,args=['--download','--confirm-transfer'],extra={}) {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'inventory-station-test-'));
  try {
    const script=path.join(folder,'download.py');fs.writeFileSync(script,plan.script.text);
    const child=cp.spawnSync('python',['-c',runner],{input:JSON.stringify({script,responses,args,output:path.join(folder,'data'),...extra}),encoding:'utf8',timeout:20000});
    assert.equal(child.status,0,child.stderr||child.stdout);return JSON.parse(child.stdout);
  } finally {
    assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));
    assert.match(path.basename(folder),/^inventory-station-test-/);
    fs.rmSync(folder,{recursive:true,force:true});
  }
}
const weatherPlan=()=>D.prepare('ghcn_daily',weather.station,weather.query);

test('generated station script dry run and missing confirmation make no network request or data files',()=>{
  for(const args of [[],['--download']]) {const result=execute(weatherPlan(),[],args);assert.equal(result.calls.length,0);assert.equal(result.receipt,null);assert.deepEqual(result.files,{});assert.equal(result.exit,args.length?2:0);}
});

test('generated downloader preserves exact real NCEI payload bytes and records rows/hash',()=>{
  const result=execute(weatherPlan(),[weather.result.rawText]);assert.equal(result.exit,0);assert.equal(result.receipt.complete,true);
  assert.equal(Object.values(result.files)[0],weather.result.rawText);assert.equal(result.receipt.files[0].returnedRows,3);
  assert.equal(result.receipt.files[0].sha256,require('node:crypto').createHash('sha256').update(weather.result.rawText).digest('hex'));
});

test('generated USGS downloader follows same-query next pages and preserves both original pages',()=>{
  const plan=D.prepare('usgs_streamflow',river.station,river.query), data=JSON.parse(river.result.rawText), next=new URL(plan.requests[0].url);next.searchParams.set('offset','2');
  const pages=[{...data,features:data.features.slice(0,2),numberReturned:2,links:[{rel:'next',href:next.href}]},{...data,features:data.features.slice(2),numberReturned:1,links:[]}].map(JSON.stringify);
  const result=execute(plan,pages);assert.equal(result.exit,0);assert.equal(result.calls.length,2);assert.equal(result.receipt.files.length,2);assert.equal(result.receipt.files.reduce((n,f)=>n+f.returnedRows,0),3);
  assert.deepEqual(result.receipt.files.map(file=>result.files[file.file]),pages);
});

test('generated CO-OPS downloader accepts the exact historical overlap and rejects a no-data response',()=>{
  const plan=D.prepare('noaa_coops_water_level',navy,{...weather.query,start:'1995-07-01',end:'1995-07-20'});
  const raw=fs.readFileSync(path.join(__dirname,'./fixtures/coops/navy-yard-observations.json'),'utf8');
  const success=execute(plan,[raw]);assert.equal(success.exit,0);assert.equal(success.receipt.files[0].returnedRows,760);assert.equal(Object.values(success.files)[0],raw);
  const empty=execute(plan,[JSON.stringify({error:{message:'No data was found.'}})]);
  assert.equal(empty.exit,1);assert.equal(empty.receipt.files.length,0);assert.match(empty.receipt.failures[0].error,/No data was found/);
});

test('the generated downloader follows the actual USGS cursor response without rewriting its filters',()=>{
  const plan=D.prepare('usgs_streamflow',river.station,river.query);
  const url=new URL(plan.manifest.requests[0].url);url.searchParams.set('limit','2');
  plan.manifest.requests[0].url=url.href;plan.script.text=D._test.python(plan.manifest);
  const pages=[1,2].map(n=>fs.readFileSync(path.join(__dirname,'./fixtures/usgs/page-'+n+'.json'),'utf8'));
  const result=execute(plan,pages);assert.equal(result.exit,0);assert.equal(result.calls.length,2);
  assert.ok(new URL(result.calls[1]).searchParams.has('cursor'));assert.deepEqual(result.receipt.files.map(file=>result.files[file.file]),pages);
});

test('USGS changed-filter or foreign pagination is rejected before sending another request',()=>{
  const plan=D.prepare('usgs_streamflow',river.station,river.query),data=JSON.parse(river.result.rawText);
  for(const href of ['https://other.example/next',plan.requests[0].url.replace('00060','00065')]) {
    const result=execute(plan,[JSON.stringify({...data,links:[{rel:'next',href}]})]);assert.equal(result.exit,1);assert.equal(result.calls.length,1);assert.equal(result.receipt.complete,false);assert.equal(result.receipt.files.length,0);
  }
});

test('USGS duplicate rows across pages are retained as an incomplete partial response, not accepted twice',()=>{
  const plan=D.prepare('usgs_streamflow',river.station,river.query),data=JSON.parse(river.result.rawText),next=new URL(plan.requests[0].url);next.searchParams.set('offset','3');
  const result=execute(plan,[JSON.stringify({...data,links:[{rel:'next',href:next.href}]}),JSON.stringify({...data,links:[]})]);
  assert.equal(result.exit,1);assert.equal(result.receipt.files.length,1);assert.match(result.receipt.failures[0].error,/Repeated USGS/);assert.ok(Object.keys(result.files).some(n=>n.endsWith('.part')));
});

test('rate limits stop unsent requests; ordinary failures continue and cancellation retains a receipt',()=>{
  const plan=D.prepare('ghcn_daily',weather.station,{...weather.query,start:'2019-12-31',end:'2020-07-03'});
  const limited=execute(plan,[{httpError:429}]);assert.equal(limited.calls.length,1);assert.equal(limited.receipt.rateLimited,true);assert.equal(limited.exit,1);
  const failed=execute(plan,['not json',weather.result.rawText]);assert.equal(failed.calls.length,2);assert.equal(failed.receipt.files.length,1);assert.equal(failed.receipt.failures.length,1);assert.equal(failed.exit,1);
  const cancelled=execute(plan,['CANCEL']);assert.equal(cancelled.calls.length,1);assert.equal(cancelled.receipt.cancelled,true);assert.equal(cancelled.exit,1);
});

test('existing station files are never overwritten or fetched again implicitly',()=>{
  const result=execute(weatherPlan(),[],['--download','--confirm-transfer'],{existing:true});assert.equal(result.calls.length,0);assert.equal(result.exit,1);assert.deepEqual(Object.values(result.files),['KEEP']);
});

test('malformed USGS envelopes cannot be mistaken for the end of pagination',()=>{
  const plan=D.prepare('usgs_streamflow',river.station,river.query),data=JSON.parse(river.result.rawText);
  const missing={...data};delete missing.links;
  for(const payload of [missing,{...data,type:'Other'},{...data,links:{rel:'next',href:plan.requests[0].url}},{...data,links:[{href:'https://example.org'}]},{...data,numberReturned:999}]) {
    const result=execute(plan,[JSON.stringify(payload)]);assert.equal(result.exit,1);assert.equal(result.receipt.complete,false);assert.equal(result.receipt.files.length,0);
  }
});

test('CO-OPS noncanonical timestamps cannot conceal duplicate instants',()=>{
  const plan=D.prepare('noaa_coops_water_level',navy,{...weather.query,start:'1995-07-01',end:'1995-07-20'});
  const payload={metadata:{id:navy.id},data:[{t:'1995-7-17 20:0',v:'1'},{t:'1995-07-17 20:00',v:'1'}]};
  const result=execute(plan,[JSON.stringify(payload)]);assert.equal(result.exit,1);assert.match(result.receipt.failures[0].error,/Noncanonical CO-OPS/);
});

test('unreadable HTTP error bodies preserve the status and batch failure policy',()=>{
  const plan=D.prepare('ghcn_daily',weather.station,{...weather.query,start:'2019-12-31',end:'2020-07-03'});
  const limited=execute(plan,[{httpError:429,brokenBody:true}]);assert.equal(limited.calls.length,1);assert.equal(limited.receipt.rateLimited,true);assert.equal(limited.receipt.failures[0].httpStatus,429);assert.match(limited.receipt.failures[0].diagnosticError,/Diagnostic stream/);
  const failed=execute(plan,[{httpError:500,brokenBody:true},weather.result.rawText]);assert.equal(failed.calls.length,2);assert.equal(failed.receipt.files.length,1);assert.equal(failed.receipt.failures[0].httpStatus,500);assert.equal(failed.exit,1);
});
