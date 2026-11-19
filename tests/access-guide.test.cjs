const test=require('node:test'),assert=require('node:assert/strict');
const A=require('../src/access.js'),G=require('../src/access-guide.js'),profiles=require('../data/access.json').profiles;
const query={mode:'point',lat:38.9,lon:-77.04,radiusKm:100,start:'2020-07-01',end:'2020-07-01'};
const guide=(id,opts={},platform='windows')=>G.forPlan(A.describe(id),A.prepare(id,query,opts),platform);
test('Direct file access leads to browser downloads with Python explicitly optional',()=>{
 const g=guide('chirps_v2_daily');assert.ok(g.direct);assert.match(g.result,/No Python or JSON/);assert.match(G.text(g,'project'),/Optional Python route/);
});
test('CDS supplies prerequisites, exact self-contained script commands and expected output',()=>{
 const g=guide('era5_t2m'),requirements=g.requirements.join(' ');
 assert.match(requirements,/CDS account/);assert.match(requirements,/accept(?:ed|ance of the dataset) terms/);assert.match(requirements,/local CDS personal access token/);assert.match(g.scriptResult,/era5_t2m_data/);
 assert.deepEqual(g.commands.map(c=>c.text),['py -3 --version','py -3 -m pip install "cdsapi>=0.7.7"','py -3 era5_t2m_request.py']);
 assert.equal(g.requiresTransferChoice,true);assert.equal(g.confirmAllCommand.text,'py -3 era5_t2m_request.py --execute --confirm-transfer');assert.match(g.confirmationCommand.text,/--request 1 --confirm-transfer$/);
 assert.ok(g.links.some(l=>l.url.includes('how-to-api')));
});
test('Public request commands match their executable flags, downloaded names and output folders',()=>{
 for(const id of ['gesla41','esa_cci_sm_combined_v09_2','ims_snow_ice','nasa_coolr']){
  const opts=id==='ims_snow_ice'?{grid:'4km',minorVersion:'1.3'}:{};
  const plan=A.prepare(id,query,opts),g=G.forPlan(A.describe(id),plan,'path');
  assert.deepEqual(plan.errors,[]);
  if(g.requiresTransferChoice){assert.equal(g.confirmAllCommand.text,'python '+g.scriptName+' --download --confirm-transfer');assert.equal(g.commands.at(-1).text,'python '+g.scriptName);}
  else assert.equal(g.commands.at(-1).text,'python '+g.scriptName+' --download');
  const script=plan.artifacts.find(a=>a.name===g.scriptName);assert.ok(script.text.includes('--download'));assert.ok(g.scriptResult.includes(id==='nasa_coolr'?'coolr_provider_features':id+'_provider_files'));
  assert.equal(g.remainingChoices.length,0);assert.ok(!plan.artifacts.find(a=>a.role==='instructions').text.includes('Still to select'));
 }
});
test('MRMS retains file discovery and offers a bounded payload download command',()=>{
 const g=guide('mrms_mesh');assert.match(g.scriptResult,/mrms_mesh_file-links\.html/);assert.match(g.scriptResult,/--execute only lists files/);assert.ok(g.commands.some(c=>/--execute$/.test(c.text)));assert.match(g.commands.at(-1).text,/--download --file 1$/);
 assert.match(g.transferNote,/no large batch starts by default/);assert.match(g.confirmationCommand.text,/--file 1 --confirm-transfer$/);
});
test('Portal routes have provider actions, remaining selections and no fabricated execution command',()=>{
 for(const p of Object.values(profiles).filter(p=>p.kind==='external')){
  const g=G.forPlan(p,{artifacts:[],errors:[]});assert.ok(g.external);assert.ok(g.steps.length);assert.equal(g.commands.length,0);assert.ok(g.remainingChoices.length);assert.match(g.providerUrl,/^https:/);
 }
 const g=guide('fathom_gfm3');assert.match(g.steps.join(' '),/not a provider submission format/);
});
test('Invalid choices cannot receive executable instructions; OS variants use correct launchers',()=>{
 assert.equal(guide('ims_snow_ice'),null);assert.equal(guide('spei_gd_v1'),null);
 assert.equal(guide('era5_t2m',{},'unix').confirmAllCommand.text,'python3 era5_t2m_request.py --execute --confirm-transfer');
 assert.throws(()=>guide('era5_t2m',{},'arbitrary-shell'),/supported/);
});
