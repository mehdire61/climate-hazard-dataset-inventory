// Usage: node tests/inventory-browser.cjs <running inventory URL> [chromium|chrome|msedge|firefox]
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {gunzipSync} = require('node:zlib');
const {chromium, firefox} = require('playwright-core');
const {products} = require('../data/catalog.json');
const groups = require('../data/hazard_groups.json');
const discovery = require('../data/discovery.json');
const {examples} = require('../data/examples.json');

const address = new URL(process.argv[2]);
const browserName = process.argv[3] || 'chromium';
const snowId = 'nrcs_snotel_daily_swe';
const snowName = products.find(p => p.product_id === snowId).product_name;
const snowFragment = '#inventory?record=' + snowId;
const recordURL = new URL(snowFragment, address).href;
const cards = page => page.locator('#results .product-card').evaluateAll(rows => rows.map(row => row.dataset.id));

async function downloadBytes(page, button) {
  const ready = page.waitForEvent('download');
  await button.click();
  const download = await ready;
  const bytes = [];
  for await (const chunk of await download.createReadStream()) bytes.push(chunk);
  return Buffer.concat(bytes);
}

async function exportedRows(page) {
  const bytes = await downloadBytes(page, page.getByRole('button', {name: /Download .* as CSV/}));
  const parser = 'import csv, io, json, sys; print(json.dumps(list(csv.DictReader(io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8-sig", newline="")))))';
  return JSON.parse(execFileSync('python', ['-c', parser], {input: bytes}));
}

async function checkFilters(page) {
  const commercial = page.getByLabel('Commercial use', {exact: true});
  const provider = page.getByLabel('Provider', {exact: true});
  const group = page.getByLabel('Hazard group', {exact: true});
  await page.getByRole('region', {name: 'The inventory', exact: true}).waitFor();
  assert.equal((await cards(page)).length, products.length);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByLabel('Sort records').selectOption({label:'Product Z–A'});
  const statuses = [...new Set(products.map(p => p.commercial_use_status))];
  for (const status of statuses) {
    const expected = products.filter(p => p.commercial_use_status === status);
    await commercial.selectOption(status);
    const visible = await cards(page);
    assert.deepEqual([...visible].sort(), expected.map(p => p.product_id).sort());
    assert.ok((await commercial.locator('option:checked').innerText()).endsWith('(' + expected.length + ')'));
    const rows = await exportedRows(page);
    assert.deepEqual(rows.map(row => row.product_id), visible);
    for (const row of rows) {
      const source = expected.find(p => p.product_id === row.product_id);
      assert.equal(row.commercial_use_status, status);
      assert.equal(row.redistribution_status, source.redistribution_status);
      assert.equal(row.terms_id, source.license_id);
      assert.equal(row.record_fragment, '#inventory?record=' + row.product_id);
    }
  }
  await commercial.selectOption('');
  await group.selectOption('snow');
  const snow = products.filter(p => groups.find(g => g.id === 'snow').products.includes(p.product_id));
  const options = await page.evaluate(() => Array.from(document.querySelector('#provider').options, option => option.value));
  assert.deepEqual(options.filter(Boolean).sort(), [...new Set(snow.map(p => p.provider))].sort());
  await provider.selectOption('USDA NRCS');
  await commercial.selectOption('PERMITTED_WITH_CONDITIONS');
  assert.deepEqual(await cards(page), [snowId]);
  await group.selectOption('temperature');
  assert.equal(await provider.inputValue(), '');
  await page.getByRole('searchbox').fill('no such meteorological product');
  assert.equal((await cards(page)).length, 0);
  assert.equal(await page.locator('#download').isDisabled(), true);
  await page.locator('#clear-empty').click();
  assert.equal((await cards(page)).length, products.length);
}

