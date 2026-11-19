/* Explicitly shared/saved project inputs only: no station responses or credentials. */
(function(root){
  'use strict';
  const MAX_BYTES=8*1024*1024,MAX_LINK=12000;
  function boundary(query){
    const data=root.InventoryApp?.data||(typeof require==='function'?{geography:require('../data/geography.json'),countryBoundaries:require('../data/country-boundaries.json')}:{});
    const shape=JSON.stringify(query.geometry),same=g=>JSON.stringify(root.SiteGeometry.normalize(g))===shape;
    const saved=(data.geography?.examples||[]).find(a=>a.source?.id===query.areaSource?.id&&same(a.geometry));
    if(saved)return {areaName:saved.name,areaSource:JSON.parse(JSON.stringify(saved.source))};
    const countries=data.countryBoundaries,known=(countries?.features||[]).find(f=>f.properties.id===query.areaSource?.id&&same(f.geometry));
    if(known)return {areaName:known.properties.name+' (generalized country boundary)',areaSource:{...countries.source,id:known.properties.id,kind:'country',generalized:true,processing:'Geometry matches this build’s bundled country boundary; source attribution restored from the bundle.'}};
    return {areaName:query.areaName,areaSource:{kind:'project-link',note:'Boundary attribution supplied by a shared project; not verified by this build. The area name is user supplied. Re-select a named boundary to obtain source attribution.'}};
  }
  function validate(value,products,hazards=[]){
    if(!value||value.schema!=='climate-inventory-project/1'||!value.query)throw Error('This is not a supported inventory project file.');
    const raw=value.query,q={mode:raw.mode,start:raw.start,end:raw.end};
    if(raw.mode==='point')Object.assign(q,{lat:raw.lat,lon:raw.lon,radiusKm:raw.radiusKm});
    else if(raw.mode==='area')Object.assign(q,{geometry:raw.geometry,areaName:String(raw.areaName||'Project area').slice(0,200),areaSource:raw.areaSource||null,bufferKm:raw.bufferKm});
    else throw Error('Project location type must be point or area.');
    const errors=root.SiteScreening.validate(q);if(errors.length)throw Error(errors.join(' '));
    if(q.mode==='area'){q.geometry=root.SiteGeometry.normalize(q.geometry);Object.assign(q,boundary(q));}
    if(!products.includes(value.selectedId))throw Error('The selected dataset is not in this catalog.');
    const hazard=value.hazard===null?null:hazards.includes(value.hazard)?value.hazard:'';
    return {schema:'climate-inventory-project/1',query:q,selectedId:value.selectedId,hazard,...(value.selectionMode==='automatic'?{selectionMode:'automatic'}:{})};
  }
  function parse(text,products,hazards){if(typeof text!=='string'||new TextEncoder().encode(text).length>MAX_BYTES)throw Error('Project files are limited to 8 MB.');return validate(JSON.parse(text),products,hazards);}
  function key(value){
    const q=value.query;
    const query=q.mode==='area'?{mode:'area',start:q.start,end:q.end,bufferKm:q.bufferKm??0,geometry:{type:q.geometry.type,coordinates:q.geometry.coordinates}}:{mode:'point',start:q.start,end:q.end,lat:q.lat,lon:q.lon,radiusKm:q.radiusKm??100};
    return JSON.stringify({query,selectedId:value.selectedId,hazard:value.hazard===null?null:value.hazard||'',...(value.selectionMode==='automatic'?{selectionMode:'automatic'}:{})});
  }
  function fragment(value){const result='#site-check?project='+encodeURIComponent(JSON.stringify(value));if(result.length>MAX_LINK)throw Error('This boundary is too detailed for a reliable link. Download the project file to share its full geometry.');return result;}
  const api={validate,parse,fragment,key,MAX_BYTES};root.SiteProjectState=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
