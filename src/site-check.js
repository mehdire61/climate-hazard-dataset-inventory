(function () {
  'use strict';
  const app = window.InventoryApp;
  const host = document.getElementById('site-check-view');
  if (!app || !host || !window.SiteScreening || !window.SiteProviders || !window.SiteGeometry) return;
  const data = app.data;
  const buildIdentity = {id:data.meta.build_id,version:data.meta.revision,catalogSnapshotDate:data.meta.snapshot_date};
  const products = data.products;
  const rules = data.screening.rules;
  const screeningMetadata = {schemaVersion: data.screening.schema_version, reviewDate: data.screening.review_date, catalogRevision: data.screening.catalog_revision};
  const examples = data.examples && Array.isArray(data.examples.examples) ? data.examples.examples : [];
  const supported = new Set(window.SiteProviders.supported);
  const byId = new Map(products.map(p => [p.product_id, p]));
  const shortNames = {ghcn_daily: 'GHCN-Daily', noaa_coops_water_level: 'CO-OPS water level', usgs_streamflow: 'USGS streamflow'};
  const geography = data.geography || {examples: [], states: []};
  let query = {mode: 'point', lat: 38.9, lon: -77.04, radiusKm: 100, start: '2020-07-01', end: '2020-07-03'};
  let draftMode = 'point', draftPoint = {...query}, draftArea = null, draftBufferKm = 0;
  let mapApi = null, areaController = null, areaGeneration = 0, areaLookup = null;
  const grdc = {catalogue:null,query:null,stations:[],selected:'',page:0,generation:0,busy:false,error:''};
  const grdcPageSize=8;
  let stationSearch = '', stationRelation = 'all', stationPage = 0, candidateDrawerOpen = false, stationChoiceRequired = false;
  let coopsFilter = 'matching';
  let stationNetwork = 'all', chartResizeObserver = null;
  const stationPageSize = 25;
  let results = [], selectedId = 'ghcn_daily', statusFilter = 'all', actionFilter = '', hazardFilter = null, searchTerm = '', liveOnly = false, accessFilterValue = '';
  let compareAllDatasets = false, explicitSelection = false;
  const shortlistLimit = 3;
  const projectEvidence = new Map();
  let availabilityController = null;
  let checkOnHazardChoice = false;
  let coopsProduct = 'water_level', timelineFull = true;
  let restoringProject=false, mapUserCollapsed=false, projectImportGeneration=0, shareGeneration=0;
  const recentKey='climate-inventory-projects-v1';
  let discovery = null, sample = null, savedLabel = '', selectedStationId = '', activeSeries = 0;
  let stationDownloadPlan = null;
  let loading = '', loadingKind = '', networkError = '', controller = null, generation = 0, dirty = false;
  let accessPlan = null, accessFileResult = null, accessOptions = {}, accessError = '', accessLoading = false, accessController = null, accessGeneration = 0, fileSearch = '', filePage = 0;
  let lakeFilter = '';
  let selectedFileKeys = new Set();
  let fileBatchSource = null, fileBatchPlan = null;
  let accessPlatform = /Win/i.test(navigator.platform) ? 'windows' : 'unix';
  const node = (tag, attrs = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) e.setAttribute(k, v);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined) e.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return e;
  };
  function userError(error) {
    if(error?.code==='SOAP_SERVER_FAULT'||/java\.lang\.[A-Za-z]+Exception/.test(error?.message||''))return 'NOAA’s station inventory service could not complete this check. Retry later or inspect the linked station inventory.';
    if(error?.name==='SyntaxError')return 'This file or response is not valid JSON. Check that it is complete, re-export it and try again.';
    if(['TypeError','ReferenceError','RangeError'].includes(error?.name))return 'The operation could not complete. Check the input and connection, then retry. Reload the page if it persists.';
    return error?.message || 'The operation failed. Check the input and try again.';
  }
  const button = (label, onClick, cls = 'btn small', attrs = {}) => node('button', {type: 'button', class: cls, onclick: onClick, ...attrs}, label);
  const p = (text, cls = 'sc-help') => node('p', {class: cls}, text);
  const link = (url, label, cls = '') => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return node('span', {}, label);
      return node('a', {href: u.href, target: '_blank', rel: 'noopener noreferrer', class: cls}, label);
    } catch (_) { return node('span', {}, label); }
  };
  const badge = (label, status = '') => node('span', {class: 'sc-badge ' + status}, label);
  const human = text => ({ALLOWED:'Allowed',ALLOWED_WITH_CONDITIONS:'Allowed with conditions',PERMITTED_WITH_CONDITIONS:'Permitted with conditions',PROHIBITED_WITHOUT_PERMISSION:'Prohibited without permission',RECORD_SPECIFIC:'Record-specific terms; inspect the selected record',OPEN_WITH_CONDITIONS:'Allowed with conditions',PUBLIC_DOMAIN:'Public domain',UNKNOWN:'Not established',RESTRICTED:'Restricted',LICENSE_REQUIRED:'License required',PROVIDER_SPECIFIC:'Check provider terms'}[text] || String(text || 'Not established'));
  const supportLabels={station:'Station data',grid:'Gridded data',event:'Event reports',track:'Storm tracks',climate_state:'Climate scenarios',acquisition:'Satellite passes',model:'Model output'};
  const timeLabels={six_minute_hourly:'6-minute or hourly',daily:'Daily',daily_accumulations:'Daily totals',daily_index:'Daily index; selected accumulation window',daily_monthly:'Daily or monthly',monthly:'Monthly',monthly_annual:'Monthly or annual',monthly_seasonal_annual:'Monthly, seasonal or annual',annual_monthly_seasonal:'Annual, monthly or seasonal',hourly:'Hourly',hourly_interval:'Hourly intervals',hourly_or_finer:'Hourly or finer',hourly_synoptic:'Hourly or synoptic',half_hourly:'30-minute',three_hourly:'3-hourly',two_minute:'2-minute',accumulation_specific:'Accumulation depends on the field',mixed:'Timing depends on the variable',overpass:'Overpass times',irregular_track:'Track times',monthly_irregular:'Monthly with gaps',return_period_scenario:'Return-period scenarios'};
  const dateRange = q => q.start === q.end ? q.start : q.start + ' → ' + q.end;
  const displayTimestamp = (value, zone = 'UTC') => String(value).replace(/\.000Z$/, 'Z').replace('T', ' ').replace(/Z$/, ' ' + zone);
  const previewPeriod = value => value.startTime && value.endTime ? displayTimestamp(value.startTime, 'UTC') + ' → ' + displayTimestamp(value.endTime, 'UTC') : dateRange(value);
  const previewWindow = (station, allowUnverified = false) => {
    const window = SiteProviders.previewWindow(selectedId, query, station, {allowUnverified});
    return {...window, days: window.available === false ? 0 : Math.round((Date.parse(window.end) - Date.parse(window.start)) / 86400000) + 1};
  };
  function previewEvidenceLabel() {
    const count=(sample?.series||[]).reduce((n,series)=>n+series.points.filter(point=>Number.isFinite(point.value)).length,0);
    const daily=selectedId==='ghcn_daily',totals=(sample?.series||[]).reduce((n,series)=>n+series.points.filter(point=>Number.isFinite(point.multiDay?.value)).length,0);
    return (savedLabel ? 'Saved preview · ' : '') + (count ? (daily?'Preview daily values returned':'Preview values returned') : daily?'No numeric daily values':'No numeric values returned in this preview') + (daily&&totals?'; '+totals+' multi-day total'+(totals===1?'':'s'):'') + (sample?.window ? ' · '+previewPeriod(sample.window) : '');
  }
  const coordinate = (v, positive, negative) => Math.abs(v).toFixed(3) + '° ' + (v < 0 ? negative : positive);
  const siteLabel = q => q.mode === 'area' ? q.areaName || 'Project area' : coordinate(q.lat, 'N', 'S') + ', ' + coordinate(q.lon, 'E', 'W');
  const resultFor = id => results.find(r => r.productId === id);
  const lookupStatus = status => ['unresolved', 'event', 'special'].includes(status);
  const screeningFamily = result => result.label;
  const reveal = target => {
    if (!target || host.hidden) return;
    target.focus({preventScroll: true});
    target.scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start'});
  };
  const field = (id, label, type, value, extra = {}) => node('div', {class: 'sc-field'}, node('label', {for: id}, label), node('input', {id, name: id, type, value, required: '', ...extra}));
  const fact = (label, value) => node('div', {}, node('dt', {}, label), node('dd', {}, value || 'Not established'));
  const accessLabels = {station: 'Station preview & data', files: 'Provider files', request: 'Prepare a download request', external: 'Get data from the provider site'};
  function accessProfile(id) {
    if (supported.has(id)) return {kind: 'station', label: accessLabels.station};
    if (window.SiteAccess) return window.SiteAccess.describe(id);
    const product = byId.get(id);
    return {kind: 'external', label: accessLabels.external, summary: 'Access-route configuration is unavailable in this build.', auth: 'See provider terms', spatialDelivery: 'Provider-specific', temporalDelivery: 'Provider-specific', verification: {label: 'Route not configured'}, docsUrl: product.documentation_url, providerUrl: product.access_url};
  }

  const intro = node('div', {class: 'sc-intro'},node('div', {},
    node('h1', {id: 'sc-heading'}, 'Check data for your project'),
    node('details', {class:'sc-scope'},node('summary',{},'Geographic scope'),p('Global and regional datasets. Integrated river and coastal station tools primarily serve U.S. locations and territories. GHCN-Daily weather stations are international. Coverage varies by variable and period.'))));
  host.setAttribute('aria-labelledby', 'sc-heading');
  const form = node('form', {class: 'sc-query', novalidate: ''});
  const modeSelect = node('select', {id: 'sc-mode', class: 'sc-select'}, node('option', {value: 'point'}, 'Point'), node('option', {value: 'area'}, 'Project area'));
  const locationFields = node('div', {class: 'sc-location-fields'});
  const rangeField = node('div', {class: 'sc-field'});
  form.append(node('div', {class: 'sc-query-grid'},
    node('div', {class: 'sc-field'}, node('label', {for: 'sc-mode'}, 'Location type'), modeSelect), locationFields, rangeField,
    field('sc-start', 'Start date', 'date', query.start), field('sc-end', 'End date', 'date', query.end)));
  const periodSelect = node('select', {id: 'sc-period', class: 'sc-select', 'aria-describedby': 'sc-period-note'},
    node('option', {value: 'dates'}, 'Custom dates'),
    ...[1, 3, 7, 10, 14, 30].map(days => node('option', {value: days}, 'Past ' + days + (days === 1 ? ' day' : ' days'))),
    node('option', {value: 'days'}, 'Custom number of days'));
  const periodCount = field('sc-past-days', 'Number of days', 'number', 7, {min: 1, step: 1, inputmode: 'numeric', 'aria-describedby': 'sc-period-note'});
  periodCount.classList.add('sc-period-count'); periodCount.hidden = true;
  const periodNote = p('', 'sc-period-note'); periodNote.id = 'sc-period-note'; periodNote.setAttribute('role', 'status');
  const resultsJump=button('View results',()=>reveal(overview),'btn small sc-results-jump',{'aria-controls':'sc-overview',hidden:''});
  let periodError = '';
  form.append(node('div', {class: 'sc-period'}, node('div', {class: 'sc-field'}, node('label', {for: 'sc-period'}, 'Quick period'), periodSelect), periodCount, periodNote,
    node('button', {type: 'submit', class: 'btn primary', id: 'sc-run',title:'Screen the catalog and check available public listings for the selected hazard.'}, 'Check site →'),resultsJump));
  const dirtyNotice = node('span', {class: 'sc-input-change', hidden: ''}, 'Inputs changed — run Check site to update results.');
  const queryHint = node('span', {}, 'WGS84 coordinates · west/south negative · historical dates');
  form.append(node('div', {class: 'sc-query-foot'}, queryHint, dirtyNotice));
  const inputError = node('div', {class: 'sc-error', role: 'alert', hidden: ''});
  form.append(inputError);
  const geographyPanel = node('div', {class: 'sc-geography'});
  const geometryControls = node('div', {class: 'sc-geometry-controls'});
  const pointHelp = node('div', {class: 'sc-point-help'}, node('h2', {}, 'Confirm the location'), p('The radius is measured along Earth’s surface.', ''), button('Pick a point on the map', () => mapApi?.beginPoint(), 'btn small'));
  const areaControls = node('div', {class: 'sc-area-controls', hidden: ''});
  const areaMethod = node('select', {id: 'sc-area-method', class: 'sc-select', 'aria-label': 'Choose area source'},
    node('option', {value:'huc'}, 'U.S. hydrologic unit (HUC)'),
    node('option', {value: 'saved'}, 'Saved boundaries'), node('option', {value: 'named'}, 'Find a named boundary'), node('option', {value: 'rectangle'}, 'Draw / enter rectangle'), node('option', {value: 'upload'}, 'Upload GeoJSON'));
  const savedArea = node('select', {id: 'sc-saved-area', class: 'sc-select', 'aria-label': 'Saved project boundary'}, node('option', {value: ''}, 'Choose a saved boundary…'));
  for (const area of geography.examples || []) savedArea.append(node('option', {value: area.id}, area.name));
  const savedAreaBox = node('div', {'data-area-method': 'saved'}, savedArea, p('These boundaries include source details and work offline.', 'sc-area-help'));
  const areaKind = node('select', {id: 'sc-area-kind', class: 'sc-select', 'aria-label': 'Boundary type'}, node('option', {value: 'county'}, 'US county'), node('option', {value: 'state'}, 'US state / territory'), node('option', {value: 'place'}, 'US city / place'), node('option', {value: 'country'}, 'Country'));
  const areaState = node('select', {id: 'sc-area-state', class: 'sc-select', 'aria-label': 'State for boundary search'}, node('option', {value: ''}, 'Any US state'));
  for (const state of geography.states || []) areaState.append(node('option', {value: state.id}, state.name));
  const areaText = node('input', {id: 'sc-area-text', class: 'sc-search', type: 'search', placeholder: 'Boundary name…', 'aria-label': 'Boundary name'});
  const hucLevel = node('select', {class:'sc-select', 'aria-label':'Hydrologic unit level'},
    node('option',{value:'huc12'},'HUC12 · subwatershed'), node('option',{value:'huc10'},'HUC10 · watershed'), node('option',{value:'huc8'},'HUC8 · subbasin'));
  const hucDetail = node('select', {class:'sc-select', 'aria-label':'WBD boundary detail'},
    node('option',{value:'screening'},'USGS screening · 0.00001° tolerance'), node('option',{value:'full'},'Full USGS geometry'));
  const hucPointButton = button('Find units at the project point', () => searchAreas(true), 'btn small');
  const hucHelp = p('HUC12 is the primary U.S. assessment unit. Choose a unit to screen its mapped area. A custom upstream drainage area requires outlet delineation. Full detail may exceed the browser geometry limit.', 'sc-area-help');
  const areaSearchButton = button('Find boundaries', () => searchAreas(), 'btn small');
  const areaMatches = node('div', {class: 'sc-area-matches'});
  const areaStatus = p('', 'sc-area-help'); areaStatus.setAttribute('role', 'status');
  const namedAreaBox = node('div', {'data-area-method': 'named'}, node('div', {class: 'sc-area-row'}, areaKind, areaState),
    hucLevel, hucDetail, hucHelp, node('div', {class: 'sc-area-row'}, areaText, areaSearchButton), hucPointButton, areaStatus, areaMatches);
  const rectangleBox = node('div', {'data-area-method': 'rectangle', hidden: ''},
    node('div', {class: 'sc-rectangle-fields'}, field('sc-west', 'West', 'number', -77.3, {step: 'any'}), field('sc-south', 'South', 'number', 38.8, {step: 'any'}), field('sc-east', 'East', 'number', -76.9, {step: 'any'}), field('sc-north', 'North', 'number', 39.1, {step: 'any'})),
    node('div', {class: 'sc-area-row'}, button('Use rectangle', useRectangle, 'btn small'), button('Draw two corners', () => mapApi?.beginRectangle(), 'btn small')),
    p('West > east means a dateline-crossing rectangle. A rectangle is a search footprint, not an administrative boundary.', 'sc-area-help'));
  const uploadInput = node('input', {id: 'sc-area-file', type: 'file', accept: '.json,.geojson,application/geo+json,application/json'});
  const uploadBox = node('div', {'data-area-method': 'upload', hidden: ''}, node('label', {class: 'sc-label', for: 'sc-area-file'}, 'WGS84 Polygon / MultiPolygon'), uploadInput, p('Polygon-only FeatureCollections are accepted. Geometry is validated without silent simplification. Maximum upload 8 MB.', 'sc-area-help'));
  const areaSelection = node('div', {class: 'sc-area-selection'});
  areaControls.append(node('h2', {}, 'Choose a project area'), areaMethod, savedAreaBox, namedAreaBox, rectangleBox, uploadBox, areaSelection);
  geometryControls.append(pointHelp, areaControls);
  const mapContainer = node('div', {id: 'sc-project-map', class: 'sc-project-map', 'aria-label': 'Project location and candidate stations', role: 'region'});
  const mapNotice = p('', 'sc-map-notice'); mapNotice.setAttribute('role', 'status');
  const mapLegend = p('', 'sc-map-legend');
  const mapStationSummary = node('span', {}, 'No candidate stations loaded');
  const mapState = node('span', {}, 'Submitted geometry');
  const basemapStatus = node('span', {class:'sc-basemap-status',role:'status'}, 'Regional overview');
  let basemapFailed = false;
  const onlineMap = button('Online detail', () => mapApi?.setOnline(basemapFailed || onlineMap.getAttribute('aria-pressed') !== 'true'),
    'sc-map-button', {'aria-pressed':'false',title:'Load detailed OpenStreetMap tiles for the visible area from OpenFreeMap.'});
  const expandMap = button('Expand map', () => {geographyPanel.classList.toggle('expanded'); expandMap.textContent = geographyPanel.classList.contains('expanded') ? 'Compact map' : 'Expand map'; requestAnimationFrame(() => {mapApi?.invalidate(); mapApi?.fit();});}, 'sc-map-button');
  const mapFrame = node('div', {class: 'sc-map-frame'}, node('div', {class: 'sc-map-toolbar'}, mapState, node('span', {}, button('Fit project', () => mapApi?.fit(), 'sc-map-button'), button('Fit stations',()=>mapApi?.fitCandidates(),'sc-map-button'), onlineMap, expandMap)), mapContainer, mapLegend,
    node('div', {class: 'sc-map-foot'}, mapStationSummary, basemapStatus), mapNotice);
  geographyPanel.append(geometryControls, mapFrame);
  const mapTools=node('details',{class:'sc-map-tools'},node('summary',{},'Map and boundary tools'),geographyPanel);form.append(mapTools);
  function showProjectMap() {if (!mapUserCollapsed && !mapTools.open) mapTools.open=true;}
  mapTools.addEventListener('toggle',()=>{mapUserCollapsed=!mapTools.open;mapApi?.setVisible(mapTools.open && !host.hidden);if(mapTools.open)requestAnimationFrame(()=>{mapApi?.invalidate();if(discovery?.stations?.length)mapApi?.fitCandidates();else mapApi?.fit();});});
  const exampleBar = node('div', {class: 'sc-examples'}, node('span', {}, 'Try a saved, real-data example:'));
  for (const ex of examples) exampleBar.append(button(shortNames[ex.productId] || ex.label, () => loadExample(ex), 'sc-example', {title: ex.label}));
  if (!examples.length) exampleBar.hidden = true;
  const summary = node('div', {role: 'group', class: 'sc-summary', 'aria-label': 'Filter catalog screening results'});
  const search = node('input', {class: 'sc-search', id: 'sc-search', type: 'search', placeholder: 'Find a dataset…', 'aria-label': 'Find a dataset in site results'});
  const hazardTiles = node('div', {class: 'hazard-strip sc-hazard-tiles', role: 'group', 'aria-label': 'Choose one hazard group'});
  for (const g of data.hazard_groups) {
    const tile = button('', () => chooseHazard(hazardFilter === g.id ? '' : g.id), 'hazard-tile sc-hazard-tile', {'data-hazard-group': g.id, 'aria-pressed': 'false', 'aria-description': g.products.length + ' datasets in the catalog'});
    const icon = document.querySelector('#tiles [data-id="' + g.id + '"] .icon');
    if (icon) tile.append(icon.cloneNode(true));
    tile.append(node('small', {'aria-hidden': 'true'}, g.products.length+' in catalog'), node('b', {}, g.label));
    tile.style.setProperty('--accent', g.color); hazardTiles.append(tile);
  }
  const allDatasets = button('All datasets', () => chooseHazard(''), 'btn small', {id: 'sc-all-datasets', 'aria-pressed': 'false'});
  const hazardCountNote=p('','sc-interest-status');
  const hazardMessage = p('', 'sc-interest-status'); hazardMessage.setAttribute('role', 'status');
  const hazardChoice = node('section', {class: 'sc-interests', tabindex: '-1', 'aria-labelledby': 'sc-interests-heading'},
    node('div', {class: 'sc-interests-heading'}, node('h2', {id: 'sc-interests-heading'}, 'Choose a hazard'), allDatasets), hazardCountNote,hazardTiles, hazardMessage);
  const liveFilter = node('input', {id: 'sc-live-only', type: 'checkbox'});
  const accessFilter = node('select', {class: 'sc-select', id: 'sc-access-filter', 'aria-label': 'Filter by how to get data'}, node('option', {value: ''}, 'All access routes'));
  for (const [value,label] of Object.entries(accessLabels)) accessFilter.append(node('option', {value}, label));
  const overview=node('section',{class:'sc-overview',id:'sc-overview',tabindex:'-1','aria-labelledby':'sc-overview-title'});
  const caption = p('', 'sc-list-caption');
  const list = node('div', {role: 'group', class: 'sc-record-list', 'aria-label': 'Screened catalog records'});
  const panel = node('article', {class: 'sc-detail', id: 'sc-detail', tabindex: '-1'});
  const catalogToggle=node('summary',{},'Browse or filter sources');
  const catalog = node('details', {class: 'sc-catalog sc-catalog-disclosure'},catalogToggle,summary,
    node('label', {class: 'sc-live-filter', for: 'sc-live-only'}, liveFilter, 'Preview station observations'),
    node('div', {class: 'sc-list-controls'}, search), node('div', {class: 'sc-access-filter-row'}, node('label', {for: 'sc-access-filter'}, 'How to get data'), accessFilter), caption, list);
  const announce = node('div', {class: 'visually-hidden', role: 'status', 'aria-live': 'polite'});
  const summaryExport = button('Download full JSON', exportSummary, 'btn small', {title:'Screening evidence, selected observations and original project geometry'});
  const briefExport = button('Download screening brief (HTML)', exportScreeningBrief, 'btn primary small', {title:'Printable project and station summary'});
  const scopedExport = button('Download screening results (CSV)', exportScreeningCSV);
  const guideGroups=node('dl',{class:'sc-guide-groups'});
  const guide=node('details',{class:'sc-reading-guide',id:'sc-reading-guide'},node('summary',{},'Screening definitions and limits'),guideGroups,
    p('The shortlist uses location, dates, scale and provider checks. Established public agencies and data centres take priority among comparable sources. A listed file or station still needs an observation check.'),
    p('Stripes cover uncertain, unresolved or unchecked dates. A crossed bar means the location is outside the mapped footprint.'),
    p('Before using a dataset, review its resolution, quality flags, gaps and licensing. Check whether the station, catchment or coastal setting represents your site. For validation, also check whether the observations are independent of the product.'));
  const projectMessage=p('','sc-project-message');projectMessage.setAttribute('role','status');
  const recentSelect=node('select',{class:'sc-select','aria-label':'Recent projects'});
  const remember=node('input',{type:'checkbox',id:'sc-remember-projects'});
  const projectFile=node('input',{type:'file',id:'sc-project-file',accept:'.json,application/json'});
  const shareField=node('input',{type:'text',readonly:'',hidden:'','aria-label':'Project link',class:'sc-share-url'});
  const projectTools=node('details',{class:'sc-project-tools'},node('summary',{},'Share or reopen a project'),
    p('Links and project files include the location or full boundary, dates and selected dataset. They contain no observation responses. Share only with the people who should receive that location.'),
    node('div',{class:'sc-project-actions'},button('Create project link',shareProject),button('Download project file',()=>{if(dirty){projectMessage.textContent='Run Check site before saving the changed inputs.';return;}download(JSON.stringify(projectState(),null,2),'application/json','inventory-project.json');}),node('label',{for:'sc-project-file'},'Open project file'),projectFile),shareField,
    node('label',{class:'sc-remember',for:'sc-remember-projects'},remember,'Remember recent projects on this browser'),p('Off by default. When enabled, keeps your five most recent projects on this browser. Unchecking removes them; observations are never saved.'),
    node('div',{class:'sc-project-actions'},recentSelect,button('Open selected project',openRecent),button('Clear recent projects',clearRecent)),projectMessage);
  const bottom = node('div', {class: 'sc-bottom-note'},briefExport,scopedExport,summaryExport,button('Screening definitions ↑',()=>{guide.open=true;reveal(guide.querySelector('summary'));}));
  const workspace = node('div', {class: 'sc-workspace'}, catalog, panel);
  host.append(intro, form, projectTools, exampleBar, hazardChoice, overview, workspace, bottom, announce);
  remember.addEventListener('change',()=>{if(remember.checked)saveRecent();else clearRecent();});
  projectFile.addEventListener('change',async()=>{
    const file=projectFile.files?.[0],generation=++projectImportGeneration;if(!file)return;invalidateShare();
    let state;
    try{if(file.size>SiteProjectState.MAX_BYTES)throw Error('Project files are limited to 8 MB.');const text=await file.text();if(generation!==projectImportGeneration)return;state=SiteProjectState.parse(text,[...byId.keys()],data.hazard_groups.map(g=>g.id));}
    catch(error){if(generation!==projectImportGeneration)return;projectMessage.textContent='Project could not open: '+error.message;projectFile.value='';return;}
    projectFile.value='';restoreProject(state);projectMessage.textContent='Project opened. Screening refreshed with this build; observations can be retrieved separately.';
  });

  form.addEventListener('input', event => {
    if (!['sc-lat', 'sc-lon', 'sc-radius', 'sc-buffer', 'sc-start', 'sc-end'].includes(event.target.id)) return;
    if (['sc-start', 'sc-end'].includes(event.target.id)) resetPeriod();
    if (draftMode === 'point') {
      draftPoint.lat = numberInput('sc-lat'); draftPoint.lon = numberInput('sc-lon'); draftPoint.radiusKm = numberInput('sc-radius');
    } else draftBufferKm = numberInput('sc-buffer');
    markDirty(); updateDraftMap();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const next = draftQuery();
    const errors = window.SiteScreening.validate(next);
    if (periodError) errors.unshift(periodError);
    if (errors.length) {
      inputError.replaceChildren(node('ul', {}, errors.map(error => node('li', {}, error)))); inputError.hidden = false;
      announce.textContent = 'The site check needs corrected inputs.';
      return;
    }
    setQuery(next, true);
    checkOnHazardChoice=!hazardFilter;
    if(hazardFilter) checkSubmittedAvailability();
    showProjectMap();
    if (next.mode === 'area' && ['named','huc'].includes(areaMethod.value)) areaStatus.textContent = 'Boundary applied to this site check.';
    announce.textContent = hazardFilter === null ? 'Project applied. Choose a hazard group to see its datasets.' : 'Screened ' + scopedResults().length + ' datasets in your selection for ' + siteLabel(query) + ', ' + dateRange(query) + '.';
    if (!mapTools.open && hazardFilter === null && hazardTiles.getBoundingClientRect().top >= window.innerHeight) reveal(hazardChoice);
  });
  periodSelect.addEventListener('change', applyRecentPeriod);
  document.getElementById('sc-past-days').addEventListener('input', applyRecentPeriod);
  search.addEventListener('input', () => { searchTerm = search.value.trim().toLowerCase(); renderList(); });
  document.addEventListener('inventory-hazard-change', event => chooseHazard(event.detail.hazard, false));
  liveFilter.addEventListener('change', () => { liveOnly = liveFilter.checked; renderList(); });
  accessFilter.addEventListener('change', () => {accessFilterValue = accessFilter.value; renderList();});
  modeSelect.addEventListener('change', () => {cancelAreaLookup(); draftMode = modeSelect.value;if(draftMode==='area')mapTools.open=true; renderGeometryControls(); markDirty(); updateDraftMap(true);});
  function showAreaMethod() {
    const huc = areaMethod.value === 'huc';
    for (const section of areaControls.querySelectorAll('[data-area-method]')) section.hidden = section.dataset.areaMethod !== (huc ? 'named' : areaMethod.value);
    for (const control of [hucLevel,hucDetail,hucHelp,hucPointButton]) control.hidden = !huc;
    areaKind.hidden = huc;
    areaState.hidden = huc || ['country','state'].includes(areaKind.value);
    areaText.placeholder = huc ? 'Name or HUC code' : 'Boundary name…';
    areaText.setAttribute('aria-label',huc ? 'Hydrologic unit name or code' : 'Boundary name');
  }
  function resetAreaSearch() {
    cancelAreaLookup(); areaLookup = null; areaMatches.replaceChildren(); areaStatus.textContent = '';
  }
  areaMethod.addEventListener('change', () => {resetAreaSearch(); showAreaMethod(); mapApi?.cancelDrawing();});
  showAreaMethod();
  savedArea.addEventListener('change', () => {const area = geography.examples.find(a => a.id === savedArea.value); if (area) acceptArea(area);});
  areaKind.addEventListener('change', () => {resetAreaSearch(); showAreaMethod();});
  hucLevel.addEventListener('change', resetAreaSearch);
  hucDetail.addEventListener('change', () => {
    const selected = areaMatches.querySelector('select')?.value;
    if (selected && areaLookup?.items[Number(selected)]) loadNamedArea(areaLookup.items[Number(selected)]);
  });
  areaText.addEventListener('input', resetAreaSearch); areaState.addEventListener('change', resetAreaSearch);
  areaText.addEventListener('keydown', event => {if (event.key === 'Enter') {event.preventDefault(); searchAreas();}});
  uploadInput.addEventListener('change', uploadArea);
  try {
    mapApi = window.ProjectMap.create(mapContainer, {
      onBasemapState(enabled, label, failed, polar){
        basemapFailed=failed; if(basemapStatus.textContent!==label) basemapStatus.textContent=label;
        onlineMap.textContent=failed?'Retry map detail':'Online detail';
        onlineMap.disabled=polar;
        onlineMap.setAttribute('aria-pressed',String(enabled && !failed && !polar));
      },
      onPoint(point) {cancelAreaLookup(); draftMode = 'point'; draftPoint = {...draftPoint, ...point}; modeSelect.value = 'point'; renderGeometryControls(); markDirty(); updateDraftMap();},
      onRectangle(bounds) {for (const key of ['west','south','east','north']) document.getElementById('sc-' + key).value = bounds[key]; useRectangle('drawn');},
      onStation(id) {
        if(selectedId==='grdc_discharge'&&grdc.query===query){
          const i=grdc.stations.findIndex(s=>s.id===id);
          if(i>=0){grdc.selected=id;grdc.page=Math.floor(i/grdcPageSize);renderPanel();}
        } else chooseStation(id,true);
      },
      onNotice(text) {mapNotice.textContent = text;},
      onLegend(text) {mapLegend.textContent = text;},
      onStationSummary(info) {mapStationSummary.textContent = info.loaded ? info.loaded + ' loaded candidates' + (info.grouped ? ' · represented by ' + info.markers + ' marks; zoom or use list' : ' · all plotted; some may overlap') : 'No candidate stations loaded';}
    });
  } catch (error) {mapNotice.textContent = userError(error);}

  function projectState(){return {schema:'climate-inventory-project/1',query,selectedId,hazard:hazardFilter,...(!explicitSelection?{selectionMode:'automatic'}:{})};}
  function invalidateShare(){
    shareGeneration++;
    if(!shareField.hidden||shareField.value){shareField.value='';shareField.hidden=true;projectMessage.textContent='Project changed. Create a new link for the current applied inputs.';}
  }
  function updateSharedProject(){
    invalidateShare();
    if(restoringProject||!location.hash.startsWith('#site-check?project='))return;
    try{history.replaceState(null,'',SiteProjectState.fragment(projectState()));}catch(_){history.replaceState(null,'','#site-check');}
  }
  async function shareProject(){
    if(dirty){projectMessage.textContent='Run Check site before sharing the changed inputs.';return;}
    const generation=++shareGeneration;
    try{const fragment=SiteProjectState.fragment(projectState()),url=location.href.split('#')[0]+fragment;shareField.value=url;shareField.hidden=false;history.replaceState(null,'',fragment);
      let copied=false;try{await navigator.clipboard.writeText(url);copied=true;}catch(_){}
      if(generation!==shareGeneration||dirty)return;
      projectMessage.textContent=(copied?'Project link copied.':'Project link ready; select and copy the field.')+(/^(127\.|localhost$)/.test(location.hostname)||location.protocol==='file:'?' This is a local preview link; it works only where this local app is reachable. Use the project file for another computer.':'');shareField.focus();shareField.select();
    }catch(error){projectMessage.textContent=error.message;}
  }
  function restoreProject(state){
    cancelAvailability();checkOnHazardChoice=false;
    projectImportGeneration++;invalidateShare();
    restoringProject=true;
    try{clearProviderState();hazardFilter=state.hazard;compareAllDatasets=hazardFilter==='';catalog.open=false;clearFilters();selectedId=state.selectedId;explicitSelection=state.selectionMode!=='automatic';setQuery(state.query);selectScopedRecord();app.setHazardGroup(hazardFilter||'');renderSummary();renderList();renderOverview();renderPanel();}
    finally{restoringProject=false;}
    updateSharedProject();saveRecent();
  }
  function restoreHash(event){
    if(!location.hash.startsWith('#site-check?project='))return;
    try{
      const encoded=location.hash.slice('#site-check?project='.length);
      if(encoded.length>12000)throw Error('This project link is too large. Open a project file instead.');
      const saved=decodeURIComponent(encoded);
      // Returning from record details should preserve the observations in the open project.
      if(event?.oldURL && new URL(event.oldURL).hash.startsWith('#inventory?record=') &&
          saved===JSON.stringify(projectState()))return;
      restoreProject(SiteProjectState.parse(saved,[...byId.keys()],data.hazard_groups.map(g=>g.id)));
    }
    catch(error){projectMessage.textContent='Project link could not open: '+error.message;projectTools.open=true;}
  }
  function readRecent(){try{const value=JSON.parse(localStorage.getItem(recentKey)||'null');return value?.enabled&&Array.isArray(value.projects)?value:null;}catch(_){return null;}}
  function loadRecent(){
    const state=readRecent();remember.checked=!!state;
    recentSelect.replaceChildren(node('option',{value:''},'Choose a recent project…'));
    for(const [i,item]of (state?.projects||[]).slice(0,5).entries()){try{const checked=SiteProjectState.validate(item,[...byId.keys()],data.hazard_groups.map(g=>g.id));recentSelect.append(node('option',{value:i},siteLabel(checked.query)+' · '+dateRange(checked.query)));}catch(_){projectMessage.textContent='A stored project is invalid and was skipped. Clear recent projects to remove it.';}}
  }
  function saveRecent(){
    if(restoringProject||dirty||!remember.checked)return;
    try{const current=projectState(),existing=readRecent()?.projects||[],key=SiteProjectState.key(current);
      const projects=[current,...existing.filter(s=>{try{return SiteProjectState.key(s)!==key;}catch(_){return false;}})].slice(0,5),value=JSON.stringify({enabled:true,projects});
      if(new TextEncoder().encode(value).length>2*1024*1024)throw Error('These boundaries exceed the 2 MB recent-project limit. Download a project file instead.');
      localStorage.setItem(recentKey,value);loadRecent();
    }catch(error){projectMessage.textContent='Recent project could not be saved: '+error.message;}
  }
  function clearRecent(){try{localStorage.removeItem(recentKey);remember.checked=false;loadRecent();projectMessage.textContent='Recent projects cleared on this browser.';}catch(_){projectMessage.textContent='Browser storage is unavailable.';}}
  function openRecent(){
    if(recentSelect.value==='')return;
    try{const item=readRecent()?.projects[Number(recentSelect.value)];restoreProject(SiteProjectState.validate(item,[...byId.keys()],data.hazard_groups.map(g=>g.id)));projectMessage.textContent='Recent project opened; results use this build.';}catch(error){projectMessage.textContent='Saved project could not open: '+error.message;}
  }
  function statusGroup(result){
    if(result.status==='excluded')return {key:'outside',icon:'×',label:'Outside'};
    if(result.status==='possible')return {key:'fit',icon:'✓',label:'Potential fit'};
    if(/^Find /.test(result.label))return {key:'find',icon:'⌖',label:'Find observations'};
    return {key:'check',icon:'?',label:'Check support'};
  }
  function scopedResults() {
    if (hazardFilter === null) return [];
    const group = data.hazard_groups.find(g => g.id === hazardFilter);
    return group ? results.filter(r => group.products.includes(r.productId)) : results;
  }
  function shortRegionalRain(scoped) {
    // A project shorter than even February benefits from short accumulation
    // intervals. Use the regional analysis only within its checked catalog span.
    if(hazardFilter!=='precipitation'||Date.parse(query.end)-Date.parse(query.start)>=27*86400000)return false;
    const stage=scoped.find(r=>r.productId==='stage_iv');
    return stage?.status==='possible'&&stage.spatialRelation==='within'&&stage.temporalSegments?.every(s=>s.kind==='documented');
  }
  function shortlistIds(scoped) {
    return SiteShortlist.rank(scoped,{byId,rules,evidence:projectEvidence,hazard:hazardFilter,
      offshore:results.some(r=>r.landCheck?.land===false),regionalRain:shortRegionalRain(scoped),limit:shortlistLimit});
  }
  function evidenceFor(id) {return projectEvidence.get(SiteShortlist.key(id,hazardFilter));}
  function rememberEvidence(id,hazard,value,requests=[]) {
    if (!value) return;
    const key=SiteShortlist.key(id,hazard), old=projectEvidence.get(key);
    if (old?.level===3 && value.level<3 || old && value.level===0 && old.level!==0) return;
    projectEvidence.set(key,{...value,checkedAt:new Date().toISOString(),source:requests.at(-1)?.url || byId.get(id).documentation_url});
  }
  function recordStations(id,response) {
    for(const hazard of id==='ghcn_daily'?['temperature','precipitation']:[''])
      rememberEvidence(id,hazard,SiteShortlist.stationEvidence(id,hazard,response,query),response.requests);
  }
  function cancelAvailability() {availabilityController?.abort();availabilityController=null;}
  function searchableSources(scoped) {
    return scoped.filter(r=>r.status!=='excluded' && r.networkInScope!==false &&
      (supported.has(r.productId)||['cmr','stac'].includes(data.access.profiles[r.productId]?.strategy)));
  }
  function checkSubmittedAvailability() {
    checkOnHazardChoice=false;
    if(location.protocol==='file:' || !navigator.onLine || !hazardFilter || availabilityController || grdc.catalogue) return;
    const scoped=scopedResults(), recommended=shortlistIds(scoped);
    const sources=searchableSources(scoped).filter(r=>recommended.has(r.productId)||supported.has(r.productId));
    if(sources.length) checkAvailability(sources);
  }
  async function checkAvailability(scoped) {
    if (availabilityController) {cancelAvailability();renderOverview();return;}
    if (dirty || !hazardFilter) return;
    const run=new AbortController();availabilityController=run;
    const queue=searchableSources(scoped).map(r=>r.productId);
    const started=document.getElementById('sc-check-availability');
    if(started)started.textContent='Cancel availability check';
    const checkNext=async()=>{
      while(queue.length&&!run.signal.aborted){
        const id=queue.shift(), options={signal:run.signal,pageBudget:1};
        try{
          if(supported.has(id)){
            const response=await SiteProviders.discover(id,query,options);
            if(!run.signal.aborted) recordStations(id,response);
          }else{
            const response=await SiteAccess.discover(id,query,options);
            if(!run.signal.aborted) rememberEvidence(id,hazardFilter,SiteShortlist.fileEvidence(accessProfile(id),response,query),response.requests);
          }
        }catch(error){
          if(!run.signal.aborted) rememberEvidence(id,hazardFilter,{level:0,label:'Check unavailable',detail:userError(error)});
        }
      }
    };
    await Promise.all([checkNext(),checkNext()]);
    function showResults(){
      if(run.signal.aborted)return;
      // Let a press on the current row finish before moving that row in the ranking.
      if(overview.querySelector('.sc-matrix-row:active')){requestAnimationFrame(showResults);return;}
      availabilityController=null;
      const focusedRow=document.activeElement?.dataset.overviewProduct;
      renderOverview(true);
      if(focusedRow)(overview.querySelector('[data-overview-product="'+focusedRow+'"]:not([hidden])')||overview).focus({preventScroll:true});
      announce.textContent='Availability check complete. The shortlist reflects the provider results.';
    }
    showResults();
  }
  function renderHazardChoice() {
    const group = data.hazard_groups.find(g => g.id === hazardFilter), chosen = hazardFilter !== null;
    const applied=!dirty&&results.length>0;
    const toReview=new Set(results.filter(r=>r.status!=='excluded'&&r.networkInScope!==false).map(r=>r.productId));
    hazardCountNote.textContent=applied?'Counts show catalog matches for your dates and area. Station coverage and files need a provider check.':'Catalog totals. Submit the project to update the counts.';
    for(const [i,tile] of Array.from(hazardTiles.children).entries()){
      const g=data.hazard_groups[i], matched=g.products.filter(id=>toReview.has(id)), count=matched.length;
      const total=g.products.length;
      tile.querySelector('small').textContent=applied?count+' of '+total:total+' total';
      tile.title=applied?(count?'Counted for this project: '+matched.map(id=>byId.get(id).product_name).join(' · '):'No catalog matches for this project'):'';
      tile.setAttribute('aria-description',applied?count+' of '+total+' catalog sources to review for the submitted project':total+' sources in the catalog. Submit the edited project to update counts.');
      tile.setAttribute('aria-pressed',String(g.id===hazardFilter));
    }
    allDatasets.setAttribute('aria-pressed', String(hazardFilter === ''));
    hazardMessage.textContent = chosen ? scopedResults().length + ' datasets · ' + (group?.label || 'All hazard groups') : '';
    hazardMessage.classList.toggle('visually-hidden',chosen);
    catalogToggle.textContent='Browse or filter '+scopedResults().length+' sources';
    for (const section of [summary, guide, overview, workspace, bottom]) section.hidden = !chosen;
    for (const control of [summaryExport,briefExport,scopedExport]) control.disabled = dirty || !chosen;
    resultsJump.hidden = dirty || !chosen;
  }
  function selectScopedRecord() {
    const scoped = scopedResults();
    if (!scoped.length)return;
    if (!explicitSelection || !scoped.some(r => r.productId === selectedId)) {
      explicitSelection=false;
      const picks=shortlistIds(scoped);
      const id=picks.values().next().value||scoped[0].productId;
      if(id===selectedId)return;
      clearProviderState();
      selectedId=id;
    }
  }
  function chooseHazard(value, syncInventory = true) {
    if (value !== null && value !== '' && !data.hazard_groups.some(g => g.id === value)) return;
    if (hazardFilter === value) return;
    cancelAvailability();projectImportGeneration++; invalidateShare(); hazardFilter = value; compareAllDatasets = value === '';catalog.open=false;
    selectScopedRecord(); clearFilters(); renderOverview(); renderPanel();
    if (syncInventory) app.setHazardGroup(value || '');
    if(value && checkOnHazardChoice && syncInventory && !dirty) checkSubmittedAvailability();
    updateSharedProject(); saveRecent();
    if(syncInventory&&value!==null&&!dirty&&window.matchMedia('(max-width: 850px)').matches)reveal(overview);
  }
  function includeProduct(id) {
    if (scopedResults().some(r => r.productId === id)) return;
    cancelAvailability();
    const inventoryGroup = data.hazard_groups.find(g => g.id === app.getHazardGroup() && g.products.includes(id));
    hazardFilter = (inventoryGroup || data.hazard_groups.find(g => g.products.includes(id)))?.id || '';
    compareAllDatasets = hazardFilter === '';
    app.setHazardGroup(hazardFilter); renderSummary();
  }
  function matrixDates(result, dates) {
    if (result.spatialRelation === 'outside') return 'Outside geographic coverage';
    const segments = result.temporalSegments || [];
    if (!segments.length) return 'Dates not assessed';
    const meaning = kind => kind === 'documented' ? 'documented' : kind === 'outside' ? 'outside documented dates' : 'to check';
    if (segments.length === 1) {
      const kind = segments[0].kind;
      if(result.temporalResolution==='monthly_solution')return kind==='documented'?'Monthly solution coverage documented':kind==='outside'?'No documented monthly solution':'Monthly solutions need checking';
      return kind === 'documented' ? 'Full period documented' : kind === 'outside' ? 'No documented date overlap' : 'Dates need checking';
    }
    if(result.temporalResolution==='monthly_solution'){
      const month=new Intl.DateTimeFormat('en-US',{month:'short',year:'numeric',timeZone:'UTC'});
      const months=d=>{const date=new Date(d);return 12*date.getUTCFullYear()+date.getUTCMonth();};
      const describe=kind=>kind==='documented'?'with solutions':kind==='outside'?'without documented solutions':'to check';
      if(segments.length<=3)return segments.map(s=>month.formatRange(Date.parse(s.start),Date.parse(s.end))+' '+describe(s.kind)).join(' · ');
      const counts=new Map();
      for(const s of segments){const label=describe(s.kind);counts.set(label,(counts.get(label)||0)+months(s.end)-months(s.start)+1);}
      return [...counts].map(([label,n])=>n+' solution '+(n===1?'month ':'months ')+label).join(' · ');
    }
    if (segments.length === 2) return segments.map(segment => {
      const first = Date.parse(segment.start), last = Date.parse(segment.end);
      return dates.formatRange(first, last).replace(/\s*–\s*/g,'–') + ' ' + meaning(segment.kind);
    }).join(' · ');
    const counts = new Map();
    for (const segment of segments) {
      const label = meaning(segment.kind), days = (Date.parse(segment.end) - Date.parse(segment.start)) / 86400000 + 1;
      counts.set(label, (counts.get(label) || 0) + days);
    }
    return [...counts].map(([label, days]) => days + (days === 1 ? ' day ' : ' days ') + label).join(' · ');
  }
  function renderOverview(refreshResults=false){
    const scoped = scopedResults();
    if (!scoped.length) {overview.replaceChildren();return;}
    const families = [
      ['fit','Potential fit','Inspect the files for the part of your project that overlaps.'],
      ['find','Find observations','Find a station, event or satellite pass and check its observations.'],
      ['check','Check support','Verify the dates, variable, archive or scenario identified in the record.'],
      ['outside','Outside','The project falls outside the documented dates or geographic extent.']
    ];
    guideGroups.replaceChildren(...families.map(([key,name,description])=>node('div',{},node('dt',{},name+' ('+scoped.filter(r=>statusGroup(r).key===key).length+')'),node('dd',{},description))));
    const canExpand=scoped.length>shortlistLimit, compact=canExpand&&!compareAllDatasets;
    const picks=compact?shortlistIds(scoped):null;
    const grid=node('div',{class:'sc-matrix'+(!compact&&scoped.length>16?' sc-matrix-many':''),id:'sc-matrix-results',role:'group','aria-label':compact?'Project dataset shortlist':scoped.length+' dataset screening results in the selected hazard group'});
    const rows=node('div',{class:'sc-matrix-rows'});
    grid.append(node('div',{class:'sc-matrix-head','aria-hidden':'true'},node('span',{},'Dataset'),node('span',{},'Screening result'),node('span',{},'Catalog date coverage')),rows);
    const start=Date.parse(query.start),end=Date.parse(query.end)+86400000,span=end-start;
    const dates=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',timeZone:'UTC',...(query.start.slice(0,4)!==query.end.slice(0,4)?{year:'numeric'}:{})});
    const projectDates=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).formatRange(start,Date.parse(query.end)).replace(/\s*–\s*/g,'–');
    const order={fit:0,find:1,check:2,outside:3};
    const ordered=compact || hazardFilter&&!canExpand?[...(picks||shortlistIds(scoped))]:[];
    const position=id=>ordered.includes(id)?ordered.indexOf(id):Infinity;
    for(const result of [...scoped].sort((a,b)=>position(a.productId)-position(b.productId)||order[statusGroup(a).key]-order[statusGroup(b).key]||byId.get(a.productId).product_name.localeCompare(byId.get(b.productId).product_name))){
      const product=byId.get(result.productId),g=statusGroup(result),track=node('span',{class:'sc-matrix-track','aria-hidden':'true'});
      if(result.spatialRelation==='outside')track.classList.add('spatially-excluded');
      for(const segment of result.temporalSegments||[]){
        if(segment.kind==='outside')continue;
        const a=Math.max(start,Date.parse(segment.start)),b=Math.min(end,Date.parse(segment.end)+86400000);if(b<=a)continue;
        track.append(node('span',{class:segment.kind==='documented'?'sc-matrix-bar bounded':'sc-matrix-unchecked',
          'data-start':segment.start,'data-end':segment.end,'data-kind':segment.kind,title:segment.reason,
          style:'left:'+((a-start)/span*100)+'%;width:'+((b-a)/span*100)+'%'}));
      }
      const coverage=matrixDates(result,dates);
      const label=product.product_name+' · '+result.label+' · '+coverage+(result.notices?.length?' · '+result.notices.join('; '):'');
      const control=button('',()=>{clearFilters();selectProduct(result.productId);reveal(panel);},'sc-matrix-row '+g.key,{'data-overview-product':result.productId,'aria-pressed':String(result.productId===selectedId),'aria-description':result.notices?.join('. ')||undefined,title:label});
      const rule=rules[result.productId],extras=compact&&explicitSelection&&result.productId===selectedId&&!picks.has(selectedId);
      control.hidden=compact&&!picks.has(result.productId)&&!extras;
      const kind=rule.support_type==='grid'&&rule.domain.kind==='regional'?'Regional grid':supportLabels[rule.support_type];
      const availability=evidenceFor(result.productId);
      const role=[SiteShortlist.publisher(product.provider).name,kind,timeLabels[rule.time_step]].filter(Boolean).join(' · ');
      const resolutionLabels=(result.resolutionChecks||[]).map(c=>c.label).filter(label=>label!==result.label);
      control.append(node('span',{class:'sc-matrix-name'},product.product_name,compact?node('small',{},(extras?'Selected for inspection · ':'')+role):null),node('span',{class:'sc-matrix-status'},[result.label,...resolutionLabels].join(' · '),availability?node('small',{class:'sc-availability-note',title:availability.detail},availability.label):null),
        node('span',{class:'sc-matrix-period'},track,node('span',{class:'sc-matrix-date-text'},coverage)),node('span',{class:'sc-matrix-arrow','aria-hidden':'true'},'›'));
      rows.append(control);
    }
    const tools=node('div',{class:'sc-matrix-tools'});
    const canCheck=hazardFilter && searchableSources(scoped).length>0;
    if(canCheck) tools.append(button(availabilityController?'Cancel availability check':'Check local availability',()=>checkAvailability(scoped),'btn small',{id:'sc-check-availability',disabled:dirty?'':undefined,title:'Check this group’s searchable public station and file listings. Other sources use catalog coverage.'}));
    if(canExpand){
      const select=node('select',{class:'sc-select',id:'sc-dataset-picker','aria-label':'Choose a dataset from all '+scoped.length+' results'},node('option',{value:''},'Choose from all '+scoped.length+' datasets…'));
      for(const result of [...scoped].sort((a,b)=>byId.get(a.productId).product_name.localeCompare(byId.get(b.productId).product_name)))select.append(node('option',{value:result.productId},byId.get(result.productId).product_name));
      const open=button('Open dataset',()=>{if(select.value){clearFilters();selectProduct(select.value);reveal(panel);}},'btn small');
      open.disabled=true;select.addEventListener('change',()=>{open.disabled=!select.value;});
      const toggle=button(compact?'Compare all '+scoped.length:'Show shortlist',()=>{compareAllDatasets=!compareAllDatasets;renderList();renderOverview();overview.querySelector('.sc-matrix-toggle')?.focus({preventScroll:true});},'btn small sc-matrix-toggle',{'aria-controls':'sc-matrix-results','aria-expanded':String(!compact)});
      tools.append(select,open,toggle);
    }
    const patterns=node('ul',{class:'sc-matrix-legend-items'});
    for(const [kind,label] of [['solid','Documented dates'],['striped','Dates to check'],['blank','Outside documented dates']]){
      const swatch=node('span',{class:'sc-matrix-track','aria-hidden':'true'});
      if(kind!=='blank')swatch.append(node('span',{class:kind==='striped'?'sc-matrix-unchecked':'sc-matrix-bar',style:'left:0;width:100%'}));
      patterns.append(node('li',{'data-pattern':kind},swatch,node('span',{},label)));
    }
    const patternLegend=node('aside',{class:'sc-matrix-legend-box','aria-labelledby':'sc-matrix-legend-title'},
      node('h3',{id:'sc-matrix-legend-title'},'Date bars'),patterns);
    const summaryText=compact?picks.size+' starting '+(picks.size===1?'point':'points')+' from '+scoped.length+' datasets':scoped.length+' datasets';
    const noFit=compact&&!picks.size?p('No starting point identified for these dates and location. You can still open any record.','sc-matrix-empty'):null;
    if(refreshResults && overview.querySelector('#sc-matrix-results')){
      // Keep the picker and its Open button attached while the user operates them.
      overview.querySelector('.sc-overview-heading span').textContent=summaryText+' · '+projectDates;
      const checkButton=overview.querySelector('#sc-check-availability');
      if(checkButton)checkButton.textContent='Check local availability';
      overview.querySelector('.sc-matrix-empty')?.remove();
      if(noFit)overview.querySelector('.sc-matrix-legend-box').before(noFit);
      overview.querySelector('#sc-matrix-results').replaceWith(grid);
      return;
    }
    overview.replaceChildren(node('div',{class:'sc-overview-heading'},node('h2',{id:'sc-overview-title'},compact?'Dataset shortlist':'Dataset coverage matrix'),node('span',{},summaryText+' · '+projectDates)),
      p('Date bars show periods documented in the catalog. Provider checks update the shortlist for this project.','sc-matrix-explainer'),...(canExpand||canCheck?[tools]:[]),...(noFit?[noFit]:[]),patternLegend,grid,guide);
  }

  function numberInput(id) {const value = document.getElementById(id)?.value.trim(); return value === undefined || value === '' ? NaN : Number(value);}
  function resetPeriod() {
    periodSelect.value = 'dates'; periodCount.hidden = true; periodError = '';
    document.getElementById('sc-past-days').removeAttribute('aria-invalid');
    periodNote.classList.remove('sc-period-invalid');
    periodNote.textContent = 'Shortcuts end yesterday (UTC). Provider reporting days vary; recent data may be delayed or provisional.';
  }
  function applyRecentPeriod() {
    if (periodSelect.value === 'dates') {resetPeriod(); return;}
    periodCount.hidden = periodSelect.value !== 'days';
    const days = periodSelect.value === 'days' ? numberInput('sc-past-days') : Number(periodSelect.value);
    const end = new Date(); end.setUTCHours(0, 0, 0, 0); end.setUTCDate(end.getUTCDate() - 1);
    const start = new Date(end); start.setUTCDate(start.getUTCDate() - days + 1);
    periodError = !Number.isSafeInteger(days) || days < 1 ? 'Enter a positive whole number of days.'
      : !Number.isFinite(start.getTime()) || start.getUTCFullYear() < 1 ? 'The day count would go before 0001-01-01. Choose a shorter period.' : '';
    document.getElementById('sc-past-days').setAttribute('aria-invalid', String(!!periodError));
    periodNote.classList.toggle('sc-period-invalid', !!periodError);
    markDirty();
    if (periodError) {periodNote.textContent = periodError; return;}
    document.getElementById('sc-start').value = start.toISOString().slice(0, 10);
    document.getElementById('sc-end').value = end.toISOString().slice(0, 10);
    periodNote.textContent = days + (days === 1 ? ' calendar day' : ' calendar days') + ', ending ' + end.toISOString().slice(0, 10) + ' (yesterday UTC when selected). Dates stay fixed. Provider reporting days vary; recent data may be delayed or provisional.';
  }
  function draftQuery() {
    const period = {start: document.getElementById('sc-start').value, end: document.getElementById('sc-end').value};
    return draftMode === 'area' ? {mode: 'area', geometry: draftArea?.geometry || null, areaName: draftArea?.name || '', areaSource: draftArea?.source || null, bufferKm: draftBufferKm, ...period} : {mode: 'point', lat: draftPoint.lat, lon: draftPoint.lon, radiusKm: draftPoint.radiusKm, ...period};
  }
  function markDirty() {
    cancelAvailability();
    projectImportGeneration++;invalidateShare();
    dirty = true; dirtyNotice.hidden = false; resultsJump.hidden = true; inputError.hidden = true;
    const check=document.getElementById('sc-check-availability');if(check)check.disabled=true;
    renderHazardChoice();
    for (const control of [summaryExport,briefExport,scopedExport]) control.disabled = true;
    cancelPending(); cancelAccessPending(); mapApi?.cancelDrawing(); mapApi?.setStations([], ''); renderPanel();
  }
  function renderGeometryControls() {
    if (Number.isFinite(draftPoint.lat) && Number.isFinite(draftPoint.lon)) {
      hucPointButton.textContent = 'Find units at project point ('+draftPoint.lat+', '+draftPoint.lon+')';
    }
    modeSelect.value = draftMode; pointHelp.hidden = draftMode === 'area'; areaControls.hidden = draftMode !== 'area';
    if (draftMode === 'point') {
      locationFields.replaceChildren(field('sc-lat', 'Latitude', 'number', Number.isFinite(draftPoint.lat) ? draftPoint.lat : '', {min: -90, max: 90, step: 'any', inputmode: 'decimal'}), field('sc-lon', 'Longitude', 'number', Number.isFinite(draftPoint.lon) ? draftPoint.lon : '', {min: -180, max: 180, step: 'any', inputmode: 'decimal'}));
      rangeField.replaceChildren(node('label', {for: 'sc-radius'}, 'Search radius · km'), node('input', {id: 'sc-radius', type: 'number', min: 0, step: 'any', value: draftPoint.radiusKm, required: ''}));
      queryHint.textContent = 'WGS84 coordinates · radius finds candidates, not representative stations';
    } else {
      const areaNameButton = button(draftArea?.name || 'Choose a footprint below', () => {areaMethod.focus(); areaControls.scrollIntoView({block: 'nearest'});}, 'sc-area-name');
      locationFields.replaceChildren(node('div', {class: 'sc-field sc-area-name-field'}, node('span', {class: 'sc-label'}, 'Selected project area'), areaNameButton));
      rangeField.replaceChildren(node('label', {for: 'sc-buffer'}, 'Outside buffer · km'), node('input', {id: 'sc-buffer', type: 'number', min: 0, step: 'any', value: draftBufferKm, required: ''}));
      queryHint.textContent = 'Area buffer defaults to 0 km; catalog screening uses the original footprint.';
    }
    areaSelection.replaceChildren();
    if (draftArea) {
      const source = draftArea.source || {};
      areaSelection.append(node('strong', {}, draftArea.name), p('Accepted ' + draftArea.geometry.type + (source.generalized && /^huc(8|10|12)$/.test(source.kind) ? ' · provider-generalized boundary' : ' · no silent simplification'), 'sc-area-help'));
      if (/^huc(8|10|12)$/.test(source.kind)) {
        areaSelection.append(p(source.processing,'sc-area-help'),link(source.fullGeometryUrl,'Full USGS boundary (GeoJSON) ↗'));
      }
      if (source.kind==='user-upload' && /altitude/i.test(source.processing||'')) areaSelection.append(p(source.processing,'sc-area-help'));
      if (source.note) areaSelection.append(p(source.note,'sc-callout'));
      if (source.url) areaSelection.append(link(source.url, 'Boundary source ↗'));
      else areaSelection.append(node('span', {}, source.name || source.kind || 'User-supplied boundary'));
      if (source.vintage) areaSelection.append(node('span', {}, ' · ' + source.vintage));
      areaSelection.append(node('details', {class: 'sc-disclosure'}, node('summary', {}, 'Boundary source and precision'),
        node('dl', {class: 'sc-facts'}, fact('Provider / dataset', [source.provider, source.dataset].filter(Boolean).join(' · ') || source.kind), fact('Represented vintage', source.vintage || source.boundaryYearRepresented), fact('Upstream source', Array.isArray(source.boundarySource) ? source.boundarySource.join('; ') : source.boundarySource || source.name), fact('Boundary licence', source.boundaryLicense || 'See source terms')),
        p('Provider boundaries can be generalized or represent an older year. They are not uniformly survey-grade.', ''), source.processing && !/altitude/i.test(source.processing) ? p(source.processing, '') : null, source.terms ? link(source.terms, 'Boundary terms ↗') : null));
    }
  }
  function updateDraftMap(fit = false) {
    const draft = draftQuery(), errors = window.SiteGeometry.validate(draft);
    if (errors.length) {mapState.textContent = 'Map retains last valid geometry'; return;}
    mapState.textContent = dirty ? 'Draft geometry · run Check site' : 'Submitted geometry';
    mapNotice.textContent = draft.mode === 'area' && draft.bufferKm > 0 ? 'Amber buffer outline is approximate; eligibility uses distance to the actual polygon boundary.' : '';
    mapApi?.setQuery(draft); if (fit) mapApi?.fit();
  }
  function geometryError(message) {inputError.replaceChildren(node('p', {}, message)); inputError.hidden = false; announce.textContent = message;}
  function acceptArea(area) {
    try {
      const geometry = window.SiteGeometry.normalize(area.geometry);
      cancelAreaLookup(); draftArea = {name: area.name || 'Project area', geometry, source: area.source || {kind: 'user-provided'}}; draftMode = 'area';
      renderGeometryControls(); markDirty(); updateDraftMap(true); announce.textContent = 'Accepted ' + draftArea.name + '. Run Check site to screen this footprint.';
    } catch (error) {geometryError(userError(error));}
  }
  function useRectangle(origin = 'entered') {
    try {
      const west = numberInput('sc-west'), south = numberInput('sc-south'), east = numberInput('sc-east'), north = numberInput('sc-north');
      const geometry = window.SiteGeometry.rectangle(west, south, east, north);
      acceptArea({name: 'Rectangle ' + [west,south,east,north].map(v => v.toFixed(3)).join(', '), geometry, source: {kind: origin === 'drawn' ? 'drawn-rectangle' : 'entered-rectangle', coordinates: {west,south,east,north}, coordinateSystem: 'WGS84 / EPSG:4326', createdAt: new Date().toISOString()}});
    } catch (error) {geometryError(userError(error));}
  }
  async function uploadArea() {
    const file = uploadInput.files[0]; if (!file) return;
    cancelAreaLookup(); const token = areaGeneration;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('Upload exceeds 8 MB. Use a smaller explicitly prepared GeoJSON; the tool will not silently simplify it.');
      const bytes = await file.arrayBuffer();
      const input = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
      if (token !== areaGeneration) return;
      const geometry = window.SiteGeometry.normalize(input), normalizationNotes=window.SiteGeometry.normalizationNotes(input);
      const sha256 = async value => {if (!window.crypto?.subtle) return null; try {const hash = await window.crypto.subtle.digest('SHA-256', value); return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');} catch (_) {return null;}};
      const [rawSha256, geometrySha256] = await Promise.all([sha256(bytes), sha256(new TextEncoder().encode(JSON.stringify(geometry)))]);
      if (token !== areaGeneration) return;
      acceptArea({name: input.properties?.name || file.name, geometry, source: {kind: 'user-upload', name: file.name, bytes: file.size, loadedAt: new Date().toISOString(), coordinateSystem: 'WGS84 / EPSG:4326', rawSha256, geometrySha256, processing:normalizationNotes.join(' ')||'Longitude and latitude coordinates unchanged.', hashStatus: rawSha256 && geometrySha256 ? 'SHA-256 recorded' : 'Web Crypto hashing unavailable'}});
    } catch (error) {if (token === areaGeneration) geometryError('GeoJSON could not be accepted: ' + userError(error));}
  }
  function cancelAreaLookup() {areaGeneration++; areaController?.abort(); areaController = null; areaSearchButton.disabled = false;}
  async function searchAreas(atPoint = false) {
    const huc = areaMethod.value === 'huc', text = areaText.value.trim();
    if (!text && !atPoint) {areaStatus.textContent = huc ? 'Enter a unit name or HUC code, or use the project point.' : 'Enter a boundary name.'; return;}
    cancelAreaLookup(); areaController = new AbortController(); const token = areaGeneration;
    areaSearchButton.disabled = true; areaStatus.textContent = 'Finding named boundaries…'; areaMatches.replaceChildren();
    try {
      const result = await window.SiteAreas.search({kind:huc ? hucLevel.value : areaKind.value, text,
        state:areaState.value || undefined, point:atPoint ? draftPoint : undefined}, {signal: areaController.signal});
      if (token !== areaGeneration) return;
      areaLookup = result;
      areaStatus.textContent = result.items.length + (result.items.length === 1 ? ' match' : ' matches') + (result.complete === false ? ' · partial search; refine the name or inspect scope.' : '.') + (result.items.length ? ' Select one to load its polygon.' : '');
      const matches = node('select', {id: 'sc-area-match', class: 'sc-select', 'aria-label': 'Boundary search results'}, node('option', {value: ''}, 'Select the exact boundary…'));
      result.items.forEach((item, i) => matches.append(node('option', {value: i}, item.name)));
      matches.addEventListener('change', () => {if (matches.value !== '') loadNamedArea(result.items[Number(matches.value)]);});
      areaMatches.replaceChildren(matches);
      if (result.notes?.length) areaMatches.append(node('details', {class: 'sc-disclosure'}, node('summary', {}, 'Boundary search scope'), node('ul', {}, result.notes.map(note => node('li', {}, note)))));
    } catch (error) {if (token === areaGeneration) {
      const retry = huc && !atPoint && !/^\d+$/.test(text) && /timed out|HTTP 5\d\d/i.test(error.message)
        ? ' Try the complete HUC code or find units at the project point.' : '';
      areaStatus.textContent = error.name === 'AbortError' ? 'Boundary search cancelled.' : userError(error) + retry;
    }}
    finally {if (token === areaGeneration) {areaSearchButton.disabled = false; areaController = null;}}
  }
  async function loadNamedArea(item) {
    cancelAreaLookup(); draftArea=null;markDirty();renderGeometryControls();updateDraftMap();areaController = new AbortController(); const token = areaGeneration; areaStatus.textContent = 'Loading and validating the selected boundary…';
    try {
      const area = await window.SiteAreas.load(item, {signal: areaController.signal, wbdDetail:hucDetail.value});
      if (token !== areaGeneration) return;
      acceptArea({...area, source: {...area.source, searchRequests: areaLookup?.requests || []}}); areaStatus.textContent = 'Boundary accepted. Check site to apply it.';
    } catch (error) {if (token === areaGeneration) {
      const retry = /^huc(8|10|12)$/.test(item.kind) && hucDetail.value === 'full' && /limit|vertices|validation budget|too complex|timed out/i.test(error.message) ? ' Select USGS screening geometry to request a generalized boundary.' : '';
      areaStatus.textContent = error.name === 'AbortError' ? 'Boundary loading cancelled. No project area is selected.' : 'Boundary not loaded. No project area is selected. '+userError(error)+retry;
    }}
    finally {if (token === areaGeneration) areaController = null;}
  }

  function cancelPending() {
    if (loadingKind === 'coops-preflight' && discovery?.coopsPreflight) discovery.coopsPreflight = {...discovery.coopsPreflight, running: false, cancelled: true, complete: false};
    generation++;
    if (controller) controller.abort();
    controller = null; loading = ''; loadingKind = '';
  }
  function clearProviderState() {
    stationChoiceRequired = false;
    stationNetwork = 'all';
    cancelPending(); discovery = null; sample = null; stationDownloadPlan = null; savedLabel = ''; selectedStationId = ''; activeSeries = 0; networkError = ''; stationSearch = ''; stationRelation = 'all'; stationPage = 0; coopsFilter = 'matching';
    clearAccessState();
    mapApi?.setStations([], '');
  }
  function setQuery(next, submitted = false) {
    projectImportGeneration++;invalidateShare();
    if (results.length && ['mode','lat','lon','radiusKm','bufferKm','start','end','areaName'].every(key=>(next[key]??null)===(query[key]??null)) && JSON.stringify(next.geometry||null)===JSON.stringify(query.geometry||null) && JSON.stringify(next.areaSource||null)===JSON.stringify(query.areaSource||null)) {dirty=false;dirtyNotice.hidden=true;inputError.hidden=true;renderHazardChoice();renderOverview();renderPanel();updateDraftMap();return;}
    cancelAvailability();projectEvidence.clear();
    if (submitted) explicitSelection = false;
    cancelAreaLookup(); clearProviderState(); query = next.mode === 'area' ? {...next, geometry: window.SiteGeometry.normalize(next.geometry), mode: 'area', bufferKm: next.bufferKm ?? 0} : {...next, mode: 'point', radiusKm: next.radiusKm ?? 100};
    dirty = false; dirtyNotice.hidden = true; inputError.hidden = true;
    draftMode = query.mode;if(draftMode==='area')showProjectMap();
    if (query.mode === 'area') {draftArea = {name: query.areaName, geometry: query.geometry, source: query.areaSource}; draftBufferKm = query.bufferKm;}
    else draftPoint = {...query};
    renderGeometryControls();
    summaryExport.disabled = false;
    document.getElementById('sc-start').value = query.start; document.getElementById('sc-end').value = query.end;
    if (!submitted) resetPeriod();
    results = window.SiteScreening.evaluateAll(products, rules, query);
    selectScopedRecord();
    renderSummary(); renderList(); renderOverview(); renderPanel(); updateDraftMap(true); updateSharedProject();saveRecent();
  }
  function selectProduct(id) {
    projectImportGeneration++;invalidateShare();
    if (!byId.has(id)) return;
    if (id !== selectedId) clearProviderState();
    selectedId = id;explicitSelection=true; renderSummary(); renderList(); renderPanel();renderOverview();updateSharedProject();saveRecent();
    if (window.matchMedia('(max-width: 850px)').matches) reveal(panel);
    else list.querySelector('[aria-pressed="true"]')?.focus({preventScroll: true});
  }
  function renderSummary() {
    renderHazardChoice();
    const scoped = scopedResults();
    const entries = [
      ['possible', scoped.filter(r=>r.status==='possible').length, 'Dates and area fit', 'Read any partial-fit details'],
      ['lookup', scoped.filter(r=>lookupStatus(r.status)).length, 'Needs a next step', 'Filter by the action below'],
      ['excluded', scoped.filter(r=>r.status==='excluded').length, 'Outside area or dates', 'Each result names the failed check']
    ];
    const filters=entries.map(([value,count,title,subtitle])=>{
      const control=button('',()=>{statusFilter=value;actionFilter='';renderSummary();renderList();summary.querySelector('[aria-pressed="true"]')?.focus({preventScroll:true});},'',{'aria-pressed':String(statusFilter===value)});
      control.append(node('b',{},count),node('span',{},node('strong',{},title),subtitle));return control;
    });
    summary.replaceChildren(node('div',{class:'sc-summary-caption'},p(scoped.length+' datasets in your selection · '+siteLabel(query)+' · '+dateRange(query)),button('Show all results in this group',()=>{compareAllDatasets=true;clearFilters();renderOverview();},'btn small',{'aria-pressed':String(statusFilter==='all'&&(!scoped.length||compareAllDatasets||scoped.length<=shortlistLimit))})),
      node('div',{class:'sc-summary-outcomes',role:'group','aria-label':'Dataset screening outcomes'},...filters));
    if (statusFilter==='lookup') {
      const counts=new Map();for(const result of scoped.filter(r=>lookupStatus(r.status)))counts.set(result.label,(counts.get(result.label)||0)+1);
      summary.append(node('div',{class:'sc-action-filters',role:'group','aria-label':'Filter next steps'},...[...counts].map(([label,count])=>button(label+' ('+count+')',()=>{actionFilter=actionFilter===label?'':label;renderSummary();renderList();},'btn small',{'aria-pressed':String(actionFilter===label)}))));
    }
  }
  function renderList() {
    const scoped = scopedResults();
    const filtered = scoped.filter(r => {
      const product = byId.get(r.productId);
      return (statusFilter === 'all' || (statusFilter === 'lookup' ? lookupStatus(r.status) : r.status === statusFilter)) && (!actionFilter || r.label===actionFilter) &&
        (!liveOnly || supported.has(r.productId)) &&
        (!accessFilterValue || accessProfile(r.productId).kind === accessFilterValue) &&
        (!searchTerm || [product.product_name, product.provider, product.variable].join(' ').toLowerCase().includes(searchTerm));
    }).sort((a,b) => Number(supported.has(b.productId)) - Number(supported.has(a.productId)) || byId.get(a.productId).product_name.localeCompare(byId.get(b.productId).product_name));
    caption.textContent = filtered.length+' of '+scoped.length+' sources';
    const previousScroll = list.scrollTop;
    list.replaceChildren();
    if (hazardFilter === null) return;
    if (!filtered.length) {
      list.append(node('div', {class: 'sc-empty'}, node('strong', {}, 'No records match these filters'), 'Clear the filters to see this hazard group, or choose another group above.', button('Clear filters', clearFilters, 'btn small')));
      return;
    }
    for (const r of filtered) {
      const product = byId.get(r.productId);
      const b = button('', () => selectProduct(r.productId), 'sc-record', {'aria-pressed': String(selectedId === r.productId), 'data-product': r.productId});
      b.append(node('h3', {}, product.product_name), node('span', {class:'sc-provider-label'}, product.provider));
      list.append(b);
    }
    list.scrollTop = previousScroll;
  }
  function clearFilters() {
    statusFilter = 'all'; actionFilter = ''; searchTerm = ''; liveOnly = false; accessFilterValue = '';
    search.value = ''; liveFilter.checked = false; accessFilter.value = '';
    renderSummary(); renderList();
  }
  function evidenceLinks(product, rule) {
    const ids = rule && Array.isArray(rule.evidence_ids) ? rule.evidence_ids : product.evidence_ids;
    return node('div', {class: 'sc-source-links'}, ids.slice(0, 5).map((id, i) => {
      const source = data.sources[id];
      if (!source) return null;
      const a = link(source.url, 'Source ' + (i + 1) + ' ↗');
      a.title = source.title; a.setAttribute('aria-label', source.title);
      return a;
    }));
  }
  function stationWorkflowStatus() {
    if (!supported.has(selectedId) || !sample) return null;
    const stale = dirty ? ' For the last submitted project; inputs have changed.' : '';
    const count = (sample.series || []).reduce((sum, series) => sum + (series.points || []).filter(point => Number.isFinite(point.value)).length, 0);
    const datum = selectedId === 'noaa_coops_water_level' ? ' · datum ' + (sample.provenance?.datumCode || sample.provenance?.datum || 'not established') : '';
    const days = Number.isInteger(sample.provenance?.reportingDays) ? ' on ' + sample.provenance.reportingDays + ' of ' + sample.provenance.windowDays + (sample.provenance.windowDays === 1 ? ' day' : ' days') : '';
    return {tone: savedLabel || !count ? 'warning' : 'success', title: previewEvidenceLabel() + ' · ' + count + (selectedId==='ghcn_daily'?' numeric daily values':' numeric values'),
      detail: sample.station.name + ' [' + sample.station.id + '] · ' + previewPeriod(sample.window) + datum + (days ? ' · reports' + days : '') + '. ' + (savedLabel ? 'Saved provider response; no live request.' : '') + stale};
  }
  function renderCoverageTimeline(rule) {
    if (!window.SiteCoverageTimeline) return null;
    const station = discovery?.stations.find(item => item.id === selectedStationId);
    const model = SiteCoverageTimeline.model(query, rule, station,{fullRecord:timelineFull});
    if (model.state !== 'ready') return p('Metadata timeline: ' + (model.rows.find(row => row.id !== 'project')?.note || model.notes.find(note => !note.startsWith('This is a metadata') && !note.startsWith('The axis focuses')) || 'Dated product or station metadata are not established.'), 'sc-timeline-unknown');
    const section = node('section', {class: 'sc-timeline', 'aria-label': 'Project and metadata period timeline'}, node('h3', {}, model.title),
      p(station ? 'Station bars show listed record spans. Individual days can have gaps.' : 'Dataset-wide record spans can contain gaps. See the matrix for regional coverage.', 'sc-timeline-note'),button(timelineFull?'Zoom to project':'Show full record',()=>{timelineFull=!timelineFull;renderPanel();},'btn small'));
    const rows = node('div', {class: 'sc-timeline-rows'});
    for (const row of model.rows.filter(row => row.segments.length)) {
      const track = node('div', {role: 'group', class: 'sc-timeline-track', 'aria-label': row.label + '; ' + row.note});
      const a=(model.project.startMs-model.axis.startMs)/(model.axis.endMs-model.axis.startMs),b=(model.project.endMs-model.axis.startMs)/(model.axis.endMs-model.axis.startMs);
      track.append(node('span',{class:'sc-project-window',style:'left:'+(a*100)+'%;width:'+((b-a)*100)+'%',title:'Project '+dateRange(query),'aria-hidden':'true'}));
      for (const tick of model.axis.ticks || []) track.append(node('span', {class:'sc-timeline-gridline',style:'left:'+(tick.fraction*100)+'%','aria-hidden':'true'}));
      for (const segment of row.segments) {
        if (!Number.isFinite(segment.startFraction) || !Number.isFinite(segment.endFraction)) continue;
        const classes = ['sc-timeline-segment', segment.kind, segment.openStart || segment.openEnd ? 'open' : '', segment.clippedStart ? 'clipped-start' : '', segment.clippedEnd ? 'clipped-end' : '', segment.point ? 'point' : ''].filter(Boolean).join(' ');
        const label = String(segment.label).replace(/\.000Z/g, 'Z');
        track.append(node('span', {class: classes, style: 'left:' + (segment.startFraction * 100) + '%;width:' + ((segment.endFraction - segment.startFraction) * 100) + '%', title: label, role: 'img', 'aria-label': label}));
      }
      const offscreen = row.segments.filter(segment => segment.offscreen).length;
      const unresolved = row.segments.filter(segment => segment.unknown || segment.invalid).length;
      const label = node('div', {class: 'sc-timeline-row-label', title: row.note}, row.label,
        !row.segments.length ? node('small', {}, 'Dates not established') : offscreen || unresolved ? node('small', {}, [offscreen ? offscreen + ' offscreen interval(s)' : '', unresolved ? unresolved + ' unresolved interval(s)' : ''].filter(Boolean).join(' · ')) : null);
      rows.append(node('div', {class: 'sc-timeline-row'}, label, track));
    }
    const axis = node('div', {class: 'sc-timeline-axis'}, (model.axis.ticks || []).map(tick => node('span', {style:'left:'+(tick.fraction*100)+'%'}, tick.label)));
    section.append(node('div', {class: 'sc-timeline-axis-row'}, node('span', {}, 'Visible dates'), axis));
    const visibleMarkers = model.markers.filter(marker => Number.isFinite(marker.positionFraction));
    if (visibleMarkers.length) section.append(node('div', {class: 'sc-timeline-row sc-timeline-marker-row'}, node('span', {class: 'sc-timeline-row-label'}, 'Metadata boundaries'),
      node('div', {class: 'sc-timeline-marker-track'}, visibleMarkers.map(marker => node('span', {class: 'sc-timeline-marker', style: 'left:' + (marker.positionFraction * 100) + '%', title: marker.label, role: 'img', 'aria-label': marker.label})))));
    const shown=model.rows.flatMap(row=>row.segments).filter(s=>Number.isFinite(s.startFraction)&&Number.isFinite(s.endFraction));
    section.append(rows,node('p',{class:'sc-timeline-legend'},node('span',{class:'project-window'},'Project window'),
      shown.some(s=>s.kind==='nominal') ? node('span',{class:'nominal'},'Catalog metadata') : null,
      shown.some(s=>s.kind==='station') ? node('span',{class:'station'},'Station metadata') : null,
      shown.some(s=>s.kind==='uncertain'||s.openStart||s.openEnd) ? node('span',{class:'uncertain'},'Open / uncertain') : null));
    section.append(node('details', {class: 'sc-disclosure'}, node('summary', {}, 'Exact intervals and timeline qualifications'),
      model.markers.length ? node('ul', {class: 'sc-timeline-markers'}, model.markers.map(marker => node('li', {}, marker.label + (marker.offscreen ? ' (' + marker.offscreen + ' the visible dates)' : '')))) : null,
      ...model.rows.map(row => node('div', {class: 'sc-timeline-row-details'}, node('strong', {}, row.label), p(row.note),
        row.segments.length ? node('ul', {}, row.segments.map(segment => node('li', {}, String(segment.label || 'Period unresolved').replace(/\.000Z/g, 'Z') +
          (segment.openStart || segment.openEnd ? ' Open endpoint: support beyond a known boundary is unconfirmed.' : '') +
          (segment.clippedStart || segment.clippedEnd ? ' Extends beyond the visible axis.' : '') + (segment.offscreen ? ' Entire interval is ' + segment.offscreen + ' the visible axis.' : '')))) : p('No dated interval is established.'))),
      node('ul', {}, model.notes.slice(1).map(note => node('li', {}, note)))));
    return section;
  }
  function renderPanel() {
    chartResizeObserver?.disconnect();
    chartResizeObserver = null;
    if (hazardFilter === null) {panel.replaceChildren();return;}
    const product = byId.get(selectedId), screening = resultFor(selectedId);
    if (!product || !screening) return;
    renderList();
    if(!explicitSelection&&!compareAllDatasets&&scopedResults().length>shortlistLimit&&!shortlistIds(scopedResults()).size){
      panel.replaceChildren(p('Choose a dataset to inspect its coverage and access route.'));
      return;
    }
    const rule = rules[selectedId] || {};
    const canPreview = supported.has(selectedId);
    const head = node('div', {class: 'sc-detail-head'}, node('h2', {}, product.product_name),
      p(product.provider + ' · ' + siteLabel(query), 'sc-detail-provider'),
      node('div', {class: 'sc-detail-actions'}, button('View full inventory record', () => app.openRecord(selectedId), 'btn small'), link(product.access_url, 'Provider access ↗', 'btn small')));
    const body = node('div', {class: 'sc-body'});
    const lead = !sample && !discovery ? screening.reasons[0] : null;
    const supportingReasons = [...new Set(screening.reasons)].filter(reason => reason !== lead && !(screening.notices || []).includes(reason));
    const why = node('details', {class: 'sc-disclosure'}, node('summary', {}, sample || discovery ? 'Catalog screening and sources' : 'Why this result?'),
      supportingReasons.length ? node('ul', {}, supportingReasons.map(reason => node('li', {}, reason))) : null,
      node('dl', {class: 'sc-facts'}, fact('Spatial check', screening.spatial), fact('Temporal check', screening.temporal), fact('Site versus extent', ({within:'Inside',partial:'Partly inside',outside:'Outside',near:'Near approximate edge',unknown:'Not established'}[screening.spatialRelation] || 'Not established'))),
      p('Catalog period: ' + product.temporal_coverage, ''), p('Catalog domain: ' + product.geographic_coverage, ''), evidenceLinks(product, rule));
    if (!sample && !discovery) {
      body.append(node('div', {class: 'sc-coverage'}, badge(statusGroup(screening).icon+' '+screeningFamily(screening), screening.status+' '+statusGroup(screening).key),
        screening.label !== screeningFamily(screening) ? p(screening.label, 'sc-coverage-specific') : null,
        lead ? p(lead) : null, why));
    }
    if (screening.notices?.length) (sample || discovery ? why : body).append(p(screening.notices.join(' · '), 'sc-record-notice'));
    if (dirty) body.append(p('Results below describe the last submitted project. The map shows the draft geometry. Run Check site to apply edited inputs.', 'sc-callout'));
    if (canPreview) {
      if (sample) {
        renderSample(body, product);
        const selected = discovery?.stations.find(station => station.id === selectedStationId);
        if (selected) renderStationDownload(body, selected, previewWindow(selected));
      }
      renderProvider(body, product, screening);
    }
    else {
      if(selectedId==='grdc_discharge') renderGrdcCatalogue(body);
      renderAccess(body, product, screening);
    }
    const timeline = renderCoverageTimeline(rule);
    if (timeline) body.append(timeline);
    if (sample || discovery) body.append(why);
    const terms = node('div', {class: 'sc-terms'},
      selectedId==='ghcn_daily'?null:p(product.limitations[0] || product.non_uses[0] || 'See the full record for scientific limitations.'),
      node('p', {}, node('strong', {}, 'Commercial use · '), human(product.commercial_use_status), ' ', link(product.license_url || product.documentation_url, 'Provider terms ↗')));
    if(selectedId==='ghcn_daily') why.append(p(product.limitations[0]));
    body.append(terms); panel.replaceChildren(head, body);
    if(discovery?.stations?.length||sample)showProjectMap();
    if (!dirty) {
      if(selectedId==='grdc_discharge') mapApi?.setStations(grdc.stations,grdc.selected);
      else mapApi?.setStations(discovery?.stations || (sample ? [sample.station] : []), selectedStationId);
    }
  }
  function renderGrdcCatalogue(body) {
    const card=node('section',{class:'sc-access-route','aria-label':'GRDC station catalogue'},node('h3',{},'Check GRDC stations'));
    const picker=node('input',{type:'file',id:'sc-grdc-file',accept:'.html,.htm,.xlsx,.csv,.tsv,.txt'});
    picker.disabled=dirty;
    const controls=node('div',{},p('Save the GRDC station map as HTML, or download a station workbook from the portal. Choose the file here to check the project footprint.','sc-access-summary'),
      node('div',{class:'sc-source-links'},link('https://grdc.bafg.de/data/database_statistics/station_maps/','GRDC station map ↗'),link('https://portal.grdc.bafg.de/','Catalogue workbook ↗')),
      node('label',{for:'sc-grdc-file',class:'sc-label'},'Station map, workbook or CSV'),picker);
    if(grdc.catalogue) card.append(node('details',{class:'sc-disclosure'},node('summary',{},'Change catalogue file'),controls));
    else card.append(controls);
    picker.addEventListener('change',async()=>{
      const file=picker.files[0];if(!file)return;
      const token=++grdc.generation;
      projectEvidence.delete('grdc_discharge');
      Object.assign(grdc,{busy:true,error:'',catalogue:null,query:null,stations:[],selected:'',page:0});renderPanel();
      try{
        const catalogue=await GrdcCatalogue.read(file);
        if(token===grdc.generation)grdc.catalogue=catalogue;
      }catch(e){if(token===grdc.generation)grdc.error=e.message;}
      if(token!==grdc.generation)return;
      grdc.busy=false;
      if(selectedId==='grdc_discharge'){
        renderPanel();renderOverview();
        if(!dirty&&grdc.stations.length)showProjectMap();
      }
    });
    if(grdc.busy)card.append(p('Reading catalogue…','sc-status-line'));
    if(grdc.error)card.append(node('p',{role:'alert',class:'sc-error'},grdc.error));
    if(grdc.catalogue){
      if(grdc.query!==query){
        grdc.stations=GrdcCatalogue.match(grdc.catalogue,query,SiteGeometry);grdc.query=query;grdc.selected='';grdc.page=0;
        if(grdc.stations.some(s=>s.dateState==='Year ranges overlap'))
          rememberEvidence('grdc_discharge','',{level:2,label:'Stations in imported catalog',detail:'GRDC-listed station years overlap the project. Check available discharge values.'});
      }
      const {name,skipped,stations}=grdc.catalogue, matches=grdc.stations;
      const allOutside=matches.length>0&&matches.every(s=>s.dateState==='Outside project years');
      card.append(node('p',{class:'sc-status-line',role:'status'},matches.length.toLocaleString()+' spatial matches from '+stations.length.toLocaleString()+' stations in '+name+'.'+(allOutside?' All matched records fall outside the project years.':'')+(skipped?' Skipped '+skipped+' invalid rows.':'')));
      if(matches.length){
        const pageStart=grdc.page*grdcPageSize, list=node('ul',{class:'sc-grdc-list','aria-label':'Matching GRDC stations'});
        for(const s of matches.slice(pageStart,pageStart+grdcPageSize)){
          const distance=query.mode==='area'&&s.relation==='inside'?'Inside project area':s.distanceKm.toLocaleString(undefined,{maximumFractionDigits:1})+(query.mode==='area'?' km from boundary':' km from point');
          const periods=s.periods.filter(p=>p.kind!=='Record'||s.periods.length===1).map(p=>p.kind+' '+(p.endBand?'ended '+p.endBand:(p.start||'?')+'–'+(p.end||'?'))).join(' · ');
          const name=[s.id,s.name,s.river].filter(Boolean).join(' · ');
          const choose=button(name,()=>{grdc.selected=s.id;mapApi?.setStations(matches,s.id);for(const b of list.querySelectorAll('button'))b.setAttribute('aria-pressed',String(b===choose));},'sc-grdc-station',{'aria-pressed':String(grdc.selected===s.id)});
          list.append(node('li',{},choose,node('small',{},[distance,s.dateState,periods].filter(Boolean).join(' · '))));
        }
        card.append(list);
        if(matches.length>grdcPageSize){
          const pager=node('div',{class:'sc-station-pager'},button('Previous',()=>{grdc.page--;renderPanel();}),node('span',{},(pageStart+1)+'–'+Math.min(pageStart+grdcPageSize,matches.length)+' of '+matches.length),button('Next',()=>{grdc.page++;renderPanel();}));
          pager.firstElementChild.disabled=grdc.page===0;pager.lastElementChild.disabled=pageStart+grdcPageSize>=matches.length;card.append(pager);
        }
        const copy=button('Copy matching station numbers',async()=>{
          const ids=matches.map(s=>s.id).join(', ');
          try{await navigator.clipboard.writeText(ids); copy.textContent='Station numbers copied';}
          catch{const field=node('textarea',{'aria-label':'Matching GRDC station numbers',readonly:''});field.value=ids;copy.replaceWith(field);field.select();}
        });
        card.append(node('div',{class:'sc-source-links'},copy,link('https://portal.grdc.bafg.de/','Open GRDC station portal ↗')));
        card.append(p('Paste the numbers in “Station Name or Number” to inspect discharge. Catalogue years can include gaps.', 'sc-access-output-note'));
      }else card.append(p('No stations in this file meet the submitted distance or boundary.','sc-access-output-note'));
    }
    card.append(p('Portal downloads are for research. Commercial use of original discharge requires provider consent via GRDC.','sc-access-output-note'));
    body.append(card);
  }
  function cancelAccessPending() {
    accessGeneration++; accessController?.abort(); accessController = null; accessLoading = false;
  }
  function clearAccessState() {
    cancelAccessPending(); accessPlan = null; accessFileResult = null; accessOptions = {}; accessError = ''; lakeFilter = ''; fileSearch = ''; filePage = 0; selectedFileKeys.clear();
    fileBatchSource = null; fileBatchPlan = null;
  }
  function accessBlocked() {return dirty || resultFor(selectedId)?.status === 'excluded';}
  function prepareAccess(forDiscovery = false) {
    if (accessBlocked()) return false;
    cancelAccessPending(); accessError = ''; fileSearch = ''; filePage = 0; selectedFileKeys.clear();
    try {
      accessPlan = window.SiteAccess.prepare(selectedId, query, accessOptions);
      accessFileResult = {origin: 'prepared', files: accessPlan.files || [], notes: accessPlan.notes || [], complete: null, cursor: null, requests: []};
      if (accessPlan.errors?.length) accessError = accessPlan.errors.join(' ');
      announce.textContent = accessError || 'Download steps are ready. Follow the provider links or the displayed script instructions.';
    } catch (error) {accessPlan = null; accessFileResult = null; accessError = userError(error) || 'The project request could not be prepared.';}
    renderPanel();
    if (!forDiscovery && accessPlan && !accessError) reveal(document.getElementById('sc-access-output-title'));
    return !!accessPlan && !accessError;
  }
  function lakePicker(option, select) {
    const searchId='sc-lake-search';
    const search=node('input',{id:searchId,type:'search',class:'sc-search',value:lakeFilter,placeholder:'Type a lake name'});
    const project=query.mode==='area'?{...query,geometry:SiteGeometry.normalize(query.geometry)}:query;
    const lakes=option.choices.filter(c=>c.value);
    const ranked=lakes.map(c=>({choice:c,overlap:c.bounds && SiteGeometry.domainRelation(project,c.bounds)!=='outside',
      km:SiteGeometry.classify(project,c).distanceKm})).sort((a,b)=>Number(!!b.overlap)-Number(!!a.overlap)||a.km-b.km||a.choice.label.localeCompare(b.choice.label));
    const suggested=ranked.slice(0,3), suggestedIds=new Set(suggested.map(r=>r.choice.value));
    const normalize=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[_-]/g,' ').trim();
    function fill() {
      const needle=normalize(search.value);
      select.replaceChildren(node('option',{value:''},needle?'Choose a matching lake…':'Choose a lake…'));
      if(needle) {
        const matches=lakes.filter(c=>normalize(c.label).includes(needle)||normalize(c.value.split('/')[1]).includes(needle));
        for(const c of matches)select.append(node('option',{value:c.value},c.label));
        if(!matches.length)select.firstChild.textContent='No matching lakes';
      } else {
        const group=node('optgroup',{label:'Lake bounds and nearest centers'});
        for(const {choice,km,overlap} of suggested)group.append(node('option',{value:choice.value},choice.label+' · '+(overlap?'lake bounds overlap':km===0?'lake center inside project':Math.round(km)+' km to lake center')));
        const rest=node('optgroup',{label:'Other monitored lakes'});
        for(const c of lakes)if(!suggestedIds.has(c.value))rest.append(node('option',{value:c.value},c.label));
        select.append(group,rest);
        if(suggested[0].overlap || suggested[0].km===0)select.firstChild.textContent='Choose a lake…  Suggested: '+suggested[0].choice.label;
      }
      select.value=accessOptions.lakeTarget || '';
    }
    search.addEventListener('input',()=>{
      lakeFilter=search.value;
      if(accessOptions.lakeTarget) {
        select.value='';
        select.dispatchEvent(new Event('change'));
        document.getElementById(searchId)?.focus({preventScroll:true});
      } else fill();
    });
    fill();
    const selectedField=node('div',{class:'sc-field'},node('label',{for:select.id},option.label),select);
    if(accessOptions.lakeTarget)selectedField.append(p('CDS request group · '+accessOptions.lakeTarget.split('/')[0],'sc-muted'));
    return [node('div',{class:'sc-field'},node('label',{for:searchId},'Find a lake'),search),selectedField];
  }
  function renderAccess(body, product, screening) {
    const profile = accessProfile(selectedId), blocked = accessBlocked();
    const card = node('section', {class: 'sc-access-route', 'aria-label': 'Dataset access route'},
      node('div', {class: 'sc-access-route-heading'}, node('h3', {}, 'Access this dataset'), node('span', {class: 'sc-access-chip ' + profile.kind}, accessLabels[profile.kind] || profile.label)),
      p(profile.auth, 'sc-access-summary'));
    const verification = profile.verification || {};
    const delivery = node('details', {class: 'sc-disclosure'}, node('summary', {}, 'Delivery, scale and verification'),
      p(profile.summary || 'Follow the documented provider route.'), p((verification.label || 'Verification status not supplied') + (verification.checkedAt ? ' · reviewed ' + verificationDate(verification.checkedAt) : ''), 'sc-access-verification'),
      node('dl', {class: 'sc-facts sc-access-facts'}, fact('Spatial delivery', profile.spatialDelivery), fact('Temporal delivery', profile.temporalDelivery)));
    const scope = screening.status === 'excluded' ? 'This project falls outside the documented coverage. Check the extent with the provider.'
      : screening.spatialRelation === 'partial' ? 'Partial overlap. The request retains your full footprint and dates.'
      : lookupStatus(screening.status) ? 'Check local coverage and valid values in the provider files.'
      : 'Metadata overlap is separate from data access. Provider files can cover a broader domain or period; no polygon clipping or silent date trimming is applied here.';
    if (screening.status === 'excluded' || screening.spatialRelation === 'partial' || lookupStatus(screening.status)) card.append(p(scope, 'sc-access-scope'));
    else delivery.append(p(scope));
    if (Array.isArray(profile.options) && profile.options.length) {
      const choices = node('div', {class: 'sc-access-options'});
      for (const option of profile.options) {
        const id = 'sc-access-option-' + option.key;
        if (accessOptions[option.key] === undefined) accessOptions[option.key] = option.value;
        const select = node('select', {id, class: 'sc-select'});
        select.addEventListener('change', () => {accessOptions[option.key] = select.value; cancelAccessPending(); accessPlan = null; accessFileResult = null; accessError = ''; filePage = 0; fileSearch = ''; selectedFileKeys.clear(); renderPanel(); document.getElementById(id)?.focus({preventScroll: true});});
        if (option.key==='lakeTarget') {
          choices.append(...lakePicker(option,select));
          delivery.append(p('Suggestions use the project footprint, published lake centers and available lake bounding boxes. Confirm the lake and its observation dates before use.'),
            link('https://cds.climate.copernicus.eu/datasets/satellite-lake-water-level?tab=download','CDS monitored lake locations ↗'), ' · ',
            link('https://climate.esa.int/en/projects/lakes/data/','ESA Lakes CCI reference bounds ↗'));
        } else {
          for (const choice of option.choices || []) select.append(node('option', {value: choice.value}, choice.label));
          select.value = String(accessOptions[option.key] ?? '');
          choices.append(node('div', {class: 'sc-field'}, node('label', {for: id}, option.label), select));
        }
      }
      card.append(choices);
    }
    const actions = node('div', {class: 'sc-access-actions'});
    const primaryLabel = profile.canDiscover ? 'Find matching provider files' : profile.kind === 'files' ? 'Show download files' : profile.kind === 'external' ? 'Show provider steps' : 'Show download steps';
    const primary = button(accessFileResult?.origin === 'discovered' && profile.canDiscover ? 'Start a new file search' : primaryLabel, () => profile.canDiscover ? discoverAccessFiles(false) : prepareAccess(false), 'btn primary small', {id: 'sc-prepare-access'});
    primary.disabled = blocked || accessLoading || !window.SiteAccess;
    actions.append(primary, link(profile.docsUrl || product.documentation_url, 'Access documentation ↗', 'btn small'));
    card.append(actions, delivery);
    if (accessLoading) card.append(node('div', {class: 'sc-loading', role: 'status'}, 'Searching provider file metadata…', button('Cancel', () => {accessController?.abort();}, 'btn small')));
    if (accessError) card.append(node('div', {class: 'sc-error', role: 'alert'}, accessError, accessFileResult?.files?.length ? ' Previously listed files remain visible; this does not establish complete availability.' : accessFileResult?.origin === 'discovered' ? ' No provider files are loaded. This does not establish that no data exist.' : ''));
    if (accessPlan && !accessPlan.errors?.length) {
      if(profile.kind === 'request' && !accessPlan.files?.length){
        const plannedRequests=accessPlan.manifest?.requests || [];
        const count=profile.strategy==='mrms'?plannedRequests.reduce((sum,request)=>sum+(request.initialDateListings||0),0):plannedRequests.length;
        const unit=['daily-template','ims-daily-template','erddap'].includes(profile.strategy)?'prepared file request(s)':profile.strategy==='mrms'?'initial daily archive listing(s); pagination may add requests':'prepared provider request(s)';
        card.append(node('div',{class:'sc-transfer-summary'},node('strong',{},'Total transfer size: unknown'),
          p(count+' '+unit+'. '+(profile.strategy==='mrms'?'The listing will report observed file counts and sizes before file download.':'The provider has not supplied a total size for this selection.'),'sc-access-output-note'),
          p('Your project dates are retained. Review the prepared selection; the script offers explicit transfer choices where supported. Preparing this request does not download data.','sc-access-output-note')));
      }
      card.append(renderAccessGuide(profile, blocked));
      if (accessFileResult && (profile.kind === 'files' || profile.canDiscover || accessFileResult.files.length)) card.append(renderAccessFiles(profile, blocked));
      const guide = SiteAccessGuide.forPlan(profile, accessPlan, accessPlatform);
      if (guide.direct && guide.scriptName) card.append(node('details', {class:'sc-disclosure sc-batch-guide'}, node('summary', {}, 'Optional: download these files with Python'), renderScriptGuide(guide, blocked)));
      const optional = node('details', {class:'sc-disclosure sc-optional-exports'}, node('summary', {}, 'Optional project records and request details'),
        p('These files document the request. They are not downloaded scientific data, are not required by the Python script, and are not a universal provider upload format.', 'sc-access-output-note'));
      for (const artifact of accessPlan.artifacts || []) {
        if (artifact.name.endsWith('.py')) continue;
        const role = artifact.role || 'instructions';
        const label = role === 'request' ? 'Save request details (JSON)' : role === 'geometry' ? 'Save project GeoJSON' : 'Save provider notes';
        optional.append(artifactDownload(artifact, label, blocked));
      }
      const manifest = button('Save access manifest', exportAccessManifest, 'btn small'); manifest.disabled = blocked || accessLoading;
      optional.append(manifest); card.append(optional);
      if (accessPlan.notes?.length) card.append(node('details', {class: 'sc-disclosure'}, node('summary', {}, 'Request qualifications'), node('ul', {}, accessPlan.notes.map(note => node('li', {}, note)))));
    }
    body.append(card);
  }
  function artifactDownload(artifact, label, blocked) {
    const preparedPlan=accessPlan;
    const save=button(label,()=>{if(accessPlan===preparedPlan&&!accessBlocked()&&!preparedPlan.errors?.length)download(artifact.text,artifact.mime,artifact.name);},'btn small');
    save.disabled=blocked;
    return node('div',{class:'sc-access-artifact'},node('div',{},node('strong',{},artifact.name)),save);
  }
  function commandBlock(command, blocked, isCurrent = () => !accessBlocked()) {
    const code=node('code',{},command.text);
    const copy=button('Copy command',async()=>{
      if(!isCurrent())return;
      try{await navigator.clipboard.writeText(command.text);copy.textContent='Copied';}
      catch(_){const range=document.createRange();range.selectNodeContents(code);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);copy.textContent='Selected — press Ctrl/Cmd+C';}
    },'btn small');copy.disabled=blocked;
    return node('div',{class:'sc-command'},node('strong',{},command.label),node('pre',{},code),copy);
  }
  function renderScriptGuide(guide, blocked) {
    const script=accessPlan.artifacts.find(a=>a.name===guide.scriptName);
    const section=node('section',{class:'sc-script-guide','aria-label':'Run the Python download script'});
    section.append(p('This script already contains your selections. You do not need to edit code or load a JSON request file.','sc-access-output-note'),
      node('ol',{},guide.scriptSteps.map(step=>node('li',{},step))));
    const select=node('select',{id:'sc-python-platform',class:'sc-select','aria-label':'Python command for your computer'});
    for(const [value,label] of [['windows','Windows (py -3)'],['unix','macOS / Linux (python3)'],['path','Python on PATH (python)']])select.append(node('option',{value},label));
    select.value=accessPlatform;select.onchange=()=>{accessPlatform=select.value;renderPanel();document.getElementById('sc-python-platform')?.focus({preventScroll:true});};
    section.append(node('label',{for:'sc-python-platform'},'Commands for your computer'),select,
      node('ul',{class:'sc-script-requirements'},guide.requirements.map(s=>node('li',{},s))),
      node('div',{class:'sc-access-actions'},guide.links.map(l=>link(l.url,l.label+' ↗','btn small'))),
      artifactDownload(script,'Download Python script',blocked),...guide.commands.map(c=>commandBlock(c,blocked)),
      node('div',{class:'sc-expected-output'},node('strong',{},'What you get'),p(guide.scriptResult)));
    if(guide.transferNote){
      const choices=guide.requiresTransferChoice?node('section',{'aria-label':'Choose transfer scope'},node('h4',{},'Choose what to download')):node('details',{class:'sc-disclosure'},node('summary',{},'Transfer choices after reviewing sizes'));
      choices.append(commandBlock(guide.confirmationCommand,blocked),commandBlock(guide.confirmAllCommand,blocked));
      section.append(p(guide.transferNote,'sc-transfer-summary'),choices);
    }
    return section;
  }
  function renderAccessGuide(profile, blocked) {
    const guide=SiteAccessGuide.forPlan(profile,accessPlan,accessPlatform);
    const project='Project: '+(query.mode==='area'?(query.areaName||'Project area')+' (original footprint retained in project GeoJSON)':query.lat+', '+query.lon)+'\nRequested dates: '+query.start+' through '+query.end;
    const section=node('section',{class:'sc-access-output sc-next-steps','aria-label':'How to get the data'},node('h4',{id:'sc-access-output-title',tabindex:'-1'},guide.title),p(project,'sc-project-context'));
    if(guide.external){
      section.append(p('Enter these selections at the provider.','sc-access-output-note'),
        link(guide.providerUrl,'Open provider workflow ↗','btn primary small'),node('ol',{},guide.steps.map(s=>node('li',{},s))));
      if(guide.remainingChoices.length)section.append(node('strong',{},'Still to select with the provider'),node('ul',{},guide.remainingChoices.map(s=>node('li',{},s))));
      const geometry=accessPlan.artifacts.find(a=>a.role==='geometry');if(geometry)section.append(artifactDownload(geometry,'Save project GeoJSON',blocked));
      section.append(p(guide.result));
    }else if(guide.direct){
      section.append(node('ol',{},guide.steps.map(s=>node('li',{},s))),p(guide.result,'sc-access-output-note'));
      if(!accessLoading&&!accessFileResult?.files?.length)section.append(link(guide.providerUrl,'Check the provider archive ↗','btn small'));
      for(const l of guide.links.filter(l=>!l.url.includes('python.org')))section.append(link(l.url,l.label+' ↗','btn small'));
    }else if(guide.scriptName){
      if(profile.strategy==='mrms')section.append(p('Without Python: open the bucket browser, then choose CONUS, the selected field/pass and each date folder (YYYYMMDD). The link is not prefilled.'),link(guide.providerUrl,'Browse MRMS files ↗','btn primary small'));
      section.append(renderScriptGuide(guide,blocked),node('details',{class:'sc-disclosure'},node('summary',{},'Prefer the provider website?'),
        p('Use the provider tools to choose this product, location and dates manually. Availability and required selections depend on the provider; this link is not prefilled.'),link(guide.providerUrl,'Open provider access ↗','btn small')));
    }
    const plan=accessPlan,save=button('Save these steps',()=>{if(accessPlan===plan&&!accessBlocked())download(SiteAccessGuide.text(guide,project),'text/plain',profile.productId+'_how_to_download.txt');},'btn small');save.disabled=blocked;
    section.append(save);return section;
  }
  function verificationDate(value) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) + ' UTC' : String(value);
  }
  function fileSize(file) {
    const approximate = file.bytesApproximate ? 'Approx. ' : '';
    if (!Number.isFinite(file.sizeBytes) || file.sizeBytes < 0) return file.sizeLabel ? (file.bytesApproximate && !/approx|≈/i.test(file.sizeLabel) ? approximate : '') + file.sizeLabel : 'Size not supplied';
    if (file.sizeBytes < 1000) return approximate + file.sizeBytes + ' B';
    const units = ['kB','MB','GB','TB']; let size = file.sizeBytes / 1000, index = 0;
    while (size >= 1000 && index < units.length - 1) {size /= 1000; index++;}
    return approximate + size.toLocaleString('en-US', {maximumFractionDigits: 1}) + ' ' + units[index];
  }
  function fileSelectionKey(file) {return String(file.id || '') + '\n' + String(file.url || '');}
  function selectedFileEntries(files) {return files.map((file, index) => ({file, index})).filter(entry => selectedFileKeys.has(fileSelectionKey(entry.file)));}
  function fileSelectionCommands(script, entries, totalFiles) {
    const command = pythonLauncher() + ' ' + script.name;
    const selectedFlags = entries.length === totalFiles ? '' : ' ' + entries.map(entry => '--file ' + (entry.index + 1)).join(' ');
    return [{label: 'Preview the complete numbered file list (no transfer)', text: command},
      {label: 'Download only the ' + entries.length + ' selected file(s)', text: command + ' --download' + selectedFlags + ' --confirm-transfer'},
      {label: 'Alternative: explicitly download every loaded file', text: command + ' --download --confirm-transfer'}];
  }
  function renderFileSelection(files, blocked) {
    const entries = selectedFileEntries(files), transfer = SiteAccess.transferSummary(entries.map(entry => entry.file));
    const amount = fileSize({sizeBytes: transfer.knownBytes, bytesApproximate: transfer.approximateCount > 0});
    const size = transfer.unknownCount ? (transfer.knownBytes ? amount + ' known + ' : '') + transfer.unknownCount + ' unknown file size(s)' : amount;
    const box = node('section', {class: 'sc-file-selection', 'aria-label': 'Selected provider files'}, node('strong', {}, entries.length + ' selected links of ' + files.length + ' loaded · ' + transfer.fileCount + ' unique transfers · ' + size));
    const selectAll = button('Select all loaded files', () => {if (accessBlocked() || accessLoading) return; selectedFileKeys = new Set(files.map(fileSelectionKey)); renderPanel(); document.getElementById('sc-clear-file-selection')?.focus({preventScroll: true});}, 'btn small'); selectAll.disabled = blocked || accessLoading;
    const clear = button('Clear selection', () => {selectedFileKeys.clear(); renderPanel();}, 'btn small', {id: 'sc-clear-file-selection'}); clear.disabled = !entries.length;
    box.append(node('div', {class: 'sc-access-actions'}, selectAll, clear));
    if (!entries.length) return box;
    if (fileBatchSource !== files) {
      fileBatchSource = files;
      try {fileBatchPlan = SiteAccess.fileScript ? SiteAccess.fileScript(selectedId, files) : {artifact: null, reason: 'A batch downloader is not available for this file list. Use the individual provider links.'};}
      catch (error) {fileBatchPlan = {artifact: null, reason: userError(error) || 'A batch downloader could not be prepared.'};}
    }
    const script = fileBatchPlan?.artifact;
    if (!script) {box.append(p(fileBatchPlan?.reason || 'Use the selected individual provider links.', 'sc-access-output-note')); return box;}
    const current = () => accessFileResult?.files === files && !accessBlocked() && !accessLoading && !accessPlan?.errors?.length;
    const save = button('Download Python script for this file list', () => {if (current()) download(script.text, script.mime, script.name);}, 'btn small'); save.disabled = blocked || accessLoading;
    const commands = fileSelectionCommands(script, entries, files.length);
    const steps = ['Save the script in a folder, then open a terminal in that folder.', 'Python 3.10 or later is required; no extra packages are needed.',
      'Preview the numbered file list before running a transfer command. The script contains all ' + files.length + ' loaded files; the selected command uses their original one-based numbers.',
      'Review the selected sizes, extents and provider terms. The script retains original files and writes transfer receipts; failed transfers remain explicit.'];
    box.append(node('details', {class: 'sc-disclosure sc-selected-file-script', open: ''}, node('summary', {}, 'Download the selected files with Python'),
      node('ol', {}, steps.map(step => node('li', {}, step))), link('https://www.python.org/downloads/', 'Get Python ↗'), platformSelect('sc-file-python-platform'), save,
      ...commands.map(command => commandBlock(command, blocked || accessLoading, current))));
    return box;
  }
  function renderAccessFiles(profile, blocked) {
    const files = accessFileResult.files || [], filtered = files.filter(file => !fileSearch || [file.name, file.id, file.version, file.start, file.end].join(' ').toLowerCase().includes(fileSearch.toLowerCase()));
    const pageSize = 20, pages = Math.max(1, Math.ceil(filtered.length / pageSize)); filePage = Math.min(filePage, pages - 1);
    const missing = [];
    if (accessFileResult.missingAssets > 0) missing.push(accessFileResult.missingAssets + ' requested layer link(s) missing');
    if (accessFileResult.missingLinksTotal > 0) missing.push(accessFileResult.missingLinksTotal + ' granule(s) without an eligible file link');
    const scope = accessFileResult.origin === 'prepared' ? 'Prepared links for the selected access method; not a provider-wide file census.' : accessFileResult.complete ? 'File metadata search complete for this request. File contents have not been downloaded or quality-checked by this search.' : accessFileResult.cancelled ? 'File metadata search cancelled. Any loaded files are retained; the search remains incomplete.' : accessFileResult.paginationComplete && !accessFileResult.cursor ? 'All provider metadata pages were read, but the file set remains incomplete: ' + (missing.length ? missing.join('; ') + '.' : 'requested file links or layers remain unresolved.') : 'File metadata search incomplete. Any loaded files are retained; more matching records may remain.';
    const section = node('section', {class: 'sc-provider-files', 'aria-label': 'Provider file links'}, node('div', {class: 'sc-provider-files-heading'}, node('h4', {}, 'Provider file links'), node('strong', {}, files.length + ' loaded')), p(scope, 'sc-access-output-note'));
    const coverage=SiteAccess.fileCoverage(selectedId,files,query,accessFileResult);
    if(coverage.assessed){
      const span=coverage.basis==='nominal_file_dates'?(coverage.firstListed?'Nominal file dates in the request run from '+coverage.firstListed+' to '+coverage.lastListed+'. ':'No loaded filename has a nominal date in the request. '):coverage.firstListed?'Listed file metadata overlap '+coverage.firstListed+' to '+coverage.lastListed+'. ':'No dated file overlaps the request. ';
      const count='Requested '+coverage.unit+' without a listed file · '+coverage.unlistedIntervals+'.';
      const gaps=coverage.missingIntervals.slice(0,10).map(r=>r.start===r.end?r.start:r.start+' to '+r.end).join('; ');
      section.append(p(span+count+(gaps?' Intervals: '+gaps+'.':'')+(coverage.missingIntervals.length>10?' All intervals are retained in the export.':'')+(!coverage.searchComplete?' The file list is incomplete or prepared; additional files may cover these intervals.':''),'sc-callout sc-file-time-coverage'),p(coverage.qualification,'sc-access-output-note'));
    }else section.append(p(coverage.reason,'sc-access-output-note sc-file-time-coverage'));
    const spatialText = file => file.spatialDelivery || profile.spatialDelivery || 'Spatial delivery not supplied; inspect provider metadata.';
    const verificationText = file => file.verificationLabel || 'A file link or metadata listing does not verify its scientific contents.';
    const commonSpatial = files.length > 1 && files.every(file => spatialText(file) === spatialText(files[0])) ? spatialText(files[0]) : null;
    const commonVerification = files.length > 1 && files.every(file => verificationText(file) === verificationText(files[0])) ? verificationText(files[0]) : null;
    if (commonSpatial || commonVerification) section.append(node('details', {class: 'sc-disclosure sc-common-file-notes'}, node('summary', {}, 'File extent and verification'), commonSpatial ? p(commonSpatial) : null, commonVerification ? p(commonVerification) : null));
    if (files.length) {
      const transfer = SiteAccess.transferSummary(files);
      const amount = fileSize({sizeBytes: transfer.knownBytes, bytesApproximate: transfer.approximateCount > 0});
      const total = transfer.unknownCount ? (transfer.knownBytes ? 'Known file sizes: ' + amount + ' + ' : 'Total size unknown: ') + transfer.unknownCount + ' file size(s) not supplied' : 'Total transfer: ' + amount;
      section.append(node('div', {class: 'sc-transfer-summary'}, node('strong', {}, total),
        p('For ' + transfer.fileCount + ' unique transfers across ' + files.length + ' loaded file links, including files outside this display page or text filter. These are original provider files, not project-sized subsets.', 'sc-access-output-note'),
        transfer.requiresConfirmation ? p('All files remain available. Review an individual file below, or select files to see the available download options. No data have been downloaded.', 'sc-access-output-note') : null));
      section.append(renderFileSelection(files, blocked));
    }
    const searchFiles = node('input', {id: 'sc-file-search', class: 'sc-search', type: 'search', placeholder: 'Search all loaded file names, periods or versions…', value: fileSearch, 'aria-label': 'Search loaded provider files'});
    searchFiles.addEventListener('input', () => {const caret = searchFiles.selectionStart; fileSearch = searchFiles.value; filePage = 0; renderPanel(); const restored = document.getElementById('sc-file-search'); restored?.focus({preventScroll: true}); restored?.setSelectionRange(caret, caret);});
    section.append(searchFiles);
    const list = node('div', {class: 'sc-file-list'});
    for (const file of filtered.slice(filePage * pageSize, (filePage + 1) * pageSize)) {
      const fileIndex = files.indexOf(file), key = fileSelectionKey(file), checkboxId = 'sc-file-pick-' + fileIndex;
      const checkbox = node('input', {type: 'checkbox', id: checkboxId, 'data-file-index': fileIndex + 1}); checkbox.checked = selectedFileKeys.has(key); checkbox.disabled = blocked || accessLoading;
      checkbox.addEventListener('change', () => {if (accessBlocked() || accessLoading) return; if (checkbox.checked) selectedFileKeys.add(key); else selectedFileKeys.delete(key); renderPanel(); document.getElementById(checkboxId)?.focus({preventScroll: true});});
      const period = file.start || file.end ? (file.start || 'Unknown start') + ' → ' + (file.end || 'Unknown end') : 'Not established by asset metadata';
      const fileAction=file.role==='checksum'?'Open checksum ↗':file.authRequired?'Sign in / open data ↗':'Download / open data ↗';
      let open = blocked || accessPlan?.errors?.length ? button(fileAction, () => {}, 'btn small', {disabled: '', 'aria-disabled': 'true'}) : link(file.url, fileAction, 'btn primary small');
      if (open.tagName === 'SPAN') open = button('No provider data URL listed', () => {}, 'btn small', {disabled: ''});
      if (open.tagName === 'A') {
        const listing = accessFileResult;
        open.setAttribute('aria-label', fileAction + ' · ' + (file.name || file.id || 'listed data file'));
        open.addEventListener('click', event => {if (accessBlocked() || accessFileResult !== listing || accessPlan?.errors?.length) event.preventDefault();});
      }
      const row = node('article', {class: 'sc-file-row', 'data-file-id': file.id || file.url}, node('label', {class: 'sc-file-select', for: checkboxId}, checkbox, 'Select file ' + (fileIndex + 1)), node('h5', {}, file.name || file.id || 'Provider file'),
        node('dl', {class: 'sc-file-facts'}, fact(file.associatedAcquisitionTime ? 'Asset reference period' : 'File period', period),
          fact('Transfer size', fileSize(file)), file.associatedAcquisitionTime ? fact('Associated acquisition', file.associatedAcquisitionTime) : null));
      if (file.temporalSupportNote) row.append(p(file.temporalSupportNote, 'sc-file-verification'));
      if (file.role === 'checksum') row.prepend(node('span', {class: 'sc-access-chip'}, 'Checksum companion'));
      const metadata = node('details', {class:'sc-disclosure'}, node('summary', {}, 'File details'),
        commonSpatial ? null : p(spatialText(file), 'sc-file-spatial'),
        node('dl', {class:'sc-file-facts'}, fact('Asset version', file.version || 'Not established'),
          file.associatedAcquisitionTime ? fact('Parent processing version', file.parentProcessingVersion || 'Not supplied') : null,
          fact('File listed', file.checkedAt ? verificationDate(file.checkedAt) : 'Not individually listed / checked')),
        commonVerification ? null : p(verificationText(file), 'sc-file-verification'));
      if (file.payloadVerifiedAt) metadata.append(p('File content check recorded: ' + verificationDate(file.payloadVerifiedAt) + '. ' + (file.payloadVerificationScope || 'See the manifest for the scope of this check.'), 'sc-file-verification'));
      row.append(metadata);
      const singleTransfer = SiteAccess.transferSummary([file]);
      const action = singleTransfer.knownBytes >= singleTransfer.byteThreshold || singleTransfer.unknownCount
        ? node('details', {class: 'sc-large-file'}, node('summary', {}, singleTransfer.unknownCount ? 'Size unknown — show provider download link' : 'Large file — show download link (' + fileSize(file) + ')'), p('This transfers the complete provider file. Check the stated extent and size before continuing.'), open)
        : open;
      row.append(node('div', {class: 'sc-file-actions'}, action)); list.append(row);
    }
    if (!filtered.length) list.append(p(files.length ? 'No loaded files match this filter. Clearing it restores the full loaded list.' : accessFileResult.complete ? 'No matching file metadata were returned for this request.' : 'No provider files are loaded yet. This is not proof that no data exist.', 'sc-status-line'));
    section.append(list);
    const previous = button('← Previous', () => {filePage--; renderPanel(); document.getElementById('sc-file-page-status')?.focus({preventScroll: true});}, 'btn small'); previous.disabled = filePage === 0;
    const next = button('Next →', () => {filePage++; renderPanel(); document.getElementById('sc-file-page-status')?.focus({preventScroll: true});}, 'btn small'); next.disabled = filePage >= pages - 1;
    section.append(node('div', {class: 'sc-station-pager'}, node('span', {id: 'sc-file-page-status', tabindex: '-1'}, filtered.length + ' matches · display page ' + (filePage + 1) + ' / ' + pages), node('span', {}, previous, next)));
    const actions = node('div', {class: 'sc-access-actions'});
    if (accessFileResult.cursor) {const more = button(accessError ? 'Retry / continue file search' : 'Continue file search', () => discoverAccessFiles(true), 'btn primary small'); more.disabled = blocked || accessLoading; actions.append(more);}
    const exportAll = button('Save all ' + files.length + ' file links + manifest', exportAccessManifest, 'btn small'); exportAll.disabled = blocked || accessLoading; actions.append(exportAll); section.append(actions);
    if (accessFileResult.notes?.length) section.append(node('details', {class: 'sc-disclosure'}, node('summary', {}, 'File search scope'), node('ul', {}, accessFileResult.notes.map(note => node('li', {}, note)))));
    return section;
  }
  async function discoverAccessFiles(resume = false) {
    if (accessBlocked() || accessLoading) return;
    const cursor = resume ? accessFileResult?.cursor : null;
    if (resume && !cursor) return;
    if (!resume && !prepareAccess(true)) return;
    if (resume) {cancelAccessPending(); accessError = '';}
    accessController = new AbortController(); const token = accessGeneration; accessLoading = true; renderPanel();
    try {
      const response = await window.SiteAccess.discover(selectedId, query, {signal: accessController.signal, cursor,
        ...(accessProfile(selectedId).strategy === 'cmr' ? {pageBudget: 5} : {})});
      if (token !== accessGeneration) return;
      const previous = accessFileResult || {files: [], requests: []}, files = new Map(previous.files.map(file => [file.id || file.url, file]));
      for (const file of response.files || []) files.set(file.id || file.url, {...files.get(file.id || file.url), ...file});
      accessFileResult = {origin: 'discovered', files: [...files.values()], complete: response.complete === true, paginationComplete: response.paginationComplete === true,
        missingAssets: response.missingAssets ?? null, missingLinksTotal: response.missingLinksTotal ?? null, cursor: response.cursor || null,
        requests: [...(previous.requests || []), ...(response.requests || [])], notes: response.notes || [], error: response.error || null, cancelled: response.cancelled === true,
        historicalBatches: [...(previous.historicalBatches || []), {fileCount: (response.files || []).length, complete: response.complete === true, notes: response.notes || [], requests: response.requests || []}]};
      rememberEvidence(selectedId,hazardFilter,SiteShortlist.fileEvidence(accessProfile(selectedId),accessFileResult,query),accessFileResult.requests);
      renderOverview();accessError = response.error?.message || '';
      announce.textContent = accessFileResult.files.length + ' provider files listed. ' + (accessFileResult.complete ? 'Metadata search complete for this request.' : 'Search incomplete; inspect its continuation and scope.');
    } catch (error) {
      if (token !== accessGeneration) return;
      accessError = error.name === 'AbortError' ? 'File metadata search cancelled.' : userError(error) || 'File metadata search failed.';
      accessFileResult = {...(accessFileResult || {files: [], requests: [], notes: [], cursor: null}), origin: 'discovered', complete: false, cancelled: error.name === 'AbortError', error: {message: accessError, code: error.code || error.name || 'LOOKUP'}};
      announce.textContent = accessError;
    } finally {if (token === accessGeneration) {accessLoading = false; accessController = null; renderPanel();}}
  }
  function exportAccessManifest() {
    if (accessBlocked() || accessLoading || (!accessPlan && !accessFileResult)) return;
    const product = byId.get(selectedId), evidenceIds = [...new Set([...product.evidence_ids, ...(rules[selectedId]?.evidence_ids || [])])];
    const manifest = {...(accessPlan?.manifest || {}), listedFileCoverage:accessFileResult?SiteAccess.fileCoverage(selectedId,accessFileResult.files||[],query,accessFileResult):null, uiContext: {tool: 'Climate-Hazard Dataset Inventory ' + data.meta.revision, exportedAt: new Date().toISOString(),
      catalogRevision: data.meta.revision, screeningMetadata, productId: selectedId, query, options: {...accessOptions}, accessCapability: accessProfile(selectedId), screening: resultFor(selectedId), screeningRule: rules[selectedId],
      sourceRecord: product, referencedSources: Object.fromEntries(evidenceIds.filter(id => data.sources[id]).map(id => [id, data.sources[id]])),
      fileDiscovery: accessFileResult, selectedFileNumbers: selectedFileEntries(accessFileResult?.files || []).map(entry => entry.index + 1), artifacts: (accessPlan?.artifacts || []).map(artifact => ({name: artifact.name, mime: artifact.mime, role: artifact.role})), preparationErrors: accessPlan?.errors || [],
      qualification: 'Request preparation and provider file metadata are separate from actual site coverage, file download and scientific fitness. The manifest includes every loaded file, not just the current display page or search filter.'}};
    if (accessFileResult?.origin === 'discovered') {
      manifest.files = accessFileResult.files;
      manifest.transferSummary = SiteAccess.transferSummary(manifest.files);
      manifest.fileListingComplete = accessFileResult.complete === true;
      manifest.qualification = 'The file list contains all provider metadata links loaded for this project. fileListingComplete records whether the search returned a complete file list. The transfer summary groups matching URLs, versions and checksums. File contents and valid site values require inspection.';
    }
    download(JSON.stringify(manifest, null, 2) + '\n', 'application/json', accessPlan?.manifestName || selectedId + '_request_manifest.json');
  }
  function coopsStatus(station) {
    return station.coopsAvailability || {state: 'unchecked', label: 'Not checked', message: 'Six-minute product, date and datum metadata have not been checked for this station.'};
  }
  function coopsGroup(station) {
    return ['match', 'partial'].includes(coopsStatus(station).state) ? 'matching' : ['outside_period', 'product_not_listed'].includes(coopsStatus(station).state) ? 'incompatible' : 'unresolved';
  }
  function coopsCounts() {
    const stations = discovery?.stations || [];
    return {found: stations.length, matching: stations.filter(station => coopsGroup(station) === 'matching').length,
      partial: stations.filter(station => coopsStatus(station).state === 'partial').length, incompatible: stations.filter(station => coopsGroup(station) === 'incompatible').length,
      unresolved: stations.filter(station => coopsGroup(station) === 'unresolved').length, unchecked: stations.filter(station => coopsStatus(station).state === 'unchecked').length,
      previewed: stations.filter(station => station.coopsPreview?.state === 'retrieved').length};
  }
  function canPreviewCoops(station) {
    const status = coopsStatus(station);
    return ['match', 'partial'].includes(status.state) && !!status.selectedDatum && (status.availableDatums || []).some(datum => datum.code === status.selectedDatum);
  }
  function nearerUnresolvedCoops() {
    const stations = discovery?.stations || [];
    const distances = stations.filter(station => coopsGroup(station) === 'matching' && Number.isFinite(station.distanceKm)).map(station => station.distanceKm);
    if (!distances.length) return null;
    const nearestMatchKm = Math.min(...distances);
    const unresolved = stations.filter(station => coopsGroup(station) === 'unresolved' && Number.isFinite(station.distanceKm) && station.distanceKm < nearestMatchKm).sort((a,b) => a.distanceKm - b.distanceKm);
    return unresolved.length ? {nearestMatchKm, stations: unresolved} : null;
  }
  function renderCoopsSummary() {
    const counts = coopsCounts(), box = node('section', {class: 'sc-coops-summary', 'aria-label': 'CO-OPS station metadata screening'});
    const filters = node('div', {role: 'group', class: 'sc-coops-counts', 'aria-label': 'Filter stations by metadata result'});
    for (const [value, count, label] of [['all', counts.found, 'Stations found'], ['matching', counts.matching, 'Metadata matches'], ['incompatible', counts.incompatible, 'Mismatches'], ['unresolved', counts.unresolved, 'Unresolved / choose datum']]) {
      filters.append(button('', () => {coopsFilter = value; candidateDrawerOpen = true; applyStationFilter(); panel.querySelector('[data-coops-filter="' + value + '"]')?.focus({preventScroll: true});}, 'sc-coops-count', {'data-coops-filter': value, 'aria-pressed': String(coopsFilter === value)}));
      filters.lastChild.append(node('strong', {}, count), node('span', {}, label));
    }
    box.append(filters, p(counts.partial + ' partial date matches · ' + counts.unchecked + ' not yet checked · ' + counts.previewed + ' stations with a retrieved live preview. Metadata matches do not establish valid observations or site suitability.', 'sc-station-note'),
      node('p', {class: 'sc-coops-legend'}, node('span', {class: 'sc-coops-key matching'}, 'Teal: metadata match / partial'), node('span', {class: 'sc-coops-key incompatible'}, 'Gray: known mismatch'), node('span', {class: 'sc-coops-key unresolved'}, 'Amber: unresolved / datum choice / unchecked')));
    const nearer = coopsFilter === 'matching' ? nearerUnresolvedCoops() : null;
    if (nearer) {
      const closest = nearer.stations[0];
      box.append(node('div', {class: 'sc-nearer-unresolved'}, p(nearer.stations.length + ' unresolved or datum-choice candidate(s) are closer than the nearest metadata match (' + nearer.nearestMatchKm.toFixed(2) + ' km). Closest: ' + (closest.name || closest.id) + ' [' + closest.id + '], ' + closest.distanceKm.toFixed(2) + ' km. Their metadata status remains unresolved.'),
        button('Inspect nearer unresolved stations', () => {coopsFilter = 'unresolved'; stationSearch = ''; stationRelation = 'all'; stationPage = 0; selectedStationId = closest.id; sample = null; stationDownloadPlan = null; savedLabel = ''; activeSeries = 0; candidateDrawerOpen = true; renderPanel(); reveal(panel.querySelector('.sc-station-row[aria-pressed="true"]'));}, 'btn small', {id: 'sc-coops-nearer'})));
    }
    const check = discovery.coopsPreflight;
    const pending = (discovery.stations || []).filter(station => ['unchecked', 'unresolved'].includes(coopsStatus(station).state));
    if (pending.length>10) box.append(p('The next check covers up to 10 stations.','sc-status-line'));
    if (check && (check.running || !check.complete || pending.length)) box.append(p((check.running ? 'Checking station inventories · ' : check.cancelled ? 'Check cancelled · ' : 'Last check · ') + check.completed + ' / ' + check.total + ' checked.'+(pending.length?' '+pending.length+' awaiting checks or retry.':''),'sc-status-line'));
    if (pending.length) {const retry = button('Check next '+Math.min(10,pending.length)+(pending.length===1?' station (':' stations (')+pending.length+' awaiting checks or retry)', () => runCoopsRetry(pending.map(station => station.id)), 'btn small', {id: 'sc-coops-retry'}); retry.disabled = !!loading || dirty; box.append(retry);}
    return box;
  }
  function renderProvider(body, product, screening) {
    const guidance = {
      ghcn_daily: 'Find a nearby station. Elevation, exposure and distance affect how well it represents your site.',
      noaa_coops_water_level: 'Choose a water-level product and gauge. Compare elevations using the same vertical datum. These gauges measure total water level.',
      usgs_streamflow: 'Check the river and contributing catchment. The nearest gauge may drain a different basin.'
    }[selectedId];
    if (sample) {
      const drawer = node('details', {class: 'sc-candidate-drawer', ...(candidateDrawerOpen ? {open: ''} : {})},
        node('summary', {}, 'Change station' + (discovery?.stations?.length > 1 ? ' · ' + discovery.stations.length + ' candidates' : '')));
      drawer.addEventListener('toggle', () => {if (drawer.isConnected) candidateDrawerOpen = drawer.open;});
      body.append(drawer); body = drawer;
    }
    if (!sample && !discovery) body.append(p(guidance));

    if (selectedId === 'noaa_coops_water_level') {
      const productSelect = node('select', {id:'sc-coops-product',class:'sc-select'}, node('option',{value:'water_level'},'Six-minute water levels · events'),node('option',{value:'hourly_height'},'Verified hourly heights · historical periods'));
      productSelect.value = coopsProduct; productSelect.disabled = !!loading || dirty;
      productSelect.addEventListener('change', () => {
        if (loading || dirty) return;
        coopsProduct = productSelect.value; sample = null; stationDownloadPlan = null; savedLabel = ''; networkError = ''; selectedStationId = ''; stationPage = 0; coopsFilter = 'matching';
        if (discovery) delete discovery.emptyPreview;
        if (discovery) discovery.stations = discovery.stations.map(station => {
          const updated = {...station,coopsProduct}; delete updated.coopsPreview;
          if (updated.coopsAvailability) updated.coopsAvailability = SiteProviders.assessCoopsStation(updated,query);
          return updated;
        });
        renderPanel(); document.getElementById('sc-coops-product')?.focus({preventScroll:true});
      });
      body.append(node('label',{for:'sc-coops-product'},'Water-level product'),productSelect,p('Products remain separate. Hourly heights can miss short-lived peaks. Monthly means and daily means use NOAA provider access.','sc-station-note'));
    }
    const discoverButton = button(discovery ? 'Start a fresh station lookup' : 'Find station candidates', () => runDiscovery(false), 'btn primary small');
    discoverButton.disabled = !!loading || dirty || screening.status === 'excluded';
    body.append(discoverButton);
    if (screening.status === 'excluded') body.append(p('This query is outside the documented scope. Change the site or period before a station lookup.', 'sc-status-line'));
    body.append(p(query.mode === 'area' ? 'Search footprint: ' + query.areaName + '. Outside buffer: ' + query.bufferKm + ' km. Candidates inside the polygon and outside within the buffer are kept distinct.' : 'Station-search radius: ' + query.radiusKm + ' km from the point.', 'sc-status-line'));
    if (loading) body.append(node('div', {class: 'sc-loading', role: 'status'}, loading, button('Cancel', cancelUserRequest, 'btn small', {id: 'sc-cancel-provider'})));
    if (networkError) body.append(node('div', {class: 'sc-error', role: 'alert'}, networkError, discovery?.stations?.length ? ' Loaded candidates are retained.' : ' No candidates were accepted. Inspect the error before starting a fresh search.'));
    if (discovery) {
      const stations = discovery.stations || [];
      const inside = stations.filter(station => station.relation === 'inside').length;
      const state = discovery.savedExample ? 'Saved example · not a live search census' : discovery.complete ? 'Provider search complete' : discovery.cancelled ? 'Search cancelled · results incomplete' : discovery.continuation ? 'More provider pages available' : discovery.paginationComplete ? 'All result pages read; some locations remain unresolved' : 'Search incomplete';
      const stats = node('div', {class: 'sc-station-totals ' + (discovery.error ? 'failure' : discovery.complete && stations.length ? 'success' : 'warning')}, node('strong', {}, stations.length + (stations.length===1?' station found':' stations found')), node('span', {}, query.mode === 'area' ? inside + ' inside / on boundary · ' + (stations.length - inside) + ' outside within buffer' : 'Within the selected point radius'), badge(state, discovery.complete && !discovery.savedExample ? 'live' : 'unresolved'));
      body.append(stats);
      if (selectedId === 'noaa_coops_water_level' && stations.length) body.append(renderCoopsSummary());
      if (Number.isFinite(discovery.searchedRecordsTotal)) body.append(p(discovery.searchedRecordsTotal + ' station records read from the provider.', 'sc-status-line'));
      if (!stations.length) {
        const message = selectedId === 'noaa_coops_water_level'
          ? 'The current and historical NOAA water-level station lists have no mapped station in this search area. The date range applies when checking a station’s observations. Try a wider area or another tide-gauge network.'
          : 'No stations matched these dates and this area. Nearby stations may have older or newer records, and provider coordinates can be wrong. Search the provider by name or ID and try without a date filter.';
        body.append(node('div', {class: 'sc-empty'}, node('strong', {}, discovery.complete ? 'No candidate stations matched this provider search' : 'No matching candidates loaded yet'), discovery.complete ? message : discovery.error ? 'The search failed. An empty list is not evidence of no stations.' : 'The search is incomplete. Continue when another page is available.'));
      }
      else body.append(renderStationBrowser());
      const searchActions = node('div', {class: 'sc-detail-actions'});
      if (discovery.continuation) {const next = button(discovery.error || discovery.cancelled ? 'Retry / continue search' : 'Continue search', () => runDiscovery(true), 'btn primary small'); next.disabled = !!loading || dirty; searchActions.append(next);}
      const exportCandidates = button((stations.length===1?'Export station':'Export all '+stations.length+' stations')+' (JSON)', exportStations);
      const stationCSV = button('Download station list (CSV)',exportStationCSV);
      exportCandidates.disabled = stationCSV.disabled = dirty || !stations.length;
      if (stations.length) searchActions.append(stationCSV,exportCandidates); body.append(searchActions);
      if (discovery.notes && discovery.notes.length) body.append(node('details', {class: 'sc-disclosure'}, node('summary', {}, 'Station lookup scope'), node('ul', {}, discovery.notes.map(note => node('li', {}, note)))));
    }
    if (selectedId === 'ghcn_daily') {
      const groups=SiteProviders.nearbyLocationConflicts(query);
      const recovery=node('details',{class:'sc-disclosure',...(groups.length || discovery && discovery.stations.length<3 ? {open:''}:{})},node('summary',{},'Missing a station? Search by name or ID'),
        p('Station coordinates come from NOAA and can be wrong. Nearby records may also fall outside your dates. Search by name or ID, or remove the dates on the provider site.'),
        link('https://www.ncei.noaa.gov/access/search/data-search/daily-summaries','Search NOAA by station name or ID ↗'));
      for (const group of groups) {
        recovery.append(p(group.name+': records nearly coincide after a coordinate sign flip. Nearby members are listed below. Check their history; neither location is assumed correct.','sc-callout'));
        for(const station of group.stations) recovery.append(p(station.id+' · '+station.lat+', '+station.lon+' · elevation '+station.elevationM+' m'),link(SiteProviders.requestURL('ghcn_daily',station,query),'View bounded observations for '+station.id+' ↗'));
      }
      body.append(recovery);
    }
  }
  function filteredStations() {
    const coops = selectedId === 'noaa_coops_water_level', rank = station => coopsStatus(station).state === 'match' ? 0 : coopsStatus(station).state === 'partial' ? 1 : coopsGroup(station) === 'unresolved' ? 2 : 3;
    return (discovery?.stations || []).filter(station => (!coops || coopsFilter === 'all' || coopsGroup(station) === coopsFilter) && (stationRelation === 'all' || station.relation === stationRelation) && (selectedId !== 'ghcn_daily' || stationNetwork === 'all' || SiteProviders.ghcnNetwork(station.id).networkLabel === stationNetwork) && (!stationSearch || [station.name, station.id, ...(station.variables || []).map(variable => variable.key)].join(' ').toLowerCase().includes(stationSearch.toLowerCase())))
      .sort((a,b) => (coops ? rank(a) - rank(b) : Number(a.dailyRecordUndated===true)-Number(b.dailyRecordUndated===true)) || (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || (a.name || a.id).localeCompare(b.name || b.id));
  }
  function applyStationFilter() {
    stationPage = 0;
    if (selectedStationId && !filteredStations().some(station => station.id === selectedStationId)) {
      stationChoiceRequired = true;
      if (!['discovery', 'coops-preflight'].includes(loadingKind)) cancelPending();
      selectedStationId = ''; sample = null; stationDownloadPlan = null; savedLabel = ''; activeSeries = 0;
      delete discovery.emptyPreview;
      networkError = discovery.error?.message || '';
    }
    renderPanel();
  }
  function renderStationBrowser() {
    const stations = discovery.stations, coops = selectedId === 'noaa_coops_water_level';
    const filtered = filteredStations(), pages = Math.max(1, Math.ceil(filtered.length / stationPageSize)); stationPage = Math.min(stationPage, pages - 1);
    if (!stationChoiceRequired && (!selectedStationId || !stations.some(station => station.id === selectedStationId)) && !stationSearch && stationRelation === 'all' && stationNetwork === 'all') selectedStationId = filtered[0]?.id || '';
    const stationFind = node('input', {id: 'sc-station-search', type: 'search', class: 'sc-search', placeholder: 'Name, ID or record element (e.g. TMAX)…', value: stationSearch, 'aria-label': 'Search loaded candidate stations'});
    stationFind.addEventListener('input', () => {const position = stationFind.selectionStart; stationSearch = stationFind.value; applyStationFilter(); const restored = document.getElementById('sc-station-search'); restored?.focus({preventScroll: true}); restored?.setSelectionRange(position, position);});
    const relationSelect = node('select', {id: 'sc-station-relation', class: 'sc-select', 'aria-label': 'Candidate relationship'}, node('option', {value: 'all'}, 'All loaded candidates'), node('option', {value: 'inside'}, 'Inside / on boundary'), node('option', {value: 'nearby'}, 'Outside within buffer'));
    relationSelect.value = stationRelation; relationSelect.hidden = query.mode !== 'area';
    relationSelect.addEventListener('change', () => {stationRelation = relationSelect.value; applyStationFilter(); document.getElementById('sc-station-relation')?.focus({preventScroll: true});});
    let networkSelect = null;
    if (selectedId === 'ghcn_daily') {
      const names = [...new Set(stations.map(s => SiteProviders.ghcnNetwork(s.id)).filter(n=>n.networkCode!=='0').map(n=>n.networkLabel))].sort();
      networkSelect = node('select', {id:'sc-station-network',class:'sc-select','aria-label':'Filter GHCN stations by network ID'}, node('option',{value:'all'},'All station networks'), names.map(name => node('option',{value:name},name)));
      networkSelect.value = stationNetwork;
      networkSelect.addEventListener('change', () => {stationNetwork=networkSelect.value;applyStationFilter();document.getElementById('sc-station-network')?.focus({preventScroll:true});});
    }
    const rows = node('div', {role: 'group', class: 'sc-station-rows', 'aria-label': 'Loaded candidate station list'});
    const page = filtered.slice(stationPage * stationPageSize, (stationPage + 1) * stationPageSize);
    for (const station of page) {
      const relation = query.mode === 'area' ? station.relation === 'inside' ? 'Inside / on boundary' : 'Outside within buffer' : 'From project point';
      const distance = Number.isFinite(station.distanceKm) ? station.distanceKm.toFixed(2) + ' km' : 'Distance unavailable';
      rows.append(button('', () => chooseStation(station.id), 'sc-station-row', {'aria-pressed': String(station.id === selectedStationId), 'data-station': station.id}));
      for (const event of ['mouseenter','focus']) rows.lastChild.addEventListener(event, () => mapApi?.highlightStation?.(station.id));
      for (const event of ['mouseleave','blur']) rows.lastChild.addEventListener(event, () => mapApi?.highlightStation?.(''));
      const ghcn = selectedId === 'ghcn_daily';
      const network = ghcn ? stationNetworkBadge(station.id) : null;
      const inside = query.mode==='area' && station.relation==='inside';
      rows.lastChild.append(node('span', {}, node('strong', {}, station.name || station.id), node('small', {}, station.id, network), !ghcn && station.variables?.length ? node('small', {class: 'sc-station-elements'}, 'Record elements: ' + station.variables.map(variable => variable.key).join(' · ')) : null), node('span', {class: 'sc-station-distance',title:inside?'Station coordinates lie inside or on the project boundary.':query.mode==='area'?'Shortest distance to the project boundary.':'Distance from the project point to the provider’s station coordinates.'}, node('b', {}, inside?'Inside project':distance), query.mode === 'area' && !inside ? node('small', {}, relation) : null));
      const catchment=station.drainageArea!=null?'Drainage area: '+station.drainageArea+' mi²':'';
      const siteType=station.siteType?({ST:'Stream',ST_CA:'Canal',LK:'Lake',ES:'Estuary'}[station.siteType]||station.siteType):'';
      const context=[catchment,siteType,station.dailyRecordUndated?'No dated daily record; values unconfirmed':'',station.adjustedRecord?'Adjusted/derived record':''].filter(Boolean).join(' · ');
      if(context)rows.lastChild.firstElementChild.append(node('small',{class:'sc-station-context'},context));
      if (station.elevationNote) rows.lastChild.firstElementChild.append(node('small',{class:'sc-station-note'},'Elevation conflicts with local terrain · check station metadata'));
      if (station.locationConflict) rows.lastChild.firstElementChild.append(node('small',{class:'sc-station-note'},'Possible coordinate sign conflict · review location'));
      if (coops) {
        rows.lastChild.firstElementChild.append(node('span', {class: 'sc-coops-status ' + coopsGroup(station)}, coopsStatus(station).label));
        if (station.coopsPreview) rows.lastChild.firstElementChild.append(node('small', {class: 'sc-coops-preview-state'}, station.coopsPreview.state === 'retrieved' ? 'Live preview retrieved · ' + station.coopsPreview.datum : station.coopsPreview.state === 'no_data' ? 'No data in the attempted preview window' : 'Preview attempt failed'));
      }
    }
    if (!filtered.length) rows.append(p(coops && !stationSearch && stationRelation === 'all' && coopsFilter === 'matching' ? 'No metadata matches are available in this group. Open Mismatches to inspect exclusions, or Unresolved / choose datum for checks that need review. All stations remain available.' : discovery.complete ? 'No loaded candidates match these filters. The provider search is complete.' : 'No loaded candidates match these filters. The provider search is incomplete.', 'sc-status-line'));
    else if (!selectedStationId) rows.append(p('Choose a station above to inspect its record and request observations.', 'sc-status-line'));
    const previous = button('← Previous', () => {stationPage--; renderPanel(); document.getElementById('sc-station-page-status')?.focus({preventScroll: true});}, 'btn small'); previous.disabled = stationPage === 0;
    const next = button('Next →', () => {stationPage++; renderPanel(); document.getElementById('sc-station-page-status')?.focus({preventScroll: true});}, 'btn small', {id: 'sc-station-next'}); next.disabled = stationPage >= pages - 1;
    const station = stations.find(item => item.id === selectedStationId);
    let details = null;
    if (station) {
    const checkedCoops = coops && !!station.coopsAvailability && coopsStatus(station).state !== 'unchecked';
    const preview = previewWindow(station), retrieveButton = button(preview.available === false ? 'No overlapping preview window' : 'Retrieve ' + preview.days + '-day preview', () => runRetrieval(false), 'btn primary small'); retrieveButton.disabled = !!loading || dirty || preview.available === false;
    const ghcn = selectedId === 'ghcn_daily';
    const metadataLimited = ghcn && preview.available !== false && (preview.start > preview.requestedStart || preview.end < preview.requestedEnd && preview.days < preview.maxDays);
    details = node('div', {class: 'sc-selected-station'}, node('span', {class: 'sc-label'}, 'Selected candidate'), node('strong', {}, station.name || station.id),
      node('dl', {class: 'sc-facts'}, fact('Location', siteLabel(station)), checkedCoops ? fact((coopsStatus(station).productLabel || 'Six-minute') + ' inventory (metadata)', (coopsStatus(station).selectedPeriods || coopsStatus(station).periods)?.length ? (coopsStatus(station).selectedPeriods || coopsStatus(station).periods).length + ' listed intervals; exact bounds below.' : 'No interval confirmed; see the metadata result below.') : fact('Station record (metadata)', station.start || station.end ? (station.start || 'Unknown start') + ' → ' + (station.end || 'Unknown end') : 'Not established by this lookup'), station.variables?.length ? fact('Record elements (metadata)', station.variables.map(variable => variable.key + ': ' + (variable.start || '?') + ' → ' + (variable.end || '?')).join('; ')) : null),
      station.note && !checkedCoops ? p(station.note, 'sc-station-note') : null,
      ghcn ? p('Selected period: ' + dateRange(query) + '.', 'sc-station-note') : null,
      ghcn ? link('https://www.ncei.noaa.gov/pub/data/ghcn/daily/readme.txt', 'Station numbering system · '+SiteProviders.ghcnNetwork(station.id).networkLabel+' ↗') : null,
      coops && preview.available === false ? null : p(preview.available === false ? 'No overlap with the project dates.' : 'Preview · '+previewPeriod(preview)+(metadataLimited?' · limited by NOAA station dates':preview.shifted?' · starts at the first overlapping record':''),'sc-station-note'),
      ...(preview.notes || []).filter(note => !coops || note !== coopsStatus(station).message && !note.startsWith('Preview request:')).map(note => p(note, 'sc-station-note')));
    if (ghcn && Number.isFinite(station.elevationM)) details.append(p('NOAA inventory elevation · '+station.elevationM+' m','sc-station-note'));
    if (station.locationConflict) details.append(p(station.locationConflict.message,'sc-callout'),link(station.locationConflict.source,'Location conflict source ↗'));
    if (coops) renderCoopsStationDetails(details, station, preview); else details.append(retrieveButton);
    if (station.elevationNote) details.append(p(station.elevationNote,'sc-callout'),link(station.elevationCheckUrl,'USGS terrain at the NOAA coordinates ↗'));
    const empty = discovery.emptyPreview;
    if (empty?.stationId === station.id) details.append(node('div', {class:'sc-callout', id:'sc-empty-preview', tabindex:'-1'},
      node('strong', {}, 'No observations returned for this preview'), p(empty.label + '. ' + empty.reason + ' Missing reports leave conditions unknown. Try another station or change the project dates and run Check site.', 'sc-station-note')));
    if (ghcn && !sample && preview.available !== false) details.append(node('details', {class:'sc-disclosure'}, node('summary', {}, 'How NOAA observations are checked'),
      p('Daily Summaries is checked first. When observations cannot be retrieved, the app checks NOAA station files and, when needed, the annual archive.'),
      node('div',{class:'sc-source-links'},link(SiteProviders.ghcnStationFileUrl(station.id), 'Open the full NOAA station file (.dly) ↗'),
        link(SiteGhcnArchive.stationUrl(station.id),'NOAA station archive (.csv.gz) ↗'))));
    if (!sample) renderStationDownload(details, station, preview);
    }
    const missingDetails = selectedId === 'usgs_streamflow' ? page.filter(station=>station.name===station.id) : [];
    const loadDetails = missingDetails.length ? button('Load names and catchment details for this page',()=>runStationDetails(missingDetails),'btn small',{id:'sc-station-details'}) : null;
    if (loadDetails) loadDetails.disabled=dirty||!!loading;
    return node('div', {class: 'sc-station-box'}, node('div', {class: 'sc-station-filters'}, stationFind, relationSelect, networkSelect), rows, loadDetails,
      node('div', {class: 'sc-station-pager'}, node('span', {id: 'sc-station-page-status', tabindex: '-1'}, filtered.length + (coops ? ' listed' : ' matches') + ' · display page ' + (stationPage + 1) + ' / ' + pages), node('span', {}, previous, next)),
      details);
  }
  function stationNetworkBadge(id) {
    const network=SiteProviders.ghcnNetwork(id);
    return network.networkCode==='0'?null:node('span',{class:'sc-station-network'},network.networkLabel);
  }
  function renderCoopsStationDetails(details, station, preview) {
    const availability = coopsStatus(station), datums = availability.availableDatums || [];
    details.append(node('p', {class: 'sc-coops-detail-status'}, node('span', {class: 'sc-coops-status ' + coopsGroup(station)}, availability.label), ' ', availability.message));
    if (availability.errors?.length) details.append(node('div', {class: 'sc-coops-messages'}, node('strong', {}, 'Metadata check messages'),
      node('ul', {}, availability.errors.map(error => node('li', {}, node('strong', {}, (error.source==='inventory'?'Station inventory':error.source==='datums'?'Datum information':'Metadata') + ': '), userError(error) || 'No diagnostic supplied.', error.recovered ? ' Recovered on retry.' : '')))));
    if (availability.alternativeProduct) details.append(link(availability.alternativeProduct.url, availability.alternativeProduct.label + ' listed for these dates · NOAA inventory ↗'));
    if (datums.length) {
      const select = node('select', {id: 'sc-coops-datum', class: 'sc-select', 'aria-describedby': 'sc-coops-datum-note'});
      if (!datums.some(datum => datum.code === availability.selectedDatum)) select.append(node('option', {value: '', disabled: ''}, 'Choose a supported datum'));
      datums.forEach(datum => select.append(node('option', {value: datum.code}, datum.code + (datum.code === availability.defaultDatum ? ' (default)' : '') + (datum.label && datum.label !== datum.code ? ' · ' + datum.label : ''))));
      select.value = availability.selectedDatum || ''; select.disabled = !!loading || dirty;
      select.addEventListener('change', () => {
        if (dirty || loading) return;
        try {
          const assessed = SiteProviders.assessCoopsStation(station, query, select.value);
          const updated = {...station, coopsAvailability: assessed};
          discovery.stations = discovery.stations.map(item => item.id === station.id ? updated : item);
          sample = null; stationDownloadPlan = null; savedLabel = ''; networkError = ''; activeSeries = 0;
          delete discovery.emptyPreview;
          if (coopsGroup(updated) === 'matching' && coopsFilter !== 'all') coopsFilter = 'matching';
          announce.textContent = 'Datum explicitly chosen: ' + select.value + '. ' + assessed.message;
          renderPanel(); document.getElementById('sc-coops-datum')?.focus({preventScroll: true});
        } catch (error) {networkError = userError(error); renderPanel();}
      });
      const chosen = datums.find(datum => datum.code === availability.selectedDatum);
      details.append(node('div', {class: 'sc-coops-datum'}, node('label', {for: 'sc-coops-datum'}, 'Requested vertical datum'), select,
        p((availability.selectionMode === 'explicit' ? 'Explicit choice. ' : availability.selectedDatum ? 'Checked default. ' : 'No automatic alternative is selected. ') + (chosen?.basis ? chosen.basis + ' ' : '') + 'The provider returns values relative to the chosen datum. This tool performs no local datum conversion; suitability requires separate review.', 'sc-station-note')));
      details.lastChild.lastChild.id = 'sc-coops-datum-note';
      const epoch=String(availability.datumMetadata?.epoch ?? '').trim();
      details.append(p(epoch && !/^0000\s*[-–]\s*0000$/.test(epoch) ? 'NOAA datum-table epoch: '+epoch+'. Check historical epoch compatibility.' : 'NOAA datum-table epoch not published.', 'sc-station-note'));
    }
    const history = station.coopsPreview;
    if (history && !(history.state === 'no_data' && discovery.emptyPreview?.stationId === station.id)) details.append(p((history.state === 'retrieved' ? 'Live preview retrieved' : history.state === 'no_data' ? 'No numeric data returned for this attempted preview' : 'Preview attempt failed') + ': ' + previewPeriod(history.window) + '; datum ' + (history.datum || 'not established') + '. ' + (history.state === 'retrieved' ? 'Only this response is evidenced.' : 'This does not change the documented metadata result or establish absence over the whole project period.'), 'sc-coops-preview-note'));
    if ((availability.selectedPeriods || availability.periods)?.length) details.append(node('details', {class: 'sc-disclosure'}, node('summary', {}, (availability.productLabel || 'Six-minute') + ' inventory intervals'), node('ul', {}, (availability.selectedPeriods || availability.periods).map(period => node('li', {}, period.product + ': ' + (period.first || period.start) + ' → ' + (period.last || period.end))))));
    if (availability.listedProducts?.length) details.append(node('details', {class: 'sc-disclosure'}, node('summary', {}, 'Products listed by NOAA'), p(availability.listedProducts.map(value => typeof value === 'string' ? value : value.name || value.product || JSON.stringify(value)).join(' · '))));
    const actions = node('div', {class: 'sc-detail-actions'});
    if (canPreviewCoops(station) && preview.available !== false) {
      const retrieve = button('Retrieve water-level preview', () => runRetrieval(false), 'btn primary small', {id: 'sc-coops-retrieve'}); retrieve.disabled = !!loading || dirty; actions.append(retrieve);
    } else if (availability.state === 'unresolved' && availability.canTryPreview === true) {
      const attempt = previewWindow(station, true);
      details.append(p('Metadata are unresolved. An unverified attempt would request ' + previewPeriod(attempt) + ', using datum ' + (availability.tryDatum || 'not established') + ' without confirmed metadata support. It may return no data or an error. This does not change the metadata status.', 'sc-callout'));
      const attemptButton = button('Try unverified preview', () => runRetrieval(true), 'btn small', {id: 'sc-coops-unverified'}); attemptButton.disabled = !!loading || dirty || attempt.available === false; actions.append(attemptButton);
    }
    const retry = button(availability.state === 'unchecked' || availability.state === 'unresolved' ? 'Check / retry station metadata' : 'Recheck station metadata', () => runCoopsRetry([station.id]), 'btn small'); retry.disabled = !!loading || dirty; actions.append(retry);
    if (availability.inventoryUrl) actions.append(link(availability.inventoryUrl, 'NOAA station inventory ↗', 'btn small'));
    details.append(actions);
  }
  function pythonLauncher() {return {windows: 'py -3', unix: 'python3', path: 'python'}[accessPlatform] || 'python';}
  function platformSelect(id) {
    const select = node('select', {id, class: 'sc-select', 'aria-label': 'Python command for your computer'});
    for (const [value, label] of [['windows', 'Windows (py -3)'], ['unix', 'macOS / Linux (python3)'], ['path', 'Python on PATH (python)']]) select.append(node('option', {value}, label));
    select.value = accessPlatform; select.addEventListener('change', () => {accessPlatform = select.value; renderPanel(); document.getElementById(id)?.focus({preventScroll: true});});
    return select;
  }
  function stationDownloadCurrent(plan) {
    return stationDownloadPlan === plan && !dirty && !loading && plan.manifest?.productId === selectedId && plan.manifest?.station?.id === selectedStationId && !plan.errors?.length;
  }
  function stationDownloadCommands(plan) {
    const command = pythonLauncher() + ' ' + plan.script.name;
    return [{label: 'Check Python', text: pythonLauncher() + ' --version'},
      {label: 'Preview the complete plan without downloading', text: command},
      {label: 'Download the first scheduled request after reviewing the plan', text: command + ' --download --file 1 --confirm-transfer'},
      {label: 'Download every scheduled request after reviewing the plan', text: command + ' --download --confirm-transfer'}];
  }
  function renderStationDownload(details, station, preview) {
    if (selectedId === 'usgs_streamflow') {
      const routes = SiteProviders.usgsStationLinks(station.id,query);
      if (routes.length) details.append(node('details', {class:'sc-disclosure sc-usgs-routes'}, node('summary', {}, 'Continuous flow, stage and annual peaks at USGS'),
        p((routes[0].projectDates?'Continuous records use the project dates in UTC. Annual peaks cover all years.':'These links browse all available dates.')+' USGS shows matching observations for this station. Follow the page links for more records.', 'sc-station-note'),
        node('div', {class:'sc-source-links'}, routes.map(route=>link(route.url, route.label+' ↗')))));
    }
    if (!window.SiteStationDownload) return;
    const eligible = preview.available !== false && (selectedId !== 'noaa_coops_water_level' || canPreviewCoops(station));
    if (!eligible) return;
    const section = node('section', {class: 'sc-project-download', 'aria-label': 'Project-period station data'});
    const prepare = button('Get project-period data', () => {
      if (dirty || loading || station.id !== selectedStationId) return;
      try {stationDownloadPlan = SiteStationDownload.prepare(selectedId, station, query);}
      catch (error) {stationDownloadPlan = {errors: [userError(error) || 'The station request could not be prepared.']};}
      renderPanel(); reveal(document.getElementById('sc-project-download-title'));
    }, 'btn small', {id: 'sc-station-project-data'}); prepare.disabled = dirty || !!loading;
    if (sample && !stationDownloadPlan && details.querySelector('.sc-exports')) {
      details.querySelector('.sc-exports').append(prepare);
      if (sample.rawFormat === 'dly') details.querySelector('.sc-observation-source').append(p('Project-period CSV and script requests use Daily Summaries. The original station file can contain additional records.'));
      return;
    }
    if (stationDownloadPlan) section.append(node('h4', {id: 'sc-project-download-title', tabindex: '-1'}, selectedId==='usgs_streamflow'?'Project-period daily mean discharge':'Project-period data'));
    else section.append(prepare);
    if (sample?.rawFormat === 'dly' || sample?.previewCsv) section.append(p('The NOAA service link and Python script use Daily Summaries. Archive CSV rows retain native units and flags.', 'sc-station-note'));
    const plan = stationDownloadPlan;
    if (!plan || plan.manifest?.station?.id && plan.manifest.station.id !== station.id) {details.append(section); return;}
    if (plan.errors?.length) {section.append(node('div', {class: 'sc-error', role: 'alert'}, node('ul', {}, plan.errors.map(error => node('li', {}, error))))); details.append(section); return;}
    const manifest = plan.manifest, initialOnly = manifest.transferSummary?.totalPagesKnown === false;
    const blocked = !stationDownloadCurrent(plan), current = () => stationDownloadCurrent(plan);
    section.append(node('dl', {class: 'sc-facts'}, sample ? null : fact('Station', manifest.station.name + ' [' + manifest.station.id + ']'), fact('Project period', dateRange(manifest.query)),
      manifest.datum ? fact('Requested datum', manifest.datum) : null, fact(initialOnly ? 'Initial requests' : 'Scheduled requests', String(plan.requestCount)), fact('Estimated JSON size', plan.transferEstimate ? fileSize({sizeBytes:plan.transferEstimate.minBytes}) + '–' + fileSize({sizeBytes:plan.transferEstimate.maxBytes}) + ' (approximate)' : 'Unknown before retrieval')));
    if (initialOnly) section.append(p((plan.requests.length===1?'The JSON link opens the first page. ':'')+'The script retrieves subsequent pages.','sc-transfer-summary'));
    if (plan.transferEstimate) section.append(node('details', {class:'sc-disclosure'}, node('summary', {}, 'How this size is estimated'), p(plan.transferEstimate.basis, 'sc-station-note')));
    if (plan.unrequestedIntervals?.length) section.append(node('details', {class: 'sc-disclosure sc-unscheduled', open: ''}, node('summary', {}, plan.unrequestedIntervals.length + ' interval(s) not scheduled'),
      node('ul', {}, plan.unrequestedIntervals.map(interval => node('li', {}, previewPeriod(interval) + '. ' + interval.reason)))));
    const directUrl=plan.directUrl || (plan.requests.length===1?plan.requests[0].url:null);
    const archiveSample=sample?.previewCsv ? sample : null;
    const sameWindow=archiveSample && archiveSample.window.start===query.start && archiveSample.window.end===query.end;
    const archiveStamp=archiveSample?.requests.at(-1)?.lastModified;
    const fullStation=archiveSample?.rawFormat==='csv.gz' && Date.parse(archiveStamp)>=Date.parse(query.end);
    if (sameWindow || fullStation) {
      const saveRows=button('Download project-period archive CSV',async()=>{
        if (!current()) return;
        saveRows.disabled=true;
        try {
          const csv=sameWindow ? archiveSample.previewCsv : (await SiteGhcnArchive.stationCsv(archiveSample.rawBytes,station.id,query.start.replace(/-/g,''),query.end.replace(/-/g,''))).previewCsv;
          if (current()) download(csv,'text/csv',station.id+'_'+query.start+'_'+query.end+'_native.csv',true);
        } catch (error) {if (current()) section.append(p(userError(error),'sc-error'));} finally {saveRows.disabled=blocked;}
      },'btn primary small');
      saveRows.disabled=blocked; section.append(saveRows);
    }
    if (directUrl) {
      const label=plan.directUrl?(archiveSample?'NOAA Daily Summaries CSV ↗':'Open project-period CSV ↗'):initialOnly?'Open provider JSON (first page) ↗':'Open provider JSON ↗';
      const direct = link(directUrl,label,'btn primary small');
      direct.addEventListener('click', event => {if (!current()) event.preventDefault();});
      section.append(node('div',{class:'sc-full-period-link'},blocked ? button(label,()=>{},'btn small',{disabled:''}) : direct));
    }
    if (plan.script) {
      const commands = stationDownloadCommands(plan);
      const save = button('Download project-period Python script', () => {if (current()) download(plan.script.text, plan.script.mime, plan.script.name);}, 'btn primary small'); save.disabled = blocked;
      const instructions = ['Save the script and open a terminal in that folder. Use Python 3.10 or later.',
        'Preview the dates, then run a download command. Files and the transfer receipt are saved in ' + plan.folderName + '/.'];
      const shownCommands = commands.filter((_, index) => index !== 0 && (index !== 2 || plan.requestCount > 1 || initialOnly));
      const script = node('details', {class: 'sc-disclosure sc-station-script'}, node('summary', {}, plan.directUrl ? 'Optional: recoverable transfer with Python' : 'Download with the prepared Python script'),
        node('ol', {}, instructions.map(text => node('li', {}, text))), link('https://www.python.org/downloads/', 'Get Python ↗'), platformSelect('sc-station-python-platform'),
        save, ...shownCommands.map(command => commandBlock(command, blocked, current)),
        plan.requestCount > 1 ? p('Repeat --file to select several request numbers.', 'sc-access-output-note') : null);
      const steps = button('Save these download steps', () => {if (current()) download(['Project-period station data', manifest.station.name + ' [' + manifest.station.id + ']', dateRange(manifest.query), manifest.datum ? 'Datum: ' + manifest.datum : '',
        'Transfer size: unknown before retrieval', 'No JSON input file or code editing is required.', '', ...instructions, '', ...commands.map(command => command.label + '\n' + command.text), '', ...(plan.notes || [])].filter(Boolean).join('\n') + '\n', 'text/plain', plan.folderName + '_how_to_download.txt');}, 'btn small'); steps.disabled = blocked;
      script.append(steps); section.append(script);
    }
    if (plan.notes?.length) section.append(node('details', {class: 'sc-disclosure'}, node('summary', {}, 'Transfer scope and qualifications'), node('ul', {}, plan.notes.map(note => node('li', {}, note)))));
    const record = button('Save prepared transfer record', () => {if (current()) download(JSON.stringify(manifest, null, 2) + '\n', 'application/json', plan.folderName + '_request_manifest.json');}, 'btn small'); record.disabled = blocked;
    section.append(node('details', {class: 'sc-disclosure'}, node('summary', {}, 'Optional request record'), p('This documents the planned transfer. It is not downloaded data and is not required by the script.'), record));
    details.append(section);
  }
  async function runStationDetails(stations) {
    if (dirty || loading || !discovery || selectedId !== 'usgs_streamflow') return;
    cancelPending(); controller=new AbortController(); const token=generation;
    loading='Loading station names and catchment details…'; loadingKind='station-details'; networkError=''; renderPanel();
    try {
      const response=await SiteProviders.describeStations(selectedId,stations,{signal:controller.signal});
      if (token!==generation) return;
      const byStation=new Map(response.stations.map(station=>[station.id,station]));
      discovery.stations=discovery.stations.map(station=>byStation.get(station.id)||station);
      discovery.requests.push(...response.requests); discovery.notes.push(...response.notes);
      announce.textContent=response.notes.join(' ')||'Station details loaded for this page.';
    } catch(error) {if(token===generation)networkError=userError(error);}
    finally {if(token===generation){loading='';loadingKind='';controller=null;renderPanel();}}
  }
  function chooseStation(id, fromMap = false) {
    if (!discovery?.stations.some(station => station.id === id)) return;
    stationChoiceRequired = false;
    if (!['discovery', 'coops-preflight'].includes(loadingKind)) cancelPending();
    selectedStationId = id; sample = null; stationDownloadPlan = null; savedLabel = ''; activeSeries = 0;
    delete discovery.emptyPreview;
    networkError = discovery.error?.message || '';
    announce.textContent = networkError || 'Station selected. Retrieve a preview to check this station and period.';
    if (fromMap) {stationSearch = ''; stationRelation = 'all'; stationNetwork = 'all'; if (selectedId === 'noaa_coops_water_level') coopsFilter = 'all'; stationPage = Math.max(0, Math.floor(filteredStations().findIndex(station => station.id === id) / stationPageSize));}
    renderPanel();
    const selected = panel.querySelector('.sc-station-row[aria-pressed="true"]');
    if (fromMap) reveal(selected); else selected?.focus({preventScroll: true});
  }
  function mergeDiscovery(response) {
    const previous = discovery || {stations: [], requests: [], notes: []};
    const stations = new Map(previous.stations.map(station => [station.id, station]));
    for (const station of response.stations || []) {
      const existing = stations.get(station.id), merged = {...existing, ...station};
      if (existing?.name && existing.name !== existing.id && (!station.name || station.name === station.id)) merged.name = existing.name;
      for (const field of ['variables', 'seriesMetadata', 'metadataRequests']) {
        const values = [...(existing?.[field] || []), ...(station[field] || [])];
        if (values.length) merged[field] = [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
      }
      const starts = [existing?.start, station.start].filter(Boolean).sort(), ends = [existing?.end, station.end].filter(Boolean).sort();
      if (starts.length) merged.start = starts[0]; if (ends.length) merged.end = ends[ends.length - 1];
      stations.set(station.id, merged);
    }
    discovery = {...previous, ...response, stations: [...stations.values()], requests: [...(previous.requests || []), ...(response.requests || [])], notes: response.notes || [],
      batchHistory: [...(previous.batchHistory || []), {candidateCount: (response.stations || []).length, notes: response.notes || [], complete: response.complete === true, cancelled: response.cancelled === true, error: response.error || null, requests: response.requests || []}],
      complete: response.complete === true, paginationComplete: response.paginationComplete ?? response.complete === true,
      error: response.error || null, cancelled: response.cancelled === true, continuation: response.continuation || null,
      searchedRecordsTotal: response.searchedRecordsTotal ?? ((previous.searchedRecordsTotal || 0) + (response.searchedRecords || 0)), savedExample: false};
    if (!stationChoiceRequired && !selectedStationId && discovery.stations.length && selectedId !== 'noaa_coops_water_level' && !stationSearch && stationRelation === 'all' && stationNetwork === 'all') selectedStationId = discovery.stations[0].id;
  }
  function cancelUserRequest() {
    if (['discovery', 'coops-preflight'].includes(loadingKind) && controller) {controller.abort(); loading = loadingKind === 'coops-preflight' ? 'Stopping metadata checks and retaining completed results…' : 'Stopping search and retaining accepted pages…'; renderPanel();}
    else {cancelPending(); renderPanel();}
  }
  async function checkCoopsCandidates(stations, token, signal, forceRefresh = false) {
    if (!stations.length || token !== generation) return;
    stations=[...stations].sort((a,b)=>Number(coopsStatus(b).state==='unchecked')-Number(coopsStatus(a).state==='unchecked')).slice(0,10);
    stationDownloadPlan = null;
    loadingKind = 'coops-preflight'; loading = 'Checking water-level products, dates and datums: 0 / ' + stations.length + '…';
    discovery.coopsPreflight = {completed: 0, total: stations.length, complete: false, cancelled: false, running: true, query: {...query}};
    renderPanel();
    const update = result => {
      if (token !== generation || !discovery) return;
      const checked = new Map((result.stations || []).map(station => [station.id, station]));
      discovery.stations = discovery.stations.map(station => checked.has(station.id) ? {...station, ...checked.get(station.id)} : station);
      discovery.coopsPreflight = {completed: result.completed, total: result.total, complete: result.complete === true, cancelled: result.cancelled === true,
        running: result.complete !== true && result.cancelled !== true, rateLimited: result.rateLimited === true, error: result.error || null, query: {...query}};
      loading = 'Checking water-level products, dates and datums: ' + result.completed + ' / ' + result.total + '…';
      const focused = document.activeElement?.id; renderPanel(); if (focused) document.getElementById(focused)?.focus({preventScroll: true});
    };
    try {
      if (!SiteProviders.checkCoopsStations) throw new Error('The CO-OPS inventory-check adapter is unavailable in this build.');
      const result = await SiteProviders.checkCoopsStations(stations, query, {signal, onProgress: update, forceRefresh});
      if (token !== generation) return;
      update(result); discovery.coopsPreflight.running = false;
      if (result.error) networkError = result.error.message || 'Station metadata checks stopped before all candidates were attempted.';
      const counts = coopsCounts();
      announce.textContent = counts.found + ' stations found; ' + counts.matching + ' metadata matches (' + counts.partial + ' partial), ' + counts.incompatible + ' mismatches, ' + counts.unresolved + ' unresolved or awaiting a datum choice.';
    } catch (error) {
      if (token !== generation) return;
      networkError = error.name === 'AbortError' ? 'Station metadata checks cancelled. Completed checks are retained.' : 'Station metadata check failed: ' + (userError(error) || 'provider unavailable');
      discovery.coopsPreflight = {...discovery.coopsPreflight, complete: false, running: false, cancelled: error.name === 'AbortError', error: {message: networkError, code: error.code || error.name || 'METADATA'}};
      announce.textContent = networkError;
    }
  }
  async function runCoopsRetry(ids) {
    if (selectedId !== 'noaa_coops_water_level' || dirty || loading || !discovery) return;
    const stations = discovery.stations.filter(station => ids.includes(station.id));
    cancelPending(); networkError = ''; controller = new AbortController(); const token = generation;
    try {await checkCoopsCandidates(stations, token, controller.signal, true);}
    finally {if (token === generation) {loading = ''; loadingKind = ''; controller = null; renderPanel();}}
  }
  async function runDiscovery(resume = false) {
    if (dirty || loading) return;
    const cursor = resume ? discovery?.continuation : null;
    if (resume && !cursor) return;
    if (!resume) clearProviderState(); else {cancelPending(); networkError = '';}
    savedLabel = ''; controller = new AbortController(); const token = generation;
    loading = resume ? 'Continuing provider pages…' : 'Looking up station candidates…'; loadingKind = 'discovery'; renderPanel();
    try {
      let nextCursor = cursor;
      do {
        const response = await window.SiteProviders.discover(selectedId, query, {signal: controller.signal, cursor: nextCursor});
        if (token !== generation) return;
        if (selectedId === 'noaa_coops_water_level') response.stations = response.stations.map(station => ({...station,coopsProduct}));
        mergeDiscovery(response); networkError = response.error?.message || '';
        nextCursor = selectedId === 'noaa_coops_water_level' && !response.error && !response.cancelled && !controller.signal.aborted ? response.continuation : null;
        if (nextCursor) {loading = 'Finding all station candidates: ' + discovery.stations.length + ' loaded…'; renderPanel();}
      } while (nextCursor);
      if (selectedId === 'noaa_coops_water_level' && discovery.stations.length && !controller.signal.aborted) await checkCoopsCandidates(discovery.stations, token, controller.signal);
      if (token !== generation) return;
      recordStations(selectedId,discovery);renderOverview();
      if (selectedId !== 'noaa_coops_water_level') announce.textContent = discovery.stations.length + ' candidates loaded. ' + (discovery.complete ? 'Provider search complete.' : 'Search incomplete; inspect its scope and continuation.');
    } catch (error) {
      if (token !== generation) return;
      networkError = error.name === 'AbortError' ? 'Station search cancelled.' : userError(error) || 'Station lookup failed.';
      discovery = {...(discovery || {stations: [], requests: [], notes: []}), complete: false, truncated: true, cancelled: error.name === 'AbortError', error: {message: networkError, code: error.code || error.name || 'LOOKUP'}};
      announce.textContent = networkError;
    } finally { if (token === generation) {loading = ''; loadingKind = ''; controller = null; renderPanel();} }
  }
  async function runRetrieval(allowUnverified = false) {
    if (dirty || loading || !discovery) return;
    const station = discovery.stations.find(s => s.id === selectedStationId);
    if (!station) return;
    const coops = selectedId === 'noaa_coops_water_level';
    allowUnverified = allowUnverified === true;
    if (coops && !canPreviewCoops(station) && !(allowUnverified && coopsStatus(station).state === 'unresolved' && coopsStatus(station).canTryPreview === true)) return;
    const attemptedWindow = previewWindow(station, allowUnverified);
    if (attemptedWindow.available === false) return;
    cancelPending(); sample = null; savedLabel = ''; networkError = ''; activeSeries = 0;
    delete discovery.emptyPreview;
    controller = new AbortController(); const token = generation;
    loading = 'Retrieving a bounded sample from the provider…'; loadingKind = 'retrieval'; renderPanel();
    try {
      const progress = text => {if (token===generation) {loading=text; renderPanel();}};
      const response = await window.SiteProviders.retrieve(selectedId, station, query, {signal: controller.signal, allowUnverified, checkStationFile: true,
        onStationFile: () => progress('Checking NOAA’s original station file…'),
        onOpenArchive: () => progress('Checking the NOAA Open Data station archive…'),
        onAnnualArchive: () => progress('Checking the dates in NOAA’s annual archive…')});
      if (token !== generation) return;
      sample = response; candidateDrawerOpen = false; activeSeries = preferredSeries(response.series);
      for(const hazard of selectedId==='ghcn_daily'?['temperature','precipitation']:[''])
        rememberEvidence(selectedId,hazard,SiteShortlist.previewEvidence(selectedId,hazard,response),response.requests);
      renderOverview();
      if (coops && allowUnverified) sample.coopsMetadataUnverified = true;
      discovery.stations = discovery.stations.map(candidate => candidate.id === response.station.id ? {...candidate, ...response.station,
        ...(coops ? {coopsPreview: {state: 'retrieved', window: response.window, datum: response.provenance?.datumCode || coopsStatus(station).selectedDatum || coopsStatus(station).tryDatum || coopsStatus(station).defaultDatum,
          checkedAt: new Date().toISOString(), metadataUnverified: allowUnverified, numericValues: response.observationCount ?? null}} : {})} : candidate);
      announce.textContent = 'Provider response retrieved. Review the sample window, units and flags.';
    } catch (error) {
      if (token !== generation) return;
      const datum = coops ? coopsStatus(station).selectedDatum || coopsStatus(station).tryDatum || coopsStatus(station).defaultDatum : null;
      const label = station.id + ' · ' + (attemptedWindow.startTime || attemptedWindow.start) + ' → ' + (attemptedWindow.endTime || attemptedWindow.end) + (datum ? ' · datum ' + datum : '');
      const reason = userError(error) || 'Sample retrieval failed.';
      if (error.code === 'NO_DATA') {
        discovery.emptyPreview = {stationId:station.id, label, window:attemptedWindow, datum, requests:error.requests || [], reason: selectedId === 'ghcn_daily' ? reason : 'The provider returned no numeric values for the requested series.'};
        for(const hazard of selectedId==='ghcn_daily'?['temperature','precipitation']:[''])
          rememberEvidence(selectedId,hazard,{level:1,label:'No observations at checked station',detail:label+'. Other stations may report.'},error.requests);
        renderOverview();
        announce.textContent = label + '. ' + discovery.emptyPreview.reason;
      } else {networkError = label + '. ' + reason; announce.textContent = networkError;}
      if (coops) discovery.stations = discovery.stations.map(candidate => candidate.id === station.id ? {...candidate, coopsPreview: {state: error.code === 'NO_DATA' ? 'no_data' : 'failed',
        window: attemptedWindow, datum: coopsStatus(station).selectedDatum || coopsStatus(station).tryDatum || coopsStatus(station).defaultDatum, checkedAt: new Date().toISOString(), metadataUnverified: allowUnverified,
        reason, code: error.code || error.name || 'PREVIEW'}} : candidate);
    } finally { if (token === generation) {loading = ''; loadingKind = ''; controller = null; renderPanel(); if (sample) reveal(document.getElementById('sc-sample-heading')); else if (discovery.emptyPreview) reveal(document.getElementById('sc-empty-preview'));} }
  }
  function loadExample(example) {
    cancelAvailability();checkOnHazardChoice=false;
    selectedId = example.productId; explicitSelection=true; includeProduct(selectedId); clearFilters(); setQuery(example.query);
    sample = example.result; savedLabel = example.label; candidateDrawerOpen = false;
    if (selectedId === 'noaa_coops_water_level') coopsFilter = 'all';
    selectedStationId = example.station.id;
    discovery = {stations: [{...example.station, ...window.SiteGeometry.classify(query, example.station)}], requests: example.discovery?.requests || [], notes: ['Saved example station only. This is not a census for the current radius; start a live lookup to discover candidate records.'], complete: false, paginationComplete: false, continuation: null, savedExample: true};
    activeSeries = preferredSeries(sample.series); renderList(); renderPanel();renderOverview();
    reveal(document.getElementById('sc-sample-heading'));
    announce.textContent = 'Loaded saved real-data example ' + example.label + '. No live request was made.';
  }
  function renderSample(body, product) {
    const box = node('section', {class: 'sc-sample', 'aria-label': 'Retrieved data preview'});
    const requests = sample.requests || [];
    const retrieval = requests.length ? requests[requests.length - 1].retrievedAt : (sample.provenance && sample.provenance.retrievedAt);
    box.append(node('div', {class: 'sc-sample-heading'}, node('h3', {id: 'sc-sample-heading', tabindex: '-1'}, selectedId==='usgs_streamflow'?'Daily mean discharge preview':'Observation preview'), badge(savedLabel ? 'Saved real-data example' : 'Live provider response', savedLabel ? 'saved' : 'live')),
      node('div', {class: 'sc-observation-site'}, node('strong', {}, sample.station.name), ' · ' + sample.station.id, selectedId === 'ghcn_daily' ? stationNetworkBadge(sample.station.id) : null),
      p('Preview ' + previewPeriod(sample.window) + (sample.window.start !== query.start || sample.window.end !== query.end ? ' · Project ' + dateRange(query) : ''), 'sc-sample-stamp'));
    if (selectedId === 'noaa_coops_water_level') box.append(p('Vertical datum · ' + (sample.provenance?.datum || sample.provenance?.datumCode || 'unconfirmed') + ' · UTC', 'sc-sample-stamp'));
    if (sample.coopsMetadataUnverified) box.append(p('Station inventory or datum metadata are unverified for these values.', 'sc-callout'));
    if (sample.station.elevationNote) box.append(node('p',{class:'sc-callout'},sample.station.elevationNote,' ',link(sample.station.elevationCheckUrl,'USGS terrain check ↗')));
    if (sample.rawFormat === 'dly') box.append(p('Source · NOAA’s original station file.', 'sc-callout'));
    const series = sample.series || [];
    if (activeSeries >= series.length) activeSeries = 0;
    if (series.length) {
      const tabs = node('div', {role: 'group', class: 'sc-series-tabs', 'aria-label': 'Preview variable'});
      series.forEach((s, i) => {
        const duplicate = series.filter(other => other.label === s.label).length > 1;
        tabs.append(button(s.label + (duplicate ? ' · series ' + (i + 1) : ''), () => {activeSeries = i; renderPanel(); panel.querySelector('.sc-series-tab[aria-pressed="true"]')?.focus({preventScroll: true});}, 'sc-series-tab', {'aria-pressed': String(i === activeSeries), title: s.key + ' · ' + displayUnit(s.unit)}));
      });
      box.append(tabs);
      if (series.filter(other => other.label === series[activeSeries].label).length > 1) box.append(p('Separate provider series: ' + series[activeSeries].key + '. Series are not merged.', 'sc-sample-stamp'));
      box.append(renderChart(series[activeSeries]));
      const points = series[activeSeries].points || [];
      const table = node('table', {class: 'sc-data-table'}, node('thead', {}, node('tr', {}, node('th', {scope: 'col'}, 'Provider time'), node('th', {scope: 'col'}, 'Value (' + displayUnit(series[activeSeries].unit) + ')'), node('th', {scope: 'col'}, 'Provider flags'))));
      const tbody = node('tbody');
      for (const point of points) tbody.append(node('tr', {}, node('td', {}, point.time), node('td', {}, point.flags?.measurementFlag==='T' ? 'Trace (provider value '+point.value+')' : Number.isFinite(point.value) ? String(point.value) : point.multiDay ? 'Daily value unavailable; '+point.multiDay.element+' '+point.multiDay.value+' '+displayUnit(series[activeSeries].unit)+' over '+(point.multiDay.days||'unknown')+' days' : 'Missing'), node('td', {}, point.multiDay ? multiDayFlagText(point) : flagText(point.flags))));
      table.append(tbody);
      const flagNote = {
        ghcn_daily: 'Source flags are distinct from quality flags. A nonblank quality flag indicates a failed provider quality check; the value remains visible. Daily dates follow provider observation-day conventions, not a guaranteed UTC day.',
        noaa_coops_water_level: 'Quality v means provider verified; p means preliminary. These are provider statuses, not validation by this tool. Data flags and sigma remain attached. Times are UTC; values are metres relative to ' + (sample.provenance?.datum || (sample.station?.greatlakes ? 'IGLD' : 'MSL')) + '.',
        usgs_streamflow: 'USGS records approval separately from qualifiers. An approved daily mean can be estimated, revised, or both.'
      }[selectedId];
      const references = sample.provenance && Array.isArray(sample.provenance.documentation) ? sample.provenance.documentation : [product.documentation_url];
      box.append(node('details', {class: 'sc-disclosure'}, node('summary', {}, 'Inspect ' + points.length + ' returned ' + (points.length === 1 ? 'row' : 'rows') + ' and flags'),
        p(flagNote || 'Provider flags are retained; a non-empty flag is not automatically a quality failure. Read the provider definitions before filtering.', ''), node('div', {class: 'sc-table-wrap'}, table), node('div', {class: 'sc-source-links'}, references.map((url, i) => link(url, 'Provider reference ' + (i + 1) + ' ↗')))));
    } else box.append(p('The response contains no previewable series. Inspect the original provider response and its source details.', 'sc-callout'));
    const source = node('details', {class: 'sc-disclosure sc-observation-source'}, node('summary', {}, 'Source and request details'),
      p((savedLabel ? savedLabel + ' · ' : '') + 'Retrieved ' + (retrieval ? displayTimestamp(retrieval) : 'at an unrecorded time') + '.'));
    const workflow = stationWorkflowStatus();
    if (workflow) source.append(node('p', {class: 'sc-workflow-status'}, workflow.title + '. ' + workflow.detail));
    if (sample.notes?.length) source.append(node('ul', {}, sample.notes.map(note => node('li', {}, note))));
    const links = node('div', {class: 'sc-source-links'});
    if (sample.provenance?.sourceFiles?.length) {
      const files = sample.provenance.sourceFiles;
      for (const url of files) {
        const element = url.match(/ELEMENT=([A-Z0-9]+)\//)?.[1];
        links.append(link(url,element?'NOAA '+element+' file '+url.split('_').pop().split('.')[0]+' ↗':'NOAA station archive (.csv.gz) ↗','sc-request-link'));
      }
    } else if (requests.length) links.append(link(requests[requests.length - 1].url, 'Open the exact provider request ↗', 'sc-request-link'));
    if (selectedId === 'ghcn_daily' && sample.rawFormat !== 'dly') links.append(link(SiteProviders.ghcnStationFileUrl(sample.station.id), 'Compare the full NOAA station file (.dly) ↗', 'sc-request-link'));
    source.append(links, button('Download sources and request details', exportProvenance, 'btn small'));
    const exports = node('div', {class:'sc-exports'});
    if (sample.previewCsv) {
      const nativeName=sample.station.id+'_'+sample.window.start+'_'+sample.window.end+'_native.csv';
      exports.append(button('Download preview rows (CSV)',()=>download(sample.previewCsv,'text/csv',nativeName,true),'btn primary small'));
      source.append(p('The archive CSV uses NOAA native units: PRCP, MDPR, TMAX and TMIN are in tenths. Snowfall is in mm and durations are in days. Charts show mm and °C.'));
      if (sample.rawFormat==='csv.gz') source.append(button('Download full NOAA station archive (.csv.gz)',()=>download(sample.rawBytes,sample.rawMime,sample.station.id+'.csv.gz',true),'btn small'));
    } else {
      exports.append(button(sample.rawFormat === 'dly' ? 'Download full NOAA station file (.dly)' : 'Download original ' + sample.rawFormat.toUpperCase(), () => download(sample.rawBytes||sample.rawText, sample.rawMime, sample.rawFormat === 'dly' ? sample.station.id + '_full_station_record.dly' : filename() + '.' + sample.rawFormat, true), 'btn primary small'));
    }
    box.append(source,exports);
    body.append(box);
  }
  const displayUnit = unit => unit === 'ft^3/s' ? 'ft³/s' : unit;
  function multiDayFlagText(point){
    const total=point.multiDay,duration=total.element==='MDPR'?'DAPR':'DASF';
    const decode=attributes=>{const parts=typeof attributes==='string'?attributes.split(','):[];return {measurementFlag:parts[0],qualityFlag:parts[1],sourceFlag:parts[2],observationTime:parts[3]};};
    return 'Daily value flags: '+flagText(point.flags)+' | '+total.element+' total flags: '+flagText(decode(total.attributes))+' | '+duration+' duration flags: '+flagText(decode(total.daysAttributes));
  }
  function flagText(flags) {
    if (flags===undefined || flags===null || flags==='') return 'No flag supplied';
    if (typeof flags!=='object') return String(flags);
    const labels={measurementFlag:'Measurement flag',qualityFlag:'QC flag',sourceFlag:'Source flag',observationTime:'Observation time',quality:'Status',dataFlags:'Data flags',sigma:'Sigma',approvalStatus:'Status',qualifier:'Qualifier',lastModified:'Last modified',timeSeriesId:'Series ID',missingSentinel:'Missing-value code'};
    return Object.entries(flags).filter(([key,value])=>key!=='attributes'&&value!==null&&value!==undefined&&value!=='').map(([key,value])=>{
      if(key==='quality')value=({v:'Verified',p:'Preliminary'}[value]||value);
      if(key==='qualifier')value=(Array.isArray(value)?value:[value]).map(q=>({ESTIMATED:'Estimated',REVISED:'Revised'}[q]||q)).join(', ');
      if(key==='sourceFlag'&&SiteObservationChart.cf6Source(value))value+=' (preliminary NWS CF6 source)';
      if(key==='qualityFlag') {const meaning={D:'failed duplicate check',G:'failed gap check',I:'failed internal consistency check',K:'failed streak/frequent-value check',L:'failed multiday-period length check',M:'failed megaconsistency check',N:'failed naught check',O:'failed climatological outlier check',R:'failed lagged-range check',S:'failed spatial consistency check',T:'failed temporal consistency check',W:'temperature too warm for snow',X:'failed bounds check',Z:'flagged by official Datzilla investigation'}[value];if(meaning)value=value+' — '+meaning;}
      if(key==='measurementFlag') {const meaning={B:'precipitation summed from two 12-hour totals',D:'precipitation summed from four 6-hour totals',K:'converted from knots',L:'temperature appears lagged relative to observation hour',O:'converted from oktas',P:'missing presumed zero',T:'trace amount',W:'converted from 16-point wind-direction code'}[value];if(meaning)value=value+' — '+meaning;}
      if(key==='observationTime' && /^\d{4}$/.test(String(value)))value=String(value).slice(0,2)+':'+String(value).slice(2);
      return (labels[key]||'Provider flag')+': '+(Array.isArray(value)?value.join(', '):String(value));
    }).join(' · ')||'No flag supplied';
  }
  function failedGhcnQc(point) {
    return selectedId === 'ghcn_daily' && typeof point.flags?.qualityFlag === 'string' && point.flags.qualityFlag.trim() !== '';
  }
  function chartTickScale(values, nonnegative = false) {
    const rawLow = Math.min(...values), low = nonnegative && rawLow >= 0 ? 0 : rawLow, high = Math.max(...values);
    const padding = (high - low) * .12 || Math.max(Math.abs(high) * .05, 1);
    const rawStep = (high - low + 2 * padding) / 4, magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const step = [1, 2, 2.5, 5, 10].find(value => value * magnitude >= rawStep) * magnitude;
    const first = nonnegative && low >= 0 ? Math.max(0,Math.floor((low-padding)/step)) : Math.floor((low-padding)/step), last = Math.ceil((high + padding) / step);
    const ticks = Array.from({length: last - first + 1}, (_, index) => Number(((first + index) * step).toPrecision(15)));
    return {min: ticks[0], max: ticks[ticks.length - 1], step, ticks};
  }
  function formatChartTick(value, step) {
    if (Math.abs(value) < step * 1e-8) return '0';
    if (Math.abs(value) >= 1e6 || Math.abs(value) < 1e-4) {
      const digits = Math.min(14, Math.max(0, Math.floor(Math.log10(Math.abs(value))) - Math.floor(Math.log10(step)) + 1));
      return value.toExponential(digits).replace(/(\.\d*?)0+e/, '$1e').replace(/\.e/, 'e');
    }
    return value.toLocaleString('en-US', {maximumFractionDigits: Math.min(12, Math.max(0, 1 - Math.floor(Math.log10(step))))});
  }
  function preferredSeries(series){
    const wanted=hazardFilter==='temperature'?'TMAX':'PRCP';
    const choice=wanted?series.findIndex(s=>s.key===wanted&&s.points.some(p=>Number.isFinite(p.value)||Number.isFinite(p.multiDay?.value))):-1;
    return choice>=0?choice:Math.max(0,series.findIndex(s=>s.points.some(p=>Number.isFinite(p.value)||Number.isFinite(p.multiDay?.value))));
  }
  function chartLegend(symbols, m) {
    const missing = (m.missing?.length || 0) - m.multiDayMissing;
    const labels = {
      bar: 'Daily amount', line: 'Consecutive readings', point: 'Reported value', zero: 'Zero',
      trace: 'Trace amount', missing: (m.daily ? 'Missing day' : 'Missing reading') + (missing === 1 ? '' : 's') + ' (' + missing + ')',
      multi: 'Multi-day total only (' + m.multiDayMissing + ')',
      estimated:'Estimated', revised:'Revised', estimatedRevised:'Estimated and revised',
      failed: 'Failed quality check', preliminary: selectedId === 'usgs_streamflow' ? 'Provisional' : 'Preliminary',
      presumed: 'Presumed zero (amount unknown)'
    };
    const legend = node('ul', {class:'sc-chart-key', 'aria-label':'Chart symbols'});
    for (const [key, label] of Object.entries(labels)) {
      if (symbols.has(key)) legend.append(node('li', {'data-legend-key':key}, node('span', {class:'sc-chart-symbol', 'aria-hidden':'true'}, key === 'missing' ? '×' : key === 'presumed' ? '?' : ''), label));
    }
    return legend;
  }
  function chartCountDetails(m, key) {
    const accumulation = key === 'PRCP' || key === 'SNOW';
    const counts = node('dl', {class:'sc-chart-counts'});
    const count = (label, value) => counts.append(node('div', {}, node('dt', {}, label), node('dd', {}, String(value))));
    count('Numeric values returned', m.numeric.length);
    if (m.expected !== null) {
      count(m.daily ? 'Expected reporting days' : 'Expected reporting intervals', m.expected);
      count('Dates or times without a record', m.absent);
    }
    count(accumulation ? 'Returned missing values without a multi-day total' : 'Missing values in returned records', m.returnedMissing - m.multiDayMissing);
    if (accumulation) {
      count('Daily values unavailable with a multi-day total', m.multiDayMissing);
      count('Multi-day totals reported', m.multiDay.length);
    }
    if (selectedId === 'ghcn_daily') count('Daily records with a failed quality flag', m.failedCount);
    if (m.preliminarySourceCount) count('Numeric values from preliminary NWS CF6 reports',m.preliminarySourceCount);
    if (selectedId === 'usgs_streamflow') {
      count('Daily means marked estimated',m.estimatedCount);
      count('Daily means marked revised',m.revisedCount);
    }
    const details = node('details', {class:'sc-disclosure sc-chart-detail'}, node('summary', {}, 'Counts and calculation details'), counts);
    if (m.kind === 'bars') details.append(p('The subtotal and maximum use quantified daily amounts with no failed provider quality flag. Traces have unknown magnitude. Missing days, presumed zeros and separate multi-day totals contribute no measured amount to these statistics.', 'sc-station-note'));
    if (m.lowerBound) details.append(p('The ≥ symbol marks a lower bound if the included nonnegative amounts are valid.', 'sc-station-note'));
    return details;
  }
  function chartMultiDayReports(m, unit, fmt, dates) {
    if (!m.multiDay.length) return null;
    const multiple = m.multiDay.length > 1;
    const box = multiple ? node('details', {class:'sc-multiday sc-disclosure'}, node('summary', {}, m.multiDay.length + ' separate multi-day totals')) : node('div', {class:'sc-multiday'});
    for (const point of m.multiDay) {
      const total = point.multiDay, last = new Date(point.time.slice(0,10) + 'T00:00:00Z');
      const first = total.days ? new Date(+last - (total.days - 1) * 86400000) : null;
      const range = first ? dates.formatRange(first, last) : 'Reported ' + dates.format(last);
      const timing = first && first.toISOString().slice(0,10) < sample.window.start ? ' This interval starts before the preview.' : '';
      const flagged = [total.attributes, total.daysAttributes].some(a => typeof a === 'string' && a.split(',')[1]?.trim());
      const status = flagged ? ' NOAA flagged the total or its duration. See the observation table.' : '';
      box.append(node('p', {}, node('strong', {}, 'Separate multi-day total · ' + fmt(total.value) + ' ' + unit + (first ? ' over ' + total.days + (total.days === 1 ? ' day' : ' days') : ' · duration unknown')),
        node('span', {}, range + '.' + timing + (Number.isFinite(point.value) ? ' A separate daily value was reported.' : '') + status)));
    }
    box.append(p('The daily subtotal excludes '+(multiple?'these reports.':'this report.'), 'sc-station-note'));
    return box;
  }
  function renderChart(series) {
    const m=SiteObservationChart.model(series,sample.window,selectedId);
    const unit=displayUnit(series.unit),figure=node('figure',{class:'sc-chart','data-chart-kind':m.kind},p(series.label+' · '+unit,'sc-chart-title'));
    const fmt=value=>Number(value.toPrecision(9)).toLocaleString('en-US',{maximumFractionDigits:6});
    const dates = new Intl.DateTimeFormat('en-US', {timeZone:'UTC', month:'short', day:'numeric', year:'numeric'});
    const shortDates = new Intl.DateTimeFormat('en-US', {timeZone:'UTC', month:'short', day:'numeric', ...(sample.window.start.slice(0,4) !== sample.window.end.slice(0,4) ? {year:'numeric'} : {})});
    if(selectedId==='ghcn_daily'&&m.failedCount)figure.append(p('NOAA flagged '+m.failedCount+' of '+m.rows.length+' returned daily rows. The daily statistics exclude values that failed a quality check.','sc-callout'));
    if(m.presumedZeroCount){
      const count=m.presumedZeroCount;
      figure.append(p('NOAA marked '+count+(count===1?' day':' days')+' as missing presumed zero (P). The daily amount is unknown. Totals and maxima exclude these entries.'+(m.sum===null?' A measured total is unavailable for this preview.':''),'sc-callout'));
    }
    if(m.sum!==null){
      const label=m.complete&&!m.traceCount?'Preview-period total':'Reported subtotal';
      const peaks=m.peak ? m.numeric.filter(point => point.value === m.peak.value && !point.failed && !point.trace && !point.presumedZero) : [];
      const cf6Peaks=peaks.filter(point=>point.preliminarySource).length;
      const when=(peaks.length>2?'On '+peaks.length+' days':peaks.map(point=>shortDates.format(point.ms)).join(' and '))+(cf6Peaks?(cf6Peaks===peaks.length?' · Preliminary NWS CF6 source':' · Mixed sources, including preliminary NWS CF6'):'');
      figure.append(node('div',{class:'sc-chart-stats'},node('div',{},node('strong',{},(m.lowerBound?'≥ ':'')+fmt(m.sum)+' '+unit),node('span',{},label)),m.peak?node('div',{},node('strong',{},fmt(m.peak.value)+' '+unit),node('span',{},'Highest daily amount'),node('small',{},when)):null));
    }else if(m.peak){
      const usgs=selectedId==='usgs_streamflow',status=usgs?SiteObservationChart.usgsStatus(m.peak.flags):[];
      const ties=usgs?m.numeric.filter(point=>point.value===m.peak.value):[];
      const when=ties.length>1?' on '+ties.length+' days (first '+m.peak.time+')':' on '+m.peak.time;
      const sameStatus=ties.every(point=>SiteObservationChart.usgsStatus(point.flags).join(' · ')===status.join(' · '));
      const qualification=!sameStatus?' · provider flags vary across tied days':status.length?' · '+status.join(' · '):'';
      figure.append(p((usgs?'Highest daily mean':'Highest value in this preview')+' · '+fmt(m.peak.value)+' '+unit+when+qualification+(m.peak.preliminarySource?' · Preliminary NWS CF6 source':'')+'.','sc-chart-qualification'));
    }
    if(m.flaggedPeak)figure.append(p('Highest flagged value · '+fmt(m.flaggedPeak.value)+' '+unit+' on '+m.flaggedPeak.time+'. '+flagText(m.flaggedPeak.flags)+'.','sc-chart-qualification'));
    const traceValues=m.numeric.filter(point=>point.trace&&!point.failed).length;
    const coverage=m.expected===null?m.numeric.length+' numeric '+(m.numeric.length===1?'value':'values')+' returned. Coverage is unknown because the reporting interval or timestamp alignment is uncertain.':
      (m.daily?(m.presumedZeroCount||m.failedCount?'Numeric entries returned for ':'Daily values reported on '):'Values reported at ')+m.numeric.length+' of '+m.expected+(m.daily?(m.expected===1?' day':' days'):(m.expected===1?' expected time':' expected times'))+
      (traceValues?' · '+traceValues+(traceValues===1?' trace':' traces')+' excluded from the subtotal':'')+'.';
    figure.append(p(coverage,'sc-chart-completeness sc-value-count'));
    if(m.preliminarySourceCount)figure.append(p('Preliminary NWS CF6 source · '+m.preliminarySourceCount+' of '+m.numeric.length+' reported values.','sc-chart-qualification'));
    const multi=chartMultiDayReports(m,unit,fmt,dates),detail=chartCountDetails(m,series.key);
    if(!m.numeric.length){if(multi)figure.append(multi);figure.append(detail);return figure;}
    const symbols=new Set();
    const NS='http://www.w3.org/2000/svg',svgNode=(tag,attrs={},text)=>{const n=document.createElementNS(NS,tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,String(v));if(text!==undefined)n.textContent=text;return n;};
    const day=86400000, height=235;
    const svg=svgNode('svg',{role:'img','aria-label':series.label+' raw sample values in '+unit+'; '+sample.window.start+' to '+sample.window.end});
    const viewport=node('div',{class:'sc-chart-scroll',role:'group',tabindex:'0','aria-label':'Observation chart. Use Left and Right arrow keys to inspect readings, or Home and End for the first and last.'},svg);
    const hint=p('Scroll sideways to see all dates.','sc-chart-scroll-hint');hint.hidden=true;
    const readout=node('output',{class:'sc-chart-reading','aria-live':'polite'});
    let inspected=-1, drawnWidth=0;
    viewport.addEventListener('keydown',event=>{
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const marks=svg.querySelectorAll('[data-observation]');
      if (!marks.length) return;
      if(inspected>=0)marks[inspected]?.removeAttribute('data-inspected');
      inspected=event.key==='Home'?0:event.key==='End'?marks.length-1:Math.max(0,Math.min(marks.length-1,inspected+(event.key==='ArrowRight'?1:-1)));
      marks[inspected].setAttribute('data-inspected','true');
      readout.textContent=marks[inspected].querySelector('title').textContent;
      if (viewport.scrollWidth > viewport.clientWidth) {
        const mark = marks[inspected].getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
        if (mark.right > bounds.right) viewport.scrollLeft += mark.right-bounds.right+5;
        else if (mark.left < bounds.left) viewport.scrollLeft -= bounds.left-mark.left+5;
      }
    });
    const values=m.numeric.map(p=>p.value),scale=chartTickScale(values,m.kind==='bars'||['SNWD','AWND','WDF2','WDF5','WSF2','WSF5'].includes(series.key)||selectedId==='usgs_streamflow');
    const pad=m.daily?day/2:(m.start===m.end?(m.cadence||3600000)/2:0),tMin=m.start-pad,tMax=m.end+pad;
    const isolated=new Set(m.segments.filter(segment=>segment.length===1).map(segment=>segment[0].ms));
    function draw(width) {
      if(width===drawnWidth)return;
      drawnWidth=width;svg.textContent='';svg.setAttribute('viewBox','0 0 '+width+' '+height);
      const x=time=>60+(time-tMin)/(tMax-tMin||1)*(width-82),y=value=>18+(scale.max-value)/(scale.max-scale.min)*170;
      for(const value of scale.ticks){const yy=y(value);svg.append(svgNode('line',{x1:60,x2:width-22,y1:yy,y2:yy,stroke:value===0?'#5f7268':'#d5ddd7','stroke-width':value===0?1.5:1}),svgNode('text',{x:51,y:yy+4,'text-anchor':'end'},formatChartTick(value,scale.step)));}
      for(const gap of m.missing||[]){
        const isTotal=gap.kind.startsWith('multi-day'),mark=svgNode('path',{d:isTotal?'M'+x(gap.ms)+' 193l5 5l-5 5l-5 -5z':'M'+(x(gap.ms)-3)+' 195l6 6m0 -6l-6 6',fill:'none',stroke:isTotal?'#24589a':'#8b343b','stroke-width':1.5,'data-missing':gap.kind});
        mark.append(svgNode('title',{},new Date(gap.ms).toISOString()+': '+gap.kind));svg.append(mark);
        symbols.add(isTotal?'multi':'missing');
      }
      for(const segment of m.segments.filter(s=>s.length>1)){
        svg.append(svgNode('path',{d:segment.map((p,i)=>(i?'L':'M')+x(p.ms)+' '+y(p.value)).join(' '),fill:'none',stroke:'#17624e','stroke-width':1.6,'data-observation-line':'true'}));
        symbols.add('line');
      }
      const barWidth=Math.max(1,Math.min(40,(width-82)*(m.cadence||day)/(tMax-tMin||day)*0.7));
      for(const point of m.numeric){
        const cx=x(point.ms),cy=y(point.value),fill=point.failed?'#ae6419':point.provisional?'#fff':'#17624e';let mark;
        if(point.presumedZero){
          mark=svgNode('text',{x:cx,y:203,'text-anchor':'middle','font-weight':'bold',fill:'#79561c','data-presumed':'true','data-quality-failure':String(point.failed)},'?');
          symbols.add('presumed');
        }else if(point.trace&&!point.failed){
          mark=svgNode('path',{d:'M'+cx+' '+(y(0)-7)+'l-5 8h10Z',fill:'#624b96',stroke:'#493474','data-trace':'true'});
          symbols.add('trace');
        }else if(m.kind==='bars'&&point.value!==0){
          mark=svgNode('rect',{x:cx-barWidth/2,y:Math.min(cy,y(0)),width:barWidth,height:Math.max(1,Math.abs(y(0)-cy)),fill,stroke:point.failed?'#79440e':'#17624e','data-observation-bar':'true','data-quality-failure':String(point.failed)});
          symbols.add(point.failed?'failed':'bar');
        }else if(point.failed){
          mark=svgNode('rect',{x:cx-3.5,y:cy-3.5,width:7,height:7,fill,stroke:'#79440e','data-quality-failure':'true'});
          symbols.add('failed');
        }else if(point.estimated||point.revised){
          const symbol=point.estimated&&point.revised?'estimatedRevised':point.estimated?'estimated':'revised';
          const shape={estimated:'M0 -5L5 0L0 5L-5 0Z',revised:'M-4 -4H4V4H-4Z',estimatedRevised:'M0 -5L5 4H-5Z'}[symbol];
          mark=svgNode('path',{d:shape,transform:'translate('+cx+' '+cy+')',fill:point.provisional?'#fff':'#604878',stroke:'#48335e','stroke-width':1.6,'data-estimated':String(point.estimated),'data-revised':String(point.revised),'data-preliminary':String(point.provisional)});
          symbols.add(symbol);
          if(point.provisional)symbols.add('preliminary');
        }else{
          const zero=m.kind==='bars'&&point.value===0;
          const dense=m.kind==='line' && m.numeric.length>100 && !isolated.has(point.ms);
          mark=svgNode('circle',{cx,cy,r:dense?(point.provisional?1.7:0.65):3.4,fill:zero?'#fff':fill,stroke:point.provisional?'#8c570e':'#17624e','stroke-width':point.provisional?1.5:dense?.4:1,'data-zero':String(zero),'data-preliminary':String(point.provisional)});
          symbols.add(point.provisional?'preliminary':zero?'zero':'point');
        }
        mark.setAttribute('data-observation','true');mark.setAttribute('data-time',point.time);mark.setAttribute('data-value',point.value);
        mark.append(svgNode('title',{},point.time+': '+(point.trace?'trace (provider value '+point.value+')':point.value)+' '+unit+'; flags: '+flagText(point.flags)));svg.append(mark);
      }
      const intervals=m.daily?Math.round((m.end-m.start)/day):Math.ceil((m.end-m.start)/(m.cadence||60000));
      const tickCount=Math.min(intervals+1,Math.max(2,Math.floor((width-82)/(m.daily?51:105))));
      const ticks=[m.start];
      // Integer strides avoid adjacent day labels when fit requires skipping dates.
      const stride=Math.max(1,Math.ceil(intervals/Math.max(1,tickCount-1)));
      for(let i=stride;i<intervals;i+=stride){
        const time=m.start+i*(m.daily?day:m.cadence||60000);
        if(x(m.end)-x(time)>=(m.daily?48:105))ticks.push(time);
      }
      if(m.end>m.start)ticks.push(m.end);
      for(const [i,time]of ticks.entries()){
        const iso=new Date(time).toISOString(),label=m.daily?iso.slice(5,10):iso.slice(5,10)+' '+iso.slice(11,16);
        svg.append(svgNode('text',{x:x(time),y:220,'data-time-tick':'true','text-anchor':m.daily?'middle':i===0?'start':i===ticks.length-1?'end':'middle'},label));
      }
      if(inspected>=0)svg.querySelectorAll('[data-observation]')[inspected]?.setAttribute('data-inspected','true');
    }
    draw(600);
    if(typeof ResizeObserver==='function'){
      chartResizeObserver=new ResizeObserver(()=>{
        if(!viewport.isConnected||!viewport.clientWidth)return;
        draw(Math.round(svg.getBoundingClientRect().width));hint.hidden=viewport.scrollWidth<=viewport.clientWidth+1;
      });
      chartResizeObserver.observe(viewport);
    }
    figure.append(viewport,hint,p(sample.window.start+' → '+sample.window.end+(m.daily?' · provider reporting dates':' · UTC'),'sc-chart-axis-note'),readout,chartLegend(symbols,m));
    if(m.kind==='bars'){
      if(symbols.has('trace'))figure.append(node('figcaption',{},'A trace is an amount too small to measure.'));
    }else figure.append(node('figcaption',{},(symbols.has('line')?'Lines join consecutive readings and break at gaps or failed quality checks.':'Points show individual observations. Gaps are left open.')+(selectedId==='usgs_streamflow'?' Daily means can miss instantaneous peaks.':m.daily&&symbols.has('line')?' Each point summarizes one reporting day.':'')));
    if(multi)figure.append(multi);
    figure.append(detail);
    return figure;
  }

  function filename() {return selectedId + '_' + sample.station.id.replace(/[^A-Za-z0-9_-]/g, '-') + '_' + sample.window.start + '_' + sample.window.end;}
  function download(text, mime, name, original=false) {
    if(original)name=name.replace(/(\.csv\.gz|\.[^.]+)$/i,'__'+buildIdentity.id+'$1');
    else if(/json/.test(mime||''))text=JSON.stringify({...JSON.parse(text),inventoryBuild:buildIdentity},null,2)+'\n';
    else if(name.endsWith('.py')){
      const comment='# Inventory build: '+buildIdentity.id+'\n';
      text=text.startsWith('#!')?text.replace(/^(#![^\n]*\n)/,'$1'+comment):comment+text;
    }else if(!/^(text\/csv|text\/html)/.test(mime))text+='\nInventory build: '+buildIdentity.id+'\n';
    const url = URL.createObjectURL(new Blob([text], {type: mime || 'application/octet-stream'}));
    const anchor = node('a', {href: url, download: name}); document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function candidateSnapshot(includeStations = true) {
    if (!discovery) return null;
    return {productId: selectedId, query, loadedCandidateCount: discovery.stations.length,
      distanceDefinition: query.mode === 'area' ? 'Zero inside/on boundary; otherwise minimum distance to original polygon boundary, including holes.' : 'Distance to submitted project point.',
      distanceMethod: window.SiteGeometry.distanceMethod, complete: discovery.complete === true, paginationComplete: discovery.paginationComplete === true,
      incomplete: discovery.complete !== true, savedExample: !!discovery.savedExample, cancelled: !!discovery.cancelled, error: discovery.error || null,
      searchedRecordsTotal: discovery.searchedRecordsTotal ?? null, unlocatedRecordsTotal: discovery.unlocatedRecordsTotal ?? null, continuation: discovery.continuation || null,
      requests: discovery.requests || [], notes: discovery.notes || [], historicalBatches: discovery.batchHistory || [], stations: includeStations ? discovery.stations : undefined,
      ...(discovery.emptyPreview ? {emptyPreview:discovery.emptyPreview} : {}),
      ...(selectedId === 'noaa_coops_water_level' ? {coopsScreening: {...coopsCounts(), lastCheck: discovery.coopsPreflight || null,
        qualification: 'Metadata matches describe the explicitly selected water-level product/date/datum inventory only. Directory completion, attempted checks and actual preview responses are separate. Every loaded station remains exported, including mismatches and unchecked stations.'}} : {}),
      qualification: 'All loaded candidates are exported without the display-page or text-filter limit. Completion is scoped to this provider route and query; it does not establish representative observations or complete data coverage.'};
  }
  function exportStations() {
    if (!discovery || dirty) return;
    const product = byId.get(selectedId);
    download(JSON.stringify({tool: 'Climate-Hazard Dataset Inventory ' + data.meta.revision, exportedAt: new Date().toISOString(),
      catalogRevision: data.meta.revision, screeningMetadata, screeningRule: rules[selectedId], sourceRecord: product,
      candidateSearch: candidateSnapshot(), referencedSources: Object.fromEntries(product.evidence_ids.filter(id => data.sources[id]).map(id => [id, data.sources[id]]))}, null, 2) + '\n', 'application/json', selectedId + '_all-loaded-candidates_' + query.start + '_' + query.end + '.json');
  }
  function exportProvenance() {
    if (!sample) return;
    const product = byId.get(selectedId);
    const evidenceIds = [...new Set([...product.evidence_ids, ...(rules[selectedId]?.evidence_ids || [])])];
    const referencedSources = Object.fromEntries(evidenceIds.filter(id => data.sources[id]).map(id => [id, data.sources[id]]));
    const manifest = {tool: 'Climate-Hazard Dataset Inventory ' + data.meta.revision, exportedAt: new Date().toISOString(), mode: savedLabel ? 'saved-real-example' : 'live-response', example: savedLabel || null,
      catalogRevision: data.meta.revision, screeningMetadata, screeningRule: rules[selectedId], referencedSources,
      query, productId: selectedId, productName: product.product_name, screening: resultFor(selectedId), station: sample.station, candidateSearch: candidateSnapshot(false),
      previewRequestWindow: sample.window, requestedWindow: sample.requestedWindow, requests: sample.requests, discoveryRequests: discovery ? discovery.requests : [], providerProvenance: sample.provenance,
      units: sample.series.map(s => ({variable: s.key, unit: s.unit})), returnedValueSummaries: sample.summaries || [], notes: sample.notes, scientificLimits: product.limitations, nonUses: product.non_uses,
      documentationUrl: product.documentation_url, accessUrl: product.access_url, licenseUrl: product.license_url || null, licenseNotes: product.license_notes, commercialUseStatus: product.commercial_use_status,
      qualification: 'Availability screening and a bounded provider response. No claim of site representativeness, scientific accuracy, completeness outside the stated sample or fitness for purpose.'};
    download(JSON.stringify(manifest, null, 2) + '\n', 'application/json', filename() + '_provenance.json');
  }
  function exportStationCSV() {
    if (dirty || !discovery?.stations.length) return;
    const product = byId.get(selectedId);
    const rows = [['Station ID','Station name','Dataset','Provider','ID network code','ID network','Latitude','Longitude','Distance (km)','Distance reference','Spatial relation',
      'Elevation (m)','Elevation note','Drainage area (mi²)','Hydrologic unit code','Site type','Station record start','Station record end','Element or series periods','Reported series units','Catalog unit guidance',
      'Water-level product','Datum','Inventory status','Location caution','Project','Requested start','Requested end','Search status','Documentation','Inventory build']];
    const searchStatus = discovery.savedExample ? 'Saved example only' : discovery.complete ? 'Complete for provider query' : 'Incomplete provider search';
    const reference = query.mode==='area' ? 'Original footprint (0 inside or on boundary)' : 'Project point';
    for (const s of discovery.stations) {
      const net = selectedId==='ghcn_daily' ? SiteProviders.ghcnNetwork(s.id) : {};
      const series = s.seriesMetadata||[], elements = s.variables||[];
      const coops = s.coopsAvailability;
      const periods = [...elements,...series,...(coops?.selectedPeriods||[])].map(v=>[v.key||v.id||v.product||'Series',v.first||v.start||'unknown','to',v.last||v.end||'unknown'].join(' ')).join(' | ');
      rows.push([s.id,s.name,product.product_name,product.provider,s.networkCode??net.networkCode,s.networkLabel??net.networkLabel,s.lat,s.lon,s.distanceKm,reference,s.relation,
        s.elevationM??(selectedId==='ghcn_daily'?s.elevation:null),s.elevationNote,s.drainageArea,s.hydrologicUnitCode,s.siteType,s.start,s.end,periods,
        [...new Set(series.map(v=>v.unit).filter(Boolean))].join(' | '),product.units,s.coopsProduct,coops?.selectedDatum,coops?.label,s.locationConflict?.message,
        siteLabel(query),query.start,query.end,searchStatus,product.documentation_url,buildIdentity.id]);
    }
    download(app.makeCSV(rows),'text/csv;charset=utf-8',selectedId+'_stations_'+query.start+'_'+query.end+'.csv');
  }
  function footprintLabel() {
    if (query.mode!=='area') return 'Point '+query.lat+'°, '+query.lon+'° · station radius '+query.radiusKm+' km';
    const boxes = SiteGeometry.searchBoxes({...query,bufferKm:0});
    const bounds = boxes.map(b=>b.map(n=>Number(n.toFixed(3))).join(', ')).join(' / ');
    return query.geometry.type+' · bounds W, S, E, N ('+bounds+') · station buffer '+query.bufferKm+' km';
  }
  function exportScreeningCSV() {
    if (dirty || hazardFilter===null) return;
    const footprint = footprintLabel(), group = data.hazard_groups.find(g=>g.id===hazardFilter)?.label || 'All hazard groups';
    const rows = [['Project','Location and footprint','Requested start','Requested end','Hazard group','Product ID','Dataset','Provider','Screening outcome','Spatial relation','Temporal finding','Time-scale check','Spatial-scale check',
      'Variable','Units','Spatial support','Time support','First screening reason','First documented limitation','Documentation','Provider access','Inventory build','Shortlist rank','Availability evidence','Evidence scope','Evidence checked','Evidence source']];
    const ranked=[...shortlistIds(scopedResults())];
    const boundary = query.areaSource;
    const isHuc = /^huc(8|10|12)$/.test(boundary?.hucKind || boundary?.kind);
    if (isHuc) rows[0].push('HUC level','HUC code','WBD feature load date','Boundary tolerance (degrees)','Boundary geometry SHA-256','Boundary attribution');
    for (const r of scopedResults()) {
      const v = byId.get(r.productId);
      const scale = dimension=>(r.resolutionChecks||[]).filter(c=>c.dimension===dimension).map(c=>c.label+'. '+c.detail).join(' ');
      rows.push([siteLabel(query),footprint,query.start,query.end,group,r.productId,v.product_name,v.provider,r.label,r.spatialRelation,r.temporal,scale('time'),scale('space'),
        v.variable,v.units,v.spatial_support,v.temporal_support,r.reasons?.[0],v.limitations?.[0],v.documentation_url,v.access_url,buildIdentity.id,
        ranked.indexOf(r.productId)+1||'',evidenceFor(r.productId)?.label||'Catalog screening',evidenceFor(r.productId)?.detail||'',evidenceFor(r.productId)?.checkedAt||'',evidenceFor(r.productId)?.source||'']);
      if (isHuc) rows.at(-1).push(boundary.level,boundary.id,boundary.featureLoadDate,boundary.maxAllowableOffsetDegrees,
        boundary.geometrySha256 || boundary.reportedGeometrySha256,boundary.kind === 'project-link' ? 'User-supplied; attribution unverified' : 'Retrieved from USGS WBD');
    }
    download(app.makeCSV(rows),'text/csv;charset=utf-8','site-screen_'+query.start+'_'+query.end+'.csv');
  }
  function briefStation() {
    const station=discovery?.stations.find(s=>s.id===selectedStationId) || sample?.station;
    if (!station) return null;
    const location=query.mode==='area' && station.relation==='inside'?'Inside project area':
      Number.isFinite(station.distanceKm)?station.distanceKm.toFixed(2)+' km from the project '+(query.mode==='area'?'boundary':'point'):'';
    const block=node('section',{},node('h2',{},'Selected station'),p([station.name,station.id,location].filter(Boolean).join(' · ')));
    if (!sample || sample.station.id!==station.id) {block.append(p('No observation preview retrieved for this station.'));return block;}
    const series=sample.series?.[activeSeries], stamp=sample.requests?.at(-1)?.retrievedAt || sample.provenance?.retrievedAt;
    block.append(p([savedLabel?'Saved provider preview':'Provider preview',previewPeriod(sample.window),stamp?'retrieved '+stamp:''].filter(Boolean).join(' · ')));
    if (!series) {block.append(p('No series returned.'));return block;}
    const model=SiteObservationChart.model(series,sample.window,selectedId), unit=displayUnit(series.unit);
    const amount=v=>Number(v.toPrecision(9)).toLocaleString('en-US',{maximumFractionDigits:6})+' '+unit;
    const datum=sample.provenance?.datumCode || sample.provenance?.datum;
    block.append(p([series.label,unit,datum?'datum '+datum:'',model.numeric.length+' numeric '+(model.expected===null?'values (expected count unknown)':'of '+model.expected+' expected')].filter(Boolean).join(' · ')));
    const facts=[];
    if (model.sum!==null) facts.push((model.lowerBound?'Reported subtotal ≥ ':model.complete?'Reported total ':'Reported subtotal ')+amount(model.sum));
    if (model.peak) {
      const flags=model.peak.flags, status=selectedId==='usgs_streamflow'?SiteObservationChart.usgsStatus(flags):selectedId==='noaa_coops_water_level'?[({v:'Verified',p:'Preliminary'})[flags?.quality]||flags?.quality].filter(Boolean):model.peak.preliminarySource?['preliminary NWS CF6 source']:[];
      const ties=model.numeric.filter(row=>row.value===model.peak.value&&!row.failed&&!row.trace&&!row.presumedZero).length;
      const peakTime=selectedId==='noaa_coops_water_level'?model.peak.time.replace('T',' ').replace(/(?:\.000)?Z$/,'')+' UTC':model.peak.time;
      facts.push('Highest '+amount(model.peak.value)+' on '+peakTime+(status.length?' ('+status.join(', ')+')':'')+(ties>1?' · first of '+ties+' tied observations':''));
    }
    if (facts.length) block.append(p(facts.join(' · ')));
    const counts=[[model.missing?.length,'missing'],[model.traceCount,'trace'],[model.presumedZeroCount,'presumed zero'],[model.failedCount,'QC flagged'],[model.multiDay.length,'multi-day totals'],[model.preliminarySourceCount,'preliminary NWS CF6 source'],[model.estimatedCount,'estimated'],[model.revisedCount,'revised'],[model.numeric.filter(r=>r.provisional).length,selectedId==='noaa_coops_water_level'?'preliminary':'provisional']];
    const reported=counts.filter(([n])=>n>0).map(([n,label])=>n+' '+label);
    if (reported.length) block.append(p(reported.join(' · ')));
    const request=sample.requests?.at(-1)?.url;
    if (request && /^https:\/\//i.test(request)) block.append(link(request,'Provider request'));
    return block;
  }
  function exportScreeningBrief() {
    if (dirty || hazardFilter===null) return;
    const scoped = scopedResults(), selected = resultFor(selectedId), product = byId.get(selectedId);
    if (!selected || !product) return;
    const doc = document.implementation.createHTMLDocument('Site screening brief · '+siteLabel(query));
    doc.documentElement.lang='en';
    doc.head.prepend(node('meta',{charset:'utf-8'}),node('meta',{name:'viewport',content:'width=device-width,initial-scale=1'}));
    doc.head.append(node('style',{},`
      @page{size:auto;margin:15mm}*{box-sizing:border-box}body{max-width:46rem;margin:2rem auto;padding:0 1rem;color:#162d34;font:15px/1.45 system-ui,Arial,sans-serif;overflow-wrap:anywhere}
      h1{font-size:1.85rem;margin:.3rem 0}h2{font-size:1.1rem;margin:1.2rem 0 .3rem}p{margin:.3rem 0}a{color:#15554d}header{border-bottom:2px solid #315c59;padding-bottom:.7rem}table{width:100%;border-collapse:collapse}td,th{padding:.32rem .4rem;border-bottom:1px solid #cad7d6;text-align:left;vertical-align:top}th{font-size:.85em}
      footer{border-top:1px solid #829894;margin-top:1rem;padding-top:.4rem;font-size:.85em}.print{float:right;padding:.4rem .7rem}a:focus,button:focus{outline:2px solid #2563eb}
      @media print{body{width:auto;max-width:none;margin:0;padding:0;font:10pt/1.3 Arial,sans-serif}h1{font-size:19pt}h2{font-size:12pt;margin:8pt 0 2pt}p{margin:2pt 0}td,th{padding:3pt}.print{display:none}a{color:inherit}header,table,tr,footer{break-inside:avoid}}`));
    const group = data.hazard_groups.find(g=>g.id===hazardFilter)?.label || 'All hazard groups';
    const source = query.areaSource, ids = [...shortlistIds(scoped)];
    const fits = scoped.filter(r=>r.status==='possible').length, outside = scoped.filter(r=>r.status==='excluded').length;
    const printButton = node('button',{type:'button',class:'print'},'Print / Save PDF');
    printButton.setAttribute('onclick','window.print()');
    doc.body.append(printButton,
      node('header',{},node('p',{},'Climate-Hazard Dataset Inventory ' + data.meta.revision),node('h1',{},'Site screening brief'),node('strong',{},siteLabel(query)),
        node('p',{},dateRange(query)+' · '+group)),node('h2',{},'Project extent'),node('p',{},footprintLabel()));
    if (query.mode==='area') {
      const attribution = source?.provider ? [source.provider,source.dataset,source.id,source.vintage].filter(Boolean).join(' · ') :
        source?.kind==='project-link' ? 'User-supplied boundary and name. Attribution is unverified.' : 'Project-supplied geometry';
      doc.body.append(node('p',{},source?.url&&source.kind!=='project-link'?link(source.url,attribution):attribution));
      if (/^huc(8|10|12)$/.test(source?.kind || '')) doc.body.append(node('p',{},source.processing),
        node('p',{},'WBD geometry SHA-256 · '+(source.geometrySha256 || 'Unavailable')));
      if (source?.hucKind) doc.body.append(node('p',{},source.note));
    }
    const observation=briefStation();
    if (observation) doc.body.append(observation);
    doc.body.append(node('h2',{},'Screening results'),node('p',{},scoped.length+' datasets screened. '+fits+' potential fits, '+(scoped.length-fits-outside)+' requiring follow-up, '+outside+' outside documented dates or area.'),
      node('table',{},node('thead',{},node('tr',{},node('th',{},'Dataset and provider documentation'),node('th',{},'Catalog finding'))),
        node('tbody',{},ids.map(id=>{
          const v=byId.get(id), r=resultFor(id);
          const findings=[r.label,...(r.resolutionChecks||[]).map(c=>c.label).filter(label=>label!==r.label),evidenceFor(id)?.label].filter(Boolean);
          return node('tr',{},node('td',{},link(v.documentation_url,v.product_name),node('br'),v.provider),node('td',{},findings.join(' · ')));
        }))),
      node('h2',{},'Selected dataset'),node('p',{},link(product.documentation_url,product.product_name)),...(!observation?[node('p',{},selected.reasons?.[0]||selected.label)]:[]),
      node('p',{},node('b',{},'Spatial support. '),product.spatial_support),node('p',{},node('b',{},'Time support. '),product.temporal_support),
      ...(selected.resolutionChecks||[]).filter(c=>c.detail!==selected.reasons?.[0]).map(c=>node('p',{},node('b',{},c.label+'. '),c.detail)),
      node('p',{},node('b',{},'Interpretation. '),product.limitations?.[0]||product.non_uses?.[0]||product.dependence_notes),
      node('h2',{},'Use in a project'),node('p',{},'Catalog screening compares the submitted dates and footprint with documented coverage. Check observations or valid cells, units, quality flags and representativeness at the project scale before drawing a site conclusion.'),
      node('p',{},link(product.access_url,'Open selected provider archive')),
      node('footer',{},'Catalog snapshot '+buildIdentity.catalogSnapshotDate+' · '+buildIdentity.id+' · Generated '+new Date().toISOString().slice(0,10)+' UTC'));
    download('<!doctype html>\n'+doc.documentElement.outerHTML,'text/html;charset=utf-8','site-screen-brief_'+query.start+'_'+query.end+'.html');
  }
  function exportSummary() {
    if (dirty || hazardFilter === null) return;
    const scoped = scopedResults(), ids = new Set(scoped.flatMap(r => [...byId.get(r.productId).evidence_ids, ...(rules[r.productId]?.evidence_ids || [])]));
    download(JSON.stringify({tool: 'Climate-Hazard Dataset Inventory ' + data.meta.revision, exportedAt: new Date().toISOString(),
      catalogRevision: data.meta.revision, inventoryBuild:buildIdentity, screeningMetadata, hazardGroup: hazardFilter || 'all', screeningRules: Object.fromEntries(scoped.map(r => [r.productId, rules[r.productId]])), referencedSources: hazardFilter === '' ? data.sources : Object.fromEntries([...ids].filter(id => data.sources[id]).map(id => [id, data.sources[id]])), query, candidateSearch: candidateSnapshot(),
      shortlist:[...shortlistIds(scoped)],availability:Object.fromEntries(scoped.filter(r=>evidenceFor(r.productId)).map(r=>[r.productId,evidenceFor(r.productId)])),
      selectedProductId:selectedId, selectedStationId:selectedStationId||null, observationPreview:sample?{source:savedLabel?'saved':'retrieved',selectedSeries:sample.series?.[activeSeries]?.key||null,result:sample}:null,
      scope: 'Catalog-level screening for the selected hazard group; date and area matches do not confirm actual site observations or scientific suitability. Display search and status filters do not remove records from this group export.', records: scoped.map(result => ({...result, productName: byId.get(result.productId).product_name, accessUrl: byId.get(result.productId).access_url, evidenceIds: (rules[result.productId] || {}).evidence_ids || byId.get(result.productId).evidence_ids}))}, null, 2) + '\n', 'application/json', 'site-screen_' + query.start + '_' + query.end + '.json');
  }
  window.SiteCheck = {
    show() {host.hidden = false; mapApi?.setVisible(mapTools.open); renderPanel(); requestAnimationFrame(() => {mapApi?.invalidate(); mapApi?.fit();});},
    hide() {host.hidden = true; mapApi?.setVisible(false); if (['discovery', 'coops-preflight'].includes(loadingKind)) controller?.abort(); else cancelPending(); accessController?.abort(); cancelAreaLookup(); mapApi?.cancelDrawing();},
    selectProduct(id) {if (!byId.has(id)) return; includeProduct(id); clearFilters(); selectProduct(id); host.hidden = false; mapApi?.setVisible(mapTools.open); requestAnimationFrame(() => {mapApi?.invalidate(); mapApi?.fit();});}
  };
  restoringProject=true;setQuery(query);restoringProject=false;loadRecent();
  window.addEventListener('hashchange',restoreHash);restoreHash();
})();
