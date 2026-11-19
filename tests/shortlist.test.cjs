const test=require('node:test'), assert=require('node:assert/strict');
const S=require('../src/shortlist.js'),screen=require('../src/screening.js');
const {products}=require('../data/catalog.json'),{rules}=require('../data/screening.json');
const groups=require('../data/hazard_groups.json'),byId=new Map(products.map(p=>[p.product_id,p]));
const point=(lat,lon,start='2017-08-24',end='2017-09-03')=>({mode:'point',lat,lon,radiusKm:25,start,end});
function ids(hazard,query,evidence=new Map()) {
  const all=screen.evaluateAll(products,rules,query,'2026-11-18'), group=groups.find(g=>g.id===hazard);
  const scoped=all.filter(r=>group.products.includes(r.productId));
  const regionalRain=hazard==='precipitation' && scoped.some(r=>r.productId==='stage_iv'&&r.status==='possible'&&r.spatialRelation==='within');
  return [...S.rank(scoped,{byId,rules,evidence,hazard,offshore:all.some(r=>r.landCheck?.land===false),regionalRain,limit:3})];
}
test('regional jurisdiction, event match and radar reach take precedence over agency recognition',()=>{
  assert.deepEqual(ids('flood',point(29.76,-95.37)).slice(0,2),['usgs_hwm_harvey_2017','usgs_streamflow']);
  assert.equal(ids('precipitation',point(29.76,-95.37))[0],'stage_iv');
  const kenya=ids('flood',point(-.10,34.75,'2020-04-05','2020-04-15'));
  assert.ok(kenya.includes('grdc_discharge') && !kenya.includes('usgs_streamflow') && !kenya.includes('noaa_coops_water_level'));
  assert.ok(!ids('precipitation',point(32.37,-64.67,'2024-08-16','2024-08-19')).some(id=>id.startsWith('mrms_')));
});
test('verified rain can lead, complete empty lists remove suggestions, and an unavailable check remains eligible',()=>{
  const q=point(29.76,-95.37),ev=new Map(),k=S.key('ghcn_daily','precipitation');
  ev.set(k,{level:3});assert.equal(ids('precipitation',q,ev)[0],'ghcn_daily');
  ev.set(k,{level:-1});assert.ok(!ids('precipitation',q,ev).includes('ghcn_daily'));
  ev.set(k,{level:0});assert.ok(ids('precipitation',q,ev).includes('ghcn_daily'));
  ev.clear();ev.set(S.key('ghcn_daily','temperature'),{level:3});assert.equal(ids('precipitation',q,ev)[0],'stage_iv');
});
test('a comparable public-service provider wins the final tie independently of input and alphabetical order',()=>{
  const testIds=['gsim_indices','grdc_discharge'],two=new Map(testIds.map((id,i)=>[id,{product_name:i?'Z':'A',provider:i?'GRDC and contributing national hydrological services':'Research team'}]));
  const sample=testIds.map(productId=>({productId,status:'unresolved',label:'Find a station',spatialRelation:'within'}));
  for(const scoped of [sample,[...sample].reverse()])assert.equal([...S.rank(scoped,{byId:two,rules,evidence:new Map(),hazard:'flood',offshore:false,regionalRain:false,limit:1})][0],'grdc_discharge');
});
test('station evidence distinguishes variables, buffers, incomplete listings and unlocated records',()=>{
  const q=point(38.9,-77.04),station={relation:'nearby',variables:[{key:'TMAX',start:'2000-01-01',end:'2020-12-31'}]};
  const response={stations:[station],complete:true};
  assert.equal(S.stationEvidence('ghcn_daily','precipitation',response,q).level,-1);
  assert.equal(S.stationEvidence('ghcn_daily','temperature',response,{...q,mode:'area'}).label,'Stations listed · In project buffer');
  assert.equal(S.stationEvidence('ghcn_daily','precipitation',{stations:[],complete:false},q).level,0);
  assert.equal(S.stationEvidence('ghcn_daily','temperature',{stations:[{variables:[]}],complete:true},q).level,0);
});
test('file lists, valid zeroes, QC failures and multi-day amounts carry different evidence',()=>{
  const q=point(38.9,-77.04),data={station:{id:'A'},window:q,series:[{key:'PRCP',points:[{time:q.start,value:0,flags:{}}]}]};
  assert.equal(S.previewEvidence('ghcn_daily','precipitation',data).level,3);
  assert.equal(S.previewEvidence('ghcn_daily','temperature',data),null);
  data.series[0].points[0].flags.qualityFlag='X';assert.equal(S.previewEvidence('ghcn_daily','precipitation',data),null);
  data.series[0].points=[{time:q.start,value:null,multiDay:{value:7.4,days:7}}];assert.equal(S.previewEvidence('ghcn_daily','precipitation',data).level,2);
  assert.equal(S.fileEvidence({spatialMode:'global'},{files:[{}]},q).label,'Files listed · global files');
  assert.equal(S.fileEvidence({},{files:[],complete:false},q).level,0);
  assert.equal(S.fileEvidence({},{files:[],complete:true},q).level,-1);
});
