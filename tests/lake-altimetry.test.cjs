const test=require('node:test');
const assert=require('node:assert/strict');
const access=require('../src/access.js');
const screening=require('../src/screening.js');
const {products}=require('../data/catalog.json');
const {rules}=require('../data/screening.json');
const id='c3s_lake_water_level';
const project={mode:'point',lat:-0.0917,lon:34.768,radiusKm:25,start:'2018-04-01',end:'2018-04-30'};

test('pre-SWOT lake altimetry requires an explicitly monitored lake; the CDS request retrieves its full record',()=>{
  const spec=access.describe(id);
  assert.equal(spec.options[0].choices.filter(c=>c.value).length,311);
  const lakes=spec.options[0].choices.filter(c=>c.value);
  assert.ok(lakes.every(c=>Number.isFinite(c.lat)&&Math.abs(c.lat)<=90&&Number.isFinite(c.lon)&&Math.abs(c.lon)<=180));
  const victoria=lakes.find(c=>c.value==='southern_africa/victoria');
  assert.deepEqual([victoria.label,victoria.lat,victoria.lon],['Victoria',-1,33]);
  assert.ok(project.lon>=victoria.bounds[0]&&project.lon<=victoria.bounds[2]&&project.lat>=victoria.bounds[1]&&project.lat<=victoria.bounds[3]);
  assert.ok(access.prepare(id,project).errors.length);
  assert.ok(access.prepare(id,project,{lakeTarget:'southern_africa/unlisted'}).errors.length);
  const plan=access.prepare(id,project,{lakeTarget:'southern_africa/victoria'});
  assert.deepEqual(plan.errors,[]);
  assert.deepEqual(plan.manifest.requests[0],{dataset:'satellite-lake-water-level',request:{variable:'all',region:['southern_africa'],lake:['victoria']},target:'victoria_water_level.download'});
  assert.ok(plan.artifacts.some(f=>f.name.endsWith('.py')&&f.text.includes('confirm-transfer')));
  assert.match(plan.notes.join(' '),/filter the delivered dates/i);
  const product=products.find(p=>p.product_id===id);
  assert.notEqual(screening.evaluate(product,rules[id],project).status,'possible');
  assert.equal(screening.evaluate(product,rules[id],{...project,start:'1988-01-01',end:'1988-12-31'}).status,'excluded');
});
