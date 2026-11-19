const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const R = require('../src/provider-requests.js');
const Geometry = require('../src/geometry.js');
const variables = {
  era5_t2m: ['2m_temperature'],
  era5_t2m_interval_extrema: ['maximum_2m_temperature_since_previous_post_processing','minimum_2m_temperature_since_previous_post_processing'],
  era5_wind10: ['10m_u_component_of_wind','10m_v_component_of_wind'],
  era5_gust10: ['10m_wind_gust_since_previous_post_processing']
};
const prefixes = {
  mrms_radaronly_qpe: ['CONUS/RadarOnly_QPE_01H_00.00/'],
  mrms_multisensor_qpe: ['CONUS/MultiSensor_QPE_01H_Pass1_00.00/','CONUS/MultiSensor_QPE_01H_Pass2_00.00/'],
  mrms_mesh: ['CONUS/MESH_00.50/']
};
const profile = id => ({id, parameterMapping: variables[id] ? {dataset:'reanalysis-era5-single-levels',product_type:['reanalysis'],variable:variables[id],data_format:'grib'} : {verifiedCONUSPrefixes:prefixes[id]}, documentationUrls:['https://cds.climate.copernicus.eu/how-to-api']});
const q = {mode:'point',lat:38.9,lon:-77.04,radiusKm:100,start:'2020-07-01',end:'2020-07-03'};
const plan = (id='era5_t2m', query=q, options={}) => R.prepare(profile(id),query,options);
const config = result => JSON.parse(result.artifacts.find(a=>a.name.endsWith('-config.json')).text);
const script = result => result.artifacts.find(a=>a.name.endsWith('.py'));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(),'inventory-request-tests-'));
function save(result, dir=temp()) {const target=path.join(dir,script(result).name); fs.writeFileSync(target,script(result).text); return {dir,target};}
function python(args, cwd) {return spawnSync('python',args,{cwd,encoding:'utf8',timeout:20000});}
function runDry(result) {const f=save(result), p=python([f.target],f.dir); assert.equal(p.status,0,p.stderr); return JSON.parse(p.stdout);}
const xmlEscape = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function listing(prefix,names,{truncated=false,token=null,keyCount=names.length,size=123}={}) {
  return '<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Prefix>'+xmlEscape(prefix)+'</Prefix><KeyCount>'+keyCount+'</KeyCount><IsTruncated>'+truncated+'</IsTruncated>'+ (token===null?'':'<NextContinuationToken>'+xmlEscape(token)+'</NextContinuationToken>')+names.map(name=>'<Contents><Key>'+xmlEscape(prefix+name)+'</Key><Size>'+size+'</Size><ETag>"provider-tag"</ETag><LastModified>2020-10-14T00:00:00Z</LastModified></Contents>').join('')+'</ListBucketResult>';
}
function runMrms(result,responses,{defaultOutput=false,preexistingHtml=null,extraArgs=[],directory=null}={}) {
  const f=save(result,directory||temp()), fixture=path.join(f.dir,'responses.json'), manifest=path.join(f.dir,defaultOutput?result.productId+'_file-manifest.json':'manifest.json'), wrapper=path.join(f.dir,'mock-network.py');
  const html=path.join(f.dir,defaultOutput?result.productId+'_file-links.html':'manifest.html');
  if(preexistingHtml!==null)fs.writeFileSync(html,preexistingHtml);
  fs.writeFileSync(fixture,JSON.stringify(responses));
  fs.writeFileSync(wrapper,`import base64,io,json,runpy,sys,time,urllib.request\nfrom pathlib import Path\nscript,fixture,output,mode,extra=sys.argv[1:]\nresponses=json.loads(Path(fixture).read_text())\nurls=[]\nclass Response(io.BytesIO):\n    def __init__(self,value):\n        super().__init__(base64.b64decode(value['body']))\n        self.status=value.get('status',200)\n        self.headers=value.get('headers',{})\ndef mock(request,timeout=None):\n    urls.append(request.full_url)\n    if not responses: raise RuntimeError('Unexpected extra request')\n    response=responses.pop(0)\n    if isinstance(response,dict):\n        if response.get('cancel'): raise KeyboardInterrupt()\n        if 'error' in response: raise RuntimeError(response['error'])\n        return Response(response)\n    return io.BytesIO(response.encode())\nurllib.request.urlopen=mock\ntime.sleep=lambda *_:None\nsys.argv=[script,'--execute']+([] if mode=='default' else ['--output',output])+json.loads(extra)\ntry:\n    runpy.run_path(script,run_name='__main__')\nfinally:\n    Path(output+'.urls.json').write_text(json.dumps(urls))\n`);
  const p=python([wrapper,f.target,fixture,manifest,defaultOutput?'default':'custom',JSON.stringify(extraArgs)],f.dir);
  let output=null;try{output=JSON.parse(p.stdout);}catch(_){}
  const listingManifest=fs.existsSync(manifest)?JSON.parse(fs.readFileSync(manifest)):null;
  const receipt=output?.transferReceipt?JSON.parse(fs.readFileSync(path.resolve(f.dir,output.transferReceipt))):null;
  return {p,dir:f.dir,manifest:receipt||listingManifest,listingManifest,output,urls:JSON.parse(fs.readFileSync(manifest+'.urls.json')),html:fs.existsSync(html)?fs.readFileSync(html,'utf8'):null,htmlName:path.basename(html)};
}
function fakeCds(dir,{failAt=0,empty=false}={}) {
  fs.writeFileSync(path.join(dir,'cdsapi.py'),`import json\nfrom pathlib import Path\ncalls=[]\nclass Client:\n    def __init__(self,**kwargs): pass\n    def retrieve(self,dataset,request,target):\n        calls.append({'dataset':dataset,'request':request,'target':Path(target).name})\n        Path('captured-calls.json').write_text(json.dumps(calls))\n        if len(calls)==${failAt}: raise RuntimeError('synthetic failure')\n        ${empty ? 'return' : "Path(target).write_bytes(b'GRIB-synthetic-test-only')"}\n`);
}

