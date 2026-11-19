/* Pure display model: metadata dates are not observation completeness or site suitability. */
(function(root){
  'use strict';
  const DAY=86400000, MIN=Date.parse('0001-01-01T00:00:00Z'), MAX=Date.parse('9999-12-31T00:00:00Z')+DAY;
  const day=ms=>new Date(ms).toISOString().slice(0,10);
  const validDay=value=>typeof value==='string'&&/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&day(Date.parse(value+'T00:00:00Z'))===value;
  function boundary(value,end,precise){
    if(value==null||value==='')return {unknown:true};
    if(validDay(value))return {ms:Date.parse(value+'T00:00:00Z')+(end?DAY:0),text:value};
    if(typeof value!=='string'||!validDay(value.slice(0,10))||!/^\d{4}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(value))return {invalid:true};
    const iso=value.replace(' ','T'),time=Date.parse(/[Z+-]\d{0,2}:?\d{0,2}$/.test(iso)?iso:iso+'Z');
    if(!Number.isFinite(time))return {invalid:true};
    // Daily station/series metadata retain provider calendar dates, rather than shifting observation days.
    return precise?{ms:time+(end?1:0),text:new Date(time).toISOString()}:{ms:Date.parse(value.slice(0,10)+'T00:00:00Z')+(end?DAY:0),text:value.slice(0,10)};
  }
  function model(query,rule,station,options={}){
    const output={state:'unknown',title:'Project dates and metadata periods',axis:null,project:null,rows:[],markers:[],notes:[]};
    if(!query||!validDay(query.start)||!validDay(query.end)||query.start>query.end){output.state='invalid';output.notes.push('Valid inclusive project dates are required to draw this timeline.');return output;}
    const startMs=Date.parse(query.start+'T00:00:00Z'),endMs=Date.parse(query.end+'T00:00:00Z')+DAY;
    let low=startMs,high=endMs;
    if(options.fullRecord){
      const periods=[...(rule?.time?.kind==='scenario'?[]:rule?.time?.intervals||[]),...(rule?.time?.uncertain_windows||[])];
      if(station?.coopsAvailability){const c=station.coopsAvailability;if(c.stationId===station.id&&c.inventoryStatus==='ok')periods.push(...(c.periods||[]),...(c.hourlyPeriods||[]));}
      else if(station)periods.push(station,...(station.variables||[]),...(station.seriesMetadata||[]));
      for(const period of periods){const a=boundary(period.first??period.start,false,false),b=boundary(period.last??period.end,true,false);if(a.invalid||b.invalid||(!a.unknown&&!b.unknown&&a.ms>=b.ms))continue;if(Number.isFinite(a.ms))low=Math.min(low,a.ms);if(Number.isFinite(b.ms))high=Math.max(high,b.ms);}
      for(const date of [rule?.time?.known_through,rule?.time?.index_snapshot?.last_file_end,rule?.time?.access_route_end])if(validDay(date))high=Math.max(high,Date.parse(date+'T00:00:00Z')+DAY);
      output.title='Full metadata record and project window';
    }
    const padding=Math.max(7,Math.ceil((high-low)/DAY*(options.fullRecord?0.025:0.1)))*DAY;
    const axis={startMs:Math.max(MIN,low-padding),endMs:Math.min(MAX,high+padding),endExclusive:true};
    axis.start=day(axis.startMs);axis.end=day(axis.endMs-1);output.axis=axis;
    output.project={start:query.start,end:query.end,startMs,endMs};
    const fraction=ms=>(ms-axis.startMs)/(axis.endMs-axis.startMs);
    axis.ticks=[];
    const span=axis.endMs-axis.startMs, rawYearStep=Math.max(1,Math.ceil(span/(365.2425*DAY*5))),yearStep=options.fullRecord?([1,2,5,10,20,25,50,100,200,500,1000,2000].find(step=>step>=rawYearStep)||rawYearStep):rawYearStep;
    if(span>730*DAY){
      const firstYear=Math.ceil(Number(axis.start.slice(0,4))/yearStep)*yearStep;
      for(let year=firstYear;year<=Number(axis.end.slice(0,4));year+=yearStep){
        const ms=Date.parse(String(year).padStart(4,'0')+'-01-01T00:00:00Z');
        if(ms>=axis.startMs&&ms<axis.endMs)axis.ticks.push({label:String(year),fraction:fraction(ms)});
      }
    }else{
      const step=[1,2,5,7,14,30,90,180,365].find(days=>days>=span/DAY/4)*DAY;
      for(let ms=Math.ceil(axis.startMs/step)*step;ms<axis.endMs;ms+=step)axis.ticks.push({label:day(ms),fraction:fraction(ms)});
    }
    function segment(start,end,kind,precise=false,reason=''){
      const a=boundary(start,false,precise),b=boundary(end,true,precise);
      const base={start:start??null,end:end??null,kind,reason,openStart:!!a.unknown,openEnd:!!b.unknown,clippedStart:false,clippedEnd:false,offscreen:null,startFraction:null,endFraction:null,displayStart:null,displayEnd:null,precision:precise?'timestamp':'calendar-date'};
      if(a.invalid||b.invalid||(!a.unknown&&!b.unknown&&a.ms>=b.ms)){return {...base,invalid:true,label:'Unusable period boundaries; inspect the source metadata.'};}
      base.label=(a.text||'Start unknown')+' → '+(b.text||'End unknown / open')+(precise?' (UTC)':'')+(reason?'. '+reason:'');
      if(a.unknown&&b.unknown)return {...base,unknown:true};
      if(!b.unknown&&b.ms<=axis.startMs)return {...base,offscreen:'before'};
      if(!a.unknown&&a.ms>=axis.endMs)return {...base,offscreen:'after'};
      const visibleStart=Math.max(a.unknown?axis.startMs:a.ms,axis.startMs),visibleEnd=Math.min(b.unknown?axis.endMs:b.ms,axis.endMs);
      return {...base,startFraction:fraction(visibleStart),endFraction:fraction(visibleEnd),clippedStart:!a.unknown&&a.ms<axis.startMs,clippedEnd:!b.unknown&&b.ms>axis.endMs,
        displayStart:precise?new Date(visibleStart).toISOString():day(visibleStart),displayEnd:precise?new Date(visibleEnd-1).toISOString():day(visibleEnd-1),point:precise&&!a.unknown&&!b.unknown&&b.ms-a.ms===1};
    }
    function row(id,label,note,periods,kind,precise=false){
      const segments=(Array.isArray(periods)?periods:[]).map(p=>p&&typeof p==='object'?segment(p.first??p.start,p.last??p.end,kind,precise,p.reason||''):segment('invalid','invalid',kind));
      output.rows.push({id,label,note,segments});
      if(id!=='project'&&segments.some(s=>!s.invalid&&!s.unknown))output.state='ready';
      if(segments.some(s=>s.invalid))output.notes.push(label+': malformed boundaries were not drawn.');
    }
    row('project','Original project period','Inclusive project dates; retrieval may use a smaller disclosed window.',[query],'project');
    const time=rule?.time;
    if(!time||typeof time!=='object')output.notes.push('No reviewed product-period metadata are available. The project period is still shown.');
    else{
      const scenario=time.kind==='scenario',event=time.kind==='event',track=rule.support_type==='track',acquisition=rule.support_type==='acquisition';
      const label=time.solution_calendar?'Nominal monthly solution periods':scenario?'Scenario / climate-state information':track?'Documented track period':event?'Documented event period':acquisition?'Documented acquisition period':time.kind==='station'?'Archive date limits':'Documented period';
      const note=time.solution_calendar?'Each interval groups nominal monthly solutions. JPL sampling bounds may cross month boundaries.':scenario?'Calendar-date overlap is not an observation-availability test for this information.':track?'A track archive does not imply continuous observations or a hazard occurrence at the project.':event?'An archive/event envelope is not a continuous time series or evidence that an event occurred at the project.':acquisition?'Dates do not establish an acquisition or valid pixels at the project.':time.kind==='station'?'Any limits shown are for the archive. Check the selected station and variable for local dates.':'Nominal metadata only; internal gaps, valid pixels and scientific suitability are untested.';
      const periods=time.solution_calendar?time.intervals.map(r=>({...r,end:r.end||time.known_through})):time.intervals;
      row('catalog',label,note,scenario?[]:periods,'nominal');
      if(typeof rule.time_step==='string')output.notes.push('Catalog time support: '+rule.time_step.replaceAll('_',' ')+'. The timeline does not convert it into daily observations.');
      if(typeof time.note==='string'&&time.note)output.notes.push(time.note);
      if(Array.isArray(time.uncertain_windows)&&time.uncertain_windows.length)row('uncertainty','Uncertain start or end','Retained uncertain periods; not an additional record of observations.',time.uncertain_windows,'uncertain');
      const through=time.index_snapshot?.last_file_end||time.known_through;
      function marker(date,kind,label){
        if(!validDay(date)){output.notes.push(label+': date unavailable or malformed.');return;}
        const ms=Date.parse(date+'T00:00:00Z')+DAY-1,offscreen=ms<axis.startMs?'before':ms>=axis.endMs?'after':null;
        output.markers.push({date,kind,label,positionFraction:offscreen?null:fraction(ms),offscreen});
      }
      if(!scenario&&through)marker(through,'known-through','Known through '+through+' in retained metadata; soft horizon, not a dataset end date');
      if(!scenario&&time.access_route_end)marker(time.access_route_end,'route-end','Selected archive route ends '+time.access_route_end+'; not necessarily the product-family endpoint');
      if(time.index_snapshot?.checked_on)output.notes.push('File-listing snapshot checked '+time.index_snapshot.checked_on+'. Listed files do not establish valid-data coverage.');
      else if(time.index_reference&&!through)output.notes.push('The retained file-index horizon was not supplied to this timeline; no endpoint is inferred.');
      if(time.access_route_note)output.notes.push(time.access_route_note);
      const policy=time.publication_policy;
      if(policy){const guidance={era5_cds:'Recent ERA5 releases may lag and may be preliminary ERA5T; check files and processing versions.',merra2_monthly:'M2I1NXASM is released monthly with variable delay; no exact release deadline is drawn.',mcd64a1_monthly:'MCD64A1 is a calendar-month product; check published granules, production metadata and per-pixel usable dates.'};output.notes.push((guidance[policy.kind]||'Publication timing requires a provider check.')+(validDay(policy.checked_on)?' Guidance reviewed '+policy.checked_on+'.':''));}
    }
    if(station&&typeof station==='object'){
      const coops=station.coopsAvailability;
      if(coops){
        if(coops.stationId!==station.id||coops.inventoryStatus!=='ok'||!Array.isArray(coops.periods))output.notes.push('CO-OPS inventory periods are unresolved or do not identify this station; no station intervals are drawn.');
        else{
          for(const [name,id]of [['Preliminary 6-Minute Water Level','preliminary'],['Verified 6-Minute Water Level','verified'],['Verified Hourly Height Water Level','hourly']]){
            const periods=[...(coops.periods||[]),...(coops.hourlyPeriods||[])].filter(p=>p?.product===name);
            if(periods.length)row('coops-'+id,name,'NOAA inventory intervals in UTC; gaps are preserved and returned quality flags remain authoritative.',periods,'station',true);
          }
          if(!coops.periods?.length)output.notes.push('No six-minute water-level product is listed in the retained station inventory.');
        }
        if(coops.message)output.notes.push(coops.message);
      }else{
        if(station.start!=null||station.end!=null)row('station','Station record span','Provider metadata envelope; it may include gaps and different variable periods.',[{start:station.start,end:station.end}],'station');
        if(Array.isArray(station.variables)){
          for(const key of [...new Set(station.variables.map(v=>v?.key).filter(Boolean))])row('element-'+key,key+' element period','Provider calendar-date metadata, not requested-period completeness or UTC-normalized observation days.',station.variables.filter(v=>v?.key===key),'station');
        }
        if(Array.isArray(station.seriesMetadata))station.seriesMetadata.forEach((series,i)=>{
          const unit=({'ft^3/s':'ft³/s','m^3/s':'m³/s'})[series?.unit] || series?.unit;
          const number=station.seriesMetadata.length>1?' '+(i+1):'';
          const label='Daily mean discharge'+number+(unit?' · '+unit:'');
          const note=[series?.id?'Provider series ID: '+series.id+'.':'',series?.unit?'Provider unit: '+series.unit+'.':'','Metadata dates may span reporting gaps.'].filter(Boolean).join(' ');
          row('series-'+i,label,note,[series],'station');
        });
      }
    }
    output.notes.unshift('This is a metadata timeline, not measured completeness. Bars can contain unobserved or invalid data; layout fractions are not coverage percentages.',options.fullRecord?'The axis includes all documented record boundaries and the project window. Open endpoints extend to the display edge without implying availability. A narrow project is highlighted with a minimum-width mark; read its exact dates.':'The axis focuses on the project with context. Offscreen periods and unknown/open endpoints remain labelled.');
    output.notes=[...new Set(output.notes)];
    return output;
  }
  const api={model};root.SiteCoverageTimeline=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
