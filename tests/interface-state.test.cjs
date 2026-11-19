// Actual UI functions exercised with an isolated DOM-shaped test fixture.
// No network, browser control, provider credentials or shipped observations are changed.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/site-check.js'),'utf8');
const chunk=(first,next)=>source.slice(source.indexOf(first),source.indexOf(next,source.indexOf(first)));
class FakeNode {}
class FakeText extends FakeNode {constructor(text){super();this.textContent=String(text);}}
class FakeElement extends FakeNode {
  constructor(tag){super();this.tagName=tag.toUpperCase();this.childNodes=[];this.attributes={};this.events={};}
  setAttribute(key,value){this.attributes[key]=String(value);if(['id','value','class'].includes(key))this[key==='class'?'className':key]=String(value);if(key==='disabled')this.disabled=true;}
  addEventListener(name,handler){(this.events[name]??=[]).push(handler);}
  append(...children){this.childNodes.push(...children);}
  prepend(...children){this.childNodes.unshift(...children);}
  get firstChild(){return this.childNodes[0];} get firstElementChild(){return this.childNodes.find(child=>child instanceof FakeElement);}
  get lastChild(){return this.childNodes.at(-1);} get children(){return this.childNodes.filter(child=>child instanceof FakeElement);}
  get textContent(){return (this._text||'')+this.childNodes.map(child=>child.textContent).join('');}
  set textContent(value){this._text=String(value);this.childNodes=[];}
}
const find=(root,predicate)=>predicate(root)?root:(root.childNodes||[]).map(child=>find(child,predicate)).find(Boolean);
const all=(root,predicate)=>[...(predicate(root)?[root]:[]),...(root.childNodes||[]).flatMap(child=>all(child,predicate))];
const byText=(root,text)=>find(root,node=>node.tagName==='BUTTON'&&node.textContent===text);
const byId=(root,id)=>find(root,node=>node.id===id);
const hasClass=(node,name)=>(node.className||'').split(' ').includes(name);
const fire=(node,name,event={})=>Promise.all((node.events[name]||[]).map(handler=>handler(event)));
const query={mode:'point',lat:40.7,lon:-74.01,radiusKm:100,start:'2020-07-01',end:'2020-07-03'};
const availability=(state='match',extra={})=>({state,label:state,message:'Fixture '+state,periods:[],defaultDatum:'MSL',selectedDatum:state==='match'||state==='partial'?'MSL':null,selectionMode:'default',availableDatums:[{code:'MSL',label:'Mean Sea Level',basis:'Fixture datum metadata'},{code:'STND',label:'Station Datum',basis:'Fixture option'}],...extra});
const station=(id,state='match',distanceKm=1)=>({id:String(id),name:'Fixture station '+id,lat:40.7,lon:-74.01,distanceKm,coopsAvailability:availability(state)});
function scope(){
  const saved=[],copied=[];
  const access={fileCoverage:require('../src/access.js').fileCoverage,transferSummary:require('../src/access.js').transferSummary,fileScript:()=>({artifact:{name:'fixture_files.py',mime:'text/x-python',text:'# isolated fixture',role:'request'},reason:null})};
  const context=vm.createContext({Node:FakeNode,URL,console,SiteProviders:require('../src/providers.js'),SiteObservationChart:require('../src/observation-chart.js'),SiteAccess:access,SiteCoverageTimeline:require('../src/coverage-timeline.js'),
    document:{createElement:tag=>new FakeElement(tag),createElementNS:(_ns,tag)=>new FakeElement(tag),createTextNode:text=>new FakeText(text),getElementById:()=>null},
    navigator:{clipboard:{writeText:async text=>copied.push(text)}},window:{SiteAccess:access,SiteCoverageTimeline:require('../src/coverage-timeline.js')}});
  context.saved=saved;context.copied=copied;
  vm.runInContext(`var query=${JSON.stringify(query)},selectedId='noaa_coops_water_level',supported=new Set(['ghcn_daily','noaa_coops_water_level','usgs_streamflow']),
    discovery=null,sample=null,timelineFull=true,hazardFilter='',savedLabel='',selectedStationId='',dirty=false,loading='',networkError='',stationDownloadPlan=null,activeSeries=0,
    coopsFilter='matching',stationSearch='',stationRelation='all',stationNetwork='all',stationPage=0,candidateDrawerOpen=false,accessPlatform='windows',
    accessPlan={errors:[]},accessFileResult=null,accessLoading=false,accessError='',selectedFileKeys=new Set(),fileBatchSource=null,fileBatchPlan=null,fileSearch='',filePage=0,announce={textContent:''};
    var panel={querySelector:()=>null};function renderPanel(){} function reveal(){} function exportAccessManifest(){} function runCoopsRetry(){} function runRetrieval(){}
    function accessBlocked(){return dirty;} function previewWindow(){return {available:true,start:query.start,end:query.end};}
    function download(text,mime,name){saved.push({text,mime,name});}
    ${chunk('const node = ','const human = ')}
    ${chunk('const dateRange = ','const previewWindow = ')}
    ${chunk('function previewEvidenceLabel()','const coordinate = ')}
    ${chunk('const screeningFamily = ','const reveal = ')}
    const fact=(label,value)=>node('div',{},node('dt',{},label),node('dd',{},value||'Not established'));
    ${chunk('function stationWorkflowStatus()','function renderPanel()')}
    ${chunk('function coopsStatus(','function renderProvider(')}
    ${chunk('function renderCoopsStationDetails(','function chooseStation(')}
    ${chunk('function commandBlock(','function renderScriptGuide(')}
    ${chunk('function verificationDate(','async function discoverAccessFiles(')}
    ${chunk('const displayUnit =','function filename(')}
  `,context);
  return context;
}
const run=(context,expression)=>vm.runInContext(expression,context);
const read=(context,expression)=>JSON.parse(JSON.stringify(run(context,expression)));
const tree=context=>new FakeElement('div');