test('four CDS products retain exact distinct variables, HRES, UTC hours and unarchived GRIB',()=>{
  for(const [id, expected] of Object.entries(variables)) {
    const interval=/interval_extrema|gust10/.test(id);
    const p=plan(id); assert.deepEqual(p.errors,[]); assert.equal(p.requests.length,interval?3:1);
    assert.deepEqual(p.requests[0].request.variable,expected); assert.deepEqual(p.requests[0].request.product_type,['reanalysis']);
    assert.deepEqual(p.requests[0].request.day,interval?['01']:['01','02','03']); assert.equal(p.requests[0].request.time.length,interval?23:24);
    if(interval) {assert.deepEqual(p.requests.at(-1).request.day,['04']);assert.deepEqual(p.requests.at(-1).request.time,['00:00']);assert.deepEqual(runDry(p).requests,p.requests);}
    assert.equal(p.requests[0].request.time.at(-1),'23:00'); assert.equal(p.requests[0].request.data_format,'grib'); assert.equal(p.requests[0].request.download_format,'unarchived');
    assert.match(p.notes.join(' '),/Authenticated retrieval has not been tested/);
  }
});

test('inclusive leap-day and cross-month requests do not add unrequested days',()=>{
  const p=plan('era5_t2m',{...q,start:'2020-02-28',end:'2020-03-01'});
  assert.equal(p.requests.length,2); assert.deepEqual(p.requests.map(r=>r.request.day),[['28','29'],['01']]);
  assert.deepEqual(p.requests.map(r=>r.request.month),[['02'],['03']]); assert.notEqual(p.requests[0].target,p.requests[1].target);
  assert.deepEqual(runDry(p).requests,p.requests);
});

test('point request declares its coordinate bracket and keeps the dateline column once',()=>{
  const p=plan('era5_wind10',{...q,lat:0,lon:179.95}); assert.deepEqual(p.errors,[]); assert.equal(p.requests.length,1);
  assert.deepEqual(config(p).boxes,[[-180,-0.125,-179.925,0.125]]);
  assert.match(p.notes.join(' '),/not point interpolation or a guaranteed nearest grid cell/);
  const pole=plan('era5_t2m',{...q,lat:90,lon:0}); assert.deepEqual(pole.requests[0].request.area,[90,-0.125,89.875,0.125]);
});

