/* NOAA Open Data fallback for bounded GHCN-Daily station previews. */
(function (root) {
  'use strict';
  const bucket = 'https://noaa-ghcn-pds.s3.amazonaws.com/';
  const fields = ['ID','DATE','DATA_VALUE','M_FLAG','Q_FLAG','S_FLAG','OBS_TIME'];
  const units = {TMAX:10, TMIN:10, PRCP:10, MDPR:10, SNOW:1, MDSF:1, DAPR:1, DASF:1};
  const header = 'ID,DATE,ELEMENT,DATA_VALUE,M_FLAG,Q_FLAG,S_FLAG,OBS_TIME';
  const MiB = 1024 * 1024;
  function fail(message, code = 'ARCHIVE_SCHEMA') { throw Object.assign(new Error(message), {code}); }
  function stationUrl(id) {
    if (!/^[A-Z0-9_]{11}$/.test(id)) fail('Invalid NOAA station ID.', 'INPUT');
    return bucket + 'csv.gz/by_station/' + id + '.csv.gz';
  }
  async function readBytes(stream, limit) {
    const reader = stream.getReader(), parts = [];
    let size = 0;
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {await reader.cancel(); fail('NOAA archive exceeds the preview size limit.', 'ARCHIVE_SIZE');}
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {bytes.set(part,offset); offset += part.length;}
    return bytes;
  }
  function appendRow(rows, id, first, last, cells) {
    const [station,day,element,raw,m,q,s,time] = cells;
    if (station !== id || cells.length !== 8 || !/^\d{8}$/.test(day))
      fail('Unexpected station or row format in the NOAA archive.');
    if (day < first || day > last || !Object.hasOwn(units,element)) return;
    const date = day.slice(0,4)+'-'+day.slice(4,6)+'-'+day.slice(6);
    if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) ||
        ![m,q,s].every(v=>/^[\x21-\x7e]?$/.test(v)) || !/^(?:\d{4})?$/.test(time) ||
        !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date)
      fail('Unreadable observation or flag in the NOAA archive.');
    if (!rows.has(date)) rows.set(date,{STATION:id, DATE:date});
    const row = rows.get(date);
    if (Object.hasOwn(row,element)) fail('NOAA archive repeats a station, date and element.');
    row[element] = Number(raw) === -9999 ? -9999 : Number(raw)/units[element];
    row[element+'_ATTRIBUTES'] = [m,q,s,time].join(',');
    return true;
  }
  function forEachLine(text, callback) {
    let start = 0;
    while (start < text.length) {
      const end = text.indexOf('\n',start), line = text.slice(start,end<0?text.length:end).replace(/\r$/,'');
      if (line) callback(line);
      if (end < 0) break;
      start = end+1;
    }
  }
  function stationCsv(bytes,id,first,last) {
    // NOAA concatenates gzip members for long records. Check each member's CRC and length.
    const gzip=root.pako || require('../vendor/pako-inflate.min.js');
    const inflater=new gzip.Inflate({windowBits:31}), decoder=new TextDecoder('utf-8',{fatal:true});
    const rows=new Map(), selectedLines=[header];
    let stationRows=0, size=0, remainder='';
    const consume=line=>{
      if (line===header) return;
      stationRows++;
      if (appendRow(rows,id,first,last,line.split(','))) selectedLines.push(line);
    };
    inflater.onData=chunk=>{
      size+=chunk.length;
      if (size>64*MiB) fail('NOAA archive exceeds the preview size limit.','ARCHIVE_SIZE');
      const text=remainder+decoder.decode(chunk,{stream:true}), end=text.lastIndexOf('\n')+1;
      forEachLine(text.slice(0,end),consume);
      remainder=text.slice(end);
    };
    inflater.push(bytes,true);
    if (inflater.err || !inflater.ended) fail('NOAA returned an incomplete or unreadable compressed station archive.');
    forEachLine(remainder+decoder.decode(),consume);
    if (!stationRows) fail('NOAA returned an empty station archive file.');
    return {rows:[...rows.values()],previewCsv:selectedLines.join('\n')+'\n'};
  }
  async function read(station, window, options, requests) {
    const id = station.id, fileUrl = stationUrl(id), first = window.start.replace(/-/g,''), last = window.end.replace(/-/g,'');
    const control = new AbortController();
    const cancel = () => control.abort();
    if (options.signal?.aborted) throw new DOMException('Cancelled','AbortError');
    options.signal?.addEventListener('abort',cancel,{once:true});
    const timer = setTimeout(cancel,options.archiveTimeoutMs || 75000);
    const fetchFile = (url, headers = {}) => (options.fetchImpl || root.fetch)(url,{headers,signal:control.signal,credentials:'omit',redirect:'error'});
    const receipt = (url,response) => ({url,httpStatus:response.status,retrievedAt:new Date().toISOString(),
      lastModified:response.headers.get('last-modified'),etag:response.headers.get('etag')});
    try {
      let response;
      try {response = await fetchFile(fileUrl);} catch (e) {if (e.name==='AbortError') throw e;}
      if (response?.ok) {
        const entry = receipt(fileUrl,response);
        requests.push(entry);
        const modified = Date.parse(entry.lastModified);
        if (Number.isFinite(modified) && new Date(modified).toISOString().slice(0,10) >= window.end &&
            Number(response.headers.get('content-length')) <= 8*MiB) {
          try {
            const bytes = await readBytes(response.body,8*MiB);
            const selected = stationCsv(bytes,id,first,last);
            entry.bytes = bytes.length;
            return {...selected, rawBytes:bytes, rawFormat:'csv.gz', rawMime:'application/gzip',
              observationSource:'NOAA GHCN-Daily station archive', sourceUrls:[fileUrl]};
          } catch (error) {
            if (error.code!=='ARCHIVE_SIZE') throw error;
            entry.outcome = error.message;
          }
        } else {
          entry.outcome = 'Used annual records to check coverage through the end of the preview.';
          await response.body?.cancel();
        }
      } else {
        requests.push({url:fileUrl,retrievedAt:new Date().toISOString(),httpStatus:response?.status ?? null,outcome:'Station archive unavailable'});
        if (response?.status===429) fail('NOAA archive rate limit reached. Retry later.', 'HTTP_429');
      }
      options.onAnnualArchive?.();
      return await readAnnual(id,first,last,fetchFile,requests,receipt);
    } catch (error) {
      if (control.signal.aborted) {
        if (options.signal?.aborted) throw new DOMException('Cancelled','AbortError');
        fail('NOAA archive timed out. Retry the station preview.', 'TIMEOUT');
      }
      throw error;
    } finally {
      control.abort(); clearTimeout(timer); options.signal?.removeEventListener('abort',cancel);
    }
  }
  // The station snapshots and annual snapshots can have different publication dates.
  // Use each annual partition's own Parquet date statistics, independent of file order.
  async function readAnnual(id, first, last, fetchFile, requests, receipt) {
    const parquet = root.GHCNParquet || (typeof require==='function' && require('../vendor/hyparquet-ghcn.min.js'));
    const files = [], sourceUrls = [], listingUrls = [], cells = [], rows = new Map();
    for (let year=Number(first.slice(0,4)); year<=Number(last.slice(0,4)); year++) {
      const prefix = 'parquet/by_year/YEAR='+year+'/';
      const countBefore = files.length;
      let token = '';
      const seen = new Set();
      do {
        const url = new URL(bucket);
        url.searchParams.set('list-type','2'); url.searchParams.set('prefix',prefix);
        if (token) url.searchParams.set('continuation-token',token);
        const response = await fetchFile(url.href);
        if (!response.ok) fail('NOAA annual archive listing is unavailable (HTTP '+response.status+').','ARCHIVE_ACCESS');
        const doc = await response.text();
        const value = (xml,key) => xml.match(new RegExp('<'+key+'>([^<]*)</'+key+'>'))?.[1].replaceAll('&quot;','"').replaceAll('&amp;','&');
        const items = Array.from(doc.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g),m=>m[1]);
        const truncated = value(doc,'IsTruncated');
        if (!/<ListBucketResult\b/.test(doc) || !doc.trimEnd().endsWith('</ListBucketResult>') ||
            value(doc,'Name')!=='noaa-ghcn-pds' || value(doc,'Prefix')!==prefix || Number(value(doc,'KeyCount'))!==items.length || !['true','false'].includes(truncated))
          fail('NOAA annual archive returned an incomplete listing.');
        requests.push(receipt(url.href,response)); listingUrls.push(url.href);
        for (const item of items) {
          const key = value(item,'Key') || '';
          if (!key.startsWith(prefix)) fail('NOAA returned an unexpected annual archive key.');
          const parts = key.slice(prefix.length).split('/');
          const element = parts[0].replace(/^ELEMENT=/,'');
          if (!Object.hasOwn(units,element) || !parts[1]) continue;
          if (parts.length!==2 || !/^[\w.-]+\.parquet$/.test(parts[1])) fail('Unexpected NOAA annual archive filename.');
          const size = Number(value(item,'Size')), etag = value(item,'ETag');
          if (!Number.isSafeInteger(size) || size<8 || size>32*MiB || !etag) fail('Invalid NOAA annual archive object metadata.');
          files.push({url:bucket+key,size,etag,element});
        }
        token = truncated==='true' ? value(doc,'NextContinuationToken') : '';
        if (truncated==='true' && (!token || seen.has(token))) fail('NOAA annual archive listing could not be completed.');
        seen.add(token);
      } while (token);
      if (files.length===countBefore) fail('No NOAA annual archive files were listed for '+year+'.','ARCHIVE_ACCESS');
    }
    async function bytesFor(file,start,end) {
      const whole = start===0 && end===file.size;
      const response = await fetchFile(file.url,whole?{}:{Range:'bytes='+start+'-'+(end-1)});
      if ((whole ? response.status!==200 : response.status!==206) || response.headers.get('etag')!==file.etag) {
        await response.body?.cancel(); fail('NOAA annual archive changed or could not be read. Retry the preview.','ARCHIVE_ACCESS');
      }
      const bytes = await readBytes(response.body,end-start);
      if (bytes.length!==end-start) fail('NOAA annual archive returned an incomplete file.');
      return bytes;
    }
    // Read a few small footers at a time. Decode full matching files one at a time.
    for (let start=0; start<files.length; start+=6) {
      const matches = await Promise.all(files.slice(start,start+6).map(async file=>{
        const meta = await parquet.parquetMetadataAsync({byteLength:file.size,
          slice:async(a,b)=>(await bytesFor(file,a,b)).buffer},{initialFetchSize:4096});
        const overlaps = meta.row_groups.some(group=>{
          const date = group.columns.find(c=>c.meta_data.path_in_schema[0]==='DATE');
          if (!date) fail('NOAA annual archive is missing its date column.');
          const s = date.meta_data.statistics;
          return !(s?.min_value>last || s?.max_value<first);
        });
        return overlaps ? {file,meta} : null;
      }));
      for (const item of matches.filter(Boolean)) {
        const {file,meta} = item, bytes = await bytesFor(file,0,file.size), chunks = new Map();
        await parquet.parquetRead({file:bytes.buffer,metadata:meta,columns:fields,onChunk:part=>{
          if (!chunks.has(part.columnName)) chunks.set(part.columnName,[]);
          chunks.get(part.columnName).push(part);
        }});
        if (fields.some(key=>!chunks.has(key))) fail('NOAA annual archive is missing an observation column.');
        const at = (name,i)=>{
          const part = chunks.get(name).find(p=>p.rowStart<=i && i<p.rowEnd);
          if (!part) fail('NOAA annual archive has incomplete observation fields.');
          return String(part.columnData[i-part.rowStart] ?? '');
        };
        for (const part of chunks.get('ID')) {
          for (let i=0; i<part.columnData.length; i++) {
            if (part.columnData[i]!==id) continue;
            const index=part.rowStart+i, day=at('DATE',index);
            if (day<first || day>last) continue;
            const row=[id,day,file.element,...fields.slice(2).map(name=>at(name,index))];
            appendRow(rows,id,first,last,row); cells.push(row);
          }
        }
        const hash = root.crypto?.subtle && await root.crypto.subtle.digest('SHA-256',bytes);
        requests.push({url:file.url,retrievedAt:new Date().toISOString(),httpStatus:200,etag:file.etag,bytes:file.size,
          ...(hash?{sha256:Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')}:{})});
        sourceUrls.push(file.url);
      }
    }
    cells.sort((a,b)=>a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));
    const rawText = [header,...cells.map(row=>row.join(','))].join('\n')+'\n';
    return {rows:[...rows.values()],previewCsv:rawText,rawText,rawBytes:new TextEncoder().encode(rawText),rawMime:'text/csv',rawFormat:'csv',
      observationSource:'NOAA GHCN-Daily annual archive',sourceUrls,listingUrls};
  }
  const api = {read,stationUrl,stationCsv,units};
  root.SiteGhcnArchive = api;
  if (typeof module!=='undefined' && module.exports) module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
