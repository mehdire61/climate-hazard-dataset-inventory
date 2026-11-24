const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const T=require('../src/coverage-timeline.js');
const rules=require('../data/screening.json').rules;
const q={start:'2020-01-01',end:'2020-01-31'};
const rule=(intervals=[],extra={})=>({support_type:'grid',time_step:'daily',time:{kind:'range',intervals,uncertain_windows:[],known_through:null,...extra}});
const row=(m,id)=>m.rows.find(r=>r.id===id);

test('inclusive project interval remains available when record dates are unknown',()=>{
  const m=T.model({start:'2020-01-01',end:'2020-01-01'},null);
  assert.equal(m.state,'unknown');assert.deepEqual([m.project.start,m.project.end],['2020-01-01','2020-01-01']);
  assert.deepEqual([m.axis.start,m.axis.end],['2019-12-25','2020-01-08']);
  const s=row(m,'project').segments[0];assert.equal(s.startFraction,7/15);assert.equal(s.endFraction,8/15);assert.equal(s.displayEnd,'2020-01-01');
});
test('separate product intervals retain gaps, exact source dates and offscreen labels',()=>{
  const m=T.model(q,rule([{start:'1980-01-01',end:'1980-12-31'},{start:'2020-01-02',end:'2020-01-04'},{start:'2020-01-10',end:'2020-01-11'},{start:'2030-01-01',end:'2030-02-01'}]));
  const s=row(m,'catalog').segments;assert.equal(m.state,'ready');assert.equal(s.length,4);assert.equal(s[0].offscreen,'before');assert.equal(s[0].startFraction,null);assert.equal(s[3].offscreen,'after');assert.equal(s[3].endFraction,null);assert.ok(s[1].endFraction<s[2].startFraction);assert.equal(s[1].start,'2020-01-02');
});
test('soft known-through and route-end markers never shorten the catalog record',()=>{
  const r=rule([{start:'1950-01-01',end:null}],{known_through:'2020-01-15',access_route_end:'2016-12-31',access_route_note:'Route only; producer may have later extensions.',index_snapshot:{last_file_end:'2020-01-15',checked_on:'2020-02-01'}});
  const before=JSON.stringify(r),m=T.model(q,r),s=row(m,'catalog').segments[0];
  assert.equal(s.end,null);assert.equal(s.openEnd,true);assert.equal(s.clippedStart,true);assert.equal(s.startFraction,0);assert.equal(s.endFraction,1);assert.match(s.label,/End unknown \/ open/);
  assert.equal(m.markers[0].date,'2020-01-15');assert.match(m.markers[0].label,/soft horizon/);assert.equal(m.markers[1].offscreen,'before');assert.equal(JSON.stringify(r),before);
});
test('unknown ends and malformed boundaries never become invented exact dates',()=>{
  const m=T.model(q,rule([{start:null,end:null},{start:'2020-02-30',end:'2020-03-01'},{start:'2020-01-20',end:'2020-01-10'}]));
  const s=row(m,'catalog').segments;assert.equal(m.state,'unknown');assert.equal(s[0].unknown,true);assert.equal(s[0].startFraction,null);assert.equal(s[0].endFraction,null);assert.ok(s[1].invalid&&s[2].invalid);assert.match(m.notes.join(' '),/malformed boundaries were not drawn/);
});
test('scenario, event, track and acquisition timelines do not promise daily site observations',()=>{
  const scenarios=T.model(q,{support_type:'climate_state',time_step:'climate_state',time:{kind:'scenario',intervals:[{start:'1900-01-01',end:'2100-01-01'}]}});
  assert.equal(row(scenarios,'catalog').segments.length,0);assert.equal(scenarios.state,'unknown');assert.match(row(scenarios,'catalog').note,/not an observation-availability test/);
  for(const [support,kind,pattern]of [['event','event',/not a continuous time series/],['track','range',/does not imply continuous observations/],['acquisition','range',/do not establish an acquisition/]]){
    const r=rule([{start:'2000-01-01',end:null}],{kind});r.support_type=support;
    assert.match(row(T.model(q,r),'catalog').note,pattern);
  }
});
test('monthly publication guidance retains a soft horizon without obsolete start uncertainty',()=>{
  const m=T.model({start:'2026-11-11',end:'2026-11-13'},rules.mcd64a1);
  assert.match(m.notes.join(' '),/calendar-month product/);assert.match(m.notes.join(' '),/Catalog time support: monthly/);assert.equal(m.markers.length,1);assert.equal(m.markers[0].date,'2026-09-30');assert.equal(m.markers[0].kind,'known-through');assert.equal(m.markers[0].offscreen,'before');assert.match(m.notes.join(' '),/checked 2026-11-14/);assert.equal(row(m,'uncertainty'),undefined);
  assert.equal(row(m,'catalog').segments[0].end,null);
});
test('station elements retain individual intervals and never reuse full-record coverage as requested-period completeness',()=>{
  const station={id:'EXAMPLE',start:'1900-01-01',end:'2025-01-01',variables:[{key:'TMAX',start:'2020-01-01',end:'2020-01-03',providerRecordCoveragePercent:99},{key:'TMAX',start:'2020-01-10',end:'2020-01-12',providerRecordCoveragePercent:99},{key:'PRCP',start:null,end:null,providerRecordCoveragePercent:80}]};
  const m=T.model(q,rules.ghcn_daily,station);
  assert.equal(row(m,'element-TMAX').segments.length,2);assert.ok(row(m,'element-TMAX').segments[0].endFraction<row(m,'element-TMAX').segments[1].startFraction);assert.equal(row(m,'element-PRCP').segments[0].unknown,true);
  assert.doesNotMatch(JSON.stringify(m),/providerRecordCoveragePercent|"completeness"|"coveragePercent"/);
});
test('CO-OPS repeated intervals preserve the actual gap and precise UTC boundaries',()=>{
  const station={id:'9752621',start:'1900-01-01',coopsAvailability:{stationId:'9752621',inventoryStatus:'ok',periods:[{product:'Preliminary 6-Minute Water Level',first:'2023-05-10 19:30',last:'2024-06-25 20:42'},{product:'Preliminary 6-Minute Water Level',first:'2024-09-26 17:00',last:'2026-11-14 16:54'}]}};
  const m=T.model({start:'2024-06-01',end:'2024-10-01'},rules.noaa_coops_water_level,station),s=row(m,'coops-preliminary').segments;
  assert.equal(s.length,2);assert.ok(s[0].endFraction<s[1].startFraction);assert.equal(s[0].displayEnd,'2024-06-25T20:42:00.000Z');assert.match(s[0].label,/UTC/);assert.equal(row(m,'station'),undefined);
  station.coopsAvailability.stationId='8594900';const wrong=T.model(q,rules.noaa_coops_water_level,station);assert.equal(wrong.state,'unknown');assert.equal(row(wrong,'coops-preliminary'),undefined);
});
test('USGS series stay separate and preserve provider calendar days without timezone conversion',()=>{
  const station={id:'USGS-EXAMPLE',seriesMetadata:[{id:'one',unit:'ft^3/s',start:'2020-01-01T23:59:00-05:00',end:'2020-01-03T23:59:00-05:00'},{id:'two',unit:'m^3/s',start:'2020-01-10',end:'2020-01-20'}]};
  const m=T.model(q,rules.usgs_streamflow,station);assert.equal(row(m,'series-0').segments[0].displayStart,'2020-01-01');assert.equal(row(m,'series-0').segments[0].displayEnd,'2020-01-03');
  assert.equal(row(m,'series-0').label,'Daily mean discharge 1 · ft³/s');assert.equal(row(m,'series-1').label,'Daily mean discharge 2 · m³/s');
  assert.match(row(m,'series-0').note,/Provider series ID: one/);assert.match(row(m,'series-1').note,/Provider unit: m\^3\/s/);
});
test('malformed CO-OPS interval containers remain unknown without fabricating an empty archive',()=>{
  for(const periods of [null,undefined,{},'not periods']){
    const m=T.model(q,rules.noaa_coops_water_level,{id:'8594900',coopsAvailability:{stationId:'8594900',inventoryStatus:'ok',periods}});
    assert.equal(m.state,'unknown');assert.match(m.notes.join(' '),/inventory periods are unresolved/);assert.doesNotMatch(m.notes.join(' '),/No six-minute water-level product is listed/);
  }
});
test('invalid inputs and extreme valid Gregorian dates do not leak NaN or overflow the visible axis',()=>{
  for(const query of [{start:'0000-01-01',end:'0000-01-02'},{start:'2020-02-30',end:'2020-03-01'},{start:'2021-01-01',end:'2020-01-01'}])assert.equal(T.model(query,rules.era5_t2m).state,'invalid');
  for(const query of [{start:'0001-01-01',end:'0001-01-01'},{start:'9999-12-31',end:'9999-12-31'}]){const m=T.model(query,rule([{start:query.start,end:query.end}]));assert.ok(Number.isFinite(m.axis.startMs)&&Number.isFinite(m.axis.endMs));assert.ok(m.axis.endMs>m.axis.startMs);for(const r of m.rows)for(const s of r.segments){assert.ok(s.startFraction>=0&&s.startFraction<=1);assert.ok(s.endFraction>=0&&s.endFraction<=1);}}
});
test('all catalog rules produce deterministic input-preserving browser and Node models',()=>{
  const context={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/coverage-timeline.js'),'utf8'),context);
  const before=JSON.stringify(rules);
  for(const [id,r]of Object.entries(rules)){const result=T.model(q,r);assert.deepEqual(T.model(q,r),result,id);assert.deepEqual(JSON.parse(JSON.stringify(context.SiteCoverageTimeline.model(q,r))),result,id);assert.equal(result.rows[0].id,'project');}
  assert.equal(JSON.stringify(rules),before);
});

test('comparison aligns matching dates and keeps open ends, uncertainty and file horizons distinct',()=>{
  const {deriveIndexSnapshot}=require('../src/screening.js');
  const index=require('../data/grid-access-index.json');
  const inputs=['chirps_v3_daily_rnl','gpm_imerg_final_v07b','spei_gd_v1','era5_t2m'].map(id=>({
    id,rule:rules[id],index:deriveIndexSnapshot(index,id)}));
  const {axis,rows}=T.comparison(inputs,'2026-11-23');
  const [chirps,imerg,spei,era]=rows;
  assert.equal(chirps.bands[0].end,inputs[0].index.last_file_end);
  assert.equal(chirps.horizon.date,inputs[0].index.last_file_end);
  assert.match(chirps.caption,/end open.*Last listed file/);
  assert.equal(imerg.bands[0].end,'2025-09-30');
  assert.equal(imerg.horizon,null);
  assert.equal(era.bands[0].style,'policy');
  assert.equal(era.bands[0].end,'2026-11-23');
  assert.equal(spei.bands.filter(b=>b.style==='uncertain').length,2);
  assert.match(spei.periods.join(' '),/file time coordinates/);
  for(const row of rows) for(const b of row.bands) {
    const begin=axis.startMs+b.left*(axis.endMs-axis.startMs);
    assert.equal(new Date(Math.round(begin)).toISOString().slice(0,10),b.start);
  }
});

test('comparison preserves missing SWE and GRACE intervals, and gives static and station rows no invented range',()=>{
  const forIds=(...ids)=>T.comparison(ids.map(id=>({id,rule:rules[id]})),'2026-11-23');
  const {rows,axis}=forIds('nohrsc_snodas_daily_swe','grace_jpl_mascon_cri_rl063_v04','jrc_glofas_rp100_depth','nrcs_snotel_daily_swe');
  assert.ok(axis);
  assert.equal(rows[0].bands.length,rules[rows[0].id].time.intervals.length);
  assert.ok(rows[0].bands.every(b=>b.end<'2005-07-31'||b.start>'2005-07-31'));
  assert.ok(rows[1].bands.every(b=>b.end<'2018-01-01'||b.start>'2018-01-01'));
  assert.match(rows[2].caption,/100-year flood scenario/);
  assert.match(rows[3].caption,/Choose a station/);
  assert.equal(rows[2].bands.length+rows[3].bands.length,0);
  assert.equal(forIds('jrc_glofas_rp100_depth','nrcs_snotel_daily_swe').axis,null);
});

test('shared dates exclude uncertain edges, internal gap days and unverified open spans',()=>{
  const compare=(...rs)=>T.comparison(rs.map((rule,i)=>({id:String(i),rule})),'2026-11-23').shared;
  const spei=rules.spei_gd_v1;
  const split=rule([{start:'1980-01-01',end:'2001-05-02'},{start:'2001-05-04',end:'2022-01-01'}]);
  assert.deepEqual(compare(spei,split).map(({start,end})=>[start,end]),[
    ['1983-01-01','2001-05-02'],['2001-05-04','2020-12-31']]);
  assert.deepEqual(compare(spei,rule([{start:'1940-01-01',end:'1970-12-31'}])),[]);
  assert.equal(compare(spei,rules.era5_t2m),null);
});
