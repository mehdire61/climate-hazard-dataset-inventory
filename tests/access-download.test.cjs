const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const access=require('../src/access.js');
const profiles=require('../data/access.json').profiles;
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'inventory-download-tests-'));
const payload=Buffer.from([0x43,0x44,0x46,0x01,0,0,0,0,0,0,0,0]); // Synthetic signature fixture, not a scientific NetCDF payload.
const digest=(bytes,algorithm='sha256')=>crypto.createHash(algorithm).update(bytes).digest('hex');
const response=(bytes,headers={})=>({body:bytes.toString('base64'),headers:{'Content-Type':'application/octet-stream','Content-Length':String(bytes.length),...headers},status:200});
function runDownload(files,responses,args=['--download'],preexisting={}) {
  const dir=temp(),script=path.join(dir,'download.py');
  fs.writeFileSync(script,access._test.rawDownloadScript('synthetic',files));
  fs.writeFileSync(path.join(dir,'responses.json'),JSON.stringify(responses));
  if(Object.keys(preexisting).length){fs.mkdirSync(path.join(dir,'synthetic_provider_files'));for(const [name,value] of Object.entries(preexisting))fs.writeFileSync(path.join(dir,'synthetic_provider_files',name),value);}
  fs.writeFileSync(path.join(dir,'wrapper.py'),`import base64,io,json,runpy,sys,urllib.request\nfrom pathlib import Path\nresponses=json.loads(Path('responses.json').read_text())\nurls=[]\nclass Response(io.BytesIO):\n    def __init__(self,value):\n        super().__init__(base64.b64decode(value['body']))\n        self.headers=value['headers']\n        self.status=value['status']\ndef fetch(request,timeout=None):\n    urls.append(request.full_url)\n    if not responses: raise RuntimeError('Unexpected request')\n    value=responses.pop(0)\n    if value.get('cancel'): raise KeyboardInterrupt()\n    if 'error' in value: raise RuntimeError(value['error'])\n    return Response(value)\nurllib.request.urlopen=fetch\nsys.argv=['download.py']+sys.argv[1:]\ntry:\n    runpy.run_path('download.py',run_name='__main__')\nfinally:\n    Path('requested-urls.json').write_text(json.dumps(urls))\n`);
  const run=spawnSync('python',['wrapper.py',...args],{cwd:dir,encoding:'utf8',timeout:20000});
  const folder=path.join(dir,'synthetic_provider_files'),saved=fs.existsSync(folder)?fs.readdirSync(folder):[];
  const receipts=saved.filter(name=>/^receipt-.+\.json$/.test(name)).map(name=>JSON.parse(fs.readFileSync(path.join(folder,name),'utf8')));
  return {dir,folder,run,saved,receipts,urls:JSON.parse(fs.readFileSync(path.join(dir,'requested-urls.json'),'utf8'))};
}

test('raw download dry run makes no request and creates no data folder',()=>{
  const r=runDownload([{url:'https://example.test/data.nc',name:'data.nc'}],[],[]);
  assert.equal(r.run.status,0,r.run.stderr);assert.deepEqual(r.urls,[]);assert.deepEqual(r.saved,[]);
});

test('dry run reports selected known bytes and unknown file count',()=>{
  const r=runDownload([{name:'known.nc',url:'https://example.test/known.nc',sizeBytes:1200},{name:'unknown.nc',url:'https://example.test/unknown.nc'}],[],[]);
  assert.equal(r.run.status,0,r.run.stderr);assert.match(r.run.stdout,/knownBytes/);assert.match(r.run.stdout,/unknownCount/);assert.deepEqual(r.urls,[]);
});

test('an unknown-size download requires explicit transfer confirmation',()=>{
  const r=runDownload([{name:'unknown.nc',url:'https://example.test/unknown.nc'}],[response(payload)]);
  assert.notEqual(r.run.status,0);assert.deepEqual(r.urls,[]);assert.match(r.run.stderr,/confirm-transfer/);
});

