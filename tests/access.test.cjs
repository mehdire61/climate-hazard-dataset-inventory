const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const access=require('../src/access.js');
const catalog=require('../data/catalog.json').products;
const point={mode:'point',lat:38.9,lon:-77.04,radiusKm:100,start:'2020-07-01',end:'2020-07-03'};
const area={mode:'area',areaName:'County test',areaSource:{kind:'test',vintage:'2020'},bufferKm:50,
 geometry:{type:'Polygon',coordinates:[[[-78,38],[-76,38],[-76,40],[-78,40],[-78,38]],[[-77.5,38.5],[-77.5,39],[-77,39],[-77,38.5],[-77.5,38.5]]]},start:point.start,end:point.end};

test('Every original record has an explicit reviewed access route',()=>{
 assert.equal(catalog.length,57);
 for(const product of catalog){const p=access.describe(product.product_id);assert.ok(['station','files','request','external'].includes(p.kind));
  for(const key of ['summary','auth','spatialDelivery','temporalDelivery','providerUrl','docsUrl'])assert.ok(p[key],product.product_id+' '+key);
  assert.ok(p.verification.label);assert.ok(p.verification.checkedAt);}
});
test('SNODAS selects dated masked archives, preserves documented SWE gaps and distinguishes dry and missing cells',()=>{
 const id='nohrsc_snodas_daily_swe',receipt=require('../docs/evidence/snodas/receipt.json');
 const plan=(start,end=start,location=point)=>access.prepare(id,{...location,start,end});
 assert.equal(plan('2024-04-01').manifest.requests[0].url,receipt.url);
 assert.deepEqual(receipt.cells.map(c=>c.sweMm),[609,0,null]);
 assert.equal(receipt.validTime,'2024-04-01T06:00:00Z');
 const leap=plan('2024-02-28','2024-03-01');
 assert.deepEqual(leap.manifest.requests.map(r=>r.url.split('/').slice(-2).join('/')),
   ['02_Feb/SNODAS_20240228.tar','02_Feb/SNODAS_20240229.tar','03_Mar/SNODAS_20240301.tar']);
 const gap=plan('2005-07-30','2005-08-03');
 assert.deepEqual(gap.manifest.requests.map(r=>r.date),['2005-07-30','2005-08-03']);
 assert.deepEqual(gap.manifest.uncoveredIntervals.map(r=>r.start),['2005-07-31','2005-08-01','2005-08-02']);
 assert.match(gap.manifest.uncoveredIntervals[0].reason,/erroneous zeros/);
 for(const day of ['2003-09-29','2003-10-30','2005-07-31','2012-12-20'])assert.ok(plan(day).errors.length,day);
 assert.deepEqual(plan('2003-09-30').errors,[]);
 assert.ok(plan('2024-04-01','2024-04-01',{...point,lat:61,lon:-150}).errors.length);
});
test('Three existing station routes are retained and have no new automatic discovery mode',()=>{
 for(const id of ['ghcn_daily','noaa_coops_water_level','usgs_streamflow'])assert.equal(access.describe(id).kind,'station');
});
test('JRC selects raw RP100 footprint tiles independently of dates and station buffers',()=>{
 const id='jrc_glofas_rp100_depth',receipt=require('../docs/evidence/jrc-flood/receipt.json');
 const p=access.prepare(id,point),polygon=access.prepare(id,{...area,start:'1980-01-01',end:'1980-01-31',bufferKm:500});
 assert.deepEqual(p.errors,[]);assert.deepEqual(polygon.errors,[]);
 assert.deepEqual(p.files.map(f=>f.url),[receipt.layers.depth.url]);
 assert.deepEqual(polygon.files.map(f=>f.url),p.files.map(f=>f.url));
 assert.equal(p.manifest.screening.status,'special');assert.equal(p.manifest.screening.label,'100-year scenario');
 assert.equal(p.files[0].sizeBytes,receipt.layers.depth.bytes);
 assert.equal(p.manifest.accessProfile.files.length,271);assert.equal(receipt.returnPeriodYears,100);
 assert.ok(p.manifest.accessProfile.files.every(f=>/_RP100_depth\.tif$/.test(f.name)));
 assert.ok(Math.abs(receipt.cells[0].depth-9.747)<0.001);
 assert.equal(receipt.cells[1].depth,receipt.layers.depth.nodata);
 const offshore=access.prepare(id,{...point,lat:0,lon:-150,radiusKm:1000});
 assert.deepEqual(offshore.files,[]);assert.ok(offshore.notes.some(n=>n.includes('No tile')));
});
test('GLEAM screens the frozen archive and separates grid-cell values, time units and reuse terms',()=>{
 const id='gleam_v4_2a_actual_evaporation';
 const {errors,files,manifest}=access.prepare(id,area);
 assert.deepEqual(errors,[]);assert.deepEqual(files,[]);assert.deepEqual(manifest.query.geometry,area.geometry);
 assert.equal(manifest.accessCapability,'external');
 assert.ok(access.prepare(id,{...point,start:'2024-01-01',end:'2024-01-02'}).errors.length);
 const record=catalog.find(p=>p.product_id===id),receipt=require('../docs/evidence/gleam/receipt.json');
 assert.equal(record.commercial_use_status,'UNKNOWN');assert.equal(record.redistribution_status,'UNKNOWN');
 assert.equal(record.license_id,'PROVIDER_LICENSE_TEXT_CONFLICT');
 assert.equal(manifest.referencedSources.GLEAM42_DEPOSIT_RIGHTS.url,receipt.rights.depositMetadata);
 assert.equal(record.license_url,receipt.rights.providerPolicy);
 assert.equal(receipt.dailyHeader.units,'mm.day-1');assert.equal(receipt.annual.units,'mm.year-1');
 assert.equal(receipt.dailyHeader.numericDailyValuesInspected,false);
 assert.ok(manifest.verification.label.includes(receipt.annual.cells[0].value.toFixed(3)));
 assert.equal(receipt.annual.cells[1].value,null);
});
test('SNOTEL handoff retains station and unit evidence without claiming a project download',()=>{
 const id='nrcs_snotel_daily_swe',q={...point,lat:45.04315,lon:-116.13253,start:'2024-04-01',end:'2024-04-03'};
 const {errors,files,manifest}=access.prepare(id,q);
 assert.deepEqual(errors,[]);assert.deepEqual(files,[]);
 assert.equal(manifest.accessCapability,'external');assert.deepEqual(manifest.query,q);
 assert.equal(manifest.verification.status,'sample-payload-checked');
 const url=new URL(manifest.referencedSources.NRCS_SNOTEL_WTEQ_SAMPLE.url);
 assert.equal(url.searchParams.get('stationTriplets'),'370:ID:SNTL');
 const folder=require('node:path').join(__dirname,'../docs/evidence/snotel');
 const receipts=JSON.parse(fs.readFileSync(folder+'/receipts.json'));
 for(const receipt of receipts){
   const raw=fs.readFileSync(folder+'/'+receipt.file);
   const response=receipt.file.endsWith('.gz')?require('node:zlib').gunzipSync(raw):raw;
   assert.equal(require('node:crypto').createHash('sha256').update(response).digest('hex'),receipt.responseSha256);
 }
 const {stationElement,values}=JSON.parse(fs.readFileSync(folder+'/brundage-daily-wteq.json'))[0].data[0];
 assert.equal(stationElement.elementCode,'WTEQ');assert.equal(stationElement.storedUnitCode,'in');
 assert.deepEqual(values.map(v=>[v.date,v.value,v.qcFlag,v.qaFlag]),[
   ['2024-04-01',24,'V','P'],['2024-04-02',23.6,'V','P'],['2024-04-03',24,'V','P']]);
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
