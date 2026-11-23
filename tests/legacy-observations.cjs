// Stored provider examples and explicitly synthetic quality flags. No live requests.
module.exports = async function checkLegacyObservationCharts(page, downloadBytes) {
  const checks=[],errors=[];
  const check=(ok,name)=>{if(!ok)throw Error(name);checks.push(name);};
  page.on('pageerror',err=>errors.push(err.message));
  const keys=()=>page.locator('.sc-chart-key li').evaluateAll(items=>items.map(item=>item.dataset.legendKey));
  const saved=name=>page.getByRole('button',{name,exact:true}).click();
  await saved('GHCN-Daily');
  check((await keys()).join(',')==='bar,zero','Complete precipitation example shows only daily amounts and true zeros');
  await page.locator('.sc-series-tab').filter({hasText:'Daily maximum temperature'}).click();
  check((await keys()).join(',')==='line,point','Temperature uses connected readings and ordinary point marks');
  for(const [id,button,label] of [['noaa_coops_water_level','CO-OPS water level','Preliminary'],['usgs_streamflow','USGS streamflow','Provisional']]){
    await saved(button);
    check((await keys()).join(',')==='line,point',button+' verified or approved example uses two symbols');
    const original=await page.evaluate(id=>{
      const s=InventoryApp.data.examples.examples.find(e=>e.productId===id).result.series[0];
      const before=JSON.stringify(s.points.map(p=>[p.time,p.value]));
      if(id==='noaa_coops_water_level')s.points[0].flags.quality='p';else s.points[0].flags.approvalStatus='Provisional';
      return before;
    },id);
    await saved(button);
    check((await keys()).join(',')==='line,point,preliminary'&&await page.locator('[data-legend-key=preliminary]').innerText()===label,button+' uses its provider-specific quality wording');
    check(await page.locator('.sc-chart [data-preliminary=true]').count()===1&&await page.locator('.sc-chart [data-quality-failure=true]').count()===0,button+' distinguishes a reporting status from failed quality control');
    check(original===await page.evaluate(id=>JSON.stringify(InventoryApp.data.examples.examples.find(e=>e.productId===id).result.series[0].points.map(p=>[p.time,p.value])),id),button+' dates and values are preserved');
  }
  await page.emulateMedia({forcedColors:'active'});
  const symbol=await page.locator('[data-legend-key=preliminary] .sc-chart-symbol').evaluate(el=>({active:matchMedia('(forced-colors: active)').matches,width:parseFloat(getComputedStyle(el,'::before').borderTopWidth),label:el.parentElement.textContent}));
  check(symbol.active&&symbol.width>=1&&symbol.label==='Provisional','Forced colors retain an outlined provisional marker and a text label');
  await page.emulateMedia({forcedColors:'none'});
  const cases=[
    {product:'usgs_streamflow',button:'USGS streamflow',file:'usgs/buffalo-bayou-daily-2017-08-25_31.json',id:'USGS-08074000',name:'Buffalo Bayou at Houston, TX',lat:29.76,lon:-95.41,start:'2017-08-25',end:'2017-08-31'},
    {product:'ghcn_daily',button:'GHCN-Daily',file:'ghcn-daily/bwi-ghcn-daily-2026-10-18_11-13.json',id:'USW00093721',name:'Baltimore Washington International Airport',lat:39.17329,lon:-76.68408,start:'2026-10-18',end:'2026-11-13'}
  ];
  for(const c of cases){
    await page.evaluate(async c=>{
      const example=InventoryApp.data.examples.examples.find(e=>e.productId===c.product);
      const raw=await fetch('tests/fixtures/'+c.file).then(r=>{if(!r.ok)throw Error(r.statusText);return r.text();});
      example.station={id:c.id,name:c.name,lat:c.lat,lon:c.lon};
      example.query={mode:'point',lat:c.lat,lon:c.lon,radiusKm:5,start:c.start,end:c.end};
      example.result=await SiteProviders.retrieve(c.product,example.station,example.query,{fetchImpl:async()=>new Response(raw)});
    },c);
    await saved(c.button);
    const briefButton=page.getByRole('button',{name:'Download screening brief (HTML)',exact:true});
    check(await briefButton.isVisible(),'Printable brief is exposed with the selected station');
    const html=(await downloadBytes(page,briefButton)).toString('utf8');
    check(html.includes(c.id)&&html.includes(c.start)&&html.includes(c.end),'Brief contains the selected station and preview window');
    if(c.product==='usgs_streamflow')check(html.includes('27,600')&&html.includes('Approved, Estimated, Revised')&&html.includes('3 estimated')&&html.includes('1 missing'),'Brief retains peak approval, combined qualifiers, and missing count');
    else check(html.includes('33.4')&&html.includes('27 preliminary NWS CF6 source'),'Brief retains precipitation subtotal and preliminary source status');
    const evidence=JSON.parse(await downloadBytes(page,page.getByRole('button',{name:'Download full JSON',exact:true})));
    check(evidence.selectedStationId===c.id&&evidence.observationPreview.result.station.id===c.id&&evidence.observationPreview.result.rawText.length>0,'Full JSON preserves the station observation response');
    if(c.product==='usgs_streamflow'){
      const summary=await page.locator('.sc-chart-qualification').innerText();
      check(/Highest daily mean.*27,600 ft³\/s.*2017-08-28.*Approved · Estimated · Revised/.test(summary),'The Buffalo Bayou maximum carries its approval and both provider qualifiers');
      const flagged=page.locator('.sc-chart [data-estimated=true][data-revised=true]');
      check(await flagged.count()===3 && await page.locator('[data-legend-key=estimatedRevised]').count()===1,'Three estimated/revised days have their own chart symbol and legend');
      await page.locator('.sc-chart-scroll').focus();await page.keyboard.press('Home');
      check(/Estimated, Revised/.test(await page.locator('.sc-chart-reading').innerText()),'Keyboard inspection includes both qualifiers');
      check(await page.locator('.sc-usgs-routes a').count()===3,'Selected station provides continuous discharge, stage and peak links');
      await page.getByRole('button',{name:'Get project-period data',exact:true}).first().click();
      const firstPage=page.getByRole('link',{name:'Open provider JSON (first page) ↗',exact:true});
      const request=new URL(await firstPage.getAttribute('href'));
      check(await firstPage.isVisible()&&request.pathname.endsWith('/daily/items')&&request.searchParams.get('monitoring_location_id')===c.id&&request.searchParams.get('statistic_id')==='00003'&&request.searchParams.get('time')===c.start+'/'+c.end,'The visible USGS transfer opens the selected station’s first daily-mean JSON page for the whole project');
    }else{
      check((await page.locator('.sc-chart-qualification').allTextContents()).some(s=>s.includes('Preliminary NWS CF6 source · 27 of 27')),'BWI discloses its CF6 reporting source with the chart');
      check(/29 mm.*Highest daily amount.*Nov 6 · Preliminary NWS CF6 source/s.test(await page.locator('.sc-chart-stats').innerText()),'The BWI maximum qualifies its input source independently of daily QC');
    }
  }
  return {checks,errors};
};
