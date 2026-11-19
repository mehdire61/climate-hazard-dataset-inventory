const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/grid-access.js');
const index = require('../data/grid-access-index.json');
const clone = value => JSON.parse(JSON.stringify(value));
const q = {mode: 'point', lat: 38.9, lon: -77.04, radiusKm: 100, start: '2020-07-01', end: '2020-07-03'};
const fails = code => error => error.code === code;

test('observed archive index contains all 550 CHIRPS months and 47 files at each GPCC resolution', () => {
  assert.equal(G.describe('chirps_v2_daily').indexedFileCount, 550);
  assert.equal(G.describe('gpcc_monthly_v2025').indexedFileCount, 188);
  for (const resolution of ['0.25', '0.5', '1', '2.5']) {
    const r = G.plan('gpcc_monthly_v2025', {...q, start: '1891-01-01', end: '2026-08-31'}, {resolution});
    assert.equal(r.files.length, 47); assert.equal(r.uncoveredIntervals.length, 0);
  }
});

test('daily CHIRPS returns the observed whole-month file, preserving requested dates and full domain', () => {
  const r = G.plan('chirps_v2_daily', q);
  assert.equal(r.files.length, 1); assert.equal(r.files[0].name, 'chirps-v2.0.2020.07.days_p05.nc');
  assert.equal(r.files[0].start, '2020-07-01'); assert.equal(r.files[0].end, '2020-07-31');
  assert.equal(r.files[0].overlapEnd, q.end); assert.deepEqual(r.query, q);
  assert.deepEqual(r.files[0].domainBounds, [-180, -50, 180, 50]);
  assert.match(r.notes.join(' '), /No polygon clipping/); assert.equal(r.files[0].payloadVerifiedAt, null);
});

test('calendar-month overlap includes leap day and excludes the adjacent nonoverlapping month', () => {
  const r = G.plan('chirps_v2_daily', {...q, start: '1984-02-29', end: '1984-03-01'});
  assert.equal(r.files.length, 2); assert.equal(r.files[0].end, '1984-02-29'); assert.equal(r.files[1].end, '1984-03-31');
  assert.equal(r.uncoveredIntervals.length, 0);
});

test('GPCC separates five-year, four-year and monthly packages and exposes the 1 degree default', () => {
  const r = G.plan('gpcc_monthly_v2025', {...q, start: '2020-12-31', end: '2025-01-15'});
  assert.equal(r.resolution, '1'); assert.equal(r.files.length, 3);
  assert.deepEqual(r.files.map(f => [f.start, f.end]), [['2016-01-01', '2020-12-31'], ['2021-01-01', '2024-12-31'], ['2025-01-01', '2025-01-31']]);
  assert.match(G.describe('gpcc_monthly_v2025').notes.join(' '), /visible default/);
  const fine = G.plan('gpcc_monthly_v2025', q, {resolution: '0.25'});
  assert.match(fine.files[0].url, /025_degree\/.+_025\.nc\.gz$/);
});

test('all selected files remain in the plan without a UI-sized cap', () => {
  const r = G.plan('chirps_v2_daily', {...q, start: '1981-01-01', end: '2026-10-31'});
  assert.equal(r.files.length, 550); assert.equal(new Set(r.files.map(f => f.url)).size, 550);
  assert.equal(r.uncoveredIntervals.length, 0); assert.ok(r.estimatedTotalBytes > 40e9); assert.equal(r.totalBytesApproximate, true);
});

test('unindexed dates are explicit gaps, not guessed URLs or claims of absent provider data', () => {
  const r = G.plan('gpcc_monthly_v2025', {...q, start: '2026-08-15', end: '2026-10-31'});
  assert.equal(r.files.length, 1); assert.deepEqual(r.uncoveredIntervals, [{start: '2026-09-01', end: '2026-10-31'}]);
  assert.equal(r.verification.dateCoverage, 'partially_indexed'); assert.match(r.notes.join(' '), /not that the provider has no data/);
  const old = G.plan('chirps_v2_daily', {...q, start: '1980-01-01', end: '1980-12-31'});
  assert.equal(old.files.length, 0); assert.equal(old.verification.dateCoverage, 'none_indexed');
});

test('full accepted geometry and source are copied without centroid substitution or mutation', () => {
  const area = {mode: 'area', geometry: {type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,1],[0,0]]]}, areaName: 'Project', areaSource: {provider: 'User GeoJSON', rawSha256: 'source'}, bufferKm: 5, start: q.start, end: q.end};
  const r = G.plan('chirps_v2_daily', area); assert.deepEqual(r.query, area);
  r.query.geometry.coordinates[0][0][0] = 12; assert.equal(area.geometry.coordinates[0][0][0], 0);
  assert.equal(r.files[0].start, q.start); assert.deepEqual(r.files[0].domainBounds, [-180, -50, 180, 50]);
});

test('snapshot verification remains separate from individual full-payload checks', () => {
  const r = G.plan('chirps_v2_daily', {...q, start: '1985-06-01', end: '1985-07-01'});
  const checked = r.files[0], uninspected = r.files[1];
  assert.equal(checked.bytes, 75166064); assert.equal(checked.bytesApproximate, false);
  assert.equal(checked.payloadSha256, '9d92d502f7bdca557a0a096d49289831b3a92c4319055643badb1b77b0d346c3');
  assert.ok(checked.payloadVerifiedAt); assert.equal(uninspected.payloadVerifiedAt, null);
  assert.equal(r.verification.mode, 'dated-provider-directory-snapshot');
  assert.match(r.verification.qualification, /not a live availability test/);
});