test('a failed first file does not prevent a later valid transfer',()=>{
  const files=[{name:'bad.nc',url:'https://example.test/bad.nc',sizeBytes:12},{name:'good.nc',url:'https://example.test/good.nc',sizeBytes:12}];
  const r=runDownload(files,[{error:'synthetic 404'},response(payload)]);
  assert.equal(r.run.status,2);assert.equal(r.urls.length,2);assert.equal(r.receipts[0].files.length,1);assert.equal(r.receipts[0].files[0].file,'good.nc');assert.equal(r.receipts[0].complete,false);
});
test('dot-only and non-Latin filenames do not stop a batch',()=>{
  const files=[{name:'..',url:'https://example.test/dots',sizeBytes:12},{name:'باران.nc',url:'https://example.test/rain.nc',sizeBytes:12}];
  const r=runDownload(files,[response(payload),response(payload)]);
  assert.equal(r.run.status,0,r.run.stderr);assert.equal(r.receipts[0].files.length,2);assert.equal(r.receipts[0].complete,true);
  for(const file of r.receipts[0].files)assert.equal(file.sha256,digest(payload));
});

test('successful synthetic downloads retain actual hashes, verify provider MD5 and complete the receipt',()=>{
  const compressed=zlib.gzipSync(Buffer.from('synthetic compressed bytes'));
  const files=[{name:'data.nc',url:'https://example.test/data.nc',sizeBytes:payload.length},{name:'data.nc.gz',url:'https://example.test/data.nc.gz',sizeBytes:compressed.length,checksum:'md5:'+digest(compressed,'md5')}];
  const r=runDownload(files,[response(payload),response(compressed)]);
  assert.equal(r.run.status,0,r.run.stderr);assert.equal(r.receipts.length,1);const receipt=r.receipts[0];
  assert.equal(receipt.complete,true);assert.equal(receipt.files.length,2);assert.deepEqual(receipt.failures,[]);
  assert.deepEqual(receipt.files.map(f=>f.sha256),[digest(payload),digest(compressed)]);assert.deepEqual(receipt.files.map(f=>f.bytes),[payload.length,compressed.length]);
  assert.ok(receipt.qualification);assert.equal(r.urls.length,2);assert.deepEqual(fs.readFileSync(path.join(r.folder,'data.nc')),payload);
});

test('HTTP200 JSON masquerading as a NetCDF file is rejected and never renamed as accepted data',()=>{
  const bytes=Buffer.from('{"error":"synthetic provider error"}');
  const r=runDownload([{name:'data.nc',url:'https://example.test/data.nc',sizeBytes:bytes.length}],[response(bytes,{'Content-Type':'application/json'})]);
  assert.notEqual(r.run.status,0);assert.equal(fs.existsSync(path.join(r.folder,'data.nc')),false);
  assert.equal(r.receipts.length,1);assert.equal(r.receipts[0].complete,false);assert.equal(r.receipts[0].files.length,0);assert.equal(r.receipts[0].failures.length,1);
});

test('a second-file failure retains the first receipt with incomplete status and original requested URLs',()=>{
  const files=[{name:'first.nc',url:'https://example.test/first.nc',sizeBytes:payload.length},{name:'second.nc',url:'https://example.test/second.nc',sizeBytes:payload.length}];
  const r=runDownload(files,[response(payload),{error:'synthetic second-file failure'}]);
  assert.notEqual(r.run.status,0);assert.equal(r.receipts.length,1);const receipt=r.receipts[0];
  assert.equal(receipt.complete,false);assert.equal(receipt.files.length,1);assert.equal(receipt.files[0].sha256,digest(payload));assert.equal(receipt.files[0].url,files[0].url);
  assert.equal(receipt.failures.length,1);assert.equal(fs.existsSync(path.join(r.folder,'first.nc')),true);assert.equal(fs.existsSync(path.join(r.folder,'second.nc')),false);
});

test('a provider checksum mismatch retains the partial file without accepting a complete file',()=>{
  const bytes=zlib.gzipSync(Buffer.from('synthetic compressed bytes'));
  const r=runDownload([{name:'data.nc.gz',url:'https://example.test/data.nc.gz',sizeBytes:bytes.length,checksum:'md5:'+'0'.repeat(32)}],[response(bytes)]);
  assert.notEqual(r.run.status,0);assert.equal(fs.existsSync(path.join(r.folder,'data.nc.gz')),false);assert.equal(fs.existsSync(path.join(r.folder,'data.nc.gz.part')),true);
  assert.equal(r.receipts[0].complete,false);assert.equal(r.receipts[0].files.length,0);assert.equal(r.receipts[0].failures.length,1);
});