test('display timestamps remove only zero milliseconds and preserve exact underlying strings',()=>{
  const c=scope(),value='2020-07-01T00:06:00.000Z';c.input=value;
  assert.equal(run(c,'displayTimestamp(input,"GMT")'),'2020-07-01 00:06:00 GMT');assert.equal(c.input,value);
  assert.equal(run(c,'displayTimestamp("2020-07-01T00:06:00.123Z")'),'2020-07-01 00:06:00.123 UTC');
  assert.equal(run(c,'previewPeriod({start:"2020-07-01",end:"2020-07-03"})'),'2020-07-01 → 2020-07-03');
});

test('nearer unresolved warning compares with nearest full OR partial metadata match without changing classifications',()=>{
  const c=scope();c.discovery={stations:[station(1,'match',5),station(2,'partial',3),station(3,'unresolved',2),station(4,'datum_required',1),station(5,'unchecked',4),station(6,'outside_period',.5),station(7,'unresolved',NaN)]};
  const result=read(c,'nearerUnresolvedCoops()');assert.equal(result.nearestMatchKm,3);assert.deepEqual(result.stations.map(s=>s.id),['4','3']);
  assert.equal(c.discovery.stations[3].coopsAvailability.state,'datum_required');
  c.discovery.stations=[station(1,'match',0),station(2,'unresolved',0)];assert.equal(run(c,'nearerUnresolvedCoops()'),null);
  c.discovery.stations=[station(1,'unresolved',1)];assert.equal(run(c,'nearerUnresolvedCoops()'),null);
});

test('nearer unresolved action exposes the candidate without promoting it or losing other candidates',async()=>{
  const c=scope();c.discovery={stations:[station(1,'match',5),station(2,'unresolved',1)],complete:true};
  const rendered=run(c,'renderCoopsSummary()');assert.match(rendered.textContent,/closer than the nearest metadata match \(5.00 km\)/);
  await fire(byId(rendered,'sc-coops-nearer'),'click');
  assert.equal(c.coopsFilter,'unresolved');assert.equal(c.selectedStationId,'2');assert.equal(c.discovery.stations.length,2);assert.equal(c.discovery.stations[1].coopsAvailability.state,'unresolved');
  assert.equal(byId(run(c,'renderCoopsSummary()'),'sc-coops-nearer'),undefined);
});

test('station messages preserve readable error source, literal text and recovered history',()=>{
  const c=scope();c.details=tree(c);c.candidate=station(1,'unresolved');c.candidate.coopsAvailability.errors=[{source:'inventory',code:'HTTP_503',message:'<b>Unavailable</b>',recovered:true}];
  run(c,'renderCoopsStationDetails(details,candidate,{available:false})');
  assert.match(c.details.textContent,/Station inventory: <b>Unavailable<\/b> Recovered on retry/);
  assert.equal(all(c.details,node=>node.tagName==='B').length,0);
  assert.equal(c.candidate.coopsAvailability.state,'unresolved');
});

