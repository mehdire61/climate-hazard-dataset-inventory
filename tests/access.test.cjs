const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const access=require('../src/access.js');
const catalog=require('../data/catalog.json').products;
const point={mode:'point',lat:38.9,lon:-77.04,radiusKm:100,start:'2020-07-01',end:'2020-07-03'};
const area={mode:'area',areaName:'County test',areaSource:{kind:'test',vintage:'2020'},bufferKm:50,
 geometry:{type:'Polygon',coordinates:[[[-78,38],[-76,38],[-76,40],[-78,40],[-78,38]],[[-77.5,38.5],[-77.5,39],[-77,39],[-77,38.5],[-77.5,38.5]]]},start:point.start,end:point.end};

test('Every original record has an explicit reviewed access route',()=>{
 assert.equal(catalog.length,53);
 for(const product of catalog){const p=access.describe(product.product_id);assert.ok(['station','files','request','external'].includes(p.kind));
  for(const key of ['summary','auth','spatialDelivery','temporalDelivery','providerUrl','docsUrl'])assert.ok(p[key],product.product_id+' '+key);
  assert.ok(p.verification.label);assert.ok(p.verification.checkedAt);}
});
test('Three existing station routes are retained and have no new automatic discovery mode',()=>{
 for(const id of ['ghcn_daily','noaa_coops_water_level','usgs_streamflow'])assert.equal(access.describe(id).kind,'station');
});
test('CHIRPS plans retain monthly file support and exact original polygon including holes/source',()=>{
 const before=JSON.stringify(area),p=access.prepare('chirps_v2_daily',area);
 assert.deepEqual(p.errors,[]);assert.equal(p.files.length,1);assert.equal(p.files[0].start,'2020-07-01');assert.equal(p.files[0].end,'2020-07-31');
 assert.deepEqual(p.manifest.query,area);assert.equal(JSON.stringify(area),before);
 const geo=JSON.parse(p.artifacts.find(a=>a.role==='geometry').text);assert.deepEqual(geo.geometry,area.geometry);assert.deepEqual(geo.properties.source,area.areaSource);
 assert.ok(p.notes.some(n=>/clipping/i.test(n)));
});
test('All matched file links remain in a multi-year plan without a display cap',()=>{
 const p=access.prepare('chirps_v2_daily',{...point,start:'1981-01-01',end:'2025-12-31'});assert.deepEqual(p.errors,[]);assert.equal(p.files.length,540);
 assert.equal(p.manifest.files.length,540);assert.ok(p.artifacts.find(a=>a.name.endsWith('.py')).text.includes(p.files.at(-1).url));
});
test('Out-of-scope and invalid inputs cannot prepare data or request artifacts',()=>{
 for(const q of [{...point,lat:70},{...point,start:'2020-02-30'},{...point,lon:181}]){
  const p=access.prepare('chirps_v2_daily',q);assert.ok(p.errors.length);assert.equal(p.files.length,0);assert.equal(p.artifacts.length,0);assert.equal(p.manifest,null);}
});
test('SPEI requires a deliberate accumulation-window choice for its restricted provider workflow',()=>{
 assert.ok(access.prepare('spei_gd_v1',point).errors.length);
 const p=access.prepare('spei_gd_v1',point,{window:'30'});assert.deepEqual(p.errors,[]);assert.equal(p.files.length,0);assert.equal(p.manifest.accessCapability,'external');assert.match(p.manifest.accessProfile.auth,/restricted/i);
 assert.ok(p.notes.some(n=>/disagree/i.test(n)));assert.equal(p.manifest.selection.window,'30');
});
test('HadEX3 lists only observed user-selected file and retains annual/monthly index semantics',()=>{
 const q={...point,start:'2000-01-01',end:'2000-12-31'},profile=access.describe('hadex3');
 assert.ok(access.prepare('hadex3',q).errors.length);
 const chosen=profile.options[0].choices.find(c=>c.value);const p=access.prepare('hadex3',q,{indexFile:chosen.value});assert.deepEqual(p.errors,[]);assert.equal(p.files.length,1);assert.equal(p.files[0].url,chosen.value);
 assert.equal(p.files[0].start,'1901-01-01');assert.equal(p.files[0].end,'2018-12-31');
});
test('Storm reports select actual annual details plus locations files and preserve event type/time qualification',()=>{
 const p=access.prepare('ncei_storm_events_hail',{...point,start:'2019-12-31',end:'2020-01-01'});assert.deepEqual(p.errors,[]);assert.equal(p.files.length,4);
 assert.ok(p.files.every(f=>/d2019_|d2020_/.test(f.name)));assert.equal(p.manifest.accessProfile.eventType,'Hail');assert.ok(p.manifest.accessProfile.temporalDelivery.includes('CZ_TIMEZONE'));
});
test('GESLA ERDDAP prepared URLs use exclusive next day and retain both quality flags',()=>{
 const p=access.prepare('gesla41',point);assert.deepEqual(p.errors,[]);assert.equal(p.files.length,0);assert.ok(p.manifest.requests.length);
 const url=decodeURIComponent(p.manifest.requests[0].url);assert.ok(url.includes('time<2020-07-04T00:00:00Z'));assert.ok(url.includes('flag1,flag2'));assert.ok(url.includes('longitude>=281'));
 assert.ok(p.artifacts.some(a=>a.name.endsWith('.py')));
});
test('Longitude convention conversion preserves Greenwich and dateline coverage',()=>{
 assert.deepEqual(access._test.lon360Boxes([-5,10,5,20]),[[355,10,360,20],[0,10,5,20]]);
 assert.deepEqual(access._test.lon360Boxes([-180,-90,180,90]),[[0,-90,360,90]]);
 assert.deepEqual(access._test.lon360Boxes([-180,0,-170,1]),[[180,0,190,1]]);
});

