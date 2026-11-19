// UI state-machine checks using the actual functions from site-check.js.
// Metadata and observations below are isolated test doubles, never shipped examples.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/site-check.js'), 'utf8');
const chunk = (first, next) => source.slice(source.indexOf(first), source.indexOf(next, source.indexOf(first)));
const clone = value => JSON.parse(JSON.stringify(value));
const query = {mode:'point', lat:40.7, lon:-74, radiusKm:100, start:'2020-07-01', end:'2020-07-03'};
const status = (state, extra = {}) => ({state, label:state, message:'Synthetic metadata: ' + state,
  availableDatums:[{code:'MSL', label:'Mean Sea Level', basis:'Synthetic fixture'}, {code:'STND', label:'Station Datum', basis:'Synthetic fixture'}],
  selectedDatum:['match','partial'].includes(state) ? 'MSL' : null, defaultDatum:'MSL', query:clone(query), ...extra});
const station = (id, state = 'unchecked', extra = {}) => ({id:String(id), name:'Synthetic station ' + id, lat:40.7, lon:-74,
  distanceKm:1, relation:'nearby', coopsAvailability:status(state), ...extra});
function context(overrides = {}) {
  const providers = {previewWindow:(_id, q, candidate, options = {}) => ({start:q.start, end:q.end,
    startTime:q.start + 'T00:06:00Z', endTime:q.end + 'T23:54:00Z', notes:[],
    available:['match','partial'].includes(candidate.coopsAvailability.state) ||
      options.allowUnverified === true && candidate.coopsAvailability.state === 'unresolved' && candidate.coopsAvailability.canTryPreview === true}), ...overrides};
  const scope = vm.createContext({AbortController, console, SiteShortlist:{previewEvidence:()=>null}, SiteProviders:providers, window:{SiteProviders:providers, SiteGeometry:{distanceMethod:'test fixture'}},
    document:{activeElement:null, getElementById:() => null}});
  vm.runInContext(`var hazardFilter='', stationChoiceRequired=false, coopsProduct='water_level', selectedId='noaa_coops_water_level', query=${JSON.stringify(query)}, discovery=null, sample=null,
    savedLabel='', selectedStationId='', stationDownloadPlan=null, activeSeries=0, loading='', loadingKind='', networkError='', controller=null,
    generation=0, dirty=false, candidateDrawerOpen=false, renders=0, announce={textContent:''};
    function renderPanel(){renders++;} function reveal(){} function renderOverview(){} function rememberEvidence(){} function recordStations(){}
    function clearProviderState(){cancelPending(); discovery=null; sample=null; selectedStationId=''; networkError='';}
    const previewWindow=(candidate,allowUnverified=false)=>SiteProviders.previewWindow(selectedId,query,candidate,{allowUnverified});
    ${chunk('function preferredSeries(', '  function renderChart(')}
    ${chunk('function userError(', '  const button =')}
    ${chunk('function cancelPending()', 'function clearProviderState()')}
    ${chunk('function coopsStatus(', 'function renderCoopsSummary(')}
    ${chunk('function mergeDiscovery(', 'function cancelUserRequest(')}
    ${chunk('function cancelUserRequest(', 'function loadExample(')}
    ${chunk('function candidateSnapshot(', 'function exportStations(')}
  `, scope);
  return scope;
}
const run = (scope, expression) => vm.runInContext(expression, scope);
const read = (scope, expression) => clone(run(scope, expression));
const complete = stations => ({stations, completed:stations.length, total:stations.length, complete:true, cancelled:false});
const directory = (stations, extra = {}) => ({stations, requests:[], notes:[], complete:true, paginationComplete:true, continuation:null, ...extra});

test('metadata groups retain all candidates and separate live-response evidence', () => {
  const scope = context();
  scope.discovery = directory(['match','partial','outside_period','product_not_listed','datum_required','unresolved','unchecked'].map((state,i) => station(i,state)));
  scope.discovery.stations[0].coopsPreview = {state:'retrieved'};
  assert.deepEqual(read(scope,'coopsCounts()'), {found:7,matching:2,partial:1,incompatible:2,unresolved:3,unchecked:1,previewed:1});
  assert.equal(run(scope,'canPreviewCoops(discovery.stations[0])'), true);
  scope.discovery.stations[0].coopsAvailability.selectedDatum = 'UNSUPPORTED';
  assert.equal(run(scope,'canPreviewCoops(discovery.stations[0])'), false);
  const exported = read(scope,'candidateSnapshot()');
  assert.equal(exported.stations.length, 7);
  assert.equal(exported.coopsScreening.found, 7);
  assert.equal(exported.coopsScreening.matching, 2);
});