test('a supported default is visibly labeled and has no empty datum option',()=>{
  const c=scope();c.details=tree(c);c.candidate=station(1);run(c,'renderCoopsStationDetails(details,candidate,{available:true})');
  const select=byId(c.details,'sc-coops-datum');assert.equal(select.value,'MSL');assert.equal(select.children.some(option=>option.value===''),false);
  assert.match(select.children.find(option=>option.value==='MSL').textContent,/MSL \(default\)/);
  c.details=tree(c);c.candidate.coopsAvailability=availability('datum_required',{selectedDatum:null,availableDatums:[{code:'STND',label:'Station Datum'}]});
  run(c,'renderCoopsStationDetails(details,candidate,{available:false})');assert.equal(byId(c.details,'sc-coops-datum').children[0].value,'');
});

test('retrieval provenance appears only for returned samples and distinguishes live, saved and stale values',()=>{
  const c=scope();c.discovery={stations:[],complete:true};assert.equal(run(c,'stationWorkflowStatus()'),null);
  c.discovery={stations:[station(1),station(2,'unresolved')],complete:false};assert.equal(run(c,'stationWorkflowStatus()'),null);
  c.sample={station:station(1),window:{start:query.start,end:query.end,startTime:query.start+'T00:06:00.000Z',endTime:query.end+'T23:54:00.000Z'},series:[{points:[{value:0},{value:1.2},{value:null}]},{points:[{value:2.1}]}],provenance:{datumCode:'STND'}};
  const snapshot=JSON.stringify(c.sample),result=read(c,'stationWorkflowStatus()');assert.match(result.title,/Preview values returned.*3 numeric values/);assert.match(result.detail,/datum STND/);assert.doesNotMatch(result.detail,/\.000/);assert.equal(JSON.stringify(c.sample),snapshot);
  c.savedLabel='Saved fixture';c.dirty=true;assert.match(run(c,'stationWorkflowStatus().title'),/Saved preview/);assert.match(run(c,'stationWorkflowStatus().detail'),/no live request.*inputs have changed/);
});

test('screening family names stay consistent without replacing the specific input classification',()=>{
  const c=scope();for(const [status,label]of [['possible','Metadata match'],['excluded','Outside listed coverage'],['unresolved','Provider check needed'],['event','Provider check needed'],['special','Provider check needed']]){c.result={status,label:'Specific retained reason'};assert.equal(run(c,'screeningFamily(result)'),c.result.label);assert.equal(c.result.label,'Specific retained reason');}
});

test('round tick scales cover the raw values and distinguish ticks for small, negative, flat and narrow-range series',()=>{
  const c=scope();for(const values of [[.051,.251],[-1.83,.22],[0,0],[34791,34795],[1e-8,2e-8],[100000001,100000003]]){
    c.values=values.slice();const result=read(c,'chartTickScale(values)');assert.ok(result.min<=Math.min(...values));assert.ok(result.max>=Math.max(...values));assert.ok(result.max>result.min);
    const labels=read(c,'chartTickScale(values).ticks.map(tick=>formatChartTick(tick,chartTickScale(values).step))');assert.equal(new Set(labels).size,labels.length);assert.ok(labels.length<=8);assert.deepEqual(c.values,values);
  }
});

test('chart rounding changes axis ticks only; the raw point values and flags remain exact',()=>{
  const c=scope();c.sample={window:query};c.series={label:'Fixture water level',unit:'m',points:[{time:'2020-07-01 00:06',value:.051,flags:{q:'v'}},{time:'2020-07-01 00:12',value:.251,flags:{q:'p'}}]};
  const before=JSON.stringify(c.series),rendered=run(c,'renderChart(series)');const titles=all(rendered,node=>node.tagName==='TITLE').map(node=>node.textContent);
  assert.ok(titles.some(text=>text.includes(': 0.051 m')));assert.ok(titles.some(text=>text.includes(': 0.251 m')));assert.equal(JSON.stringify(c.series),before);
  const axis=all(rendered,node=>node.tagName==='TEXT'&&node.attributes['text-anchor']==='end'&&node.attributes.x==='51').map(node=>node.textContent);
  assert.deepEqual(axis,['0','0.1','0.2','0.3']);
});