test('Prepared payload manifests retain unknown sizes rather than report an empty zero-byte selection',()=>{
 for(const [id,options] of [['esa_cci_sm_combined_v09_2',{}],['ims_snow_ice',{grid:'4km',minorVersion:'1.3'}],['gesla41',{}]]){
  const plan=access.prepare(id,point,options),summary=plan.manifest.transferSummary;
  assert.deepEqual(plan.errors,[]);assert.ok(plan.manifest.requests.length>0);
  assert.equal(summary.fileCount,plan.manifest.requests.length);assert.equal(summary.unknownCount,summary.fileCount);
  assert.equal(summary.requiresConfirmation,true);assert.equal(summary.unit,'prepared file requests');
 }
 const discovery=access.prepare('gpm_imerg_final_v07b',point);
 assert.ok(discovery.manifest.requests.length>0);assert.equal(discovery.manifest.transferSummary.fileCount,0,'CMR metadata URLs are not payload files');
});
test('Portal handoff names unresolved choices without inventing a Fathom scenario',()=>{
 const p=access.prepare('fathom_gfm3',area);assert.deepEqual(p.errors,[]);assert.equal(p.files.length,0);assert.equal(p.manifest.requests.length,0);
 assert.ok(p.manifest.requiredSelections.includes('Return period'));assert.ok(!p.artifacts.some(a=>a.name.endsWith('.py')));assert.ok(p.artifacts.find(a=>a.role==='instructions').text.includes('not translated into a scenario'));
});
test('Source caveats and referenced provenance stay attached to prepared access',()=>{
 const p=access.prepare('chirps_v3_daily_sat',{...point,start:'1998-06-01',end:'1998-06-03'});
 assert.deepEqual(p.errors,[]);assert.equal(p.files.length,0);assert.equal(p.manifest.screening.status,'possible');assert.match(p.manifest.screening.reasons.join(' '),/other provider formats/);assert.ok(p.manifest.sourceRecord.limitations.length);assert.ok(Object.keys(p.manifest.referencedSources).length);
});
test('Download scripts are review-only by default, avoid overwriting and retain failed partial files',()=>{
 const script=access._test.rawDownloadScript('test',[{url:'https://example.org/data.zip',name:'data.zip'}]);
 assert.ok(script.includes('if not args.download:'));assert.ok(script.includes('partial.open("xb")'));assert.ok(script.includes('raise FileExistsError'));assert.ok(script.includes('Expected ZIP signature'));
 assert.ok(!script.includes('unlink('));
});