test('CO-OPS discovery automatically reads every page before checking a bounded batch', async () => {
  const candidates = Array.from({length:45}, (_,i) => station(9000000+i));
  const calls = [];
  const scope = context({discover:async (_id, q, options) => {
    calls.push({kind:'directory', cursor:options.cursor, q});
    return options.cursor ? directory(candidates.slice(20)) : directory(candidates.slice(0,20), {complete:false,paginationComplete:false,continuation:{page:2}});
  }, checkCoopsStations:async (all, q, options) => {
    calls.push({kind:'check', count:all.length, q, refresh:options.forceRefresh});
    const result = complete(all.map(candidate => ({...candidate,coopsAvailability:status('match')})));
    options.onProgress(result); return result;
  }});
  await run(scope,'runDiscovery()');
  assert.deepEqual(calls.map(call=>call.kind), ['directory','directory','check']);
  assert.equal(calls[2].count, 10);
  assert.equal(calls[2].refresh, false);
  assert.equal(scope.discovery.stations.length, 45);
  assert.equal(scope.discovery.complete, true);
  assert.equal(scope.discovery.coopsPreflight.complete, true);
  assert.equal(scope.loading, '');
});

test('cancelling preflight retains successful checks and every unchecked candidate', async () => {
  let ready;
  const entered = new Promise(resolve => {ready=resolve;});
  const candidates = Array.from({length:7},(_,i)=>station(9000000+i));
  const scope = context({discover:async()=>directory(candidates), checkCoopsStations:async(all,_q,options)=>{
    const current=all.map((candidate,i)=>i===0?{...candidate,coopsAvailability:status('match')}:candidate);
    options.onProgress({stations:current,completed:1,total:7,complete:false,cancelled:false}); ready();
    return new Promise(resolve=>options.signal.addEventListener('abort',()=>resolve({stations:current,completed:1,total:7,complete:false,cancelled:true}),{once:true}));
  }});
  const work=run(scope,'runDiscovery()'); await entered;
  run(scope,'cancelUserRequest()'); await work;
  assert.deepEqual(read(scope,'coopsCounts()'), {found:7,matching:1,partial:0,incompatible:0,unresolved:6,unchecked:6,previewed:0});
  assert.equal(scope.discovery.complete,true);
  assert.equal(scope.discovery.coopsPreflight.cancelled,true);
  assert.equal(scope.discovery.coopsPreflight.running,false);
  assert.equal(scope.loading,'');
});

test('late metadata progress cannot repopulate a changed project', async () => {
  let resolve, progress, ready;
  const entered=new Promise(done=>{ready=done;});
  const scope=context({discover:async()=>directory([station(9000001)]),checkCoopsStations:async(_all,_q,options)=>{
    progress=options.onProgress; ready(); return new Promise(done=>{resolve=done;});
  }});
  const work=run(scope,'runDiscovery()'); await entered;
  run(scope,"clearProviderState(); query={...query,start:'2021-01-01',end:'2021-01-02'};");
  const before=scope.renders;
  const result=complete([station(9000001,'match')]); progress(result); resolve(result); await work;
  assert.equal(scope.discovery,null);
  assert.equal(scope.renders,before);
  assert.equal(scope.query.start,'2021-01-01');
});

test('explicit retry refreshes only the selected subset and retains other stations', async () => {
  let observed;
  const scope=context({checkCoopsStations:async(all,q,options)=>{observed={ids:all.map(s=>s.id),q,refresh:options.forceRefresh};return complete(all.map(s=>({...s,coopsAvailability:status('match')})));}});
  scope.discovery=directory([station(9000001,'unresolved'),station(9000002,'outside_period')]);
  await run(scope,"runCoopsRetry(['9000001'])");
  assert.deepEqual(clone(observed.ids),['9000001']); assert.equal(observed.refresh,true);
  assert.equal(scope.discovery.stations.length,2); assert.equal(scope.discovery.stations[1].coopsAvailability.state,'outside_period');
});