test('bad dates, future periods, unavailable resolutions and unknown products fail explicitly', () => {
  for (const change of [{start:'2020-02-30'},{start:'0000-01-01'},{start:'2021-01-01'},{end:'2999-01-01'}]) assert.throws(() => G.plan('chirps_v2_daily', {...q,...change}), fails('INPUT'));
  assert.throws(() => G.plan('gpcc_monthly_v2025', q, {resolution:'5'}), fails('INPUT'));
  assert.throws(() => G.plan('era5_t2m', q), fails('UNSUPPORTED'));
});

test('malformed index URL, dates, sizes, verification and duplicates cannot become download links', () => {
  for (const mutate of [
    p => {p.files[0].url = 'https://example.com/unverified.nc';},
    p => {p.files[0].end = '1981-01-30';},
    p => {p.files[0].bytes = -1;},
    p => {p.files[0].metadataCheckedAt = 'not-a-date';},
    p => {p.files[0].payloadVerifiedAt = '2026-11-14T00:00:00Z';},
    p => {p.files.push(clone(p.files[0]));}
  ]) {
    const modified = clone(index); mutate(modified.products.chirps_v2_daily);
    assert.throws(() => G.plan('chirps_v2_daily', q, {index:modified}), fails('INDEX'));
  }
});

test('a missing snapshot fails instead of synthesizing filenames', () => {
  assert.throws(() => G.plan('chirps_v2_daily', q, {index:{schemaVersion:1,products:{}}}), fails('INDEX'));
});

test('original payload metadata confirms daily CHIRPS fields and separate GPCC totals and diagnostics', () => {
  const chirps = require('../docs/evidence/access/chirps-sample-metadata.json');
  const gpcc = require('../docs/evidence/access/gpcc-sample-metadata.json');
  assert.deepEqual(chirps.dimensions, {longitude:7200,latitude:2000,time:30}); assert.equal(chirps.variables.precip.attributes.units, 'mm/day');
  assert.equal(chirps.timeDates[0], '1985-06-01 00:00:00'); assert.equal(chirps.timeDates.at(-1), '1985-06-30 00:00:00');
  assert.equal(gpcc.variables.precip.attributes.units, 'mm/month'); assert.equal(gpcc.variables.precip_infill.attributes.units, 'mm/month');
  assert.equal(gpcc.variables.sys_err.attributes.units, 'multiplier'); assert.equal(gpcc.dimensions.time, 1);
});

test('v3 variants use separate observed URLs even when their filenames match', () => {
  const rnl = G.plan('chirps_v3_daily_rnl', q), sat = G.plan('chirps_v3_daily_sat', q);
  assert.equal(rnl.files[0].name, sat.files[0].name); assert.notEqual(rnl.files[0].url, sat.files[0].url);
  assert.match(rnl.files[0].url, /final\/rnl\/netcdf\/byMonth\//); assert.match(sat.files[0].url, /final\/sat\/netcdf\/byMonth\//);
  assert.deepEqual(rnl.files[0].domainBounds, [-180, -60, 180, 60]); assert.equal(rnl.files[0].variant, 'rnl');
  assert.equal(sat.files[0].variant, 'sat'); assert.ok(rnl.files[0].bytes > 200e6);
});

test('sat monthly route starts June 2000 without erasing the older documentation conflict', () => {
  assert.equal(G.describe('chirps_v3_daily_rnl').indexedFileCount, 550);
  assert.equal(G.describe('chirps_v3_daily_sat').indexedFileCount, 317);
  const r = G.plan('chirps_v3_daily_sat', {...q, start:'1998-01-01', end:'2000-06-02'});
  assert.equal(r.files.length, 1); assert.equal(r.files[0].start, '2000-06-01');
  assert.deepEqual(r.uncoveredIntervals, [{start:'1998-01-01',end:'2000-05-31'}]);
  assert.match(r.notes.join(' '), /1998/); assert.match(r.notes.join(' '), /2001/);
  assert.match(r.notes.join(' '), /not indexed here/);
});

test('v3 payloads independently confirm daily fields and actual earliest monthly-file dates', () => {
  const rnl = require('../docs/evidence/access/chirps-v3-rnl-sample-metadata.json');
  const sat = require('../docs/evidence/access/chirps-v3-sat-sample-metadata.json');
  assert.deepEqual(rnl.dimensions, {longitude:7200,latitude:2400,time:31}); assert.equal(rnl.timeDates[0], '1981-01-01 00:00:00');
  assert.equal(sat.timeDates[0], '2000-06-01 00:00:00'); assert.equal(sat.timeDates.at(-1), '2000-06-30 00:00:00');
  assert.equal(sat.variables.precip.attributes.units, 'mm/day'); assert.equal(sat.payloadReceipt.fullPayloadRetrieved, true);
});

test('a wrong variant URL or identity fails instead of mixing rnl and sat', () => {
  for (const change of [f => {f.variant='sat';}, f => {f.url=f.url.replace('/rnl/','/sat/');}]) {
    const modified=clone(index); change(modified.products.chirps_v3_daily_rnl.files[0]);
    assert.throws(() => G.plan('chirps_v3_daily_rnl', q, {index:modified}), fails('INDEX'));
  }
});