test('large, approximate and many-file transfers require explicit confirmation before any payload request',()=>{
  const base={name:'data.nc',url:'https://example.test/data.nc',sizeBytes:payload.length};
  for(const files of [[{...base,sizeBytes:1000000000}],[{...base,bytesApproximate:true}],Array.from({length:101},(_,i)=>({...base,name:i+'.nc',url:'https://example.test/'+i+'.nc'}))]){
    const r=runDownload(files,[]);assert.equal(r.run.status,2);assert.deepEqual(r.urls,[]);assert.match(r.run.stderr,/confirm-transfer/);assert.deepEqual(r.saved,[]);
  }
});

test('explicitly confirmed unknown transfers and narrowed known selections are supported',()=>{
  const unknown={name:'unknown.nc',url:'https://example.test/unknown.nc'};
  const confirmed=runDownload([unknown],[response(payload)],['--download','--confirm-transfer']);assert.equal(confirmed.run.status,0,confirmed.run.stderr);assert.equal(confirmed.receipts[0].explicitTransferConfirmation,true);
  const narrowed=runDownload([{name:'large.nc',url:'https://example.test/large.nc',sizeBytes:4e10},{name:'small.nc',url:'https://example.test/small.nc',sizeBytes:payload.length}],[response(payload)],['--download','--file','2']);
  assert.equal(narrowed.run.status,0,narrowed.run.stderr);assert.deepEqual(narrowed.urls,['https://example.test/small.nc']);assert.equal(narrowed.receipts[0].transferSummary.fileCount,1);
});

test('general transfer summaries agree between exported JS metadata and selected Python preview',()=>{
  for(const files of [[{name:'a.nc',url:'https://example.test/a.nc',sizeBytes:1234}],[{name:'b.nc',url:'https://example.test/b.nc',sizeMB:1.25}],[{name:'c.nc',url:'https://example.test/c.nc',sizeBytes:null,sizeLabel:'unknown'}]]){
    const r=runDownload(files,[],[]),line=r.run.stdout.split(/\r?\n/).find(l=>l.startsWith('Selected transfer summary: '));
    assert.deepEqual(JSON.parse(line.slice('Selected transfer summary: '.length)),access.transferSummary(files));
  }
});

test('existing data and partial files remain unchanged while later files still download',()=>{
  const files=['existing.nc','partial.nc','new.nc'].map(name=>({name,url:'https://example.test/'+name,sizeBytes:payload.length}));
  const r=runDownload(files,[response(payload)],['--download'],{'existing.nc':'keep original','partial.nc.part':'keep partial'});
  assert.equal(r.run.status,2);assert.equal(r.urls.length,1);assert.equal(r.receipts[0].files.length,1);assert.equal(r.receipts[0].failures.length,2);
  assert.equal(fs.readFileSync(path.join(r.folder,'existing.nc'),'utf8'),'keep original');assert.equal(fs.readFileSync(path.join(r.folder,'partial.nc.part'),'utf8'),'keep partial');
});

test('general cancellation preserves earlier successes and stops subsequent requests',()=>{
  const files=['one.nc','two.nc','three.nc'].map(name=>({name,url:'https://example.test/'+name,sizeBytes:payload.length}));
  const r=runDownload(files,[response(payload),{cancel:true},response(payload)]);
  assert.equal(r.run.status,130);assert.equal(r.urls.length,2);assert.equal(r.receipts[0].cancelled,true);assert.equal(r.receipts[0].complete,false);assert.equal(r.receipts[0].files.length,1);assert.equal(r.receipts[0].failures.length,1);
});