test('timeline preserves separate intervals, distinguishes open support and does not draw unknown dates',()=>{
  const c=scope();c.rule={support_type:'grid',time_step:'daily',time:{kind:'range',intervals:[{start:'2020-06-29',end:'2020-07-01'},{start:'2020-07-03',end:null}]}};
  const rendered=run(c,'renderCoverageTimeline(rule)'),segments=all(rendered,node=>hasClass(node,'sc-timeline-segment')&&hasClass(node,'nominal'));
  assert.equal(segments.length,2);assert.ok(hasClass(segments[1],'open'));assert.match(rendered.textContent,/spans can contain gaps/);assert.match(rendered.textContent,/Open endpoint/);
  c.rule={support_type:'station',time_step:'daily',time:{kind:'station',intervals:[]}};const unknown=run(c,'renderCoverageTimeline(rule)');assert.ok(hasClass(unknown,'sc-timeline-unknown'));assert.equal(all(unknown,node=>hasClass(node,'sc-timeline-track')).length,0);
});

test('timeline labels omit zero milliseconds and distinguish an in-axis soft horizon from the product end',()=>{
  const c=scope();c.selectedStationId='1';c.discovery={stations:[station(1)]};Object.assign(c.discovery.stations[0].coopsAvailability,{stationId:'1',inventoryStatus:'ok',periods:[{product:'Verified 6-Minute Water Level',first:'2020-07-01 00:06',last:'2020-07-03 23:54'}]});
  c.rule={support_type:'station',time_step:'six_minute',time:{kind:'station',intervals:[],known_through:'2020-07-02'}};
  const rendered=run(c,'renderCoverageTimeline(rule)');assert.equal(all(rendered,node=>hasClass(node,'sc-timeline-marker')).length,1);
  assert.match(rendered.textContent,/soft horizon, not a dataset end date/);assert.ok(all(rendered,node=>hasClass(node,'sc-timeline-segment')).every(node=>!node.attributes.title.includes('.000')));
});

function transferPlan(c,extra={}){return {errors:[],requests:[{name:'part1.json',start:query.start,end:query.end,url:'https://example.test/data'}],requestCount:1,estimatedTotalBytes:null,directUrl:null,notes:['Fixture transfer; no suitability claim.'],unrequestedIntervals:[],folderName:'fixture_station_data',script:{name:'fixture_station_data_download.py',mime:'text/x-python',text:'# fixture script'},manifest:{productId:c.selectedId,query:{...query},station:station(1),datum:'MSL',transferSummary:{totalPagesKnown:true}},...extra};}
function enableStation(c,plan){c.selectedStationId='1';c.candidate=station(1);c.details=tree(c);c.stationDownloadPlan=plan;c.window.SiteStationDownload={prepare:()=>plan};c.SiteStationDownload=c.window.SiteStationDownload;}

test('project-period script choices disclose unknown size, exact datum and unscheduled intervals',()=>{
  const c=scope(),plan=transferPlan(c,{unrequestedIntervals:[{startTime:'2020-07-02T00:00:00.000Z',endTime:'2020-07-02T23:54:00.000Z',reason:'Fixture listed gap.'}]});enableStation(c,plan);
  run(c,'renderStationDownload(details,candidate,{available:true})');const text=c.details.textContent;
  assert.match(text,/Unknown before retrieval/);assert.match(text,/Requested datumMSL/);assert.match(text,/interval\(s\) not scheduled/);assert.match(text,/Fixture listed gap/);assert.doesNotMatch(text,/\.000/);
  const commands=read(c,'stationDownloadCommands(stationDownloadPlan)');assert.equal(commands[1].text,'py -3 fixture_station_data_download.py');assert.match(commands[2].text,/--download --file 1 --confirm-transfer$/);assert.match(commands[3].text,/--download --confirm-transfer$/);
});

test('USGS project transfer labels an initial request rather than a known final page count',()=>{
  const c=scope();c.selectedId='usgs_streamflow';const plan=transferPlan(c);plan.manifest.datum=null;plan.manifest.transferSummary.totalPagesKnown=false;enableStation(c,plan);
  run(c,'renderStationDownload(details,candidate,{available:true})');assert.match(c.details.textContent,/Initial requests1/);assert.match(c.details.textContent,/JSON link opens the first page.*script retrieves subsequent pages/);
});

