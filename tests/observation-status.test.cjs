const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const providers = require('../src/providers.js');
const chart = require('../src/observation-chart.js');
const load = relative => fs.readFileSync(path.join(__dirname, 'fixtures', relative), 'utf8');

test('Buffalo Bayou daily mean keeps Approved, Estimated and Revised together without deleting or changing the peak', async () => {
  const raw = load('usgs/buffalo-bayou-daily-2017-08-25_31.json');
  const station = {id:'USGS-08074000',name:'Buffalo Bayou at Houston, TX'};
  const query = {mode:'point',lat:29.76,lon:-95.41,radiusKm:10,start:'2017-08-25',end:'2017-08-31'};
  const result = await providers.retrieve('usgs_streamflow',station,query,{fetchImpl:async()=>new Response(raw)});
  assert.equal(result.rawText,raw);
  const m = chart.model(result.series[0],result.window,'usgs_streamflow');
  assert.deepEqual([m.numeric.length,m.absent,m.estimatedCount,m.revisedCount,m.failedCount],[6,1,3,3,0]);
  assert.equal(m.peak.time,'2017-08-28');
  assert.equal(m.peak.value,27600);
  assert.equal(m.peak.estimated && m.peak.revised,true);
  assert.deepEqual(chart.usgsStatus(m.peak.flags),['Approved','Estimated','Revised']);
  assert.deepEqual(m.peak.flags.qualifier,['ESTIMATED','REVISED']);
  assert.deepEqual(chart.usgsStatus(m.rows.at(-1).flags),['Approved']);
  assert.deepEqual(chart.usgsStatus({approvalStatus:'Provisional',qualifier:'estimated'}),['Provisional','Estimated']);
  assert.deepEqual(chart.usgsStatus({qualifier:['REVISED','REVISED']}),['Revised']);
  assert.deepEqual(chart.usgsStatus({qualifier:['NOTESTIMATED','UNREVISED']}),[]);
});

test('Baltimore precipitation keeps CF6 provenance on individual days, the maximum and subtotal while preserving values', async () => {
  const raw = load('ghcn-daily/bwi-ghcn-daily-2026-10-18_11-13.json');
  const query = {mode:'point',lat:39.17329,lon:-76.68408,radiusKm:10,start:'2026-10-18',end:'2026-11-16'};
  const station = {id:'USW00093721',name:'Baltimore Washington International Airport',end:'2026-11-13'};
  const result = await providers.retrieve('ghcn_daily',station,query,{fetchImpl:async()=>new Response(raw)});
  const rain = result.series.find(s=>s.key==='PRCP');
  const m = chart.model(rain,result.window,'ghcn_daily');
  assert.equal(result.rawText,raw);
  assert.equal(m.preliminarySourceCount,27);
  assert.equal(m.failedCount,0);
  assert.equal(m.sum,33.4);
  assert.deepEqual([m.peak.time,m.peak.value,m.peak.preliminarySource],['2026-11-06',29,true]);
  assert.deepEqual(['1','D','d','W',''].map(chart.cf6Source),[true,true,false,false,false]);
  const mixed = structuredClone(rain);
  mixed.points[0].flags.sourceFlag='W';
  mixed.points[1].flags.sourceFlag='D';
  mixed.points[2].value=null;
  assert.equal(chart.model(mixed,result.window,'ghcn_daily').preliminarySourceCount,25);
});

test('USGS provider-only access uses the selected station and keeps daily, continuous and annual statistics distinct', () => {
  const dates={start:'2017-08-25',end:'2017-08-31'};
  const links=providers.usgsStationLinks('USGS-08074000',dates).map(route=>new URL(route.url));
  assert.deepEqual(links.map(u=>u.pathname.split('/').at(-2)),['continuous','continuous','peaks']);
  assert.deepEqual(links.map(u=>u.searchParams.get('parameter_code')),['00060','00065','00060']);
  assert.ok(links.every(u=>u.host==='api.waterdata.usgs.gov'&&u.searchParams.get('monitoring_location_id')==='USGS-08074000'));
  assert.equal(links[0].searchParams.get('time'),'2017-08-25T00:00:00Z/2017-08-31T23:59:59.999Z');
  assert.equal(links[2].searchParams.get('time'),null);
  assert.deepEqual(providers.usgsStationLinks('../../x',dates),[]);
  for(const route of providers.usgsStationLinks('USGS-08074000',{start:'1950-01-01',end:'2026-01-01'}))
    assert.equal(new URL(route.url).searchParams.has('time'),false);
});
