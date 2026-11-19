const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const vm = require('node:vm');
const geometry = require('../src/geometry.js');

// A subprocess deadline can catch a synchronous UI freeze; an in-process timer cannot.
for (const id of ['montgomery-md', 'maryland', 'montgomery-multipart']) {
  test(`detailed area screening completes without losing coordinates: ${id}`, () => {
    const code = `
      const assert = require('node:assert/strict');
      const screen = require('./src/screening.js');
      const {products} = require('./data/catalog.json');
      const {rules} = require('./data/screening.json');
      const id = process.argv[1];
      const example = require('./data/geography.json').examples.find(e => e.id === (id === 'montgomery-multipart' ? 'montgomery-md' : id));
      let shape = example.geometry;
      if (id === 'montgomery-multipart') {
        // Explicit synthetic second part, translated from the retained real county boundary.
        const second = shape.coordinates.map(ring => ring.map(([lon, lat]) => [lon + 10, lat]));
        shape = {type:'MultiPolygon', coordinates:[shape.coordinates, second]};
      }
      const query = {mode:'area', geometry:shape, bufferKm:0, start:'2020-07-01', end:'2020-07-03'};
      const original = JSON.stringify(query);
      const start = performance.now();
      const results = screen.evaluateAll(products, rules, query, '2026-11-15');
      assert.equal(results.length, products.length);
      assert.equal(new Set(results.map(r => r.productId)).size, products.length);
      assert.ok(results.every(r => r.label !== 'Check inputs'));
      const byId = Object.fromEntries(results.map(r => [r.productId, r]));
      assert.equal(byId.chirps_v3_daily_rnl.spatialRelation, id==='montgomery-md'?'within':'partial');
      if(id!=='montgomery-md')assert.ok(byId.chirps_v3_daily_rnl.reasons.some(s=>s.includes('valid cells')));
      assert.equal(byId.era5_t2m.status, 'possible');
      assert.equal(byId.trmm_3b42_v7.label, 'Outside documented dates');
      assert.equal(byId.ghcn_daily.label, 'Find a station');
      assert.equal(JSON.stringify(query), original, 'All original coordinates must be retained');
      console.log(JSON.stringify({elapsedMs:performance.now() - start}));
    `;
    const run = spawnSync(process.execPath, ['-e', code, id], {
      cwd:path.join(__dirname, '..'), encoding:'utf8', timeout:10000,
    });
    assert.equal(run.error, undefined, `${id} exceeded the 10-second screening deadline: ${run.error}`);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(JSON.parse(run.stdout).elapsedMs < 10000);
  });
}

test('all 242 bundled countries complete full screening with their original polygon parts', () => {
  const code = `
    const assert = require('node:assert/strict');
    const screen = require('./src/screening.js');
    const {products} = require('./data/catalog.json');
    const {rules} = require('./data/screening.json');
    const {features} = require('./data/country-boundaries.json');
    assert.equal(features.length, 242);
    for (const feature of features) {
      const id = feature.properties.id, original = JSON.stringify(feature.geometry), start = performance.now();
      const results = screen.evaluateAll(products, rules, {mode:'area', geometry:feature.geometry, bufferKm:0, start:'2020-07-01', end:'2020-07-03'}, '2026-11-15');
      assert.equal(results.length, products.length, id);
      assert.ok(results.every(r => r.label !== 'Check inputs'), id);
      assert.ok(results.find(r => r.productId === 'mcd64a1').landCheck.countryIds.includes(id), id + ': exact land check retains the selected country');
      assert.equal(JSON.stringify(feature.geometry), original, id + ': coordinates retained');
      assert.ok(performance.now() - start < 10000, id + ': screening exceeded ten seconds');
    }
  `;
  const run = spawnSync(process.execPath, ['-e', code], {cwd:path.join(__dirname, '..'), encoding:'utf8', timeout:60000});
  assert.equal(run.error, undefined, String(run.error));
  assert.equal(run.status, 0, run.stderr);
});

test('land bounding boxes never replace exact holes, part gaps, touching edges or date-line intersections', () => {
  const polygon = (w,s,e,n) => ({type:'Polygon', coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]});
  const reference = {features:[
    {type:'Feature', properties:{id:'MID'}, geometry:polygon(-1,-1,1,1)},
    {type:'Feature', properties:{id:'PAC'}, geometry:polygon(179.5,-0.5,179.8,0.5)},
  ]};
  const context = {SiteGeometry:geometry, turf:require('../vendor/turf.min.js'), URL, Date,
    InventoryApp:{data:{countryBoundaries:reference}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/screening.js'), 'utf8'), context);
  const product = require('../data/catalog.json').products.find(p => p.product_id === 'mcd64a1');
  const rule = require('../data/screening.json').rules.mcd64a1;
  const cases = [
    ['hole', {type:'Polygon', coordinates:[polygon(-2,-2,2,2).coordinates[0],polygon(-1.5,-1.5,1.5,1.5).coordinates[0]]}, []],
    ['gap between parts', {type:'MultiPolygon', coordinates:[polygon(-5,0,-4,1).coordinates,polygon(4,0,5,1).coordinates]}, []],
    ['crossing', polygon(-2,-0.2,2,0.2), ['MID']],
    ['touching edge', polygon(1,0,2,1), ['MID']],
    ['split date line', geometry.rectangle(179,-1,-179,1), ['PAC']],
  ];
  for (const [name, shape, expected] of cases) {
    const result = context.SiteScreening.evaluate(product, rule, {mode:'area',geometry:shape,bufferKm:0,start:'2020-07-01',end:'2020-07-03'}, '2026-11-15');
    assert.deepEqual(Array.from(result.landCheck.countryIds), expected, name);
    assert.equal(result.landCheck.land, expected.length > 0, name);
  }
});

test('editing a raw area between checks cannot reuse stale validated polygons', () => {
  const screen = require('../src/screening.js');
  const products = require('../data/catalog.json').products.filter(p => p.product_id === 'chirps_v3_daily_rnl');
  const {rules} = require('../data/screening.json');
  const query = {mode:'area',geometry:structuredClone(geometry.rectangle(31,1,31.4,1.4)),bufferKm:0,start:'2020-07-01',end:'2020-07-03'};
  assert.equal(screen.evaluateAll(products,rules,query,'2026-11-15')[0].spatialRelation,'within');
  for (const point of query.geometry.coordinates[0]) point[1] += 70;
  assert.equal(screen.evaluateAll(products,rules,query,'2026-11-15')[0].spatialRelation,'outside');
  query.geometry.coordinates[0][1][1] = 95;
  assert.equal(screen.evaluateAll(products,rules,query,'2026-11-15')[0].label,'Check inputs');
});