test('area requests retain full source and geometry while excluding station buffer from boxes',()=>{
  const geometry={type:'Polygon',coordinates:[[[1,1],[3,1],[3,3],[1,3],[1,1]],[[1.5,1.5],[1.5,2],[2,2],[2,1.5],[1.5,1.5]]]};
  const area={mode:'area',geometry,areaName:'A project',areaSource:{provider:'User GeoJSON',sha256:'source-hash'},bufferKm:100,start:q.start,end:q.end};
  const p=plan('era5_gust10',area); assert.deepEqual(p.errors,[]); assert.deepEqual(config(p).boxes,Geometry.searchBoxes({...area,bufferKm:0}));
  assert.deepEqual(config(p).originalQuery,area); assert.match(p.notes.join(' '),/not polygon clipped or area averaged/);
  assert.deepEqual(runDry(p).requests,p.requests); p.query.geometry.coordinates[0][0][0]=100; assert.equal(area.geometry.coordinates[0][0][0],1);
});

test('invalid project dates/geography, pre-1940 ERA5 and wrong scientific profiles fail before script export',()=>{
  for(const query of [null,{...q,start:'0000-01-01'},{...q,start:'2020-02-30'},{...q,end:'2020-06-30'},{...q,end:'2999-01-01'},{...q,start:'1939-12-31'},{...q,lat:100}]) {
    const p=plan('era5_t2m',query); assert.ok(p.errors.length); assert.equal(p.artifacts.length,0);
  }
  for(const change of [{variable:['total_precipitation']},{product_type:['ensemble_members']},{data_format:'netcdf'},{dataset:'reanalysis-era5-land'}]) {
    const changed=profile('era5_t2m'); Object.assign(changed.parameterMapping,change); assert.ok(R.prepare(changed,q).errors.length);
  }
  assert.ok(R.prepare({id:'unknown'},q).errors.length);
});

test('MRMS choices expose both multisensor passes and use the verified MESH 00.50 prefix',()=>{
  const options=R.describeOptions('mrms_multisensor_qpe'); assert.equal(options[0].key,'mrmsField'); assert.equal(options[0].choices.length,2); assert.equal(options[0].value,prefixes.mrms_multisensor_qpe[0]);
  const pass2=plan('mrms_multisensor_qpe',q,{mrmsField:options[0].choices[1].value}); assert.deepEqual(pass2.errors,[]); assert.equal(config(pass2).prefix,prefixes.mrms_multisensor_qpe[1]);
  assert.equal(config(plan('mrms_mesh')).prefix,'CONUS/MESH_00.50/');
  assert.ok(plan('mrms_mesh',q,{mrmsField:'CONUS/MESH_00.00/'}).errors.length); assert.deepEqual(R.describeOptions('era5_t2m'),[]);
});

test('MRMS long periods use lazy date-listing generation and never invent object filenames',()=>{
  const p=plan('mrms_mesh',{...q,start:'1900-01-01',end:'2020-12-31'}); assert.equal(p.requests.length,1);
  assert.equal(p.requests[0].initialDateListings,44195); assert.equal(p.requests[0].payloadDownload,false); assert.equal(new URL(p.requests[0].url).searchParams.get('prefix'),'CONUS/MESH_00.50/19000101/');
  const dry=runDry(p); assert.equal(dry.initialDateListings,44195); assert.match(dry.actionOnExecute,/no GRIB2/); assert.ok(script(p).text.length<script(plan('mrms_mesh')).text.length+2000);
});

test('all supported generated scripts compile and dry-run without network or CDS credential access',()=>{
  for(const id of R.supported) {
    const p=id==='c3s_lake_water_level' ?
      require('../src/access.js').prepare(id,q,{lakeTarget:'southern_africa/victoria'}) : plan(id);
    assert.deepEqual(p.errors,[],id);const f=save(p); fs.writeFileSync(path.join(f.dir,'cdsapi.py'),"raise RuntimeError('Dry run must not import cdsapi')\n");
    const compiled=python(['-m','py_compile',f.target],f.dir); assert.equal(compiled.status,0,compiled.stderr);
    const dry=python([f.target],f.dir); assert.equal(dry.status,0,dry.stderr); assert.equal(JSON.parse(dry.stdout).mode,'dry-run');
  }
});

test('untrusted project labels remain data in Python configuration',()=>{
  const name='\"\n\'\'\'; __import__(\"pathlib\").Path(\"injected\").touch(); # ${bad} `bad` \\ snowâ˜ƒ';
  const area={mode:'area',geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]]},areaName:name,areaSource:{label:name},bufferKm:0,start:q.start,end:q.end};
  const p=plan('era5_t2m',area),f=save(p); const run=python([f.target],f.dir); assert.equal(run.status,0,run.stderr); assert.equal(config(p).originalQuery.areaName,name); assert.equal(fs.existsSync(path.join(f.dir,'injected')),false);
});