test('rate limiting remains an incomplete metadata check, with all candidates exported', async()=>{
  const scope=context({checkCoopsStations:async(all)=>({stations:all,completed:1,total:all.length,complete:false,cancelled:false,rateLimited:true,error:{code:'HTTP_429',message:'Synthetic rate limit'}})});
  scope.discovery=directory([station(9000001,'match'),station(9000002)]);
  await run(scope,"runCoopsRetry(['9000001','9000002'])");
  const exported=read(scope,'candidateSnapshot()');
  assert.equal(exported.complete,true);
  assert.equal(exported.coopsScreening.lastCheck.complete,false);
  assert.equal(exported.coopsScreening.lastCheck.rateLimited,true);
  assert.equal(exported.coopsScreening.lastCheck.error.code,'HTTP_429');
  assert.equal(exported.stations.length,2);
  assert.match(scope.networkError,/rate limit/);
});

test('known mismatches and unchecked candidates cannot bypass retrieval guards', async()=>{
  let calls=0;
  const scope=context({retrieve:async()=>{calls++;throw new Error('should not be reached');}});
  for(const state of ['outside_period','product_not_listed','datum_required','unchecked']){
    scope.discovery=directory([station(9000001,state,{coopsAvailability:status(state,{canTryPreview:true})})]);scope.selectedStationId='9000001';
    await run(scope,'runRetrieval(true)');
  }
  scope.discovery=directory([station(9000001,'unresolved')]);
  await run(scope,'runRetrieval(true)');
  assert.equal(calls,0);
});

test('unverified fallback requires the explicit action and keeps failure scoped to that preview', async()=>{
  const calls=[];
  const scope=context({retrieve:async(id,candidate,q,options)=>{calls.push({id,candidate,q,override:options.allowUnverified});const error=new Error('Synthetic no data');error.code='NO_DATA';throw error;}});
  scope.discovery=directory([station(9000001,'unresolved',{coopsAvailability:status('unresolved',{canTryPreview:true,tryDatum:'MSL'})})]);scope.selectedStationId='9000001';
  await run(scope,'runRetrieval(false)'); assert.equal(calls.length,0);
  await run(scope,'runRetrieval(true)'); assert.equal(calls.length,1); assert.equal(calls[0].override,true);
  const candidate=scope.discovery.stations[0];
  assert.equal(candidate.coopsAvailability.state,'unresolved'); assert.equal(candidate.coopsPreview.state,'no_data');
  assert.equal(candidate.coopsPreview.window.startTime,'2020-07-01T00:06:00Z');
  assert.equal(candidate.coopsPreview.datum,'MSL'); assert.equal(candidate.coopsPreview.metadataUnverified,true);
});

test('ordinary NO_DATA does not turn a nominal match into whole-period absence',async()=>{
  const scope=context({retrieve:async()=>{const error=new Error('Synthetic no data');error.code='NO_DATA';throw error;}});
  scope.discovery=directory([station(9000001,'partial')]);scope.selectedStationId='9000001';
  await run(scope,'runRetrieval()');
  assert.equal(scope.discovery.stations[0].coopsAvailability.state,'partial');
  assert.equal(scope.discovery.stations[0].coopsPreview.state,'no_data');
  assert.equal(scope.discovery.stations[0].coopsPreview.metadataUnverified,false);
});

test('a successful response is separate station-specific evidence and records the explicit datum',async()=>{
  const scope=context({retrieve:async(_id,candidate)=>({station:candidate,window:{start:query.start,end:query.end},
    series:[{key:'water_level',points:[{value:1}]}],observationCount:1,provenance:{datumCode:'STND'}})});
  scope.discovery=directory([station(9000001,'match',{coopsAvailability:status('match',{selectedDatum:'STND',explicitDatum:'STND'})}),station(9000002,'match')]);scope.selectedStationId='9000001';
  await run(scope,'runRetrieval()');
  assert.equal(scope.discovery.stations[0].coopsPreview.datum,'STND');
  assert.equal(scope.discovery.stations[1].coopsPreview,undefined);
  assert.deepEqual(read(scope,'coopsCounts()'),{found:2,matching:2,partial:0,incompatible:0,unresolved:0,unchecked:0,previewed:1});
});

