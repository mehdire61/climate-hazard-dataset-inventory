const assert = require('node:assert/strict');

module.exports = async function checkReviewWorkflows(context,address,downloadBytes) {
  const page=await context.newPage();
  const openRecord=id=>page.goto(new URL('#inventory?record='+id,address).href);
  async function atSite(id) {
    await openRecord(id);
    await page.getByRole('button',{name:'Check this record at a site'}).click();
    await page.waitForFunction(()=>document.activeElement.id==='sc-detail');
  }
  try {
    await page.setViewportSize({width:1180,height:900});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.goto(new URL('#inventory',address).href);
    for(const search of ['NetCDF','NAVD88','NAVD 88','usgs_groundwater_discrete_levels']) {
      await page.locator('#search').fill(search);
      assert.ok(await page.locator('#results .product-card').count(),search);
    }
    await page.locator('#search').fill('');
    for(const direction of [1,-1]) {
      await page.locator('#sort').selectOption('temporal:'+direction);
      const dates=await page.locator('#results .product-card').evaluateAll(cards=>{
        const rules=window.InventoryApp.data.screening.rules;
        return cards.map(card=>rules[card.dataset.id].time.intervals.map(i=>i.start).filter(Boolean).sort()[0]||'');
      });
      const known=dates.filter(Boolean);
      assert.deepEqual(dates.slice(0,known.length),direction===1?[...known].sort():[...known].sort().reverse());
      assert.equal(dates.at(-1),'');
    }
    await openRecord('mrms_mesh');
    assert.equal(await page.getByRole('dialog').getByText('NOAA_NODD_OPEN_DATA',{exact:true}).count(),1);
    const searches={cmr:0,stac:0};
    await page.route('https://cmr.earthdata.nasa.gov/search/granules.json?**',route=>{
      searches.cmr++;
      const collection=new URL(route.request().url()).searchParams.get('collection_concept_id');
      return route.fulfill({headers:{'CMR-Hits':'1','Access-Control-Expose-Headers':'CMR-Hits'},json:{feed:{entry:[{
        id:'G1-GES_DISC',collection_concept_id:collection,title:'Review granule',time_start:'2020-07-01T00:00:00Z',
        time_end:'2020-07-01T00:30:00Z',links:[{rel:'http://esipfed.org/ns/fedsearch/1.1/data#',href:'https://example.org/review-granule.hdf'}]
      }]}}});
    });
    await page.route('https://stac.eodc.eu/**',route=>{
      searches.stac++;
      return route.fulfill({json:{type:'FeatureCollection',numberMatched:1,links:[],features:[{id:'review-scene',
        collection:'GFM',properties:{datetime:'2020-07-01T01:00:00Z'},bbox:[-78,38,-76,40],assets:{
          ensemble_flood_extent:{href:'https://data.eodc.eu/review-extent.tif',roles:['data']},
          exclusion_mask:{href:'https://data.eodc.eu/review-mask.tif',roles:['data']}
        }}]}});
    });
    const ids=['gpm_imerg_final_v07b','cems_gfm'];
    for(const id of ids) {
      await atSite(id);
      assert.ok((await page.locator('#sc-detail').boundingBox()).y<900);
      await page.locator('#sc-prepare-access').click();
      await page.locator('.sc-file-list a').first().waitFor({state:'attached'});
    }
    const counts={...searches};
    for(const [index,id] of ids.entries()) {
      await atSite(id);
      assert.match(await page.locator('#sc-prepare-access').innerText(),/Start a new file search/);
      assert.ok(await page.locator('.sc-file-list a').count()>index);
    }
    assert.deepEqual(searches,counts);
    await page.locator('#sc-start').fill('2019-01-01');
    await page.locator('#sc-end').fill('2019-01-03');
    await page.locator('#sc-run').click();
    await atSite(ids[0]);
    assert.equal(await page.locator('.sc-file-list').count(),0);
    await page.getByRole('button',{name:'CO-OPS water level',exact:true}).click();
    const preview=page.locator('.sc-sample');
    await preview.locator('#sc-coops-product').waitFor();
    await preview.locator('#sc-coops-datum').waitFor();
    const other=await preview.locator('#sc-coops-datum').evaluate(select=>[...select.options].find(o=>!o.disabled && o.value!==select.value)?.value);
    if(other) {
      await preview.locator('#sc-coops-datum').selectOption(other);
      assert.equal(await preview.count(),0);
      assert.equal(await page.locator('#sc-coops-datum').inputValue(),other);
    }
    await page.setViewportSize({width:390,height:844});
    for(const name of ['View results','Download screening brief (HTML)']) assert.ok((await page.getByRole('button',{name,exact:true}).boundingBox()).height>=44);
    await page.locator('#sc-lat').fill('51.5');
    await page.locator('#sc-lon').fill('-0.12');
    await page.locator('#sc-run').click();
    await page.getByRole('button',{name:/Severe thunderstorms/i}).first().click();
    const brief=await downloadBytes(page,page.getByRole('button',{name:'Download screening brief (HTML)'}));
    assert.match(brief.toString(),/colspan="2">No starting-point datasets identified/);
  } finally {await page.close();}
};
