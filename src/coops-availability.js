/* NOAA station inventory screening. Metadata overlap is not verified data coverage. */
(function (root) {
  'use strict';
  const DAY = 86400000, SLOT = 360000, LIMIT = 1048576;
  const INVENTORY_NS = 'https://opendap.co-ops.nos.noaa.gov/axis/webservices/datainventory/wsdl';
  const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
  const PRODUCTS = {'Preliminary 6-Minute Water Level': 'preliminary', 'Verified 6-Minute Water Level': 'verified'};
  function productSpec(station) {
    const id = station?.coopsProduct || 'water_level';
    if (!['water_level','hourly_height'].includes(id)) fail('Choose six-minute water levels or verified hourly heights.', 'INPUT');
    return id === 'hourly_height' ? {id,label:'Verified hourly heights',periodLabel:'hourly',cadenceMs:3600000,maxDays:365} : {id,label:'Six-minute water levels',periodLabel:'six-minute',cadenceMs:360000,maxDays:28};
  }
  const DATUM_NAMES = {CRD:'Columbia River Datum',IGLD:'International Great Lakes Datum',LWD:'Great Lakes Low Water Datum',MHHW:'Mean Higher High Water',MHW:'Mean High Water',MTL:'Mean Tide Level',MSL:'Mean Sea Level',MLW:'Mean Low Water',MLLW:'Mean Lower Low Water',NAVD:'North American Vertical Datum',STND:'Station Datum (station-specific reference)'};
  const DOCS = ['https://tidesandcurrents.noaa.gov/js/inventory.js', 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/', 'https://api.tidesandcurrents.noaa.gov/api/prod/', 'https://tidesandcurrents.noaa.gov/js/wlcgi.js?hash=123456'];
  const copy = value => JSON.parse(JSON.stringify(value));
  function fail(message, code = 'SCHEMA') {const error = new Error(message); error.code = code; throw error;}
  function validDate(value) {return typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0,10) === value;}
  function validateQuery(query) {if (!query || !validDate(query.start) || !validDate(query.end) || query.start > query.end) fail('Enter valid inclusive project dates.', 'INPUT');}
  function stationId(station) {if (!station || !/^\d{7}$/.test(station.id)) fail('A seven-digit NOAA station ID is required.', 'INPUT'); return station.id;}
  const metadataURL = id => 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/' + id + '.json?expand=details,datums&units=metric';
  const inventoryURL = id => 'https://opendap.co-ops.nos.noaa.gov/axis/webservices/datainventory/response.jsp?stationId=' + id + '&format=xml&Submit=Submit';
  function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/.test(value) || !validDate(value.slice(0,10))) fail('NOAA inventory contains an invalid or unknown period boundary.');
    return Date.parse(value.replace(' ', 'T') + ':00Z');
  }
  function entities(text) {
    let output = '', position = 0;
    const pattern = /&([^;]*);/g;
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(position, match.index); if (before.includes('&')) fail('Malformed XML entity.'); output += before;
      const named = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
      if (Object.hasOwn(named, match[1])) output += named[match[1]];
      else {
        const number = /^#x[0-9a-f]+$/i.test(match[1]) ? parseInt(match[1].slice(2),16) : /^#\d+$/.test(match[1]) ? Number(match[1].slice(1)) : NaN;
        if (!Number.isInteger(number) || !(number === 9 || number === 10 || number === 13 || number >= 32 && number <= 0xD7FF || number >= 0xE000 && number <= 0xFFFD || number >= 0x10000 && number <= 0x10FFFF)) fail('Unsupported XML entity.');
        output += String.fromCodePoint(number);
      }
      position = match.index + match[0].length;
    }
    const rest = text.slice(position); if (rest.includes('&')) fail('Malformed XML entity.'); return output + rest;
  }
  // A strict small XML reader for the observed SOAP inventory schema, shared by browser and Node.
  // No DTD, custom entities, CDATA, external resources, or error-page recovery is supported.
  function xmlTree(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > LIMIT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) fail('Empty, oversized or malformed XML inventory.');
    const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(?:(?:"[^"]*"|'[^']*'|[^'">])*)>|[^<]+/g;
    const stack = [], roots = []; let position = 0, declaration = false;
    for (const match of text.matchAll(tokens)) {
      if (match.index !== position) fail('Malformed XML inventory.'); position += match[0].length;
      const token = match[0];
      if (token.startsWith('<!--')) {if (token.slice(4,-3).includes('--')) fail('Malformed XML comment.'); continue;}
      if (token.startsWith('<?')) {if (declaration || roots.length || stack.length || !/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"[A-Za-z0-9._-]+"|'[A-Za-z0-9._-]+'))?\s*\?>$/.test(token)) fail('Unsupported XML processing instruction.'); declaration = true; continue;}
      if (!token.startsWith('<')) {const content = entities(token); if (!stack.length && content.trim()) fail('Text outside XML root.'); if (stack.length) stack.at(-1).text += content; continue;}
      if (token.startsWith('<!')) fail('DTD, entities and unsupported XML declarations are forbidden.');
      if (token.startsWith('</')) {if (!/^<\/[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?\s*>$/.test(token) || !stack.length || stack.pop().name !== token.slice(2,-1).trim()) fail('Mismatched XML closing tag.'); continue;}
      const selfClosing = token.endsWith('/>'), inner = token.slice(1,selfClosing ? -2 : -1);
      const nameMatch = /^([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)([\s\S]*)$/.exec(inner); if (!nameMatch) fail('Malformed XML element.');
      const attrs = {}, tail = nameMatch[2], attribute = /\s+([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)\s*=\s*("[^"<]*"|'[^'<]*')/y;
      let offset = 0;
      while (offset < tail.length && tail.slice(offset).trim()) {
        attribute.lastIndex = offset; const found = attribute.exec(tail);
        if (!found || Object.hasOwn(attrs,found[1])) fail('Malformed or repeated XML attribute.');
        attrs[found[1]] = entities(found[2].slice(1,-1)); offset = attribute.lastIndex;
      }
      const namespaces = {...(stack.at(-1)?.namespaces || {xml:'http://www.w3.org/XML/1998/namespace'})};
      for (const [name,value] of Object.entries(attrs)) {if (name === 'xmlns') namespaces[''] = value; else if (name.startsWith('xmlns:')) namespaces[name.slice(6)] = value;}
      const parts = nameMatch[1].split(':'), prefix = parts.length === 2 ? parts[0] : '';
      if (prefix && !namespaces[prefix]) fail('Undeclared XML namespace.');
      const expandedAttrs = new Set();
      for (const name of Object.keys(attrs).filter(name => name !== 'xmlns' && !name.startsWith('xmlns:'))) {
        const bits = name.split(':'), ns = bits.length === 2 ? namespaces[bits[0]] : '';
        if (bits.length === 2 && !ns) fail('Undeclared XML attribute namespace.');
        const key = ns + '|' + bits.at(-1); if (expandedAttrs.has(key)) fail('Repeated expanded XML attribute.'); expandedAttrs.add(key);
      }
      const node = {name:nameMatch[1],local:parts.at(-1),ns:namespaces[prefix] || '',attrs,namespaces,children:[],text:''};
      if (stack.length) stack.at(-1).children.push(node); else roots.push(node);
      if (!selfClosing) stack.push(node);
      if (stack.length > 30 || roots.length > 1) fail('Unexpected XML nesting or multiple roots.');
    }
    if (position !== text.length || stack.length || roots.length !== 1) fail('Incomplete XML inventory.'); return roots[0];
  }
  function one(parent, local, ns) {const found = parent.children.filter(node => node.local === local && node.ns === ns); if (found.length !== 1) fail('Unexpected NOAA inventory structure.'); return found[0];}
  function parseInventory(text, id) {
    const envelope = xmlTree(text);
    if (envelope.local !== 'Envelope' || envelope.ns !== SOAP_NS) fail('NOAA inventory is not the expected SOAP envelope.');
    const body = one(envelope,'Body',SOAP_NS);
    const fault = body.children.find(node => node.local === 'Fault' && node.ns === SOAP_NS);
    if (fault) {
      const code = fault.children.find(node => node.local === 'faultcode')?.text.trim().split(':').at(-1);
      const reason = (fault.children.find(node => node.local === 'faultstring')?.text || 'No reason supplied').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,280);
      fail('NOAA inventory service fault: ' + reason, /^Server(?:\.|$)/.test(code || '') ? 'SOAP_SERVER_FAULT' : 'SOAP_FAULT');
    }
    const inventory = one(body,'DataInventory',INVENTORY_NS), station = one(inventory,'station',INVENTORY_NS);
    if ([envelope,body,inventory,station].some(node => node.text.trim()) || body.children.length !== 1 || inventory.children.length !== 1 || station.children.some(node => !['metadata','parameter'].includes(node.local) || node.ns !== INVENTORY_NS)) fail('Unexpected NOAA inventory elements or namespace.');
    if (station.attrs.ID !== id) fail('NOAA inventory returned a different station.');
    const parameters = station.children.filter(node => node.local === 'parameter' && node.ns === INVENTORY_NS);
    if (!parameters.length) fail('The inventory contains no product rows; absence of observations cannot be inferred.');
    const periods = [], hourlyPeriods = [], listedProducts = [];
    for (const node of parameters) {
      const {name,first,last} = node.attrs;
      if (!name || !name.trim() || node.children.length || node.text.trim()) fail('Malformed NOAA inventory product row.');
      if (!Object.hasOwn(PRODUCTS,name) && /(?:6|six)/i.test(name) && /min/i.test(name) && /water|level/i.test(name)) fail('Unrecognized six-minute inventory product name; coverage cannot be inferred.');
      const start = timestamp(first), end = timestamp(last); if (start > end) fail('NOAA inventory period is reversed.');
      listedProducts.push(name);
      const period = {product:name,kind:PRODUCTS[name] || 'verified',start:first.slice(0,10),end:last.slice(0,10),first,last,startTime:new Date(start).toISOString(),endTime:new Date(end).toISOString()};
      if (Object.hasOwn(PRODUCTS,name)) periods.push(period);
      if (name === 'Verified Hourly Height Water Level') hourlyPeriods.push(period);
    }
    return {periods,hourlyPeriods,listedProducts:[...new Set(listedProducts)]};
  }
  function parseMetadata(data, id) {
    if (!data || data.count !== 1 || !Array.isArray(data.stations) || data.stations.length !== 1 || data.stations[0]?.id !== id) fail('NOAA station details are missing or identify another station.');
    const station = data.stations[0]; if (typeof station.greatlakes !== 'boolean') fail('NOAA Great Lakes classification is missing or malformed.');
    if (station.details != null && (typeof station.details !== 'object' || Array.isArray(station.details) || station.details.id != null && station.details.id !== id)) fail('NOAA expanded station details are malformed or identify another station.');
    const collection = station.datums, rows = collection?.datums;
    if (rows != null && (!Array.isArray(rows) || rows.some(row => !row || typeof row.name !== 'string' || !row.name || typeof row.value !== 'number' || !Number.isFinite(row.value)))) fail('NOAA datum metadata is malformed.');
    const availableDatums = [], add = (code,basis,sourceName) => {if (!availableDatums.some(d => d.code === code)) availableDatums.push({code,label:DATUM_NAMES[code],basis,...(sourceName ? {sourceName} : {})});};
    for (const row of rows || []) {
      const code = ({NAVD88:'NAVD',CRD_OFFSET:'CRD',GL_LWD:'LWD'})[row.name] || row.name;
      if (Object.hasOwn(DATUM_NAMES,code) && (station.greatlakes || !['IGLD','LWD'].includes(code))) add(code,'NOAA station datum table',row.name);
    }
    if (station.greatlakes) {add('IGLD','NOAA documented Great Lakes request datum'); add('LWD','NOAA documented Great Lakes request datum');}
    else add('STND','NOAA water-level interface offers this station-specific reference');
    const datumReviewRequired = id === '9063075';
    return {greatlakes:station.greatlakes,stationDetails:copy(station.details || {}),availableDatums:datumReviewRequired ? [] : availableDatums,
      datumTableStatus:Array.isArray(rows) && rows.length ? 'listed' : 'unresolved',datumMetadata:{epoch:collection?.epoch ?? null,units:collection?.units ?? null,accepted:collection?.accepted ?? null,sourceNames:(rows || []).map(row => row.name)},
      datumReviewRequired,datumNote:datumReviewRequired ? 'NOAA identifies Old Woman Creek (9063075) water levels as NAVD88, not IGLD85. The Great Lakes flag does not establish the request datum here; review with NOAA before retrieval.' : 'Datum options follow NOAA metadata and its own water-level interface. They do not establish actual observations, datum equivalence or epoch compatibility.'};
  }
  function mergedIntervals(periods, slot = SLOT) {
    const merged = [];
    for (const period of periods.map(p => ({start:timestamp(p.first),end:timestamp(p.last)})).sort((a,b) => a.start-b.start || a.end-b.end)) {
      const previous = merged.at(-1); if (previous && period.start <= previous.end + slot) previous.end = Math.max(previous.end,period.end); else merged.push({...period});
    }
    return merged;
  }
  function initial(station, query) {
    const explicitDatum = station.coopsAvailability?.explicitDatum;
    return {schemaVersion:1,stationId:station.id,state:'unchecked',label:'Availability not checked',message:'Selected water-level product, period and datum metadata have not been checked.',query:{start:query.start,end:query.end},periods:[],hourlyPeriods:[],listedProducts:[],availableDatums:[],defaultDatum:station.greatlakes === true ? 'IGLD' : 'MSL',selectedDatum:null,tryDatum:null,selectionMode:null,...(typeof explicitDatum === 'string' && Object.hasOwn(DATUM_NAMES,explicitDatum) ? {explicitDatum} : {}),canTryPreview:false,inventoryStatus:'unchecked',metadataStatus:'unchecked',datumTableStatus:'unresolved',requests:[],checkedAt:null,errors:[],inventoryUrl:'https://tidesandcurrents.noaa.gov/inventory.html?id=' + station.id,documentation:DOCS};
  }
  function assessCoopsStation(station, query, datum) {
    validateQuery(query); stationId(station);
    const spec = productSpec(station), SLOT = spec.cadenceMs;
    const original = station.coopsAvailability;
    if (!original || original.schemaVersion !== 1 || original.stationId !== station.id) return initial(station,query);
    const a = copy(original); a.query = {start:query.start,end:query.end}; a.defaultDatum = (typeof a.greatlakes === 'boolean' ? a.greatlakes : station.greatlakes) === true ? 'IGLD' : 'MSL';
    if (datum !== undefined) {if (datum !== null && (typeof datum !== 'string' || !Object.hasOwn(DATUM_NAMES,datum))) fail('Choose a supported NOAA datum code.', 'INPUT'); a.explicitDatum = datum;}
    const selected = a.explicitDatum || a.defaultDatum, supported = a.availableDatums.some(item => item.code === selected);
    a.selectedDatum = supported ? selected : null; a.selectionMode = a.explicitDatum ? 'explicit' : 'default'; a.tryDatum = selected; a.canTryPreview = false;
    const periods = spec.id === 'hourly_height' ? (a.hourlyPeriods || []) : a.periods;
    a.product = spec.id; a.productLabel = spec.label; a.selectedPeriods = periods; a.cadenceMs = SLOT;
    const otherPeriods = spec.id === 'hourly_height' ? a.periods : (a.hourlyPeriods || []);
    a.alternativeProduct = a.inventoryStatus === 'ok' && otherPeriods.some(p => p.start <= query.end && p.end >= query.start) ?
      {id:spec.id === 'hourly_height' ? 'water_level' : 'hourly_height',label:spec.id === 'hourly_height' ? 'Six-minute water levels' : 'Hourly heights',url:a.inventoryUrl} : null;
    const finish = (state,label,message) => Object.assign(a,{state,label,message:message + (a.alternativeProduct ? ' ' + a.alternativeProduct.label + ' are also listed for these dates; select that product explicitly to inspect its intervals.' : '')});
    if (a.inventoryStatus === 'unchecked' && a.metadataStatus === 'unchecked') return finish('unchecked','Availability not checked','Selected water-level product, period and datum metadata have not been checked.');
    if (a.inventoryStatus === 'ok' && !periods.length) return finish('product_not_listed',spec.label + ' not listed','The station inventory lists ' + a.listedProducts.join(', ') + ', but no ' + spec.periodLabel + ' water-level product. This is not evidence of no observations in other products or archives.');
    if (a.datumReviewRequired || station.id === '9063075') return finish('datum_required','Station-specific datum review required',a.datumNote || 'NOAA identifies this station as a special datum case; the generic Great Lakes default cannot be assumed.');
    if (!supported && a.metadataStatus === 'ok' && a.datumTableStatus === 'listed') return finish('datum_required','Choose a supported datum',selected + ' is not established by the reviewed station datum options. Choose an explicitly listed alternative; no datum is substituted automatically.');
    if (a.explicitDatum && !supported) return finish('datum_required','Chosen datum unverified','The explicitly chosen datum is not supported by the retained metadata. Review the available datum options.');
    const start = Date.parse(query.start + 'T00:00:00Z'), end = Date.parse(query.end + 'T00:00:00Z') + DAY-SLOT;
    const intervals = a.inventoryStatus === 'ok' ? mergedIntervals(periods,SLOT) : [], overlap = intervals.filter(p => p.start <= end && p.end >= start);
    if (intervals.length && !overlap.length) {
      const removed = a.stationDetails?.removed;
      const removedTime = typeof removed === 'string' && validDate(removed.slice(0,10)) && /^\d{4}-\d{2}-\d{2} [0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?$/.test(removed) ? Date.parse(removed.replace(' ','T') + 'Z') : NaN;
      const knownClosed = Number.isFinite(removedTime) && removedTime >= intervals.at(-1).end && removedTime < start && !station.listTypes?.includes('waterlevels');
      if (start > intervals.at(-1).end && !knownClosed) {a.canTryPreview = spec.id !== 'hourly_height'; return finish('unresolved','Recent availability unresolved',spec.id==='hourly_height' ? 'The requested dates are after the latest verified hourly heights. Refresh the inventory or choose six-minute water levels for recent dates; an hourly preview is not offered until a verified period is listed.' : 'The requested dates are after the latest listed '+spec.periodLabel+' timestamp. Refresh the inventory or explicitly try an unverified preview using '+selected+'.');}
      return finish('outside_period','Outside listed ' + spec.periodLabel + ' periods','The requested dates do not overlap the listed ' + spec.periodLabel + ' observation intervals. Station installation/removal dates are not used as observation-period boundaries.');
    }
    if (a.inventoryStatus !== 'ok' || a.metadataStatus !== 'ok' || !supported) {
      a.canTryPreview = !a.datumReviewRequired && station.id !== '9063075' && !(spec.id==='hourly_height' && query.end>=new Date().toISOString().slice(0,7)+'-01');
      return finish('unresolved','Availability unresolved','The product/period or default-datum metadata could not be established. Retry the metadata check or deliberately attempt an unverified preview using ' + selected + '; that attempt is not evidence of availability.');
    }
    const full = overlap.some(p => p.start <= start && p.end >= end);
    return finish(full ? 'match' : 'partial',full ? 'Dates match' : 'Dates partly match',full ? 'The listed ' + spec.periodLabel + ' intervals span the requested period and a request datum is identified. Internal gaps, quality and actual returned observations remain unverified.' : 'Only part of the project period overlaps listed ' + spec.periodLabel + ' intervals. The preview uses the first overlapping interval; project dates remain unchanged and gaps are not bridged.');
  }
  function previewWindow(station, query, options = {}) {
    const spec = productSpec(station), SLOT = spec.cadenceMs;
    const a = assessCoopsStation(station,query), ordinary = ['match','partial'].includes(a.state), unverified = !ordinary && options.allowUnverified === true && a.canTryPreview === true;
    const base = {available:ordinary || unverified,requestedStart:query.start,requestedEnd:query.end,maxDays:28,product:spec.id,cadenceMs:SLOT,shifted:false,basis:'coops_inventory',coverageStatus:a.state,unverifiedMetadata:unverified,notes:[a.message]};
    if (!base.available) return {start:null,end:null,...base};
    const qStart = Date.parse(query.start + 'T00:00:00Z'), qEnd = Date.parse(query.end + 'T00:00:00Z') + DAY-SLOT;
    const intervals = a.inventoryStatus === 'ok' ? mergedIntervals(a.selectedPeriods,SLOT) : [{start:qStart,end:qEnd}];
    const first = intervals.map(p => ({start:Math.max(qStart,p.start),end:Math.min(qEnd,p.end)})).find(p => p.start <= p.end) || (unverified ? {start:qStart,end:qEnd} : null);
    if (!first) return {start:null,end:null,...base,available:false,notes:['No overlapping preview interval could be prepared.']};
    first.end = Math.min(first.end,Math.floor(first.start/DAY)*DAY + 28*DAY-SLOT);
    const startTime = new Date(first.start).toISOString(), endTime = new Date(first.end).toISOString(); base.shifted = first.start !== qStart;
    base.notes.push('Preview request: ' + startTime.replace('T',' ').replace('.000Z',' UTC') + ' to ' + endTime.replace('T',' ').replace('.000Z',' UTC') + '. Original project dates are retained. Inventory first/last timestamps do not verify continuity or data quality.');
    if (unverified) base.notes.push('The user explicitly requested an unverified metadata attempt using ' + a.tryDatum + '. No alternate datum was selected automatically.');
    return {start:startTime.slice(0,10),end:endTime.slice(0,10),startTime,endTime,datum:ordinary ? a.selectedDatum : a.tryDatum,...base};
  }
  async function checkCoopsStations(stations, query, options = {}) {
    validateQuery(query); if (!Array.isArray(stations)) fail('Expected a station candidate array.', 'INPUT');
    const spacing = options.requestSpacingMs ?? 250; if (!Number.isFinite(spacing) || spacing < 0 || spacing > 5000) fail('Invalid metadata request spacing.', 'INPUT');
    const retryDelay = options.retryDelayMs ?? 750; if (!Number.isFinite(retryDelay) || retryDelay < 0 || retryDelay > 10000) fail('Invalid metadata retry delay.', 'INPUT');
    let completed = 0, next = 0, nextStart = 0, rateLimited = false;
    const output = stations.map(station => {
      const retained = copy(station), old = station.coopsAvailability;
      if (!options.forceRefresh && old?.schemaVersion === 1 && ['match','partial','outside_period','product_not_listed','datum_required'].includes(old.state) && old.stationId === station.id && old.query?.start === query.start && old.query?.end === query.end && old.inventoryStatus === 'ok' && old.metadataStatus === 'ok' && !(old.errors || []).some(error => !error.recovered)) {retained.coopsAvailability = assessCoopsStation(retained,query); completed++;}
      else retained.coopsAvailability = initial(station,query);
      return retained;
    });
    const pending = output.map((s,i) => s.coopsAvailability.state === 'unchecked' ? i : -1).filter(i => i >= 0).slice(0,10);
    const snapshot = () => ({stations:[...output],completed,total:output.length,batchLimit:10,remaining:output.length-completed,complete:completed === output.length && !options.signal?.aborted && !rateLimited,cancelled:!!options.signal?.aborted,rateLimited,...(rateLimited ? {error:{code:'HTTP_429',message:'NOAA rate limited metadata checks. Loaded checks are retained; remaining candidates are unchecked. Wait before retrying.'}} : {})});
    const emit = () => {if (options.onProgress) options.onProgress(snapshot());};
    const aborted = () => {if (options.signal?.aborted) {const error = new Error('Availability check cancelled.'); error.name = 'AbortError'; throw error;} if (rateLimited) fail('Metadata queue stopped after a provider rate limit.', 'HTTP_429');};
    async function pause(ms) {
      aborted(); if (!ms) return;
      await new Promise((resolve,reject) => {const stop = () => {clearTimeout(timer); const e = new Error('Availability check cancelled.'); e.name = 'AbortError'; reject(e);}; const timer = setTimeout(() => {options.signal?.removeEventListener('abort',stop); resolve();},ms); options.signal?.addEventListener('abort',stop,{once:true});});
      aborted();
    }
    async function retainFailureBody(response, receipt) {
      const limit = 65536, reader = response.body?.getReader?.(); let text = '', bytes = 0, truncated = false;
      if (reader) {
        const decoder = new TextDecoder();
        try {
          while (true) {const item = await reader.read(); if (item.done) break; const keep = item.value.subarray(0,Math.max(0,limit-bytes)); text += decoder.decode(keep,{stream:true}); bytes += keep.length;
            if (keep.length < item.value.length || bytes === limit) {truncated = true; await reader.cancel(); break;}}
          text += decoder.decode();
        } finally {reader.releaseLock();}
      } else {const body = await response.text(); text = body.slice(0,limit); truncated = body.length > limit; bytes = new TextEncoder().encode(text).length;}
      Object.assign(receipt,{rawFailureText:text,rawFailureBytes:bytes,rawFailureTruncated:truncated,rawFailureEncoding:'Decoded UTF-8; bounded diagnostic response, not observation data'});
    }
    async function read(url, source, a, attempt) {
      const due = Math.max(Date.now(),nextStart); nextStart = due + spacing; await pause(Math.max(0,due-Date.now())); aborted();
      const controller = new AbortController(), abort = () => controller.abort(); let timedOut = false;
      const timer = setTimeout(() => {timedOut = true; controller.abort();},options.timeoutMs || 25000); options.signal?.addEventListener('abort',abort,{once:true});
      const receipt = {source,url,attempt,requestedAt:new Date().toISOString()}; a.requests.push(receipt);
      try {
        const response = await (options.fetchImpl || root.fetch)(url,{signal:controller.signal,credentials:'omit',redirect:'error',headers:{Accept:source === 'inventory' ? 'text/xml' : 'application/json'}});
        receipt.httpStatus = response.status; receipt.retrievedAt = new Date().toISOString(); receipt.contentType = response.headers?.get('content-type') || null;
        if (response.status === 429) rateLimited = true;
        if (!response.ok) {
          try {await retainFailureBody(response,receipt);} catch (error) {if (options.signal?.aborted || error.name === 'AbortError') throw error; receipt.failureBodyUnavailable = true;}
          fail(response.status === 429 ? 'NOAA rate limited metadata checks; remaining candidates were not requested.' : 'NOAA ' + source + ' request failed (HTTP ' + response.status + ').','HTTP_' + response.status);
        }
        const size = response.headers?.get('content-length'); if (size && Number(size) > LIMIT) fail('NOAA metadata response exceeds the size bound.');
        const text = await response.text(); if (text.length > LIMIT) fail('NOAA metadata response exceeds the size bound.');
        aborted(); receipt.textLength = text.length; receipt.outcome = 'received'; return {text,receipt};
      } catch (original) {
        let error = original;
        if (options.signal?.aborted) error.name = 'AbortError';
        else if (timedOut) error = Object.assign(new Error('NOAA metadata request timed out.'),{code:'TIMEOUT'});
        else if (error.name !== 'AbortError' && error.code !== 'SCHEMA' && !/^HTTP_\d{3}$/.test(error.code || '')) error = Object.assign(new Error('NOAA metadata could not be reached.'),{code:'NETWORK'});
        receipt.outcome = 'failed'; receipt.error = {code:error.name === 'AbortError' ? 'ABORTED' : error.code || 'NETWORK',message:error.message}; receipt.finishedAt = new Date().toISOString(); error.requestReceipt = receipt; throw error;
      } finally {clearTimeout(timer); options.signal?.removeEventListener('abort',abort);}
    }
    async function worker() {
      while (next < pending.length && !options.signal?.aborted && !rateLimited) {
        const index = pending[next++], station = output[index], a = initial(station,query); let cancelled = false;
        for (const source of ['metadata','inventory']) {
          for (let attempt = 1; attempt <= 2; attempt++) {
            let loaded;
            try {
              if (attempt === 2) await pause(retryDelay);
              aborted(); const id = stationId(station); loaded = await read(source === 'metadata' ? metadataURL(id) : inventoryURL(id),source,a,attempt);
              if (source === 'metadata') {let data; try {data = JSON.parse(loaded.text);} catch (_) {fail('NOAA metadata response is not valid JSON.');} Object.assign(a,parseMetadata(data,id)); a.metadataStatus = 'ok';}
              else {Object.assign(a,parseInventory(loaded.text,id)); a.inventoryStatus = 'ok';}
              loaded.receipt.outcome = 'success';
              for (const error of a.errors.filter(error => error.source === source)) error.recovered = true;
              break;
            } catch (error) {
              const code = error.name === 'AbortError' ? 'ABORTED' : error.code || 'METADATA', receipt = loaded?.receipt || error.requestReceipt;
              if (loaded) Object.assign(receipt,{outcome:'failed',error:{code,message:error.message},rawFailureText:loaded.text.slice(0,65536),rawFailureTruncated:loaded.text.length > 65536,rawFailureEncoding:'Decoded response text; at most 65536 characters; metadata parsing failed'});
              const retry = attempt === 1 && !options.signal?.aborted && !rateLimited && (code === 'NETWORK' || code === 'TIMEOUT' || code === 'SOAP_SERVER_FAULT' || /^HTTP_5\d\d$/.test(code));
              a[source === 'metadata' ? 'metadataStatus' : 'inventoryStatus'] = 'unresolved'; a.errors.push({source,attempt,phase:receipt ? 'request' : 'waiting',code,message:error.message,retryScheduled:retry,recovered:false,...(receipt ? {requestIndex:a.requests.indexOf(receipt)} : {})});
              if (error.name === 'AbortError') cancelled = true;
              if (!retry) break;
            }
          }
          if (cancelled || rateLimited) break;
        }
        a.checkedAt = new Date().toISOString(); station.coopsAvailability = a;
        try {station.coopsAvailability = assessCoopsStation(station,query);} catch (error) {a.state = 'unresolved'; a.label = 'Availability unresolved'; a.message = error.message; a.canTryPreview = false;}
        if (!cancelled && !rateLimited) completed++;
        output[index] = {...station}; emit();
      }
    }
    emit(); await Promise.all(Array.from({length:Math.min(3,pending.length)},worker)); emit(); return snapshot();
  }
  const api = {productSpec,checkCoopsStations,assessCoopsStation,previewWindow,metadataURL,inventoryURL,observationIntervals:mergedIntervals}; root.SiteCoopsAvailability = api;
  if (typeof module === 'object' && module.exports) module.exports = {...api,_test:{parseInventory,parseMetadata,xmlTree,mergedIntervals}};
})(typeof globalThis !== 'undefined' ? globalThis : this);
