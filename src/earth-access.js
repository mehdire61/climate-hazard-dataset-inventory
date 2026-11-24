/* Public NASA CMR discovery. Data payloads remain at their authenticated provider URLs. */
(function(root){
  'use strict';
  const ENDPOINT='https://cmr.earthdata.nasa.gov/search/granules.json',PAGE_SIZE=1000;
  const geometry=()=>root.SiteGeometry||(typeof require==='function'?require('./geometry.js'):null);
  const screening=()=>root.SiteScreening||(typeof require==='function'?require('./screening.js'):null);
  function fail(message,code='CMR_ERROR'){const error=new Error(message);error.code=code;throw error;}
  const copy=value=>JSON.parse(JSON.stringify(value));
  function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
  async function fingerprint(value){const text=canonical(value);if(!root.crypto?.subtle)return text;const hash=await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,'0')).join('');}
  function validateProfile(profile){
    if(!profile||profile.kind!=='cmr'||typeof profile.productId!=='string'||!Array.isArray(profile.collections)||!profile.collections.length)fail('This product has no verified CMR access profile.','INPUT');
    if(profile.spatialMode!==undefined&&!['project','global'].includes(profile.spatialMode))fail('The CMR spatial discovery mode is invalid.','INPUT');
    for(const c of profile.collections)if(!c||!/^C\d+-[A-Z0-9_]+$/.test(c.id)||typeof c.shortName!=='string'||!c.shortName||typeof c.version!=='string'||!c.version)fail('The CMR collection identity/version is invalid.','INPUT');
  }
  function scopes(profile,query){
    const spatial=profile.spatialMode==='global'?[{}]:query.mode==='area'?geometry().searchBoxes({...query,bufferKm:0}).map(b=>({bounding_box:b.join(',')})):[{point:query.lon+','+query.lat}];
    return profile.collections.flatMap(collection=>spatial.map(bounds=>({collection,...bounds})));
  }
  function requestURL(scope,query){return ENDPOINT+'?'+new URLSearchParams({collection_concept_id:scope.collection.id,...(scope.collection.granulePattern?{readable_granule_name:scope.collection.granulePattern,'options[readable_granule_name][pattern]':'true'}:{}),temporal:query.start+'T00:00:00Z,'+query.end+'T23:59:59.999Z',...(scope.point?{point:scope.point}:scope.bounding_box?{bounding_box:scope.bounding_box}:{}),page_size:PAGE_SIZE,sort_key:'start_date'});}
  function freshState(key,productId){return {version:1,productId,key,scopeIndex:0,after:null,seenTokens:[],seenIds:[],hits:null,read:0,granulesReadTotal:0,missingLinksTotal:0};}
  function readState(cursor,key,productId,length){
    if(!cursor)return freshState(key,productId);const s=copy(cursor);
    if(s.version!==1||s.productId!==productId||s.key!==key||!Number.isInteger(s.scopeIndex)||s.scopeIndex<0||s.scopeIndex>=length||
      !(s.after===null||typeof s.after==='string'&&s.after.length<=8192&&!/[\u0000-\u001f]/.test(s.after))||
      !Array.isArray(s.seenTokens)||!s.seenTokens.every(t=>typeof t==='string'&&t.length>0&&t.length<=8192&&!/[\u0000-\u001f]/.test(t))||new Set(s.seenTokens).size!==s.seenTokens.length||
      !Array.isArray(s.seenIds)||!s.seenIds.every(t=>typeof t==='string'&&/^G\d+-[A-Z0-9_]+$/.test(t))||new Set(s.seenIds).size!==s.seenIds.length||
      !(s.hits===null||Number.isSafeInteger(s.hits)&&s.hits>=0)||![s.read,s.granulesReadTotal,s.missingLinksTotal].every(v=>Number.isSafeInteger(v)&&v>=0)||s.read!==s.seenIds.length)fail('The CMR continuation is invalid or belongs to another product, geometry or period. Start a new file search.','CURSOR');
    if(s.granulesReadTotal<s.read||s.missingLinksTotal>s.granulesReadTotal||
      (s.read===0?(s.after!==null||s.hits!==null||s.seenTokens.length):(s.hits===null||s.hits<=s.read||!s.after||s.seenTokens.at(-1)!==s.after)))fail('The CMR continuation counts or page state are inconsistent. Start a new file search.','CURSOR');
    return s;
  }
  async function request(url,after,options,requests){
    const controller=new AbortController(),abort=()=>controller.abort();let timedOut=false;
    if(options.signal?.aborted){const e=new Error('File search cancelled.');e.name='AbortError';throw e;}
    options.signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},options.timeoutMs||60000);
    try{
      const headers={Accept:'application/json'};if(after)headers['CMR-Search-After']=after;
      const response=await(options.fetchImpl||root.fetch)(url,{headers,signal:controller.signal,credentials:'omit',redirect:'error'});
      if(!response.ok)fail('CMR returned HTTP '+response.status+(response.status===429?'. Wait before retrying; the service rate limit was reached.':'. File discovery did not complete.'),'HTTP_'+response.status);
      const rawText=await response.text();let data;try{data=JSON.parse(rawText);}catch(_){fail('CMR did not return JSON.','SCHEMA');}
      if(data.errors)fail('CMR rejected the request: '+String(data.errors.join?.('; ')||data.errors).slice(0,240),'PROVIDER_ERROR');
      if(!data.feed||!Array.isArray(data.feed.entry))fail('CMR granule metadata have an unexpected structure.','SCHEMA');
      if(response.headers.get('CMR-Timed-Out')==='true')fail('CMR timed out internally; a partial search is not accepted as complete.','TIMEOUT');
      const rawHits=response.headers.get('CMR-Hits'),hits=rawHits!==null&&/^\d+$/.test(rawHits)?Number(rawHits):NaN;
      if(!Number.isSafeInteger(hits)||hits<0)fail('CMR result-count headers are unavailable. Completeness cannot be verified.','SCHEMA');
      const next=response.headers.get('CMR-Search-After');
      if(next&&(next.length>8192||/[\u0000-\u001f]/.test(next)))fail('CMR returned an invalid continuation header.','PAGINATION');
      const receipt={url,retrievedAt:new Date().toISOString(),httpStatus:response.status,cmrHits:hits,searchAfter:after||null,nextSearchAfter:next||null,requestId:response.headers.get('CMR-Request-Id')||null};
      requests.push(receipt);return {entries:data.feed.entry,hits,next,receipt};
    }catch(error){
      if(timedOut)fail('CMR file discovery timed out. Retry the same page.','TIMEOUT');
      if(options.signal?.aborted||error.name==='AbortError'){error.name='AbortError';throw error;}
      if(error.code)throw error;fail('CMR could not be reached. Retry or use the prepared provider request.','NETWORK');
    }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
  }
  function parseEntries(entries,collection){
    const files=[],ids=[];let missing=0;
    for(const entry of entries){
      if(!entry||typeof entry.id!=='string'||!/^G\d+-[A-Z0-9_]+$/.test(entry.id)||entry.collection_concept_id!==collection.id||
        typeof entry.title!=='string'||typeof entry.time_start!=='string'||typeof entry.time_end!=='string'||!Number.isFinite(Date.parse(entry.time_start))||!Number.isFinite(Date.parse(entry.time_end))||Date.parse(entry.time_start)>Date.parse(entry.time_end)||!Array.isArray(entry.links))fail('CMR returned a malformed granule or a different collection. No files from this page were accepted.','SCHEMA');
      ids.push(entry.id);
      const links=entry.links.filter(link=>link&&!link.inherited&&link.rel==='http://esipfed.org/ns/fedsearch/1.1/data#').filter(link=>{try{const u=new URL(link.href);return u.protocol==='https:'&&!u.username&&!u.password;}catch(_){return false;}});
      const unique=[...new Map(links.map(link=>[link.href,link])).values()],fileStart=files.length;
      const rawSize=entry.granule_size,size=rawSize!==undefined&&rawSize!==null&&String(rawSize).trim()!==''?Number(rawSize):NaN;
      for(const link of unique){
        const pathname=new URL(link.href).pathname;let name=pathname.split('/').pop()||entry.title;try{name=decodeURIComponent(name);}catch(_){}const extension=name.split('.').pop().toLowerCase();
        files.push({id:entry.id+'|'+link.href,granuleId:entry.id,name,url:link.href,collectionId:collection.id,collectionShortName:collection.shortName,version:collection.version,platform:collection.label||collection.shortName,start:entry.time_start,end:entry.time_end,
          format:({hdf:'HDF',hdf5:'HDF5',nc:'NetCDF',nc4:'NetCDF4',zip:'ZIP',tif:'GeoTIFF',tiff:'GeoTIFF',sha256:'SHA-256 checksum',md5:'MD5 checksum',csv:'CSV',txt:'Text'})[extension]||link.type||'Provider data route',
          sizeMB:unique.length===1&&Number.isFinite(size)&&size>=0?size:null,granuleSizeMB:Number.isFinite(size)&&size>=0?size:null,
          authRequired:collection.authRequired!==false&&!(collection.id==='C2763353619-ORNL_CLOUD'&&extension==='sha256'&&link.href.startsWith('https://data.ornldaac.earthdata.nasa.gov/public/')),
          role:['sha256','md5'].includes(extension)?'checksum':'data',metadataOnly:true,verification:'CMR metadata link; data payload not downloaded or authenticated by this tool.'});
      }
      if(!files.slice(fileStart).some(file=>file.role==='data'))missing++;
    }
    return {files,ids,missing};
  }
  async function discover(profile,submittedQuery,options={}){
    validateProfile(profile);const errors=screening().validate(submittedQuery);if(errors.length)fail(errors.join(' '),'INPUT');
    const query=copy(submittedQuery);if(query.mode==='area')query.geometry=geometry().normalize(query.geometry);
    const list=scopes(profile,query),key=await fingerprint({productId:profile.productId,collections:profile.collections,spatialMode:profile.spatialMode||'project',query}),state=readState(options.cursor,key,profile.productId,list.length);
    const budget=options.pageBudget===undefined?1:options.pageBudget;if(!Number.isInteger(budget)||budget<1||budget>5)fail('A CMR action reads between one and five pages.','INPUT');
    const files=[],requests=[];let error=null,cancelled=false,pages=0;
    for(let i=0;i<budget&&state.scopeIndex<list.length;i++){
      const checkpoint=copy(state),scope=list[state.scopeIndex];
      try{
        const response=await request(requestURL(scope,query),state.after,options,requests),parsed=parseEntries(response.entries,scope.collection);
        if(state.hits!==null&&response.hits!==state.hits)fail('CMR holdings changed while paging. Earlier files are retained; restart discovery for a consistent metadata count.','CHANGED_RESULTS');
        if(new Set(parsed.ids).size!==parsed.ids.length||parsed.ids.some(id=>state.seenIds.includes(id)))fail('CMR repeated granules within this collection/spatial search. Earlier pages are retained; discovery is incomplete.','PAGINATION');
        if(state.read+parsed.ids.length>response.hits||!parsed.ids.length&&state.read<response.hits)fail('CMR page length conflicts with its result count. Discovery is incomplete.','PAGINATION');
        const more=state.read+parsed.ids.length<response.hits;
        if(more&&(!response.next||response.next===state.after||state.seenTokens.includes(response.next)))fail('CMR did not provide a new continuation for remaining granules.','PAGINATION');
        files.push(...parsed.files);pages++;state.hits=response.hits;state.read+=parsed.ids.length;state.seenIds.push(...parsed.ids);state.granulesReadTotal+=parsed.ids.length;state.missingLinksTotal+=parsed.missing;
        if(more){state.after=response.next;state.seenTokens.push(response.next);}else{state.scopeIndex++;state.after=null;state.hits=null;state.read=0;state.seenIds=[];state.seenTokens=[];}
      }catch(e){Object.assign(state,checkpoint);if(!pages&&!options.cursor)throw e;cancelled=e.name==='AbortError';error={code:cancelled?'CANCELLED':e.code||'CMR_ERROR',message:e.message};break;}
    }
    const continuation=state.scopeIndex<list.length?copy(state):null,complete=!continuation&&!error&&!state.missingLinksTotal;
    const notes=[profile.spatialMode==='global'?'CMR searched this collection globally by temporal overlap. No project spatial filter was applied: these are whole-domain files and the provider spatial metadata are unsuitable for point/area filtering.':query.mode==='area'?'CMR searched bounding envelopes of the original project area. Station buffers were excluded. Candidate granules are not exact polygon clips and may intersect holes or unused parts of the envelope.':'CMR searched the project point. The station-search radius was not used.',
      'Dates select overlapping granule time envelopes. Original files can contain times and locations outside the request; no pixel/variable subsetting, temporal aggregation or quality filtering was performed.',
      'File links come from public granule metadata. Protected data still require provider/Earthdata authentication; authenticated payload retrieval has not been tested here.',
      'Complete means the selected CMR metadata searches were traversed, not that valid observations cover the project. CMR holdings are mutable and are not an atomic archive snapshot.'];
    if(state.missingLinksTotal)notes.push(state.missingLinksTotal+' granules had no eligible HTTPS data link; file-access completeness remains unresolved.');
    if(continuation)notes.push('More granule metadata remain. Continue to retrieve the next batch; there is no overall file-count cap.');if(error)notes.push(error.message);
    return {files:[...new Map(files.map(f=>[f.id,f])).values()],requests,continuation,complete,paginationComplete:!continuation,truncated:!complete,cancelled,error,granulesReadTotal:state.granulesReadTotal,missingLinksTotal:state.missingLinksTotal,query,
      scope:{spatial:profile.spatialMode==='global'?'Whole-domain collection; no project spatial filter':query.mode==='area'?'Original footprint bounding-envelope candidates':'Project point',stationBufferApplied:false,temporal:'Granule-envelope overlap; original files are not clipped',payload:'Provider files, authentication may be required'},notes};
  }
  const api={discover,requestURL,scopes};root.SiteEarthAccess=api;
  if(typeof module!=='undefined'&&module.exports)module.exports={...api,_test:{parseEntries,readState}};
})(typeof globalThis!=='undefined'?globalThis:this);