async function checkSharedInventory(browser) {
  const page = await browser.newPage({viewport:{width:375,height:812}});
  const fresh = await browser.newPage();
  try {
    await page.goto(new URL('#inventory?group=temperature',address).href);
    const temperature = groups.find(g => g.id === 'temperature').products;
    assert.deepEqual((await cards(page)).sort(),[...temperature].sort());
    await page.getByLabel('Sort records').selectOption('product:-1');
    const order = await cards(page);
    assert.ok(order.length > 1);
    if (browserName !== 'firefox') {
      await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:address.origin});
      await page.getByRole('button',{name:'Copy filtered view'}).click();
      await page.locator('#view-status').filter({hasText:/view link copied/i}).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()),page.url());
    }
    // An independent browser context also exercises the manual-copy fallback.
    await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true}));
    const manual = page.getByRole('textbox',{name:'Filtered view URL to copy'});
    await page.getByRole('button',{name:'Copy filtered view'}).click();
    await fresh.goto(await manual.inputValue());
    assert.deepEqual(await cards(fresh),order);
    assert.deepEqual((await exportedRows(fresh)).map(r => r.product_id),order);
    const shared = fresh.url();
    await fresh.locator('#results .card-open').first().click();
    await fresh.getByRole('dialog').getByRole('button',{name:'Close record details'}).click();
    await fresh.waitForURL(shared);
    assert.deepEqual(await cards(fresh),order);
    await fresh.goForward();
    await fresh.getByRole('dialog').waitFor();
    await fresh.goBack();
    await fresh.waitForURL(shared);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);

    await page.locator('#group').selectOption('drought');
    await page.locator('#provider').selectOption('Ghent University / GLEAM');
    await page.locator('#commercial').selectOption('UNKNOWN');
    await page.locator('#search').fill('actual evapotranspiration');
    await page.getByRole('button',{name:'Copy filtered view'}).click();
    await fresh.goto(await manual.inputValue());
    await fresh.reload();
    assert.deepEqual(await cards(fresh),['gleam_v4_2a_actual_evaporation']);
    for (const id of ['group','provider','commercial','search','sort']) {
      assert.equal(await fresh.locator('#'+id).inputValue(),await page.locator('#'+id).inputValue());
    }
    const emptySearch = 'snow + heat? & 50%';
    await page.locator('#search').fill(emptySearch);
    await page.waitForURL(url => new URLSearchParams(url.hash.slice('#inventory?'.length)).get('q') === emptySearch);
    await fresh.goto(page.url());
    await fresh.locator('#no-results').waitFor();
    assert.equal(await fresh.locator('#search').inputValue(),emptySearch);
    assert.deepEqual(await cards(fresh),[]);
    assert.equal(await fresh.locator('#download').isDisabled(),true);
    await fresh.goto(new URL('#inventory?group=retired&sort=missing',address).href);
    await fresh.locator('#view-status').filter({hasText:/Unavailable selections/}).waitFor();
    assert.equal((await cards(fresh)).length,products.length);
    assert.equal(await fresh.locator('#sort').inputValue(),'product:1');
  } finally {
    await fresh.close();
    await page.close();
  }
}

