/* GFM metadata discovery only. Provider COGs retain full tile extent and quality layers. */
(function(root) {
  'use strict';
  const endpoint='https://stac.eodc.eu/api/v1/collections/GFM/items',pageSize=25;
  const geometry=()=>root.SiteGeometry||(typeof require==='function'?require('./geometry.js'):null);
  const screening=()=>root.SiteScreening||(typeof require==='function'?require('./screening.js'):null);
  const copy=value=>JSON.parse(JSON.stringify(value));
  function scopes(query) {return geometry().searchBoxes({...query,radiusKm:0,bufferKm:0});}
  function urlFor(query,box,token=null) {
    const params=new URLSearchParams({bbox:box.join(','),datetime:query.start+'T00:00:00Z/'+query.end+'T23:59:59.999Z',limit:pageSize});
    if(token)params.set('token',token);return endpoint+'?'+params;
  }
  function fail(message) {throw new Error(message);}
  async function discover(profile,query,options={}) {
    const errors=screening().validate(query);if(errors.length)fail(errors.join(' '));
    if(profile.productId!=='cems_gfm'||!Array.isArray(profile.assetKeys))fail('Unknown GFM access profile.');
    const boxes=scopes(query),key=JSON.stringify({query,assetKeys:profile.assetKeys});
    let state=options.cursor?copy(options.cursor):{version:1,key,scopeIndex:0,token:null,seenTokens:[],seenIds:[],expected:null,missingAssets:0};
    if(state.version!==1||state.key!==key||!Number.isInteger(state.scopeIndex)||state.scopeIndex<0||state.scopeIndex>=boxes.length||
      !(state.token===null||typeof state.token==='string'&&state.token.length<8192&&!/[\u0000-\u001f]/.test(state.token))||
      !Array.isArray(state.seenTokens)||!state.seenTokens.every(v=>typeof v==='string')||!Array.isArray(state.seenIds)||!state.seenIds.every(v=>typeof v==='string')||
      !(state.expected===null||Number.isSafeInteger(state.expected)&&state.expected>=0)||!Number.isSafeInteger(state.missingAssets)||state.missingAssets<0)fail('This continuation does not belong to the current GFM query. Start a new search.');
    const files=[],requests=[],notes=['GFM metadata matches project envelopes and acquisition dates. Files retain full tile extent; polygon masks, valid observations and representativeness are unverified.'];
    const result={files,requests,notes,complete:false,paginationComplete:false,missingAssets:state.missingAssets,cursor:state};
    const controller=new AbortController(),abort=()=>controller.abort();let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},options.timeoutMs||25000);
    options.signal?.addEventListener('abort',abort,{once:true});
    try {
      if(options.signal?.aborted){const e=new Error('File search cancelled.');e.name='AbortError';throw e;}
      const url=urlFor(query,boxes[state.scopeIndex],state.token);
      const response=await(options.fetchImpl||root.fetch)(url,{signal:controller.signal,credentials:'omit',redirect:'error',headers:{Accept:'application/geo+json, application/json'}});
      if(!response.ok)fail('GFM returned HTTP '+response.status+'. The search did not complete.');
      const raw=await response.text();let body;try{body=JSON.parse(raw);}catch(_){fail('GFM returned a non-JSON response.');}
      if(body.type!=='FeatureCollection'||!Array.isArray(body.features)||!Array.isArray(body.links)||!Number.isSafeInteger(body.numberMatched)||body.numberMatched<0)fail('GFM metadata have an unexpected structure.');
      if(state.expected!==null&&state.expected!==body.numberMatched)fail('GFM matching counts changed during pagination. Start a fresh search.');
      const accepted=[],ids=[];let missingAssets=state.missingAssets;
      for(const item of body.features) {
        if(item.collection!=='GFM'||typeof item.id!=='string'||!item.assets||!Number.isFinite(Date.parse(item.properties?.datetime)))fail('GFM returned an invalid item or another collection.');
        if(state.seenIds.includes(item.id)||ids.includes(item.id))fail('GFM repeated an item across pages. Completeness is unverified.');
        ids.push(item.id);
        for(const assetKey of profile.assetKeys) {
          const asset=item.assets[assetKey];if(!asset){missingAssets++;continue;}
          let target;try{target=new URL(asset.href);}catch(_){fail('GFM returned an invalid asset link.');}
          if(target.protocol!=='https:'||target.hostname!=='data.eodc.eu'||target.username||target.password||!asset.roles?.includes('data'))fail('GFM returned an unexpected data asset.');
          accepted.push({id:item.id+'|'+assetKey,name:decodeURIComponent(target.pathname.split('/').pop()),url:target.href,
            start:null,end:null,version:null,assetReferencePeriod:null,assetVersion:null,
            associatedAcquisitionTime:item.properties.datetime,parentProcessingVersion:item.properties['processing:version']||null,sizeBytes:null,
            temporalSupportNote:'The acquisition time and processing version describe the parent item. This asset’s own reference period and version are not established by the returned metadata.',
            checkedAt:new Date().toISOString(),authRequired:false,verificationLabel:'Live STAC metadata link; data pixels have not been inspected.',
            spatialDelivery:'Complete provider tile, not clipped to the project.',itemId:item.id,assetKey,assetDescription:asset.description||asset.title||assetKey,
            bbox:item.bbox,rasterBands:asset['raster:bands']||[],collection:'GFM'});
        }
      }
      const nextLinks=body.links.filter(l=>l.rel==='next');if(nextLinks.length>1)fail('GFM returned ambiguous pagination.');
      let nextToken=null;
      if(nextLinks.length) {
        const next=new URL(nextLinks[0].href);
        if(next.origin+next.pathname!==endpoint||!next.searchParams.has('token')||(nextLinks[0].method&&nextLinks[0].method!=='GET'))fail('GFM returned an unsafe or unsupported continuation.');
        nextToken=next.searchParams.get('token');
        if(!nextToken||nextToken.length>=8192||/[\u0000-\u001f]/.test(nextToken)||state.seenTokens.includes(nextToken)||!ids.length)fail('GFM continuation did not progress.');
      }
      const total=state.seenIds.length+ids.length;
      if(total>body.numberMatched||(!nextToken&&total!==body.numberMatched)||(nextToken&&total>=body.numberMatched))fail('GFM page counts do not establish complete results.');
      requests.push({url,retrievedAt:new Date().toISOString(),httpStatus:response.status,numberMatched:body.numberMatched,returnedItems:ids.length});
      files.push(...accepted);
      if(ids.length&&!accepted.length)notes.push('Matching metadata had no supported final-layer files. This does not establish usable data.');
      result.missingAssets=missingAssets;
      if(missingAssets)notes.push(missingAssets+' requested final-layer asset link(s) were absent from matched STAC items. Listed files are retained; the requested layer set is incomplete even when all metadata pages have been read.');
      if(nextToken)state={...state,token:nextToken,seenTokens:[...state.seenTokens,nextToken],seenIds:[...state.seenIds,...ids],expected:body.numberMatched,missingAssets};
      else if(state.scopeIndex+1<boxes.length)state={...state,scopeIndex:state.scopeIndex+1,token:null,seenTokens:[],seenIds:[],expected:null,missingAssets};
      else {state=null;result.complete=missingAssets===0;result.paginationComplete=true;}
      result.cursor=state;return result;
    } catch(error) {
      result.error={message:timedOut?'GFM file search timed out. Retry this page.':error.message};
      result.cancelled=options.signal?.aborted===true||(!timedOut&&error.name==='AbortError');return result;
    } finally {clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
  }
  const api={discover,requestURLs:query=>scopes(query).map(box=>urlFor(query,box))};
  root.SiteStacAccess=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