test('all merged public snapshot/grid/ERDDAP/CDS/MRMS script artifacts compile and run review-only',()=>{
  const strategies=new Set(['snapshot','grid','erddap','cds','mrms']);let products=0,scripts=0;
  for(const [id,profile] of Object.entries(profiles)) {
    if(!strategies.has(profile.strategy))continue;
    const options={};for(const choice of access.describe(id).options||[])if(choice.required)options[choice.key]=choice.choices.find(x=>x.value)?.value;
    const q={mode:'point',lat:38.9,lon:-77.04,radiusKm:100,start:id==='gfd_modis_v1'?'2000-01-01':id==='hadex3'?'2000-07-01':'2020-07-01',end:id==='gfd_modis_v1'?'2018-12-31':id==='hadex3'?'2000-07-03':'2020-07-03'};
    const prepared=access.prepare(id,q,options);assert.deepEqual(prepared.errors,[],id+' preparation errors');products++;
    for(const artifact of prepared.artifacts.filter(a=>a.name.endsWith('.py'))) {
      const dir=temp(),script=path.join(dir,artifact.name),wrapper=path.join(dir,'dry-run.py');fs.writeFileSync(script,artifact.text);
      fs.writeFileSync(path.join(dir,'cdsapi.py'),"raise RuntimeError('Dry run must not access the CDS client')\n");
      fs.writeFileSync(wrapper,"import runpy,sys,urllib.request\ndef forbidden(*args,**kwargs): raise RuntimeError('Dry run attempted network access')\nurllib.request.urlopen=forbidden\nsys.argv=[sys.argv[1]]\nrunpy.run_path(sys.argv[0],run_name='__main__')\n");
      const compile=spawnSync('python',['-m','py_compile',script],{cwd:dir,encoding:'utf8',timeout:20000});assert.equal(compile.status,0,id+' '+compile.stderr);
      const run=spawnSync('python',[wrapper,script],{cwd:dir,encoding:'utf8',timeout:20000});assert.equal(run.status,0,id+' '+run.stderr);scripts++;
    }
  }
  assert.ok(products>=15,'Expected all merged public/request families to be exercised');assert.ok(scripts>=15,'Expected an executable artifact for each exercised product');
});


test('shared objects transfer once while retaining every acquisition association',()=>{
  const first={name:'shared.nc',url:'https://example.test/shared.nc',sizeBytes:payload.length,itemId:'acquisition-one',associatedAcquisitionTime:'2024-09-27T00:00:00Z'};
  const r=runDownload([first,{...first,itemId:'acquisition-two',associatedAcquisitionTime:'2024-09-29T00:00:00Z'}],[response(payload)]);
  assert.equal(r.run.status,0,r.run.stderr);assert.equal(r.urls.length,1);assert.equal(r.receipts[0].complete,true);
  assert.equal(r.receipts[0].transferSummary.associationCount,2);assert.equal(r.receipts[0].transferSummary.fileCount,1);
  assert.deepEqual(r.receipts[0].files[0].associations.map(a=>a.itemId),['acquisition-one','acquisition-two']);
});

test('different objects sharing a basename get separate stable destinations',()=>{
  const files=['a','b'].map(id=>({name:'same.nc',url:'https://example.test/'+id+'/same.nc',sizeBytes:payload.length}));
  const r=runDownload(files,[response(payload),response(payload)]);
  assert.equal(r.run.status,0,r.run.stderr);assert.equal(r.receipts[0].files.length,2);
  assert.equal(new Set(r.receipts[0].files.map(f=>f.file.toLowerCase())).size,2);
  for(const f of r.receipts[0].files)assert.deepEqual(fs.readFileSync(path.join(r.folder,f.file)),payload);
});

test('partial-batch retry reuses only receipt-verified bytes and retrieves the missing object',()=>{
  const files=['one','two'].map(id=>({name:id+'.nc',url:'https://example.test/'+id+'.nc',sizeBytes:payload.length}));
  const r=runDownload(files,[response(payload),{error:'synthetic interrupted batch'}]);assert.equal(r.run.status,2);
  fs.writeFileSync(path.join(r.dir,'responses.json'),JSON.stringify([response(payload)]));
  const retry=spawnSync('python',['wrapper.py','--download'],{cwd:r.dir,encoding:'utf8',timeout:20000});assert.equal(retry.status,0,retry.stderr);
  const receipts=fs.readdirSync(r.folder).filter(n=>/^receipt-.+\.json$/.test(n)).sort();
  const receipt=JSON.parse(fs.readFileSync(path.join(r.folder,receipts.at(-1))));
  assert.equal(receipt.complete,true);assert.equal(receipt.files[0].reused,true);assert.equal(receipt.files[1].reused,false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.dir,'requested-urls.json'))),[files[1].url]);
  fs.writeFileSync(path.join(r.folder,'one.nc'),'ALTERED');fs.writeFileSync(path.join(r.dir,'responses.json'),'[]');
  const altered=spawnSync('python',['wrapper.py','--download'],{cwd:r.dir,encoding:'utf8',timeout:20000});
  assert.equal(altered.status,2);assert.equal(fs.readFileSync(path.join(r.folder,'one.nc'),'utf8'),'ALTERED');
});