test('a known CO-OPS mismatch cannot expose project-period download controls',()=>{
  const c=scope();enableStation(c,transferPlan(c));c.candidate.coopsAvailability=availability('outside_period');run(c,'renderStationDownload(details,candidate,{available:false})');assert.equal(c.details.childNodes.length,0);
});

test('GHCN direct CSV is visible beside the project dates and unknown size, and stale actions cannot run',async()=>{
  const c=scope();c.selectedId='ghcn_daily';const plan=transferPlan(c,{directUrl:'https://example.test/full.csv'});enableStation(c,plan);run(c,'renderStationDownload(details,candidate,{available:true})');
  const disclosure=find(c.details,node=>hasClass(node,'sc-full-period-link'));assert.equal(disclosure.tagName,'DIV');assert.match(disclosure.children[0].textContent,/Open project-period CSV/);assert.match(c.details.textContent,/2020-07-01 → 2020-07-03/);assert.match(c.details.textContent,/Unknown before retrieval/);
  const link=find(disclosure,node=>node.tagName==='A'),downloadButton=byText(c.details,'Download project-period Python script');
  c.dirty=true;let prevented=false;await fire(link,'click',{preventDefault(){prevented=true;}});await fire(downloadButton,'click');assert.equal(prevented,true);assert.equal(c.saved.length,0);
  c.dirty=false;c.selectedStationId='2';await fire(downloadButton,'click');assert.equal(c.saved.length,0);
});

test('project transfer script and readable steps are downloadable without a JSON prerequisite',async()=>{
  const c=scope(),plan=transferPlan(c);enableStation(c,plan);run(c,'renderStationDownload(details,candidate,{available:true})');
  await fire(byText(c.details,'Download project-period Python script'),'click');await fire(byText(c.details,'Save these download steps'),'click');
  assert.equal(c.saved.length,2);assert.equal(c.saved[0].text,plan.script.text);assert.match(c.saved[1].text,/No JSON input file or code editing is required/);assert.match(c.saved[1].text,/--download --confirm-transfer/);
});

test('selected file numbers follow the full loaded list across filtering, pagination and new pages',()=>{
  const c=scope();c.files=Array.from({length:45},(_,i)=>({id:'f'+i,url:'https://example.test/'+i,name:'file'+i,sizeBytes:100}));run(c,'selectedFileKeys.add(fileSelectionKey(files[2]));selectedFileKeys.add(fileSelectionKey(files[30]));');
  c.fileSearch='file30';c.filePage=1;let entries=read(c,'selectedFileEntries(files)');assert.deepEqual(entries.map(entry=>entry.index),[2,30]);
  c.files.push({id:'f45',url:'https://example.test/45'});entries=read(c,'selectedFileEntries(files)');assert.deepEqual(entries.map(entry=>entry.index),[2,30]);
  c.script={name:'fixture_files.py'};const commands=read(c,'fileSelectionCommands(script,selectedFileEntries(files),files.length)');assert.equal(commands[1].text,'py -3 fixture_files.py --download --file 3 --file 31 --confirm-transfer');
  c.files[2]={...c.files[2],url:'https://example.test/changed'};assert.deepEqual(read(c,'selectedFileEntries(files)').map(entry=>entry.index),[30]);
});

test('explicit all-file selection uses a short all-file command and remains separate from preview',()=>{
  const c=scope();c.files=Array.from({length:1488},(_,i)=>({id:String(i),url:'https://example.test/'+i}));run(c,'selectedFileKeys=new Set(files.map(fileSelectionKey));');c.script={name:'fixture_files.py'};
  const commands=read(c,'fileSelectionCommands(script,selectedFileEntries(files),files.length)');assert.equal(commands[0].text,'py -3 fixture_files.py');assert.equal(commands[1].text,'py -3 fixture_files.py --download --confirm-transfer');
});

