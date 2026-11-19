const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const S = require('../src/science-requests.js');
const G = require('../src/geometry.js');
const q={mode:'point',lat:38.9,lon:-77.04,radiusKm:100,start:'2020-07-01',end:'2020-07-02'};
const p=id=>({productId:id,strategy:({esa_cci_sm_combined_v09_2:'daily-template',ims_snow_ice:'ims-daily-template',nasa_coolr:'coolr-arcgis'})[id]});
const esa=p('esa_cci_sm_combined_v09_2'),ims=p('ims_snow_ice'),coolr=p('nasa_coolr');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'access-science-tests-'));
test.after(()=>{assert.equal(path.dirname(path.resolve(tmp)),path.resolve(os.tmpdir()));assert.match(path.basename(tmp),/^access-science-tests-/);fs.rmSync(tmp,{recursive:true,force:true});});
function py(name,prepared,source){const file=path.join(tmp,name+'.py');fs.writeFileSync(file,prepared.artifacts[0].text);const check=path.join(tmp,name+'-check.py');fs.writeFileSync(check,source);const result=cp.spawnSync('python',['-B','-X','utf8',check,file],{cwd:tmp,encoding:'utf8'});assert.equal(result.status,0,result.stdout+'\n'+result.stderr);return result.stdout;}