async function checkPublishedWorkflows(context) {
  const baseline = require('./fixtures/inventory-v02.json');
  const priorIds = new Set(baseline.productIds);
  const page = await context.newPage();
  try {
    await page.goto(new URL('#inventory',address).href);
    const originalRows = ids => ids.filter(id=>priorIds.has(id));
    assert.deepEqual(originalRows(await cards(page)),baseline.productIds);
    for (const sample of baseline.cases) {
      await page.locator('#clear').click();
      await page.locator('#group').selectOption(sample.group);
      if (sample.provider) await page.locator('#provider').selectOption(sample.provider);
      await page.locator('#search').fill(sample.query);
      await page.locator('#sort').selectOption(sample.sort);
      const visible = await cards(page);
      assert.deepEqual(originalRows(visible),sample.ids,sample.group+' legacy results');
      assert.deepEqual((await exportedRows(page)).map(r=>r.product_id),visible,sample.group+' CSV');
      await page.reload();
      assert.deepEqual(await cards(page),visible,sample.group+' reopened view');
    }
    await page.goto(new URL('#site-check',address).href);
    await page.locator('.sc-project-tools summary').click();
    await page.locator('#sc-project-file').setInputFiles({name:'published-v02.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(baseline.project))});
    await page.locator('.sc-project-message').filter({hasText:/Project opened/}).waitFor();
    const saved=JSON.parse(await downloadBytes(page,page.getByRole('button',{name:'Download project file'})));
    for (const key of ['schema','query','selectedId','hazard']) assert.deepEqual(saved[key],baseline.project[key],key);
    assert.equal(saved.inventoryBuild.version,'v0.3');
  } finally {await page.close();}
}

async function checkDiscoveryFilters(browser) {
  const page = await browser.newPage({viewport:{width:375,height:812}});
  const fresh = await browser.newPage();
  try {
    await page.goto(new URL('#inventory',address).href);
    await page.getByText('More filters',{exact:true}).click();
    for (const [key,facet] of Object.entries(discovery.facets)) {
      const select = page.getByLabel(facet.label,{exact:true});
      for (const code of Object.keys(facet.options)) {
        await select.selectOption(code);
        const expected = products.filter(p=>discovery.records[p.product_id][key].includes(code)).map(p=>p.product_id);
        assert.deepEqual((await cards(page)).sort(),expected.sort(),key+'='+code);
        assert.ok((await select.locator('option:checked').innerText()).endsWith('('+expected.length+')'));
        assert.ok((await select.locator('option').first().innerText()).endsWith('('+products.length+')'));
      }
      await select.selectOption('');
    }
    const choices={origin:'model',lifecycle:'maintained',spatial:'grid-1-10km',frequency:'daily',geography:'conus'};
    for(const [key,code] of Object.entries(choices)) await page.locator('#'+key).selectOption(code);
    assert.deepEqual(await cards(page),['nohrsc_snodas_daily_swe']);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true}));
    await page.getByRole('button',{name:'Copy filtered view'}).click();
    const shared=await page.getByRole('textbox',{name:'Filtered view URL to copy'}).inputValue();
    await fresh.goto(shared);
    assert.deepEqual(await cards(fresh),['nohrsc_snodas_daily_swe']);
    assert.equal(await fresh.locator('#more-filters').evaluate(el=>el.open),true);
    const [row]=await exportedRows(fresh);
    for(const [key,code] of Object.entries(choices)) {
      assert.equal(await fresh.locator('#'+key).inputValue(),code);
      assert.ok(row['filter_'+key].split(' | ').includes(discovery.facets[key].options[code]));
    }
    await fresh.locator('#results .card-open').click();
    await fresh.getByText('Version, access and data dependencies',{exact:true}).click();
    await fresh.getByRole('heading',{name:'Inventory classifications'}).waitFor();
    await fresh.getByRole('button',{name:'Close record details'}).click();
    await fresh.waitForURL(shared);
    assert.deepEqual(await cards(fresh),['nohrsc_snodas_daily_swe']);
    await fresh.goto(new URL('#inventory?lifecycle=stream-ended',address).href);
    assert.deepEqual((await cards(fresh)).sort(),['gfed4_1s_legacy','viirs_375_active_fire']);
    await fresh.goto(new URL('#inventory?origin=model&frequency=return-period&geography=conus',address).href);
    await fresh.locator('#no-results').waitFor();
    assert.equal(await fresh.locator('#download').isDisabled(),true);
    await fresh.locator('#clear-empty').click();
    assert.equal((await cards(fresh)).length,products.length);
    await fresh.goto(new URL('#inventory?lifecycle=ended&origin=obsolete',address).href);
    await fresh.locator('#view-status').filter({hasText:/Unavailable selections.*origin/}).waitFor();
    assert.deepEqual((await cards(fresh)).sort(),['gpm_imerg_final_v07b','isd_global_hourly','trmm_3b42_v7']);
  } finally { await fresh.close(); await page.close(); }
}

async function checkRecord(page, context) {
  const dialog = page.getByRole('dialog');
  const snowLink = page.getByRole('link', {name: 'View details for ' + snowName});
  await snowLink.click();
  assert.equal(page.url(), recordURL);
  await dialog.getByRole('heading', {name: snowName, exact:true}).waitFor();
  if (browserName !== 'firefox') {
    await context.grantPermissions(['clipboard-read','clipboard-write'], {origin: address.origin});
    await dialog.getByRole('button', {name:'Copy record link'}).click();
    await dialog.getByRole('status').filter({hasText:'link copied'}).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), recordURL);
  }
  await page.goBack();
  await dialog.waitFor({state:'hidden'});
  await page.goForward();
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden'});
  assert.equal(await snowLink.evaluate(link => link === document.activeElement), true);

  const direct = await context.newPage();
  try {
    const incoming = new URL(recordURL);
    incoming.searchParams.set('utm_source','review');
    await direct.goto(incoming.href);
    await direct.getByRole('dialog').getByRole('heading', {name:snowName, exact:true}).waitFor();
    await direct.reload();
    const reopened = direct.getByRole('dialog');
    await reopened.waitFor();
    await direct.evaluate(() => Object.defineProperty(navigator, 'clipboard', {value:undefined, configurable:true}));
    await reopened.getByRole('button', {name:'Copy record link'}).click();
    const field = reopened.getByRole('textbox', {name:'Record URL to copy'});
    assert.equal(await field.inputValue(), recordURL);
    assert.equal(await field.evaluate(e => e.selectionEnd - e.selectionStart), recordURL.length);
    await reopened.getByRole('button', {name:'Close record details'}).click();
    await reopened.waitFor({state:'hidden'});
    assert.equal(new URL(direct.url()).hash, '#inventory');
    await direct.goto(new URL('#inventory?record=unknown_record_id',address).href);
    await direct.locator('#unknown-record').waitFor();
    assert.equal(await reopened.isVisible(), false);
    await direct.goto(new URL('#inventory?record=gleam_v4_2a_actual_evaporation',address).href);
    await reopened.getByRole('heading',{name:'GLEAM v4.2a · actual evapotranspiration',exact:true}).waitFor();
    assert.ok(await reopened.locator('a[href="https://zenodo.org/records/14724263"]').count());
    assert.match(await reopened.textContent(),/approval for commercial use/);
  } finally {
    await direct.close();
  }
  await snowLink.click();
  await dialog.getByRole('button', {name:'Check this record at a site'}).click();
  await page.locator('#sc-detail').getByRole('heading', {name:snowName, exact:true}).waitFor();
}

