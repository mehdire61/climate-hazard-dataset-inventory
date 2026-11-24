const test = require('node:test');
const assert = require('node:assert/strict');
const {products} = require('../data/catalog.json');
const {rules} = require('../data/screening.json');
const facets = require('../data/discovery.json');
const groups = require('../data/hazard_groups.json');
const sources = require('../data/sources.json');
const screening = require('../src/screening.js');
const access = require('../src/access.js');

// Each case follows the normal screening and access routes for an in-scope site.
const records = [
  ['noaa_atlas14_precip_frequency', /confidence/i],
  ['noaa_atlas15_montana_v1_pilot', /comparison and feedback/i],
  ['era5_single_level_water_balance', /preceding hour/i],
  ['era5_land_water_balance', /00 UTC forecast/i],
  ['prism_conus_daily_ppt', /ending at 12 UTC/i],
  ['daymet_v4r1_daily_prcp', /omit December 31/i],
  ['gridmet_daily_precipitation', /PRISM.*NLDAS-2/i],
  ['nldas2_hourly_forcing_precip', /kg m⁻² for the hour/i],
  ['usdm_weekly_drought', /valid Tuesday/i],
  ['smap_l3_enhanced_surface_moisture', /top 5 cm/i],
  ['smap_l4_surface_rootzone_moisture', /0–100 cm/i],
  ['openet_ensemble_monthly_v2', /et_ensemble_mad/i],
  ['modis_mod16a2gf_actual_et', /5 or 6 days/i],
  ['usgs_groundwater_discrete_levels', /72019/i],
];
for (const [id, distinction] of records) {
  test('reviewed catalog record ' + id, () => {
    const product = products.find(p => p.product_id === id);
    assert.match(JSON.stringify(product), distinction);
    const rule = rules[id];
    assert.deepEqual(groups.filter(g => g.products.includes(id)).map(g => g.id).sort(), [...product.hazard_family].sort());
    for (const [facet, codes] of Object.entries(facets.records[id]))
      for (const code of codes) assert.ok(facets.facets[facet].options[code]);
    assert.ok(product.evidence_ids.every(key => sources.some(s => s.evidence_id === key)));
    const query = {mode:'point', lat:46.6, lon:-112, radiusKm:15, start:'2020-07-01', end:'2020-07-02'};
    const result = screening.evaluate(product,rule,query,'2026-11-23');
    assert.ok(!['Check screening metadata','Check inputs'].includes(result.label),result.label);
    assert.notEqual(result.status,'excluded',result.reasons.join(' '));
    const plan = access.prepare(id,query);
    assert.deepEqual(plan.errors,[]);
    assert.equal(plan.manifest.query.start,query.start);
    if (id.startsWith('noaa_atlas')) assert.equal(result.label,'Choose duration and probability');
    if (id==='daymet_v4r1_daily_prcp') {
      const url = new URL(plan.manifest.requests[0].url);
      assert.equal(url.searchParams.get('readable_granule_name'),'*prcp*');
      assert.equal(screening.evaluate(product,rule,{...query,start:'2020-12-31',end:'2020-12-31'}).status,'excluded');
      assert.equal(screening.evaluate(product,rule,{...query,start:'1960-01-01',end:'1960-01-02'}).status,'excluded');
    }
    if (rule.domain.bounds || rule.domain.regions) {
      const elsewhere = screening.evaluate(product,rule,{...query,lat:-89,lon:70});
      if (rule.domain.kind!=='station' && !product.geographic_coverage.startsWith('Global')) assert.equal(elsewhere.status,'excluded');
    }
  });
}