test('ESA exact version, daily support and inclusive dates are retained without network',()=>{
  const r=S.prepare(esa,q);assert.deepEqual(r.errors,[]);assert.equal(r.requests.length,2);assert.equal(r.requests[0].url,'https://dap.ceda.ac.uk/neodc/esacci/soil_moisture/data/daily_files/COMBINED/v09.2/2020/ESACCI-SOILMOISTURE-L3S-SSMV-COMBINED-20200701000000-fv09.2.nc');assert.match(r.notes.join(' '),/No network call/);assert.equal(r.artifacts[0].role,'request');
  const no=S.prepare(esa,{...q,start:'1970-01-01'});assert.ok(no.errors.length);assert.equal(no.requests.length,0);
  const late=S.prepare(esa,{...q,end:'2025-01-01'});assert.match(late.errors.join(' '),/not trimmed/);
});
test('IMS requires explicit version, leap/day-of-year and year rollover are correct',()=>{
  assert.match(S.prepare(ims,q).errors.join(' '),/explicitly/);
  const r=S.prepare(ims,{...q,start:'2020-02-28',end:'2020-03-01'},{grid:'4km',minorVersion:'1.3'});assert.equal(r.requests.length,3);assert.match(r.requests[1].name,/2020060_00UTC_4km_v1.3/);
  const year=S.prepare(ims,{...q,start:'2020-12-31',end:'2021-01-01'},{grid:'1km',minorVersion:'1.3'});assert.match(year.requests[0].url,/2020\/ims2020366/);assert.match(year.requests[1].url,/2021\/ims2021001/);
});
test('known impossible grid/version eras are rejected without silent date trimming',()=>{
  const cases=[['4km','1.1','2000-01-01','2000-01-02'],['1km','1.2','2010-01-01','2010-01-02'],['24km','1.3','2010-01-01','2010-01-02'],['4km','1.2','2020-01-01','2020-01-02'],['24km','1.1','2004-01-01','2004-03-02'],['1km','1.3','2014-11-30','2014-12-02']];
  for(const [grid,minorVersion,start,end]of cases){const r=S.prepare(ims,{...q,start,end},{grid,minorVersion});assert.ok(r.errors.length,[grid,minorVersion,start].join());assert.equal(r.requests.length,0);assert.equal(r.artifacts.length,0);}
  const transition=S.prepare(ims,{...q,start:'2014-12-01',end:'2014-12-02'},{grid:'1km',minorVersion:'1.3'});assert.equal(transition.errors.length,0);assert.match(transition.notes.join(' '),/Transition-month/);
});
test('daily prepared requests have no hidden file cap and dates remain exact',()=>{
  const r=S.prepare(esa,{...q,start:'1978-11-01',end:'2024-12-31'});assert.equal(r.errors.length,0);assert.ok(r.requests.length>16000);assert.equal(r.requests.at(-1).date,'2024-12-31');assert.match(r.requests[0].url,/19781101000000/);
});
test('COOLR exact point excludes station radius and retains unknown dates in predicate',()=>{
  const r=S.prepare(coolr,q),u=new URL(r.requests[0].url);assert.equal(u.searchParams.get('geometry'),'-77.04,38.9');assert.equal(u.searchParams.get('geometryType'),'esriGeometryPoint');assert.equal(u.searchParams.get('returnIdsOnly'),'true');assert.equal(u.searchParams.get('where'),"(event_date >= DATE '2020-07-01' AND event_date < DATE '2020-07-03') OR event_date IS NULL");assert.equal(u.searchParams.has('distance'),false);assert.match(r.notes.join(' '),/Nearby point reports require an explicit area/);
});
test('COOLR uses original dateline footprint envelopes, not buffer or center',()=>{
  const query={mode:'area',geometry:G.rectangle(170,-10,-170,10),bufferKm:500,start:q.start,end:q.end};const original=JSON.stringify(query);const r=S.prepare(coolr,query,{layer:'Events_Polygons'});assert.equal(r.requests.length,2);assert.deepEqual(r.requests.map(x=>x.providerBounds).sort((a,b)=>a[0]-b[0]),[[-180,-10,-170,10],[170,-10,180,10]]);assert.ok(r.requests.every(x=>x.url.includes('Events_Polygons')));assert.equal(JSON.stringify(query),original);assert.match(r.notes.join(' '),/Holes and exact polygon/);
});
test('invalid dates/options and unreviewed products fail before artifact generation',()=>{
  for(const r of [S.prepare(esa,{...q,start:'2020-02-30'}),S.prepare(ims,q,{grid:'../x',minorVersion:'1.3'}),S.prepare(ims,q,{grid:'4km',minorVersion:'1.3;raise Exception()'}),S.prepare(coolr,q,{layer:'https://attacker.example'}),S.prepare({productId:'unknown',strategy:'daily-template'},q)]){assert.ok(r.errors.length);assert.equal(r.artifacts.length,0);}
});
test('generated Python scripts AST-parse, dry-run without network and match JavaScript dates',()=>{
  const cases=[['esa',S.prepare(esa,q)],['ims',S.prepare(ims,{...q,start:'2020-02-28',end:'2020-03-01'},{grid:'4km',minorVersion:'1.3'})],['coolr',S.prepare(coolr,q)]];
  for(const [name,r]of cases){const stdout=py('dry-'+name,r,`import ast,contextlib,io,runpy,sys,urllib.request
source=open(sys.argv[1],encoding='utf8').read();ast.parse(source)
urllib.request.urlopen=lambda *args,**kwargs:(_ for _ in ()).throw(AssertionError('Network in dry-run'))
m=runpy.run_path(sys.argv[1]);out=io.StringIO()
with contextlib.redirect_stdout(out):assert m['main']([])==0
print(out.getvalue())
`);for(const request of r.requests)assert.ok(stdout.includes(request.url));assert.match(stdout,/Dry run only/);}
});
test('exported daily CLI numbers and deduplicates choices, and stops unconfirmed or invalid downloads before network',()=>{
  for(const [name,profile,options]of [['esa',esa,{}],['ims',ims,{grid:'4km',minorVersion:'1.3'}]]){
    const r=S.prepare(profile,{...q,end:'2020-07-03'},options);
    py('daily-cli-guard-'+name,r,`import contextlib,io,json,runpy,sys,urllib.request
from pathlib import Path
script=sys.argv[1];calls=[]
def forbidden(*args,**kwargs):
    calls.append(args);raise AssertionError('No payload request permitted')
urllib.request.urlopen=forbidden
def invoke(args):
    old=sys.argv;sys.argv=[script,*args];out=io.StringIO();err=io.StringIO()
    try:
        with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
            try:runpy.run_path(script,run_name='__main__')
            except SystemExit as stop:code=stop.code
    finally:sys.argv=old
    return code,out.getvalue(),err.getvalue()
folder=Path(script).parent/('never-created-'+Path(script).stem)
for args in [['--download'],['--download','--file','2'],['--download','--confirm-transfer','--file','0'],['--download','--confirm-transfer','--file','4']]:
    code,out,err=invoke([*args,'--output',str(folder)])
    assert code==2,(args,code,out,err)
    assert 'No payload request sent' in err or 'outside the prepared list' in err
    assert not calls and not folder.exists()
code,out,err=invoke(['--file','3','--file','2','--file','2'])
assert code==0 and not err and not calls
summary=json.loads(next(x.split(': ',1)[1] for x in out.splitlines() if x.startswith('Selected transfer summary:')))
assert summary=={'fileCount':2,'totalPreparedCount':3,'knownBytes':0,'unknownCount':2,'requiresConfirmation':True},summary
assert '2 2020-07-02 size unknown' in out and '3 2020-07-03 size unknown' in out
assert '1 2020-07-01' not in out and '--download --confirm-transfer' in out
print('Exported CLI selection and pre-network guard passed')
`);
  }
});
test('exported daily CLI explicitly downloads selected files or the complete plan and records that choice',()=>{
  for(const [name,profile,options,end]of [['esa',esa,{},'2020-11-10'],['ims',ims,{grid:'4km',minorVersion:'1.3'},'2020-07-03']]){
    const r=S.prepare(profile,{...q,end},options);
    py('daily-cli-confirm-'+name,r,`import contextlib,gzip,io,json,runpy,sys,urllib.request
from pathlib import Path
script=sys.argv[1];calls=[]
class Response(io.BytesIO):
    def __init__(self,data):super().__init__(data);self.status=200;self.headers={'Content-Length':str(len(data))}
def opener(request,timeout):
    calls.append(request.full_url)
    return Response(gzip.compress(b'IMS synthetic transport fixture') if request.full_url.endswith('.gz') else b'CDF\\x01synthetic transport fixture')
urllib.request.urlopen=opener
requests=runpy.run_path(script)['build_requests']()
def invoke(args):
    old=sys.argv;sys.argv=[script,*args]
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            try:runpy.run_path(script,run_name='__main__')
            except SystemExit as stop:assert stop.code==0,stop.code
    finally:sys.argv=old
selected=Path(script).parent/('selected-'+Path(script).stem)
invoke(['--download','--confirm-transfer','--file','2','--file','2','--output',str(selected)])
assert calls==[requests[1]['url']],calls
receipt=json.loads(next(selected.glob('receipt-*.json')).read_text())
assert receipt['selection']['fileNumbers']==[2] and receipt['selection']['mode']=='selected'
assert receipt['selection']['explicitTransferConfirmation'] is True
assert receipt['selection']['transferSummary']['fileCount']==1 and receipt['selection']['transferSummary']['unknownCount']==1
assert len(receipt['receipts'])==1 and receipt['receipts'][0]['date']=='2020-07-02'
assert receipt['receipts'][0]['status']=='downloaded' and len(receipt['receipts'][0]['sha256'])==64
assert len(list(selected.glob('*.gz' if requests[0]['name'].endswith('.gz') else '*.nc')))==1
calls.clear();all_folder=Path(script).parent/('all-'+Path(script).stem)
invoke(['--download','--confirm-transfer','--output',str(all_folder)])
assert calls==[x['url'] for x in requests]
receipt=json.loads(next(all_folder.glob('receipt-*.json')).read_text())
assert receipt['selection']['fileNumbers'] is None and receipt['selection']['mode']=='all'
assert receipt['selection']['transferSummary']['fileCount']==len(requests)
assert len(receipt['receipts'])==len(requests) and all(x['status']=='downloaded' for x in receipt['receipts'])
print('Confirmed selection/full plan passed for',len(requests),'synthetic responses')
`);
  }
});
test('daily receipts omit HTTP redirect and network error details that could expose credentials',()=>{
  py('daily-redaction',S.prepare(esa,q),`import json,runpy,sys,tempfile
from pathlib import Path
from urllib.error import HTTPError,URLError
m=runpy.run_path(sys.argv[1]);requests=m['build_requests']()
def opener(req,timeout):
    if '20200701' in req.full_url:raise HTTPError('https://redirect.invalid/?token=secret-token',403,'Bearer secret-token',None,None)
    raise URLError('proxy password=secret-password')
folder=Path(tempfile.mkdtemp(dir=Path(sys.argv[1]).parent));receipts=m['download'](requests,folder,opener)
assert all(x['status']=='failed' for x in receipts)
assert 'HTTP 403' in receipts[0]['error'] and 'network error detail omitted' in receipts[1]['error']
text=next(folder.glob('receipt-*.json')).read_text()
assert all(value not in text for value in ['secret-token','secret-password','redirect.invalid','Bearer'])
assert all(x['url'] in text for x in requests)
print('Network detail redaction and original request provenance passed')
`);
});
test('daily Python records validated payloads and failed responses without overwriting or false success',()=>{
  py('daily-mechanics',S.prepare(esa,q),`import io,json,runpy,sys,tempfile
from pathlib import Path
m=runpy.run_path(sys.argv[1]);requests=m['build_requests']()
class Response(io.BytesIO):
    def __init__(self,data,status=200,length=None,ctype='application/octet-stream'):
        super().__init__(data);self.status=status;self.headers={'Content-Type':ctype,'Content-Length':str(len(data) if length is None else length)}
def opener(req,timeout):
    return Response(b'\\x89HDF\\r\\n\\x1a\\nfixture') if '20200701' in req.full_url else Response(b'<html>login</html>',ctype='text/html')
folder=Path(tempfile.mkdtemp(dir=Path(sys.argv[1]).parent));r=m['download'](requests,folder,opener)
assert [x['status'] for x in r]==['downloaded','failed'];assert len(r[0]['sha256'])==64
assert (folder/requests[0]['name']).exists();assert not (folder/requests[1]['name']).exists()
r2=m['download'](requests[:1],folder,lambda *a,**kw:(_ for _ in ()).throw(AssertionError('Should not fetch existing target')))
assert r2[0]['status']=='failed';assert 'overwritten' in r2[0]['error']
folder2=Path(tempfile.mkdtemp(dir=Path(sys.argv[1]).parent));r3=m['download'](requests[:1],folder2,lambda *a,**kw:Response(b'CDF\\x01partial',length=999))
assert r3[0]['status']=='failed';assert (folder2/(requests[0]['name']+'.part')).exists();assert not (folder2/requests[0]['name']).exists()
assert json.loads(next(folder.glob('receipt-*.json')).read_text())['receipts']
print('daily response and failure checks passed')
`);
});
test('IMS Python checks complete gzip CRC and does not shift the valid day',()=>{
  const r=S.prepare(ims,q,{grid:'4km',minorVersion:'1.3'});py('ims-gzip',r,`import gzip,io,runpy,sys,tempfile
from pathlib import Path
m=runpy.run_path(sys.argv[1]);requests=m['build_requests']();assert '2020183_00UTC' in requests[0]['name']
good=gzip.compress(b'Original categorical IMS file fixture');bad=good[:-4]
class Response(io.BytesIO):
    def __init__(self,data):super().__init__(data);self.status=200;self.headers={'Content-Length':str(len(data))}
folder=Path(tempfile.mkdtemp(dir=Path(sys.argv[1]).parent));r=m['download'](requests,folder,lambda req,timeout:Response(good if '2020183_' in req.full_url else bad))
assert [x['status'] for x in r]==['downloaded','failed'];assert (folder/(requests[1]['name']+'.part')).exists()
print('IMS gzip integrity checks passed')
`);
});
test('COOLR Python traverses all IDs, preserves null dates and fails on missing pages',()=>{
  const query={mode:'area',geometry:G.rectangle(170,-10,-170,10),bufferKm:100,start:q.start,end:q.end};py('coolr-paging',S.prepare(coolr,query),`import io,json,runpy,sys,tempfile
from pathlib import Path
from urllib.parse import urlparse,parse_qs
m=runpy.run_path(sys.argv[1]);root=Path(sys.argv[1]).parent
class Response(io.BytesIO):
    def __init__(self,value):super().__init__(json.dumps(value).encode());self.status=200;self.headers={}
def factory(missing=False,limited=False):
    def opener(request,timeout):
        params=parse_qs(urlparse(request.full_url).query)
        if 'returnIdsOnly' in params:return Response({'objectIdFieldName':'objectid','objectIds':list(range(1,206))})
        ids=[int(x) for x in params['objectIds'][0].split(',')]
        if missing and ids[0]>200:ids=ids[:-1]
        rows=[{'type':'Feature','id':oid,'properties':{'objectid':oid,'event_date':None if oid==1 else 1593561600000},'geometry':{'type':'Point','coordinates':[175,0]}} for oid in ids]
        return Response({'type':'FeatureCollection','features':rows,**({'exceededTransferLimit':True} if limited else {})})
    return opener
folder=Path(tempfile.mkdtemp(dir=root));r=m['retrieve'](folder,factory());assert r['complete'];assert r['featureCount']==205;assert r['unknownDateCount']==1;assert len(r['requests'])==4
data=json.loads((folder/r['file']).read_text());assert data['features'][0]['properties']['event_date'] is None
folder2=Path(tempfile.mkdtemp(dir=root));r=m['retrieve'](folder2,factory(missing=True));assert not r['complete'];assert r['featureCount']==200;assert r['partialFile'];assert len(json.loads((folder2/r['partialFile']).read_text())['features'])==200
folder3=Path(tempfile.mkdtemp(dir=root));r=m['retrieve'](folder3,factory(limited=True));assert not r['complete'];assert r['featureCount']==0;assert 'transfer limit' in r['error']
folder4=Path(tempfile.mkdtemp(dir=root));r=m['retrieve'](folder4,lambda *a,**kw:Response({'error':{'message':'service error'}}));assert not r['complete'];assert r['featureCount']==0
print('COOLR complete and partial pagination checks passed')
`);
});
