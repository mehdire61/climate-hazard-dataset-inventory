// Usage: node tests/inventory-browser.cjs <running inventory URL> [chromium|chrome|msedge|firefox]
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {gunzipSync} = require('node:zlib');
const {chromium, firefox} = require('playwright-core');
const {products} = require('../data/catalog.json');
const groups = require('../data/hazard_groups.json');
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
    await dialog.getByRole('button', {name:'Close record details'}).click();
    await page.getByLabel('Hazard group', {exact:true}).selectOption('snow');
    await page.getByRole('link', {name:'View details for ' + snowName}).click();
    await dialog.waitFor();
    assert.equal(page.url(), new URL(snowFragment,entry).href);
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
  const page = await context.newPage();
  try {
    await page.route('https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer/6/query?*', route => {
      const params = new URL(route.request().url()).searchParams;
      if (params.get('where')?.startsWith('UPPER(name)')) return route.fulfill({status:503,body:'Service unavailable'});
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
    await page.getByText(/Try the complete HUC code or find units at the project point/).waitFor();
    await page.getByLabel('Hydrologic unit name or code').fill(attrs.huc12);
    await page.getByRole('button',{name:'Find boundaries',exact:true}).click();
    await page.getByLabel('Boundary search results').selectOption({label:'HUC12 020700100103 · Pimmit Run-Potomac River (DC,MD,VA)'});
    await page.getByText('Boundary accepted. Check site to apply it.',{exact:true}).waitFor();
    await page.locator('#sc-run').click();
    await page.getByText('Boundary applied to this site check.',{exact:true}).waitFor();
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
    assert.deepEqual(errors, []);
    await context.close();
    await checkOffline(browser);
    console.log(browserName, browser.version(), 'passed record navigation, project return, chart and raw download, HUC12 selection/export/reopen, mobile layout, CSV/filter and offline checks.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
