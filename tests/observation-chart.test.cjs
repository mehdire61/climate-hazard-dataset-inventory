const test = require('node:test');
const assert = require('node:assert/strict');
const {model} = require('../src/observation-chart.js');

const day = 86400000;
const sixMinutes = 360000;
const fiveDays = {start: '2020-01-01', end: '2020-01-05'};
const twoDays = {start: '2020-01-01', end: '2020-01-02'};
const point = (date, value, flags = {}) => ({time: '2020-01-0' + date, value, flags});
const daily = (key, points) => ({key, cadenceMs: day, points});

test('both edges of the requested window and a returned null are distinct gaps', () => {
  const series = daily('TMAX', [point(2,12), point(3,null), point(4,18)]);
  const original = structuredClone(series);
  const chart = model(series, fiveDays, 'ghcn_daily');
  assert.equal(chart.expected, 5);
  assert.equal(chart.absent, 2);
  assert.equal(chart.returnedMissing, 1);
  assert.deepEqual(chart.missing, [
    {ms: Date.parse('2020-01-01'), kind: 'absent timestamp'},
    {ms: Date.parse('2020-01-03'), kind: 'missing value'},
    {ms: Date.parse('2020-01-05'), kind: 'absent timestamp'}
  ]);
  assert.deepEqual(chart.segments.map(segment => segment.length), [1, 1]);
  assert.deepEqual(series, original);
});

test('temperature lines connect consecutive days on either side of a missing day', () => {
  const series = daily('TMAX', [point(1,-2), point(2,0), point(4,3), point(5,4)]);
  const chart = model(series, fiveDays, 'ghcn_daily');
  assert.equal(chart.kind, 'line');
  assert.deepEqual(chart.segments.map(segment => segment.map(p => p.value)), [[-2, 0], [3, 4]]);
});

test('a failed GHCN quality flag splits the line while preserving the flagged value', () => {
  const series = daily('TMAX', [point(1,2), point(2,999,{qualityFlag:'X'}), point(3,3)]);
  const chart = model(series, fiveDays, 'ghcn_daily');
  assert.deepEqual(chart.segments.map(segment => segment.length), [1, 1]);
  assert.equal(chart.flaggedPeak.value, 999);
  assert.equal(chart.peak.value, 3);
  assert.equal(chart.failedCount, 1);
  assert.equal(chart.complete, false);
});

test('daily precipitation distinguishes a measured zero, trace, returned null and absent day', () => {
  const series = daily('PRCP', [point(1,0), point(2,0,{measurementFlag:'T'}), point(3,12.3), point(4,null)]);
  const chart = model(series, fiveDays, 'ghcn_daily');
  assert.equal(chart.kind, 'bars');
  assert.equal(chart.rows[0].trace, false);
  assert.equal(chart.rows[1].trace, true);
  assert.equal(chart.traceCount, 1);
  assert.equal(chart.absent, 1);
  assert.equal(chart.returnedMissing, 1);
  assert.equal(chart.sum, 12.3);
  assert.equal(chart.lowerBound, true);
});

test('failed-QC rain remains in the record and is excluded from its subtotal', () => {
  const series = daily('PRCP', [point(1,4), point(2,800,{qualityFlag:'X'})]);
  const chart = model(series, twoDays, 'ghcn_daily');
  assert.equal(chart.sum, 4);
  assert.equal(chart.numeric[1].value, 800);
  assert.equal(chart.complete, false);
});

test('only accumulation variables get a total over complete reporting intervals', () => {
  const observations = [point(1,1), point(2,2)];
  const rain = model(daily('PRCP', observations), twoDays, 'ghcn_daily');
  assert.equal(rain.sum, 3);
  assert.equal(rain.complete, true);
  assert.equal(model(daily('TMAX', observations), twoDays, 'ghcn_daily').sum, null);
});

test('snowfall totals use bars and snow depth uses a line', () => {
  const values = [point(1,5), point(2,6)];
  assert.equal(model(daily('SNOW', values), twoDays, 'ghcn_daily').kind, 'bars');
  assert.equal(model(daily('SNWD', values), twoDays, 'ghcn_daily').kind, 'line');
});

test('wind direction across north remains two unconnected measurements', () => {
  const chart = model(daily('WDF2', [point(1,359), point(2,1)]), twoDays, 'ghcn_daily');
  assert.equal(chart.kind, 'points');
  assert.deepEqual(chart.segments, []);
});

test('unknown or off-cadence observations leave completeness unassessed', () => {
  const points = [{time: '2020-01-01T00:07:00Z', value: 4}];
  for (const cadenceMs of [null, sixMinutes]) {
    const chart = model({key:'water_level', cadenceMs, points}, fiveDays, 'noaa_coops_water_level');
    assert.equal(chart.expected, null);
    assert.equal(chart.missing, null);
    assert.equal(chart.kind, 'points');
  }
});

test('CO-OPS counts six-minute UTC slots inside the actual request times', () => {
  const points = [
    {time:'2020-01-01 00:06', value:1},
    {time:'2020-01-01 00:12', value:2, flags:{quality:'p'}},
    {time:'2020-01-01 00:24', value:3}
  ];
  const window = {startTime:'2020-01-01T00:03:00Z', endTime:'2020-01-01T00:27:00Z'};
  const chart = model({key:'water_level', cadenceMs:sixMinutes, points}, window, 'noaa_coops_water_level');
  assert.equal(chart.expected, 4);
  assert.deepEqual(chart.missing, [{ms:Date.parse('2020-01-01T00:18:00Z'), kind:'absent timestamp'}]);
  assert.equal(chart.numeric[1].provisional, true);
  assert.equal(chart.failedCount, 0);
  assert.deepEqual(chart.segments.map(segment => segment.length), [2, 1]);
});

test('an empty CO-OPS day retains all expected six-minute or hourly slots', () => {
  const window = {start:'2020-01-01', end:'2020-01-01'};
  for (const [cadenceMs, expected] of [[sixMinutes, 240], [3600000, 24]]) {
    const chart = model({key:'water_level', cadenceMs, points:[]}, window, 'noaa_coops_water_level');
    assert.equal(chart.expected, expected);
    assert.equal(chart.absent, expected);
  }
});

test('USGS daily means retain provider calendar dates and provisional status', () => {
  const points = [
    {time:'2020-01-01T23:00:00-05:00', value:2, flags:{approvalStatus:'Provisional'}},
    {time:'2020-01-02T23:00:00-05:00', value:3}
  ];
  const chart = model(daily('discharge', points), twoDays, 'usgs_streamflow');
  assert.equal(chart.absent, 0);
  assert.equal(chart.segments[0].length, 2);
  assert.equal(chart.numeric[0].ms, Date.parse('2020-01-01'));
  assert.equal(chart.numeric[0].provisional, true);
});

test('isolated readings and duplicate dates cannot create a continuous series', () => {
  const isolated = model(daily('TMAX', [point(3,3)]), fiveDays, 'ghcn_daily');
  assert.equal(isolated.segments[0].length, 1);
  assert.equal(isolated.absent, 4);
  const duplicate = model(daily('TMAX', [point(1,3), point(1,4)]), fiveDays, 'ghcn_daily');
  assert.equal(duplicate.kind, 'points');
  assert.equal(duplicate.expected, null);
});
