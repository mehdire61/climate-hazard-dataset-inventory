/* Project-specific shortlist. Evidence describes the actual scope of a provider check. */
(function (root) {
  'use strict';
  const publicProviders=[
    [/^NOAA/,'NOAA'],[/^USGS/,'USGS'],[/^NASA/,'NASA'],[/^ESA /,'ESA'],[/^ECMWF/,'ECMWF / Copernicus'],
    [/^DWD /,'DWD / GPCC'],[/^GRDC /,'GRDC'],[/^(?:Copernicus|CEMS|European Commission Copernicus)/,'Copernicus'],
    [/^Met Office/,'Met Office'],[/^US National Ice Center/,'USNIC / NSIDC'],[/^PSMSL$/,'PSMSL'],[/^USDA NRCS/,'USDA NRCS']
  ];
  function publisher(name) {
    const match=publicProviders.find(([pattern])=>pattern.test(name));
    return {name:match?.[1] || (name.startsWith('UCSB Climate Hazards')?'UCSB CHC':name.split(/;| \/ /)[0]),publicService:!!match};
  }
  function key(id,hazard) {return id==='ghcn_daily'?id+'/'+hazard:id;}
  function elements(hazard) {return hazard==='precipitation'?['PRCP','MDPR']:hazard==='temperature'?['TMIN','TMAX']:null;}
  function stationEvidence(id,hazard,result,query) {
    const keys=id==='ghcn_daily' && elements(hazard);
    const matches=result.stations.filter(s=>!s.locationConflict && (!keys || s.variables?.some(v=>keys.includes(v.key) &&
      v.start && v.start<=query.end && (!v.end || v.end>=query.start))));
    if (matches.length) {
      const inside=query.mode==='area' && matches.some(s=>s.relation==='inside');
      const label=query.mode==='point'?'In search radius':inside?'Inside project area':'In project buffer';
      return {level:2,label:'Stations listed · '+label,detail:(id==='noaa_coops_water_level'?'Gauge locations. Check operating dates and datum.':'Station metadata overlap the project dates. Individual reports can have gaps.')};
    }
    if (result.complete && !result.error && !result.cancelled && !result.stations.some(s=>s.locationConflict ||
      (keys && (!s.variables?.length || s.variables.some(v=>keys.includes(v.key)&&!v.start)))))
      return {level:-1,label:'No matching stations listed',detail:'The completed search found no matching station in this project search area.'};
    return {level:0,label:'Station coverage unresolved',detail:'The available station metadata do not settle local coverage.'};
  }
  function fileEvidence(profile,response,query) {
    if (response.files?.length) {
      const scope=profile.spatialMode==='global'?'global files':query.mode==='area'?'area envelope':'project point';
      return {level:2,label:'Files listed · '+scope,detail:'Provider file metadata overlap the request. Check the cell, variable and observation dates in the files.'};
    }
    if (response.complete && !response.error && !response.cancelled)
      return {level:-1,label:'No matching files listed',detail:'The provider returned a complete empty listing for this request.'};
    return {level:0,label:'File coverage unresolved',detail:'The provider listing was incomplete or unavailable.'};
  }
  function previewEvidence(id,hazard,result) {
    const wanted=id==='ghcn_daily' && elements(hazard), days=new Set();
    for (const series of result.series || []) {
      if (wanted && !wanted.includes(series.key)) continue;
      for (const p of series.points || []) {
        if (Number.isFinite(p.value) && !p.flags?.qualityFlag) days.add(p.time.slice(0,10));
      }
    }
    const detail=result.station.id+' · '+result.window.start+' to '+result.window.end;
    if (days.size) return {level:3,label:'Observations returned · '+days.size+' '+(days.size===1?'day':'days'),detail};
    if (id==='ghcn_daily' && hazard==='precipitation' && result.series.some(s=>s.key==='PRCP' && s.points.some(p=>Number.isFinite(p.multiDay?.value))))
      return {level:2,label:'Multi-day precipitation reported',detail};
    return null;
  }
  function rank(scoped,{byId,rules,evidence,hazard,offshore,regionalRain,limit}) {
    const landNetworks=['ghcn_daily','ghcnh_hourly','isd_global_hourly','grdc_discharge','gsim_indices','usgs_streamflow','nrcs_snotel_daily_swe'];
    const state=r=>evidence.get(key(r.productId,hazard))?.level ?? 0;
    const kind=r=>rules[r.productId].support_type==='grid' && rules[r.productId].domain.kind==='regional'?'regional grid':rules[r.productId].support_type;
    const nationalRiver=r=>['flood','drought'].includes(hazard) && !offshore && r.productId==='usgs_streamflow' && r.networkInScope;
    const regionalConcern=r=>state(r)<=0 && (r.spatialRelation==='unknown'||r.spatialRelation==='near'&&!nationalRiver(r));
    const regionalStorm=r=>regionalRain && r.status==='possible' ? (r.productId==='stage_iv'?2:r.productId==='gpm_imerg_final_v07b'?1:0) : 0;
    const fit=r=>r.status==='possible'?2:/^Find /.test(r.label)?1:0;
    const documented=r=>r.temporalSegments?.some(s=>s.kind==='documented');
    const localOperator=r=>nationalRiver(r) || (r.productId==='noaa_coops_water_level' && r.networkInScope) ||
      (r.status==='possible' && r.spatialRelation==='within' && rules[r.productId].domain.kind==='regional' && /^NOAA/.test(byId.get(r.productId).provider));
    const catalogue=byId, authority=r=>publisher(catalogue.get(r.productId).provider).publicService;
    const candidates=scoped.filter(r=>r.status!=='excluded' && state(r)>=0 &&
      (state(r)>0 || (r.networkInScope!==false && !(offshore&&(landNetworks.includes(r.productId)||rules[r.productId].domain.mask)))))
      .sort((a,b)=>Number(regionalConcern(a))-Number(regionalConcern(b)) ||
        Number(!!a.resolutionChecks?.length)-Number(!!b.resolutionChecks?.length) ||
        Number(!!b.eventStudyMatch)-Number(!!a.eventStudyMatch) || state(b)-state(a) ||
        regionalStorm(b)-regionalStorm(a) || Number(!!a.partial)-Number(!!b.partial) || Number(!!localOperator(b))-Number(!!localOperator(a)) ||
        fit(b)-fit(a) || Number(!!documented(b))-Number(!!documented(a)) ||
        Number(authority(b))-Number(authority(a)) ||
        Number(landNetworks.includes(b.productId)&&hazard==='flood')-Number(landNetworks.includes(a.productId)&&hazard==='flood') ||
        catalogue.get(a.productId).product_name.localeCompare(catalogue.get(b.productId).product_name));
    const picked=new Set();
    for (const pool of [candidates.filter(r=>!regionalConcern(r)&&!r.resolutionChecks?.length),candidates.filter(r=>!regionalConcern(r)),candidates]) {
      if (picked.size>=limit) break;
      for (const r of pool.filter(r=>r.eventStudyMatch || state(r)>0)) {
        if(picked.size>=limit)break;
        picked.add(r);
      }
      for (const distinguish of [kind,r=>kind(r)+'/'+rules[r.productId].time_step,r=>r.productId]) {
        const represented=new Set([...picked].map(distinguish));
        for (const r of pool) {
          if(picked.size>=limit)break;
          const type=distinguish(r);
          if (!represented.has(type)) {picked.add(r);represented.add(type);}
        }
      }
    }
    return new Set(candidates.filter(r=>picked.has(r)).map(r=>r.productId));
  }
  const api={publisher,key,stationEvidence,fileEvidence,previewEvidence,rank};
  root.SiteShortlist=api;
  if(typeof module!=='undefined' && module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