test('synthetic CDS execution captures exact requests and hashes actual returned bytes',()=>{
  const p=plan('era5_t2m',{...q,start:'2020-02-29',end:'2020-03-01'}),f=save(p); fakeCds(f.dir); const out=path.join(f.dir,'received');
  const run=python([f.target,'--execute','--confirm-transfer','--output',out],f.dir); assert.equal(run.status,0,run.stderr);
  const manifest=JSON.parse(fs.readFileSync(path.join(out,'retrieval-manifest.json'))); assert.equal(manifest.complete,true); assert.equal(manifest.files.length,2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir,'captured-calls.json'))),p.requests);
  const hash=crypto.createHash('sha256').update('GRIB-synthetic-test-only').digest('hex'); assert.ok(manifest.files.every(x=>x.sha256===hash));
  assert.match(manifest.qualification,/scientific metadata/);
  const rerun=python([f.target,'--execute','--confirm-transfer','--output',out],f.dir); assert.equal(rerun.status,1); assert.match(rerun.stderr,/will not be overwritten/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'retrieval-manifest.json'))).complete,true);
});

test('CDS later failure preserves the earlier receipt and incomplete status; empty target is not success',()=>{
  const p=plan('era5_t2m',{...q,start:'2020-02-29',end:'2020-03-01'}),f=save(p); fakeCds(f.dir,{failAt:2}); const out=path.join(f.dir,'received');
  const run=python([f.target,'--execute','--confirm-transfer','--output',out],f.dir); assert.equal(run.status,2,run.stderr); const manifest=JSON.parse(fs.readFileSync(path.join(out,'retrieval-manifest.json')));
  assert.equal(manifest.complete,false); assert.equal(manifest.files.length,1); assert.equal(manifest.requests.length,2);
  const e=save(plan()); fakeCds(e.dir,{empty:true}); const eo=path.join(e.dir,'empty'); const er=python([e.target,'--execute','--confirm-transfer','--output',eo],e.dir); assert.equal(er.status,2); assert.equal(JSON.parse(fs.readFileSync(path.join(eo,'retrieval-manifest.json'))).files.length,0);
});

test('MRMS follows encoded pagination and retains all files with explicit unverified payload status',()=>{
  const p=plan('mrms_mesh',{...q,start:'2020-10-14',end:'2020-10-14'}),prefix='CONUS/MESH_00.50/20201014/';
  const r=runMrms(p,[listing(prefix,['a.grib2.gz'],{truncated:true,token:'next+/='}),listing(prefix,['b.grib2.gz'])]);
  assert.equal(r.p.status,0,r.p.stderr); assert.equal(r.manifest.complete,true); assert.equal(r.manifest.files.length,2);
  assert.equal(new URL(r.urls[1]).searchParams.get('continuation-token'),'next+/='); assert.ok(r.manifest.files.every(f=>f.payloadVerified===false)); assert.equal(JSON.parse(r.p.stdout).payloadsDownloaded,0);
  assert.deepEqual(r.manifest.configuration.originalQuery,{...q,start:'2020-10-14',end:'2020-10-14'});
});

test('MRMS failure and cancellation preserve accepted earlier pages without claiming completeness',()=>{
  const p=plan('mrms_mesh',{...q,start:'2020-10-14',end:'2020-10-14'}),prefix='CONUS/MESH_00.50/20201014/';
  for(const failure of [{error:'synthetic network failure'},{cancel:true},'<Error><Code>AccessDenied</Code></Error>',listing(prefix,['a.grib2.gz']),listing(prefix,['b.grib2.gz'],{truncated:true,token:'again'})]) {
    const r=runMrms(p,[listing(prefix,['a.grib2.gz'],{truncated:true,token:'again'}),failure]); assert.equal(r.p.status,2,r.p.stderr); assert.equal(r.manifest.complete,false); assert.equal(r.manifest.files.length,1); assert.equal(r.manifest.requests.length,1); assert.ok(r.manifest.error);
  }
});