async function checkProjectReturn(page) {
  await page.getByRole('button', {name:'USGS streamflow', exact:true}).click();
  const example = page.getByRole('region', {name:'Retrieved data preview'});
  await example.waitFor();
  const original = await example.innerText();
  await page.locator('.sc-project-tools summary').click();
  await page.getByRole('button', {name:'Create project link'}).click();
  await page.waitForURL(url => url.hash.startsWith('#site-check?project='));
  const projectURL = page.url();
  await page.getByRole('button', {name:'View full inventory record'}).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(new URL(page.url()).hash, '#inventory?record=usgs_streamflow');
  await page.getByRole('button', {name:'Close record details'}).click();
  await page.waitForURL(projectURL);
  await example.waitFor();
  assert.equal(await example.innerText(), original);
}

async function checkOffline(browser) {
  const context = await browser.newContext({offline:true});
  try {
    const page = await context.newPage();
    const entry = require('node:url').pathToFileURL(require('node:path').resolve(__dirname, '../index.html'));
    await page.goto(new URL(snowFragment,entry).href);
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', {name:snowName, exact:true}).waitFor();
    assert.equal(await dialog.locator('.swe-inspected strong').innerText(),'609 mm');
    await dialog.getByRole('button', {name:'Close record details'}).click();
    await page.getByLabel('Hazard group', {exact:true}).selectOption('snow');
    await page.getByRole('link', {name:'View details for ' + snowName}).click();
    await dialog.waitFor();
    assert.equal(page.url(), new URL(snowFragment,entry).href);
    const filtered = await context.newPage();
    await filtered.goto(new URL('#inventory?group=snow',entry).href);
    assert.deepEqual((await cards(filtered)).sort(),[...groups.find(g => g.id === 'snow').products].sort());
  } finally {
    await context.close();
  }
}

async function checkObservationGap(page) {
  const saved = examples.find(example => example.productId === 'ghcn_daily');
  // Remove the middle day from a preserved NOAA response to create a known gap.
  const rows = JSON.parse(saved.result.rawText).filter(row => row.DATE !== '2020-07-02');
  const raw = JSON.stringify(rows);
  await page.route('https://www.ncei.noaa.gov/access/services/data/v1?*', route =>
    route.fulfill({contentType:'application/json', body:raw}));
  await page.getByRole('button', {name:'GHCN-Daily', exact:true}).click();
  await page.getByText('Change station', {exact:true}).click();
  await page.getByRole('button', {name:'Retrieve 3-day preview', exact:true}).click();
  const preview = page.getByRole('region', {name:'Retrieved data preview'});
  await preview.getByText('Live provider response', {exact:true}).waitFor();
  await preview.getByRole('button', {name:'Daily maximum temperature', exact:true}).click();
  const chart = preview.locator('.sc-chart');
  const gap = chart.locator('[data-missing="absent timestamp"]');
  assert.match(await gap.locator('title').textContent(), /2020-07-02/);
  assert.equal(await chart.locator('[data-observation-line]').count(), 0);
  const marks = chart.locator('[data-observation]');
  assert.equal(await marks.count(), rows.length);
  for (const [index, row] of rows.entries()) {
    assert.equal(await marks.nth(index).getAttribute('data-time'), row.DATE);
  }
  await preview.getByRole('button', {name:'Daily precipitation', exact:true}).click();
  assert.equal(await chart.getAttribute('data-chart-kind'), 'bars');
  assert.match(await chart.locator('.sc-chart-completeness').innerText(), /2 of 3 days/);
  assert.equal(await chart.locator('[data-zero="true"]').getAttribute('data-time'), '2020-07-03');
  assert.match(await gap.locator('title').textContent(), /2020-07-02/);
  const bytes = await downloadBytes(page, preview.getByRole('button', {name:'Download original JSON'}));
  assert.deepEqual(bytes, Buffer.from(raw));
}