test('authenticated file selection retains totals and individual-file guidance without a fabricated command',()=>{
  const c=scope();c.files=[{id:'a',url:'https://example.test/private',authRequired:true,sizeBytes:null}];c.accessFileResult={files:c.files};run(c,'selectedFileKeys.add(fileSelectionKey(files[0]));');c.SiteAccess.fileScript=()=>({artifact:null,reason:'Authentication required; use individual links.'});
  const rendered=run(c,'renderFileSelection(files,false)');assert.match(rendered.textContent,/1 selected links of 1 loaded/);assert.match(rendered.textContent,/1 unknown file size/);assert.match(rendered.textContent,/Authentication required/);assert.doesNotMatch(rendered.textContent,/--download/);
});

test('identical spatial and verification notes appear once while differing file facts remain attached',()=>{
  const c=scope();c.profile={spatialDelivery:'Whole provider grid'};c.accessFileResult={origin:'prepared',files:[{id:'1',name:'One',url:'https://example.test/1',sizeBytes:100,version:'v1',verificationLabel:'Listing only'},{id:'2',name:'Two',url:'https://example.test/2',sizeBytes:200,version:'v2',verificationLabel:'Listing only'}],notes:[]};
  const rendered=run(c,'renderAccessFiles(profile,false)');assert.equal((rendered.textContent.match(/Whole provider grid/g)||[]).length,1);assert.equal((rendered.textContent.match(/Listing only/g)||[]).length,1);
  assert.match(rendered.textContent,/Asset versionv1/);assert.match(rendered.textContent,/Asset versionv2/);assert.equal(all(rendered,node=>node.tagName==='INPUT'&&node.attributes.type==='checkbox').length,2);
  c.accessFileResult.files[1].spatialDelivery='Distinct tile';const distinct=run(c,'renderAccessFiles(profile,false)');assert.match(distinct.textContent,/Distinct tile/);assert.match(distinct.textContent,/Whole provider grid/);
});


test('preview wording stays bounded for year-long projects, missing values, saved examples and failed QC',()=>{
  const c=scope();c.query.end='2020-12-31';
  c.sample={station:station(1),window:{start:'2020-01-01',end:'2020-01-31'},series:[{points:[{value:12,flags:{quality:'X'}},{value:null}]}]};
  assert.match(run(c,'previewEvidenceLabel()'),/Preview values returned.*2020-01-01.*2020-01-31/);
  assert.doesNotMatch(run(c,'previewEvidenceLabel()'),/project-period data available|valid|quality-approved/);
  c.sample.series[0].points[0].value=null;
  assert.match(run(c,'previewEvidenceLabel()'),/No numeric values returned in this preview/);
  assert.equal(run(c,'stationWorkflowStatus().tone'),'warning');
  c.savedLabel='Retained example';assert.match(run(c,'previewEvidenceLabel()'),/^Saved preview/);
});

for(const fixture of [
  {name:'precipitation-only companion',key:'PRCP',value:null,multiDay:{element:'MDPR',value:32,days:10,attributes:',,N',daysAttributes:',,N'}},
  {name:'snowfall-only companion',key:'SNOW',value:null,multiDay:{element:'MDSF',value:17.5,days:3,attributes:',,N'}},
  {name:'unknown duration',key:'PRCP',value:null,multiDay:{element:'MDPR',value:32,days:null}},
  {name:'ordinary daily zero',key:'PRCP',value:0},
  {name:'daily plus companion',key:'PRCP',value:7,multiDay:{element:'MDPR',value:32,days:10}},
  {name:'failed total and duration QC',key:'SNOW',value:null,multiDay:{element:'MDSF',value:17.5,days:3,attributes:',X,N',daysAttributes:',L,N'}}
])test('R1 scoped daily counts: '+fixture.name,()=>{
  const c=scope();c.selectedId='ghcn_daily';const point={time:'2017-08-25',value:fixture.value,flags:{},...(fixture.multiDay?{multiDay:fixture.multiDay}:{})};
  c.sample={station:station(1),window:{start:point.time,end:point.time},series:[{key:fixture.key,label:fixture.key,unit:'mm',cadenceMs:86400000,points:[point]}]};c.series=c.sample.series[0];
  const before=JSON.stringify(c.sample),chart=run(c,'renderChart(series)'),status=read(c,'stationWorkflowStatus()'),daily=fixture.value===null?0:1,multi=fixture.multiDay?1:0;
  assert.match(status.title,new RegExp(daily+' numeric daily values'));
  assert.match(chart.textContent,new RegExp('Daily values reported on '+daily+' of 1 day'));
  const detail=find(chart,n=>hasClass(n,'sc-chart-counts'));
  const counts=Object.fromEntries(detail.children.map(row=>row.children.map(n=>n.textContent)));
  assert.equal(counts['Multi-day totals reported'],String(multi));
  assert.equal(counts['Daily values unavailable with a multi-day total'],String(multi&&!daily?1:0));
  assert.equal(counts['Daily records with a failed quality flag'],'0');
  if(!daily){assert.match(status.title,/No numeric daily values; 1 multi-day total/);assert.equal(all(chart,n=>n.tagName==='SVG').length,0);assert.doesNotMatch(chart.textContent,/Reported subtotal|Preview-period total/);}
  if(fixture.multiDay?.attributes)assert.match(run(c,'multiDayFlagText(series.points[0])'),new RegExp(fixture.multiDay.attributes.includes('X')?'MDSF total flags: QC flag: X':'Source flag: N'));
  const model=read(c,'SiteObservationChart.model(series,sample.window,selectedId)');assert.equal(model.sum,fixture.value);assert.equal(JSON.stringify(c.sample),before);
});