test('MRMS malformed prefixes, counts, duplicate keys and pagination are rejected as incomplete',()=>{
  const p=plan('mrms_mesh',{...q,start:'2020-10-14',end:'2020-10-14'}),prefix='CONUS/MESH_00.50/20201014/';
  for(const bad of [listing('CONUS/Other/20201014/',['a.grib2.gz']),listing(prefix,['a.grib2.gz'],{keyCount:0}),listing(prefix,['a.grib2.gz','a.grib2.gz']),listing(prefix,['a.grib2.gz'],{truncated:true}),listing(prefix,['../a.grib2.gz']),'<html>provider proxy failure</html>']) {
    const r=runMrms(p,[bad]); assert.equal(r.p.status,2,r.p.stderr); assert.equal(r.manifest.complete,false); assert.equal(r.manifest.files.length,0);
  }
});

test('MRMS empty successful listings are archive-list completion only, not absence of observations',()=>{
  const p=plan('mrms_mesh',{...q,start:'2020-10-14',end:'2020-10-15'});
  const r=runMrms(p,[listing('CONUS/MESH_00.50/20201014/',[]),listing('CONUS/MESH_00.50/20201015/',[])]);
  assert.equal(r.p.status,0,r.p.stderr); assert.equal(r.manifest.complete,true); assert.equal(r.manifest.files.length,0); assert.equal(r.urls.length,2); assert.match(r.manifest.qualification,/do not establish absent observations/);
});

test('MRMS companion HTML exposes every observed file across pages with complete status and no automatic download',()=>{
  const p=plan('mrms_mesh',{...q,start:'2020-10-14',end:'2020-10-14'}),prefix='CONUS/MESH_00.50/20201014/';
  const first=Array.from({length:1000},(_,i)=>i+'.grib2.gz'),last=Array.from({length:501},(_,i)=>(1000+i)+'.grib2.gz');
  const r=runMrms(p,[listing(prefix,first,{truncated:true,token:'page2'}),listing(prefix,last)],{defaultOutput:true});
  assert.equal(r.p.status,0,r.p.stderr);assert.equal(r.htmlName,'mrms_mesh_file-links.html');assert.match(r.html,/Complete listing/);assert.equal((r.html.match(/target="_blank"/g)||[]).length,1501);
  assert.ok(r.html.includes('1500.grib2.gz'));assert.match(r.html,/Nothing is downloaded automatically/);assert.doesNotMatch(r.html,/<script|http-equiv|onload=/i);
  assert.equal(JSON.parse(r.p.stdout).fileLinksPage,'mrms_mesh_file-links.html');assert.equal(r.urls.length,2);assert.equal(JSON.parse(r.p.stdout).payloadsDownloaded,0);
});

test('MRMS custom output uses the same basename HTML and preserves partial links with escaped text',()=>{
  const p=plan('mrms_mesh',{...q,start:'2020-10-14',end:'2020-10-14'}),prefix='CONUS/MESH_00.50/20201014/',name='a"><img src=x onerror=alert(1)>.grib2.gz';
  const r=runMrms(p,[listing(prefix,[name],{truncated:true,token:'page2'}),{error:'<script>synthetic failure</script>'}]);
  assert.equal(r.p.status,2);assert.equal(r.htmlName,'manifest.html');assert.match(r.html,/Partial or failed listing/);assert.equal((r.html.match(/target="_blank"/g)||[]).length,1);
  assert.doesNotMatch(r.html,/<img|<script>/);assert.ok(r.html.includes('&lt;img'));assert.ok(r.html.includes('&lt;script&gt;synthetic failure&lt;/script&gt;'));
  assert.ok(r.html.includes('manifest.json'));assert.equal(r.manifest.files.length,1);
});

test('MRMS refuses an existing companion HTML before sending any request',()=>{
  const p=plan('mrms_mesh',{...q,start:'2020-10-14',end:'2020-10-14'});
  const r=runMrms(p,[],{preexistingHtml:'existing review, preserve me'});
  assert.notEqual(r.p.status,0);assert.deepEqual(r.urls,[]);assert.equal(r.manifest,null);assert.equal(r.html,'existing review, preserve me');assert.match(r.p.stderr,/no request has been sent/);
});