test('dirty input blocks discovery, metadata retry, and every preview action',async()=>{
  let calls=0;
  const scope=context({discover:async()=>{calls++;},checkCoopsStations:async()=>{calls++;},retrieve:async()=>{calls++;}});
  scope.discovery=directory([station(9000001,'match')]);scope.selectedStationId='9000001';scope.dirty=true;
  await run(scope,'runDiscovery()');await run(scope,"runCoopsRetry(['9000001'])");await run(scope,'runRetrieval()');
  assert.equal(calls,0);
});

test('the actual station renderer appends status and preview history to the element, not the empty button text node',()=>{
  // A minimal DOM shape preserves the decisive browser distinction: text nodes have no append().
  class FakeNode {}
  class FakeText extends FakeNode {constructor(text){super();this.textContent=String(text);}}
  class FakeElement extends FakeNode {
    constructor(tag){super();this.tagName=tag;this.childNodes=[];this.attributes={};}
    setAttribute(key,value){this.attributes[key]=String(value);}
    addEventListener(){}
    append(...children){this.childNodes.push(...children);}
    get firstChild(){return this.childNodes[0];}
    get firstElementChild(){return this.childNodes.find(child=>child instanceof FakeElement);}
    get lastChild(){return this.childNodes.at(-1);}
  }
  const scope=context();scope.Node=FakeNode;
  scope.document.createElement=tag=>new FakeElement(tag);
  scope.document.createTextNode=text=>new FakeText(text);
  const saved=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/examples.json'),'utf8')).examples.find(item=>item.productId==='noaa_coops_water_level').station;
  scope.discovery=directory([{...saved,note:'Availability during your dates has not yet been checked.',coopsAvailability:status('match',{periods:[{start:query.start,end:query.end}]}),coopsPreview:{state:'retrieved',datum:'MSL'}}]);
  scope.SiteProviders.previewWindow=()=>({start:query.start,end:query.end,available:true,notes:['Synthetic metadata: match','Preview request: Fixture GMT interval']});
  vm.runInContext(`${chunk('const node = ', 'const human = ')}
    var stationSearch='',stationRelation='all',stationNetwork='all',stationPage=0,stationPageSize=25,coopsFilter='matching';
    function siteLabel(){return 'Fixture coordinates';} function previewPeriod(){return 'Fixture GMT interval';}
    function fact(label,value){return node('div',{},label,value);}
    function renderCoopsStationDetails(){} function renderStationDownload(){}
    ${chunk('function filteredStations()', 'function renderCoopsStationDetails(')}
    var fixtureTree=renderStationBrowser();
  `,scope);
  const find=(root,predicate)=>predicate(root)?root:(root.childNodes||[]).map(child=>find(child,predicate)).find(Boolean);
  const row=find(scope.fixtureTree,element=>element.className==='sc-station-row');
  assert.ok(row.firstChild instanceof FakeText);
  assert.ok(row.firstElementChild instanceof FakeElement);
  assert.ok(find(row.firstElementChild,element=>element.className==='sc-coops-status matching'));
  assert.ok(find(row.firstElementChild,element=>element.className==='sc-coops-preview-state'));
  const text=root=>root instanceof FakeText?root.textContent:(root.childNodes||[]).map(text).join(' ');
  const rendered=text(scope.fixtureTree);
  assert.doesNotMatch(rendered,/not yet been checked|Station record \(metadata\)/);
  assert.match(rendered,/Six-minute inventory \(metadata\)/);
  assert.equal((rendered.match(/Preview · Fixture GMT interval/g)||[]).length,1);
});

test('a progress-render failure clears busy state and retains discovered candidates',async()=>{
  const scope=context({discover:async()=>directory([station(9000001)]),checkCoopsStations:async(all,_q,options)=>{
    options.onProgress(complete(all.map(candidate=>({...candidate,coopsAvailability:status('match')}))));
    return complete(all);
  }});
  run(scope,"renderPanel=function(){renders++;if(renders===3)throw new Error('Synthetic transient render error');};");
  await run(scope,'runDiscovery()');
  assert.equal(scope.discovery.stations.length,1);
  assert.equal(scope.discovery.complete,true);
  assert.equal(scope.loading,'');assert.equal(scope.loadingKind,'');assert.equal(scope.controller,null);
  assert.match(scope.networkError,/Synthetic transient render error/);
  assert.equal(scope.discovery.coopsPreflight.running,false);
});