async function checkHydrologicUnit(context) {
  const raw = gunzipSync(readFileSync(join(__dirname,'fixtures/wbd/pimmit-huc12-screening.geojson.gz')));
  const attrs = JSON.parse(raw).features[0].properties;
  const points = [];
  const page = await context.newPage();
  try {
    await page.route('https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer/6/query?*', route => {
      const params = new URL(route.request().url()).searchParams;
      if (params.has('geometry')) {
        points.push(params.get('geometry'));
        const features = points.at(-1)==='0,0' ? [] : [{attributes:attrs},{attributes:{...attrs,huc12:'020700100104',name:'Adjacent unit'}}];
        return route.fulfill({json:{features}});
      }
      if (params.get('where')?.startsWith('UPPER(name)')) return route.fulfill({status:503,body:'Service unavailable'});
      if (params.get('f')==='geojson' && params.get('where')?.includes('020700100104')) return route.fulfill({status:503,body:'Service unavailable'});
      const body = params.get('f') === 'geojson' ? raw : JSON.stringify({features:[{attributes:attrs}]});
      return route.fulfill({contentType:'application/json',body});
    });
    await page.goto(new URL('#site-check',address).href);
    await page.locator('#sc-mode').selectOption('area');
    assert.equal(await page.getByLabel('Choose area source').inputValue(),'huc');
    assert.equal(await page.getByLabel('Hydrologic unit level').inputValue(),'huc12');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    await page.getByLabel('Hydrologic unit name or code').fill('Pimmit Run');
    await page.getByRole('button',{name:'Find boundaries',exact:true}).click();
    await page.getByText(/Try the complete HUC code or choose a location on the map/).waitFor();
    await page.getByLabel('Hydrologic unit name or code').fill(attrs.huc12);
    await page.getByRole('button',{name:'Find boundaries',exact:true}).click();
    await page.getByLabel('Boundary search results').selectOption({label:'HUC12 020700100103 · Pimmit Run-Potomac River (DC,MD,VA)'});
    await page.getByText('Boundary accepted. Check site to apply it.',{exact:true}).waitFor();
    await page.locator('#sc-run').click();
    await page.getByText('Boundary applied to this site check.',{exact:true}).waitFor();
    await page.locator('#sc-huc-location summary').click();
    assert.equal(await page.locator('#sc-huc-lat').inputValue(),'');
    await page.locator('#sc-huc-find').click();
    await page.getByText(/Enter latitude from/).waitFor();
    assert.deepEqual(points,[]);
    await page.locator('#sc-huc-pick').click();
    await page.locator('#sc-project-map').press('Escape');
    assert.equal(await page.locator('#sc-huc-pick').getAttribute('aria-pressed'),'false');
    await page.locator('#sc-huc-pick').click();
    await page.locator('#sc-project-map').click({position:{x:130,y:106}});
    await page.getByText(/2 matches at/).waitFor();
    const coordinate = async axis => Number(await page.locator('#sc-huc-'+axis).inputValue());
    assert.equal(points.at(-1),[await coordinate('lon'),await coordinate('lat')].join(','));
    assert.notEqual(points.at(-1),'-77.04,38.9');
    assert.equal(await page.locator('#sc-area-match').inputValue(),'');
    assert.equal(await page.locator('#sc-mode').inputValue(),'area');
    assert.equal(await page.locator('.sc-huc-pin').count(),1);
    await page.locator('#sc-area-match').selectOption('1');
    await page.getByText(/Boundary not loaded/).waitFor();
    assert.match(await page.locator('.sc-area-name').innerText(),/Pimmit/);
    await page.locator('#sc-huc-lat').fill('0');
    await page.locator('#sc-huc-lon').fill('0');
    await page.locator('#sc-huc-lon').press('Enter');
    await page.getByText(/0 matches at 0°, 0°/).waitFor();
    assert.equal(points.at(-1),'0,0');
    assert.equal(await page.locator('#sc-area-match').count(),0);
    assert.match(await page.locator('.sc-area-name').innerText(),/Pimmit/);
    assert.equal(await page.locator('.sc-input-change').isVisible(),false);
    await page.getByRole('button',{name:'All datasets',exact:true}).click();
    await page.locator('.sc-project-tools summary').click();
    await page.getByRole('button',{name:'Create project link'}).click();
    await page.locator('.sc-project-message').filter({hasText:/project file/i}).waitFor();
    const projectBytes = await downloadBytes(page,page.getByRole('button',{name:'Download project file'}));
    const project = JSON.parse(projectBytes);
    assert.equal(project.query.areaSource.id,attrs.huc12);
    assert.equal(project.query.areaSource.maxAllowableOffsetDegrees,0.00001);
    const csvButton = page.getByRole('button',{name:'Download screening results (CSV)'});
    const csv = (await downloadBytes(page,csvButton)).toString('utf8');
    assert.ok(csv.includes('HUC code') && csv.includes(attrs.huc12) && csv.includes(project.query.areaSource.geometrySha256));
    await page.locator('#sc-project-file').setInputFiles({name:'reopen.json',mimeType:'application/json',buffer:projectBytes});
    await page.locator('.sc-area-selection').getByText(/saved polygon is used exactly as supplied/i).waitFor();
    const reopened = JSON.parse(await downloadBytes(page,page.getByRole('button',{name:'Download project file'})));
    assert.deepEqual(reopened.query.geometry,project.query.geometry);
    assert.equal(reopened.query.areaSource.hucKind,'huc12');
    assert.equal(reopened.query.areaSource.kind,'project-link');
  } finally {
    await page.close();
  }
}