test('CDS diagnostics retain a useful reason while redacting credentials and signed URLs',()=>{
  const f=save(plan()),out=path.join(f.dir,'received');
  const message='403 terms not accepted; Authorization: Bearer fake-bearer-secret; token=fake-token-secret; URL https://user:fake-password@example.test/result?X-Amz-Signature=fake-signed-secret';
  fs.writeFileSync(path.join(f.dir,'cdsapi.py'),'class Client:\n    def __init__(self, **kwargs): pass\n    def retrieve(self,*args): raise RuntimeError('+JSON.stringify(message)+')\n');
  const run=python([f.target,'--execute','--confirm-transfer','--output',out],f.dir),manifest=JSON.parse(fs.readFileSync(path.join(out,'retrieval-manifest.json')));
  assert.equal(run.status,2);assert.match(manifest.error,/403 terms not accepted/);assert.ok(manifest.error.length<=800);
  for(const value of ['fake-bearer-secret','fake-token-secret','fake-password','fake-signed-secret'])assert.ok(!(run.stdout+run.stderr+JSON.stringify(manifest)).includes(value));
});

test('MRMS optionally downloads a listed gzip GRIB2 file with a hash receipt',()=>{
  const p=plan('mrms_mesh',{...q,start:'2020-10-14',end:'2020-10-14'}),prefix='CONUS/MESH_00.50/20201014/';
  const bytes=zlib.gzipSync(Buffer.from([71,82,73,66,0,0,0,2,0,0,0,0])); // Synthetic format fixture, not a scientific GRIB message.
  const r=runMrms(p,[listing(prefix,['fixture.grib2.gz'],{size:bytes.length}),{body:bytes.toString('base64'),headers:{'Content-Length':String(bytes.length)}}],{extraArgs:['--download']});
  assert.equal(r.p.status,0,r.p.stderr);assert.equal(r.manifest.transfer.complete,true);assert.equal(r.manifest.transfer.files.length,1);
  assert.equal(r.manifest.transfer.files[0].sha256,crypto.createHash('sha256').update(bytes).digest('hex'));assert.equal(JSON.parse(r.p.stdout).payloadsDownloaded,1);
});

test('MRMS execute then download reuses a matching listing without overwriting it or its HTML',()=>{
  const p=plan('mrms_mesh',{...q,start:'2020-10-14',end:'2020-10-14'}),prefix='CONUS/MESH_00.50/20201014/';
  const bytes=zlib.gzipSync(Buffer.from([71,82,73,66,0,0,0,2,0,0,0,0]));
  const first=runMrms(p,[listing(prefix,['one.grib2.gz','two.grib2.gz'],{size:bytes.length})],{defaultOutput:true});
  const manifestPath=path.join(first.dir,'mrms_mesh_file-manifest.json'),before=fs.readFileSync(manifestPath);
  const next=runMrms(p,[{body:bytes.toString('base64'),headers:{'Content-Length':String(bytes.length)}}],{directory:first.dir,defaultOutput:true,extraArgs:['--download','--file','2']});
  assert.equal(next.p.status,0,next.p.stderr);assert.equal(next.output.reusedListing,true);assert.equal(next.urls.length,1);assert.ok(next.urls[0].endsWith('/two.grib2.gz'));
  assert.deepEqual(fs.readFileSync(manifestPath),before);assert.equal(next.html,first.html);assert.equal(next.manifest.transfer.files.length,1);assert.ok(next.output.transferReceipt);
  const again=runMrms(p,[],{directory:first.dir,defaultOutput:true,extraArgs:['--download','--file','2']});
  assert.equal(again.p.status,2);assert.deepEqual(again.urls,[]);assert.equal(again.manifest.transfer.failures.length,1);assert.notEqual(again.output.transferReceipt,next.output.transferReceipt);
});

test('MRMS bulk guard retains its listing and an explicitly confirmed rerun downloads all selected files',()=>{
  const p=plan('mrms_mesh',{...q,start:'2020-10-14',end:'2020-10-14'}),prefix='CONUS/MESH_00.50/20201014/';
  const bytes=zlib.gzipSync(Buffer.from([71,82,73,66,0,0,0,2,0,0,0,0])),names=Array.from({length:101},(_,i)=>i+'.grib2.gz');
  const first=runMrms(p,[listing(prefix,names,{size:bytes.length})],{extraArgs:['--download']});
  assert.equal(first.p.status,2);assert.equal(first.urls.length,1);assert.match(first.manifest.transfer.blocked,/confirm-transfer/);assert.equal(first.manifest.transfer.files.length,0);
  const next=runMrms(p,names.map(()=>({body:bytes.toString('base64'),headers:{'Content-Length':String(bytes.length)}})),{directory:first.dir,extraArgs:['--download','--confirm-transfer']});
  assert.equal(next.p.status,0,next.p.stderr);assert.equal(next.urls.length,101);assert.equal(next.manifest.transfer.complete,true);assert.equal(next.manifest.transfer.files.length,101);assert.equal(next.output.reusedListing,true);
});