test('Washington chart keys, ties, missing dates and accumulation agree with the original NCEI rows',()=>{
  const c=scope(),id='US1DCDC0045',raw=require('./fixtures/observation-legend/US1DCDC0045-20261018-20261105.json');
  const w={start:'2026-10-18',end:'2026-11-05'};
  c.selectedId='ghcn_daily';c.sample={window:w};
  c.series=require('../src/providers.js')._test.parseGHCN(raw,{id},w).find(s=>s.key==='PRCP');
  const before=JSON.stringify(c.series),chart=run(c,'renderChart(series)');
  const keys=all(chart,n=>n.attributes?.['data-legend-key']).map(n=>n.attributes['data-legend-key']);
  assert.deepEqual(keys,['bar','zero','trace','missing','multi']);
  assert.match(chart.textContent,/12 of 19 days · 3 traces excluded from the subtotal/);
  assert.match(chart.textContent,/≥ 1 mm/);assert.match(chart.textContent,/Oct 20 and Nov 5/);
  assert.match(chart.textContent,/Missing days \(6\)/);assert.match(chart.textContent,/Multi-day total only \(1\)/);
  assert.match(chart.textContent,/7.1 mm over 4 days/);assert.match(chart.textContent,/starts before the preview/);
  assert.doesNotMatch(chart.textContent,/,,N|expected slots/);
  assert.equal(JSON.stringify(c.series),before);
});

test('legend follows plotted markers for measured zero, trace, presumed zero, failed QC and missingness',()=>{
  const c=scope();c.selectedId='ghcn_daily';c.sample={window:{start:'2020-02-26',end:'2020-03-01'}};
  c.series={key:'PRCP',label:'Daily precipitation',unit:'mm',cadenceMs:86400000,points:[
    {time:'2020-02-26',value:0,flags:{}},{time:'2020-02-27',value:0,flags:{measurementFlag:'T'}},
    {time:'2020-02-28',value:0,flags:{measurementFlag:'P'}},{time:'2020-02-29',value:6,flags:{qualityFlag:'X'}}]};
  const chart=run(c,'renderChart(series)');
  assert.deepEqual(all(chart,n=>n.attributes?.['data-legend-key']).map(n=>n.attributes['data-legend-key']),['zero','trace','missing','failed','presumed']);
  assert.match(chart.textContent,/0 mm/);assert.match(chart.textContent,/highest flagged value/i);
  assert.match(chart.textContent,/Numeric entries returned for 4 of 5 days/);
});

test('R1 trace magnitudes use subtotal wording without changing the bound or zero handling',()=>{
  const c=scope();c.selectedId='ghcn_daily';c.sample={window:{start:'2017-08-25',end:'2017-08-26'}};
  for(const value of [-1,5]){c.series={key:'PRCP',label:'Daily precipitation',unit:'mm',cadenceMs:86400000,points:[{time:'2017-08-25',value},{time:'2017-08-26',value:0,flags:{measurementFlag:'T'}}]};const chart=run(c,'renderChart(series)');assert.match(chart.textContent,/Reported subtotal/);assert.doesNotMatch(chart.textContent,/Preview-period total/);assert.equal(chart.textContent.includes('≥'),value>=0);}
});