async function checkFloodDepth(context) {
  const page = await context.newPage();
  try {
    await page.goto(new URL('#inventory?record=jrc_glofas_rp100_depth',address).href);
    await page.getByRole('dialog').getByRole('button',{name:'Check this record at a site'}).click();
    await page.getByRole('button',{name:'Show download files'}).click();
    const row = page.locator('.sc-file-row');
    await row.getByRole('heading',{name:'ID55_N40_W80_RP100_depth.tif'}).waitFor();
    const url = await row.getByRole('link',{name:/Download \/ open data/}).getAttribute('href');
    assert.match(url,/\/RP100\/ID55_N40_W80_RP100_depth\.tif$/);
    const manifest = JSON.parse(await downloadBytes(page,page.getByRole('button',{name:'Save all 1 file links + manifest'})));
    assert.deepEqual(manifest.files.map(f=>f.url),[url]);
  } finally { await page.close(); }
}

async function checkSnowMap(context) {
  const example = require('../data/brundage-swe.json');
  const page = await context.newPage();
  try {
    await page.goto(new URL('#inventory?record=nohrsc_snodas_daily_swe',address).href);
    const chart = page.locator('dialog .swe-example'), svg = chart.locator('svg');
    const reading = chart.locator('.swe-inspected strong');
    assert.equal(await reading.innerText(),'609 mm');
    assert.match(await chart.locator('.swe-position').innerText(),/row 939, col 1032/);
    assert.ok((await chart.innerText()).includes('24.0 in (609.6 mm)'));
    await chart.locator('[aria-label="Inspect cell east"]').press('Enter');
    assert.match(await chart.locator('.swe-position').innerText(),/row 939, col 1033/);
    const cells = example.grid.values;
    for (const [wanted,label] of [[0,'0 mm'],[null,'No data']]) {
      const row = cells.findIndex(values=>values.includes(wanted)), col=cells[row].indexOf(wanted);
      const size = await svg.boundingBox();
      await svg.click({position:{x:(col+.5)*size.width/cells[row].length,y:(row+.5)*size.height/cells.length}});
      assert.equal(await reading.innerText(),label);
    }
    await chart.getByRole('button',{name:'Station cell',exact:true}).click();
    assert.equal(await reading.innerText(),'609 mm');
    assert.equal(await chart.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    await page.locator('dialog').getByRole('button',{name:'Check this record at a site'}).click();
    await page.getByText('Explore the Brundage snow map example',{exact:true}).click();
    assert.equal(await page.locator('#sc-detail .swe-inspected strong').innerText(),'609 mm');
  } finally {await page.close();}
}

async function checkGriddedSnow(context) {
  const page = await context.newPage();
  try {
    await page.goto(new URL('#inventory?record=nohrsc_snodas_daily_swe',address).href);
    await page.getByRole('dialog').getByRole('button',{name:'Check this record at a site'}).click();
    await page.getByRole('button',{name:'Show download steps'}).click();
    await page.getByText('Optional project records and request details',{exact:true}).click();
    const manifest=JSON.parse(await downloadBytes(page,page.getByRole('button',{name:'Save access manifest'})));
    assert.equal(manifest.productId,'nohrsc_snodas_daily_swe');
    assert.equal(manifest.requests.length,3);
    assert.match(manifest.requests[0].url,/\/masked\/2020\/07_Jul\/SNODAS_20200701\.tar$/);
    assert.equal(manifest.transferSummary.unknownCount,3);
  } finally { await page.close(); }
}

async function checkStationSnow(context) {
  const page=await context.newPage();
  try {
    await page.goto(new URL(snowFragment,address).href);
    await page.getByRole('dialog').getByRole('button',{name:'Check this record at a site'}).click();
    for(const [key,value] of Object.entries({lat:'45.04315',lon:'-116.13253',radius:'0',start:'2024-04-01',end:'2024-04-03'})) {
      await page.locator('#sc-'+key).fill(value);
    }
    await page.locator('#sc-run').click();
    await page.getByText(/^Browse or filter \d+ sources$/).click();
    await page.locator('[data-product="nrcs_snotel_daily_swe"]').click();
    const select=page.locator('#sc-access-option-stationTriplet');
    assert.equal(await select.evaluate(el=>el.labels[0].textContent),'SNOTEL station');
    assert.deepEqual(await select.locator('option').evaluateAll(opts=>opts.map(o=>o.value)),['','370:ID:SNTL']);
    await select.focus();
    await select.press('ArrowDown');
    await page.keyboard.press('Tab');
    assert.equal(await select.inputValue(),'370:ID:SNTL');
    await page.getByRole('button',{name:'Show download steps'}).click();
    const link=page.getByRole('link',{name:/Open daily SWE/});
    const href=await link.getAttribute('href');
    const expected=require('../docs/evidence/snotel/receipts.json').find(r=>r.file==='brundage-daily-wteq.json');
    assert.equal(href,expected.url);
    await page.getByText('Optional project records and request details',{exact:true}).click();
    const manifest=JSON.parse(await downloadBytes(page,page.getByRole('button',{name:'Save access manifest'})));
    assert.equal(manifest.station.id,'370:ID:SNTL');assert.equal(manifest.requests[0].url,href);
    await page.locator('#sc-end').fill('2024-04-04');
    assert.equal(await link.isVisible(),false);
  } finally { await page.close(); }
}

async function checkVerticalReference(context) {
  const page=await context.newPage();
  try {
    for(const [id,expected] of [['usgs_hwm_harvey_2017','NAVD 88'],['psmsl_rlr','Revised Local Reference'],
      ['swot_raster_d','EGM2008'],['jrc_glofas_rp100_depth','modeled ground']]){
      await page.goto(new URL('#inventory?record='+id,address).href);
      const section=page.getByRole('dialog').locator('section').filter({has:page.getByRole('heading',{name:'Vertical reference',exact:true})});
      assert.ok((await section.innerText()).includes(expected));
      assert.ok(await section.getByRole('link').count());
    }
  } finally {await page.close();}
}

async function checkComparison(browser) {
  const page=await browser.newPage({viewport:{width:375,height:812}});
  const fresh=await browser.newPage();
  try {
    const ids=['chirps_v3_daily_rnl','gpm_imerg_final_v07b','gpcc_monthly_v2025'];
    const selected=ids.map(id=>products.find(p=>p.product_id===id));
    await page.goto(new URL('#inventory?group=precipitation',address).href);
    await page.locator('#results [data-id="'+ids[0]+'"] .compare-check').check();
    await page.locator('#comparison summary').click();
    assert.equal(await page.locator('#copy-comparison').isDisabled(),true);
    for(const id of ids.slice(1))await page.getByLabel('Add a dataset').selectOption(id);
    const table=page.locator('#compare-table');
    const periods=page.locator('#compare-periods');
    assert.deepEqual(await periods.locator('[data-product] h4').allTextContents(),selected.map(p=>p.product_name));
    assert.match(await periods.locator('.period-shared').innerText(),/1998-01-01 → 2025-09-30/);
    assert.ok((await periods.locator('[data-product="chirps_v3_daily_rnl"]').innerText()).includes('Last listed file'));
    assert.ok((await periods.locator('[data-product="gpm_imerg_final_v07b"]').innerText()).includes('2025-09-30'));
    assert.equal(await periods.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    assert.equal(await table.getAttribute('aria-label'),'Dataset comparison');
    const readRow=label=>table.locator('tbody tr').evaluateAll((rows,key)=>{
      const match=rows.find(row=>row.querySelector('th[scope="row"]')?.textContent===key);
      return Array.from(match?.querySelectorAll('td')||[],cell=>cell.textContent);
    },label);
    assert.deepEqual(await readRow('Temporal scale'),selected.map(p=>p.temporal_support));
    assert.deepEqual(await readRow('Shared inputs and dependence'),selected.map(p=>p.dependence_notes));
    assert.ok((await readRow('Terms of use')).every((text,i)=>text.includes(selected[i].license_notes)));
    assert.equal(await table.evaluate(el=>el.scrollWidth>el.clientWidth),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.locator('#group').selectOption('snow');
    assert.equal(await table.locator('thead th[scope="col"]').count(),4);
    await page.getByLabel('Add a dataset').selectOption('nohrsc_snodas_daily_swe');
    assert.equal(await page.getByLabel('Add a dataset').isDisabled(),true);
    assert.equal(await page.locator('#results [data-id="nrcs_snotel_daily_swe"] .compare-check').isDisabled(),true);
    await page.getByRole('button',{name:/Remove SNODAS daily gridded/}).click();
    assert.equal(await page.getByLabel('Add a dataset').isDisabled(),false);
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true}));
    await page.getByRole('button',{name:'Copy comparison link'}).click();
    const url=await page.getByRole('textbox',{name:'Filtered view URL to copy'}).inputValue();
    await fresh.goto(url);
    assert.deepEqual(await fresh.locator('#compare-table thead a').allTextContents(),selected.map(p=>p.product_name));
    await fresh.locator('#compare-table thead a').first().click();
    await fresh.getByRole('dialog').getByRole('button',{name:'Close record details'}).click();
    await fresh.waitForURL(url);
    assert.equal(await fresh.locator('#compare-table tbody tr').count()>0,true);
    await fresh.goto(new URL('#inventory?compare=psmsl_rlr,jrc_glofas_rp100_depth,psmsl_rlr,unlisted',address).href);
    assert.equal(await fresh.locator('#compare-periods .period-track').count(),0);
    assert.match(await fresh.locator('#compare-periods').innerText(),/100-year flood scenario/);
    assert.equal(await fresh.locator('#compare-table thead a').count(),2);
    await fresh.locator('#view-status').filter({hasText:/Unavailable selections.*compare/}).waitFor();
    assert.ok((await fresh.locator('#compare-table').innerText()).includes('Revised Local Reference'));
    await fresh.getByRole('button',{name:/Remove JRC global river flood depth/}).click();
    assert.equal(await fresh.locator('#compare-table').isVisible(),false);
    assert.equal(await fresh.locator('#compare-periods').isVisible(),false);
  } finally {await fresh.close();await page.close();}
}

async function main() {
  const browser = browserName === 'firefox' ? await firefox.launch() :
    await chromium.launch(browserName === 'chromium' ? {} : {channel:browserName});
  try {
    const context = await browser.newContext({viewport:{width:375,height:812}});
    const errors = [];
    context.on('weberror', e => errors.push(e.error().message));
    const page = await context.newPage();
    await page.goto(new URL('#inventory',address).href);
    await checkFilters(page);
    await checkRecord(page,context);
    await page.setViewportSize({width:1280,height:850});
    await checkProjectReturn(page);
    await checkObservationGap(page);
    await checkHydrologicUnit(context);
    await checkSnowMap(context);
    await checkFloodDepth(context);
    await checkGriddedSnow(context);
    await checkStationSnow(context);
    await checkVerticalReference(context);
    await checkSharedInventory(browser);
    await checkPublishedWorkflows(context);
    await checkDiscoveryFilters(browser);
    await checkComparison(browser);
    assert.deepEqual(errors, []);
    await context.close();
    await checkOffline(browser);
    console.log(browserName, browser.version(), 'passed discovery filters, comparison and sharing, HUC12 selection/export/reopen, flood tiles, station and gridded snow, vertical references, project return, charts, mobile layout, CSV and offline checks.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