test('MRMS rejects mismatched or tampered saved listings before any payload request',()=>{
  const p=plan('mrms_mesh',{...q,start:'2020-10-14',end:'2020-10-14'}),prefix='CONUS/MESH_00.50/20201014/';
  for(const mutate of [m=>{m.configuration.start='2020-10-13';},m=>{m.files[0].url='https://evil.test/data.gz';},m=>{m.complete=false;},m=>{m.requests[0].objects=2;},m=>{m.files[0].bytes=-1;}]){
    const first=runMrms(p,[listing(prefix,['one.grib2.gz'])]);const file=path.join(first.dir,'manifest.json'),value=JSON.parse(fs.readFileSync(file));mutate(value);fs.writeFileSync(file,JSON.stringify(value));const before=fs.readFileSync(file);
    const next=runMrms(p,[],{directory:first.dir,extraArgs:['--download']});assert.notEqual(next.p.status,0);assert.deepEqual(next.urls,[]);assert.deepEqual(fs.readFileSync(file),before);assert.match(next.p.stderr,/No payload request|no payload request/);
  }
});
test('MRMS refuses a saved listing with its first page removed or its continuation chain altered',()=>{
 const p=plan('mrms_mesh',{...q,start:'2020-10-14',end:'2020-10-14'}),prefix='CONUS/MESH_00.50/20201014/';
 for(const removeFirst of [true,false]){
  const first=runMrms(p,[listing(prefix,['one.grib2.gz'],{truncated:true,token:'page2'}),listing(prefix,['two.grib2.gz'])]),file=path.join(first.dir,'manifest.json'),manifest=JSON.parse(fs.readFileSync(file));assert.equal(first.p.status,0,first.p.stderr);
  if(removeFirst){manifest.requests.shift();manifest.files.shift();}else manifest.requests[0].nextContinuationToken='wrong-token';fs.writeFileSync(file,JSON.stringify(manifest));
  const next=runMrms(p,[],{directory:first.dir,extraArgs:['--download']});assert.notEqual(next.p.status,0);assert.deepEqual(next.urls,[]);assert.match(next.p.stderr,/initial page|continuation chain/);
 }
});

test('MRMS payload errors retain partials and do not prevent later valid files',()=>{
  const p=plan('mrms_mesh',{...q,start:'2020-10-14',end:'2020-10-14'}),prefix='CONUS/MESH_00.50/20201014/';
  const bytes=zlib.gzipSync(Buffer.from([71,82,73,66,0,0,0,2,0,0,0,0]));
  const invalid=Buffer.from(bytes);invalid[invalid.length-8]^=255; // Same declared length, invalid gzip CRC.
  const first=runMrms(p,[listing(prefix,['bad.grib2.gz','good.grib2.gz'],{size:bytes.length}),{body:invalid.toString('base64'),headers:{}},{body:bytes.toString('base64'),headers:{'Content-Length':String(bytes.length)}}],{extraArgs:['--download']});
  assert.equal(first.p.status,2);assert.equal(first.manifest.complete,true);assert.equal(first.manifest.transfer.complete,false);assert.equal(first.manifest.transfer.files.length,1);assert.equal(first.manifest.transfer.failures.length,1);assert.equal(first.urls.length,3);
  assert.equal(fs.existsSync(path.join(first.dir,'mrms_mesh_provider_files','bad.grib2.gz.part')),true);assert.equal(fs.existsSync(path.join(first.dir,'mrms_mesh_provider_files','bad.grib2.gz')),false);
});

test('MRMS archive warnings are tied to dated field-specific provider listings without trimming dates',()=>{
  const p=plan('mrms_mesh',q),c=config(p),dry=runDry(p);
  assert.equal(c.start,q.start);assert.equal(c.end,q.end);assert.equal(c.archiveReview.firstObservedDate,'2020-10-14');assert.match(c.archiveReview.listingUrl,/noaa-mrms-pds/);assert.equal(new URL(c.archiveReview.listingUrl).searchParams.get('prefix'),prefixes.mrms_mesh[0]);assert.equal(c.archiveReview.checkedAt,'2026-11-14');assert.ok(dry.warnings.length);assert.match(p.notes.join(' '),/does not establish absence/);
});

