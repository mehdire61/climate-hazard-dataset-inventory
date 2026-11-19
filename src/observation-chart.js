/* Display-only calculations. Provider values, flags and exports stay unchanged. */
(function(root){
  'use strict';
  const DAY=86400000;
  const cf6Source=flag=>flag==='1'||flag==='D';
  function usgsStatus(flags) {
    const labels = flags?.approvalStatus ? [String(flags.approvalStatus)] : [];
    const qualifiers = (Array.isArray(flags?.qualifier) ? flags.qualifier : [flags?.qualifier])
      .flatMap(value => typeof value === 'string' ? value.toUpperCase().split(/[\s,;|]+/) : []);
    if (qualifiers.includes('ESTIMATED') || qualifiers.includes('E')) labels.push('Estimated');
    if (qualifiers.includes('REVISED')) labels.push('Revised');
    return labels;
  }
  function model(series,window,productId){
    const daily=series.cadenceMs===DAY;
    const time=value=>daily||/^\d{4}-\d{2}-\d{2}$/.test(String(value))?Date.parse(String(value).slice(0,10)+'T00:00:00Z'):Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(String(value))?value:String(value).replace(' ','T')+'Z');
    const start=time(window.startTime||window.start),end=window.endTime?time(window.endTime):time(window.end)+(daily?0:DAY-1);
    const cadence=Number.isFinite(series.cadenceMs)&&series.cadenceMs>0?series.cadenceMs:null;
    const first=cadence?Math.ceil(start/cadence)*cadence:start,last=cadence?Math.floor(end/cadence)*cadence:end;
    const accumulation=['PRCP','SNOW'].includes(series.key);
    const rows=(series.points||[]).map(point=>{
      const status=productId==='usgs_streamflow'?usgsStatus(point.flags):[];
      return {...point,ms:time(point.time),estimated:status.includes('Estimated'),revised:status.includes('Revised'),preliminarySource:productId==='ghcn_daily'&&cf6Source(point.flags?.sourceFlag),failed:productId==='ghcn_daily'&&!!String(point.flags?.qualityFlag||'').trim(),trace:productId==='ghcn_daily'&&point.flags?.measurementFlag==='T',presumedZero:productId==='ghcn_daily'&&accumulation&&point.flags?.measurementFlag==='P',provisional:point.flags?.approvalStatus==='Provisional'||point.flags?.quality==='p'};
    }).sort((a,b)=>a.ms-b.ms);
    const numeric=rows.filter(p=>Number.isFinite(p.value)&&Number.isFinite(p.ms));
    const counts=new Map();for(const row of rows)counts.set(row.ms,(counts.get(row.ms)||0)+1);
    const irregular=rows.some(p=>!Number.isFinite(p.ms)||p.ms<start||p.ms>end||(cadence&&p.ms%cadence!==0)||(counts.get(p.ms)>1));
    const expected=cadence&&Number.isFinite(start)&&Number.isFinite(end)&&end>=start&&!irregular?Math.max(0,(last-first)/cadence+1):null;
    const present=new Map(rows.map(p=>[p.ms,p]));
    const missing=[];
    // Provider previews are bounded. Refuse an unbounded synthetic slot expansion.
    if(expected!==null&&expected<=100000)for(let ms=first;ms<=last;ms+=cadence){const p=present.get(ms);if(!p||!Number.isFinite(p.value))missing.push({ms,kind:p?.multiDay?'multi-day total; daily value unavailable':p?'missing value':'absent timestamp'});}
    const assessed=expected!==null&&expected<=100000;
    const direction=/^(WDF|WDIR|AWDR$)/.test(series.key);
    const kind=accumulation&&assessed?'bars':!direction&&assessed?'line':'points';
    const segments=[];let segment=[];
    if(kind==='line')for(const row of rows){
      if(!Number.isFinite(row.value)||row.failed){if(segment.length)segments.push(segment);segment=[];continue;}
      if(segment.length&&row.ms-segment[segment.length-1].ms!==cadence){segments.push(segment);segment=[];}
      segment.push(row);
    }
    if(segment.length)segments.push(segment);
    const presumedZeroCount=rows.filter(p=>p.presumedZero).length;
    const accepted=numeric.filter(p=>!p.failed&&!p.trace&&!p.presumedZero);
    const traceCount=rows.filter(p=>p.trace&&!p.failed).length,failedCount=rows.filter(p=>p.failed).length;
    const sum=kind==='bars'&&(accepted.length||traceCount)?accepted.reduce((n,p)=>n+p.value,0):null;
    const peak=accepted.length?accepted.reduce((a,b)=>a.value>=b.value?a:b):null;
    const flagged=numeric.filter(p=>p.failed&&!p.presumedZero),flaggedPeak=flagged.length?flagged.reduce((a,b)=>a.value>=b.value?a:b):null;
    const multiDay=rows.filter(p=>p.multiDay),multiDayMissing=multiDay.filter(p=>!Number.isFinite(p.value)).length;
    // A lower-bound display is conditional on accepted nonnegative measurements, not a QC certification.
    const lowerBound=sum!==null&&accepted.every(p=>p.value>=0)&&(traceCount>0||missing.length>0||failedCount>0||presumedZeroCount>0);
    return {kind,rows,numeric,segments,cadence,estimatedCount:numeric.filter(p=>p.estimated).length,revisedCount:numeric.filter(p=>p.revised).length,preliminarySourceCount:numeric.filter(p=>p.preliminarySource).length,expected:assessed?expected:null,missing:assessed?missing:null,absent:assessed?missing.filter(p=>p.kind==='absent timestamp').length:null,returnedMissing:rows.filter(p=>!Number.isFinite(p.value)).length,traceCount,failedCount,presumedZeroCount,sum,peak,flaggedPeak,multiDay,multiDayMissing,lowerBound,complete:assessed&&missing.length===0&&failedCount===0&&presumedZeroCount===0,start:Number.isFinite(start)?start:Math.min(...numeric.map(p=>p.ms)),end:Number.isFinite(end)?end:Math.max(...numeric.map(p=>p.ms)),daily,irregular};
  }
  const api={model,usgsStatus,cf6Source};root.SiteObservationChart=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
