/* Read provider station metadata locally. No imported file is executed or uploaded. */
(function () {
  'use strict';
  const limit = 24 * 1024 * 1024, expandedLimit = 64 * 1024 * 1024;
  const invalid = text => {throw new Error(text);};
  const clean = value => String(value ?? '').trim();
  const year = value => /^\d{4}(?:[-/].*)?$/.test(clean(value)) ? Number(clean(value).slice(0,4)) : null;
  const coordinate = (value,max) => {
    const text=clean(value).replace(',','.');
    const v=/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)?Number(text):NaN;
    return Number.isFinite(v)&&Math.abs(v)<=max?v:null;
  };
  const xml = content => {
    const doc=new DOMParser().parseFromString(content,'application/xml');
    if(doc.querySelector('parsererror'))invalid('The workbook contains unreadable XML.');
    return doc;
  };
  // Official XLSX catalogues store only the relevant worksheets and, optionally,
  // a shared-string table. Read these named ZIP members and cap expanded bytes.
  async function workbook(file) {
    const bytes=new Uint8Array(await file.arrayBuffer()), dv=new DataView(bytes.buffer);
    const u16=i=>dv.getUint16(i,true),u32=i=>dv.getUint32(i,true), text=new TextDecoder();
    let e=bytes.length-22;
    while(e>=Math.max(0,bytes.length-65557)&&u32(e)!==0x06054b50)e--;
    if(e<0||u32(e)!==0x06054b50)invalid('Choose an unencrypted .xlsx workbook or a CSV export.');
    const files=new Map();
    let cursor=u32(e+16), remaining=expandedLimit;
    for(let n=0;n<u16(e+10);n++) {
      if(u32(cursor)!==0x02014b50)invalid('The workbook ZIP directory is invalid.');
      const namesize=u16(cursor+28), name=text.decode(bytes.subarray(cursor+46,cursor+46+namesize));
      if(/^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(name))
        files.set(name,{offset:u32(cursor+42),method:u16(cursor+10),packed:u32(cursor+20),length:u32(cursor+24)});
      cursor+=46+namesize+u16(cursor+30)+u16(cursor+32);
    }
    async function extract(entry) {
      const {offset,method,packed,length}=entry;
      if(length>remaining||u32(offset)!==0x04034b50)invalid('This workbook is too large or unreadable. Export the station sheet as CSV.');
      const from=offset+30+u16(offset+26)+u16(offset+28);
      if(from+packed>bytes.length||![0,8].includes(method))invalid('Unsupported workbook compression. Export the station sheet as CSV.');
      let stream=new Blob([bytes.subarray(from,from+packed)]).stream();
      if(method===8)stream=stream.pipeThrough(new DecompressionStream('deflate-raw'));
      const reader=stream.getReader(), decoder=new TextDecoder(), parts=[];
      let size=0;
      for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;
        if(size>length){await reader.cancel();invalid('The expanded workbook exceeds its declared size.');}
        parts.push(decoder.decode(value,{stream:true}));
      }
      if(size!==length)invalid('A compressed worksheet is incomplete.');
      remaining-=size;parts.push(decoder.decode());return xml(parts.join(''));
    }
    const entry=files.get('xl/sharedStrings.xml');
    const strings=entry?Array.from((await extract(entry)).getElementsByTagName('si'),el=>el.textContent):[];
    for(const [name,info] of files){
      if(!name.startsWith('xl/worksheets/'))continue;
      const rows=[];
      for(const row of (await extract(info)).getElementsByTagName('row')){
        const values=[];
        for(const cell of row.getElementsByTagName('c')){
          const ref=cell.getAttribute('r')?.match(/^[A-Z]+/)?.[0];if(!ref)continue;
          const col=Array.from(ref).reduce((sum,c)=>sum*26+c.charCodeAt(0)-64,0)-1;
          if(col>255)continue;
          const value=cell.getElementsByTagName('v')[0]?.textContent;
          const type=cell.getAttribute('t');
          values[col]=type==='s'?strings[Number(value)]:type==='inlineStr'?cell.getElementsByTagName('is')[0]?.textContent:value;
        }
        rows.push(values);
      }
      const parsed=table(rows);if(parsed)return parsed;
    }
    invalid('The workbook has no station sheet with a GRDC number, latitude and longitude.');
  }
  function csvRows(text) {
    const line=text.split(/\r?\n/,1)[0], separator=['\t',';',','].sort((a,b)=>line.split(b).length-line.split(a).length)[0];
    const rows=[];let row=[],value='',quoted=false;
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
      else if(!quoted&&(c===separator||c==='\n'||c==='\r')){
        row.push(value);value='';
        if(c!==separator){rows.push(row);row=[];if(c==='\r'&&text[i+1]==='\n')i++;}
      }else value+=c;
    }
    if(quoted)invalid('The catalogue CSV contains an unclosed quoted field.');
    row.push(value);rows.push(row);return rows;
  }
  function table(rows) {
    const names=values=>values.map(v=>clean(v).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,''));
    let indices, header=-1;
    for(let i=0;i<Math.min(rows.length,50);i++){
      const cols=names(rows[i]), col=(...keys)=>keys.map(k=>cols.indexOf(k)).find(n=>n>=0)??-1;
      indices={id:col('grdc_no','station_no','station_number','grdc_number','grdc_station_number','grdc_station_no','grdc_nr'),lat:col('lat','latitude','station_latitude'),lon:col('long','lon','longitude','station_longitude'),
        name:col('station','station_name'),river:col('river','river_name'),d0:col('d_start'),d1:col('d_end'),m0:col('m_start'),m1:col('m_end'),t0:col('t_start','start_year'),t1:col('t_end','end_year')};
      if(indices.id>=0&&indices.lat>=0&&indices.lon>=0){header=i;break;}
    }
    if(header<0)return null;
    const stations=[], seen=new Set();let skipped=0;
    for(const values of rows.slice(header+1)){
      if(!values.some(v=>clean(v)))continue;
      const get=key=>clean(values[indices[key]]),id=get('id'),lat=coordinate(get('lat'),90),lon=coordinate(get('lon'),180);
      if(!/^\d+$/.test(id)||lat===null||lon===null){skipped++;continue;}
      if(seen.has(id))continue;seen.add(id);
      const periods=[];
      for(const [kind,a,b] of [['Daily','d0','d1'],['Monthly','m0','m1'],['Record','t0','t1']]){
        if(kind==='Record'&&periods.length)break;
        const start=year(get(a)),end=year(get(b));
        if((start||end)&&!(start&&end&&end<start))periods.push({kind,start,end});
      }
      stations.push({id,lat,lon,name:get('name'),river:get('river'),periods});
    }
    return {stations,skipped};
  }
  function stationMap(text) {
    // Match only inert JSON. Never insert provider HTML or its scripts into the DOM.
    for(const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)){
      if(!/\btype\s*=\s*["']application\/json["']/i.test(match[1]))continue;
      let calls;
      try{calls=JSON.parse(match[2]).x?.calls;}catch{continue;}
      if(!Array.isArray(calls))continue;
      const layers=calls.filter(c=>c.method==='addCircleMarkers'), group=layers.find(c=>c.args?.[4]==='All');
      const legend=calls.find(c=>c.method==='addLegend'&&/time series end/i.test(c.args?.[0]?.title))?.args?.[0];
      if(!group||!legend)continue;
      const periods=new Map((legend.colors||[]).map((c,i)=>[c,String(legend.labels[i]).match(/\d{4}/g)]));
      const entries=new Map();let skipped=0;
      for(const layer of [group,...layers.filter(c=>['Daily','Monthly'].includes(c.args?.[4]))]){
        const [lats,lons,,,kind,style,,,ids]=layer.args;
        if(!Array.isArray(ids)||ids.length!==lats.length||lons.length!==lats.length)invalid('The station map has mismatched coordinate and ID arrays.');
        for(let i=0;i<ids.length;i++){
          const id=String(ids[i]).match(/^GRDC Station Nr:\s*(\d+)$/i)?.[1],lat=coordinate(lats[i],90),lon=coordinate(lons[i],180);
          if(!id||lat===null||lon===null){if(kind==='All')skipped++;continue;}
          if(kind==='All'){if(!entries.has(id))entries.set(id,{id,lat,lon,name:'',river:'',periods:[]});}
          const station=entries.get(id),bin=periods.get(style?.fillColor?.[i]);
          if(station&&bin?.length===2)station.periods.push({kind:kind==='All'?'Record':kind,endBand:bin.join('–'),end:Number(bin[1])});
        }
      }
      return {stations:[...entries.values()],skipped};
    }
    invalid('Choose the saved GRDC Station Maps HTML or a station catalogue workbook/CSV.');
  }
  async function read(file) {
    if(!file.size||file.size>limit)invalid('Choose a nonempty catalogue file up to 24 MB.');
    let decoded;
    if(/\.xlsx$/i.test(file.name)){
      try{decoded=await workbook(file);}
      catch(e){if(e instanceof RangeError||e instanceof TypeError)invalid('This workbook is unreadable. Export the station sheet as CSV.');throw e;}
    }
    else {
      const content=(await file.text()).replace(/^\uFEFF/,'');
      decoded=/^\s*</.test(content)?stationMap(content):table(csvRows(content));
    }
    if(!decoded?.stations.length)invalid('No valid GRDC stations found. Check the station numbers and geographic coordinates.');
    return {...decoded,name:file.name};
  }
  function match(catalogue,query,geometry) {
    const boxes=geometry.searchBoxes(query), start=Number(query.start.slice(0,4)),end=Number(query.end.slice(0,4));
    const stations=[];
    for(const s of catalogue.stations){
      const x=s.lon,y=s.lat;
      if(!boxes.some(b=>y>=b[1]&&y<=b[3]&&(Math.abs(y)===90||x>=b[0]&&x<=b[2]||Math.abs(x)===180&&-x>=b[0]&&-x<=b[2])))continue;
      const position=geometry.classify(query,s);
      if(!position.included)continue;
      const dateState=s.periods.some(p=>p.start&&p.end&&p.start<=end&&p.end>=start)?'Year ranges overlap':
        s.periods.length&&s.periods.every(p=>p.start&&p.start>end||p.end&&p.end<start)?'Outside project years':'Check dates';
      stations.push({...s,...position,dateState});
    }
    const rank={'Year ranges overlap':0,'Check dates':1,'Outside project years':2};
    return stations.sort((a,b)=>rank[a.dateState]-rank[b.dateState]||a.distanceKm-b.distanceKm||a.id.localeCompare(b.id));
  }
  const api={read,match};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else window.GrdcCatalogue=api;
})();