test('CDS unknown-size execution requires confirmation before client import or network access',()=>{
  const f=save(plan('era5_t2m',{...q,start:'2020-02-29',end:'2020-03-01'}));
  fs.writeFileSync(path.join(f.dir,'cdsapi.py'),"from pathlib import Path\nPath('client-imported').touch()\nraise RuntimeError('Client must not be imported before confirmation')\n");
  const run=python([f.target,'--execute'],f.dir);assert.equal(run.status,2);assert.match(run.stderr,/total transfer size is unknown/);assert.equal(fs.existsSync(path.join(f.dir,'client-imported')),false);assert.equal(fs.existsSync(path.join(f.dir,'era5_t2m_data')),false);
  const dry=runDry(plan('era5_t2m',{...q,start:'2020-02-29',end:'2020-03-01'}));assert.equal(dry.transferSummary.knownBytes,0);assert.equal(dry.transferSummary.unknownCount,2);assert.equal(dry.transferSummary.requiresConfirmation,true);
});

test('CDS explicitly selected monthly requests preserve numbering and avoid unselected retrievals',()=>{
  const p=plan('era5_t2m',{...q,start:'2020-02-29',end:'2020-03-01'}),f=save(p);fakeCds(f.dir);const out=path.join(f.dir,'selected');
  const preview=python([f.target,'--request','2'],f.dir);assert.equal(preview.status,0);const dry=JSON.parse(preview.stdout);assert.deepEqual(dry.selectedRequestNumbers,[2]);assert.equal(dry.availableRequestCount,2);assert.deepEqual(dry.requests,[p.requests[1]]);
  const run=python([f.target,'--execute','--confirm-transfer','--request','2','--output',out],f.dir);assert.equal(run.status,0,run.stderr);
  const manifest=JSON.parse(fs.readFileSync(path.join(out,'retrieval-manifest.json')));assert.deepEqual(manifest.selectedRequestNumbers,[2]);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir,'captured-calls.json'))),[p.requests[1]]);assert.equal(manifest.explicitTransferConfirmation,true);
});

test('one large MRMS object is guarded before payload retrieval and cancel stops later transfers',()=>{
  const p=plan('mrms_mesh',{...q,start:'2020-10-14',end:'2020-10-14'}),prefix='CONUS/MESH_00.50/20201014/';
  const large=runMrms(p,[listing(prefix,['large.grib2.gz'],{size:1000000000})],{extraArgs:['--download']});
  assert.equal(large.p.status,2);assert.equal(large.urls.length,1);assert.equal(large.manifest.transfer.transferSummary.knownBytes,1000000000);assert.equal(large.manifest.transfer.files.length,0);
  const bytes=zlib.gzipSync(Buffer.from([71,82,73,66,0,0,0,2,0,0,0,0]));
  const cancelled=runMrms(p,[listing(prefix,['one.grib2.gz','two.grib2.gz','three.grib2.gz'],{size:bytes.length}),{body:bytes.toString('base64'),headers:{}},{cancel:true}],{extraArgs:['--download']});
  assert.equal(cancelled.p.status,130);assert.equal(cancelled.urls.length,3);assert.equal(cancelled.manifest.transfer.cancelled,true);assert.equal(cancelled.manifest.transfer.complete,false);assert.equal(cancelled.manifest.transfer.files.length,1);
});

test('CDS sanitization is bounded and removes quoted, signed-parameter and client-key secrets',()=>{
  const f=save(plan()),out=path.join(f.dir,'received');
  const message='429 rate limit; invalid token "quoted-fake-secret"; X-Amz-Signature=signed-fake-secret; client says local-fake-key-secret; '+ 'detail '.repeat(1000);
  fs.writeFileSync(path.join(f.dir,'cdsapi.py'),'class Client:\n    def __init__(self, **kwargs): self.key="local-fake-key-secret"\n    def retrieve(self,*args): raise RuntimeError('+JSON.stringify(message)+')\n');
  const run=python([f.target,'--execute','--confirm-transfer','--output',out],f.dir),manifest=JSON.parse(fs.readFileSync(path.join(out,'retrieval-manifest.json')));
  assert.equal(run.status,2);assert.match(manifest.error,/429 rate limit/);assert.ok(manifest.error.length<=800);assert.doesNotMatch(run.stdout+run.stderr+JSON.stringify(manifest),/quoted-fake-secret|signed-fake-secret|local-fake-key-secret/);
});
