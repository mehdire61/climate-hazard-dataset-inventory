/* Access capability and prepared artifacts are separate from catalog coverage evidence. */
(function(root) {
  'use strict';
  const copy=value=>JSON.parse(JSON.stringify(value));
  const moduleFor=(globalName,file)=>root[globalName]||(typeof require==='function'?require('./'+file):null);
  function data() {
    if(root.InventoryApp?.data)return root.InventoryApp.data;
    if(typeof require==='function')return {products:require('../data/catalog.json').products,access:require('../data/access.json'),screening:require('../data/screening.json'),sources:require('../data/sources.json')};
    throw new Error('The access catalog is unavailable. Reload the inventory.');
  }
  const labels={station:'Station preview & data',files:'Provider files',request:'Prepared request',external:'External workflow'};
  function profileFor(id) {
    const profile=data().access?.profiles?.[id];
    if(!profile||!labels[profile.kind])throw new Error('This record has no reviewed access profile.');
    return profile;
  }
  function describe(id) {
    const profile=profileFor(id),{files,...description}=profile;
    if(profile.strategy==='grid') {
      const grid=moduleFor('SiteGridAccess','grid-access.js').describe(id);
      description.options=grid.resolutions.length>1?[{key:'resolution',label:'Grid resolution',value:grid.defaultResolution,choices:grid.resolutions.map(r=>({value:r.value,label:r.label}))}]:[];
    }
    if(['cds','mrms'].includes(profile.strategy)&&id!=='c3s_lake_water_level')description.options=moduleFor('SiteProviderRequests','provider-requests.js').describeOptions(id);
    return {...copy(description),label:profile.label||labels[profile.kind],canDiscover:['cmr','stac'].includes(profile.strategy)};
  }
  function validate(id,query) {
    const d=data(),screening=moduleFor('SiteScreening','screening.js'),errors=screening.validate(query);
    const product=d.products.find(p=>p.product_id===id);if(!product)errors.push('Unknown catalog record.');
    if(errors.length)return {errors};
    const result=screening.evaluate(product,d.screening.rules[id],query);
    if(result.status==='excluded')errors.push('This project is outside the documented scope. Change the location or period before preparing access.');
    return {errors,product,result};
  }
  function choicesFor(profile,options) {
    const chosen={},errors=[];
    for(const option of describe(profile.productId).options||[]) {
      const value=options[option.key]===undefined?option.value:String(options[option.key]);
      if(!option.choices.some(c=>String(c.value)===String(value))||(option.required&&!value))errors.push('Choose '+option.label.toLowerCase()+'.');
      chosen[option.key]=value;
    }
    return {chosen,errors};
  }
  function safeURL(value) {
    const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password)throw new Error('Only credential-free HTTPS provider routes are accepted.');return url.href;
  }
  function normalizeFile(file,profile) {
    return {...copy(file),id:file.id||file.url,url:safeURL(file.url),name:file.name||new URL(file.url).pathname.split('/').pop(),
      sizeBytes:file.sizeBytes??file.bytes??null,
      sizeLabel:file.sizeLabel||(Number.isFinite(file.sizeMB)?file.sizeMB.toLocaleString('en-US',{maximumFractionDigits:1})+' MB (provider metadata; approximate)':null),
      checkedAt:file.checkedAt||file.metadataCheckedAt||null,verificationLabel:file.verificationLabel||file.verificationStatus||file.verification||'Provider metadata link; data payload not inspected.',
      spatialDelivery:file.spatialDelivery||profile.spatialDelivery,version:file.associatedAcquisitionTime?file.assetVersion??null:file.version||profile.version||null};
  }
  function spatialBoxes(query,useStationRadius=false) {
    return moduleFor('SiteGeometry','geometry.js').searchBoxes({...query,radiusKm:useStationRadius?(query.radiusKm??100):0,bufferKm:0});
  }
  function lon360Boxes(box) {
    const [w,s,e,n]=box;
    if(w===-180&&e===180)return [[0,s,360,n]];
    if(w<0&&e>=0)return [[w+360,s,360,n],[0,s,e,n]].filter(b=>b[0]<=b[2]);
    return [[w<0?w+360:w,s,e<0?e+360:e,n]];
  }
  function erddapRequests(profile,query) {
    const last=new Date(query.end+'T00:00:00Z');last.setUTCDate(last.getUTCDate()+1);
    return spatialBoxes(query,true).flatMap(lon360Boxes).map((b,i)=>{
      const expressions=[profile.variables.join(','),'latitude>='+b[1],'latitude<='+b[3],'longitude>='+b[0],'longitude<='+b[2],
        'time>='+query.start+'T00:00:00Z','time<'+last.toISOString().slice(0,10)+'T00:00:00Z'];
      return {url:profile.endpoint+'?'+expressions.map(encodeURIComponent).join('&'),method:'GET',name:profile.productId+'_part'+(i+1)+'.csv',
        providerBounds:b,longitudeConvention:'0 to 360 degrees east',verification:'Generated request; actual returned observations are unverified until executed.'};
    });
  }
  const jsonText=value=>JSON.stringify(value,null,2)+'\n';
  const pythonValue=value=>'json.loads('+JSON.stringify(JSON.stringify(value))+')';
  function transferSummary(files) {
    const associationCount=files.length;
    files=[...new Map(files.map(file=>[JSON.stringify([file.url,file.assetVersion??file.version??null,file.checksum||null]),file])).values()];
    let knownBytes=0,unknownCount=0,approximateCount=0;
    for(const file of files) {
      const raw=file.sizeBytes??file.bytes;
      let bytes=raw,approximate=file.bytesApproximate===true;
      if(raw==null&&Number.isFinite(file.sizeMB)&&file.sizeMB>=0){bytes=Math.round(file.sizeMB*1000000);approximate=true;}
      if(Number.isFinite(bytes)&&bytes>=0)knownBytes+=bytes;else unknownCount++;
      if(approximate)approximateCount++;
    }
    return {fileCount:files.length,associationCount,knownBytes,unknownCount,approximateCount,requiresConfirmation:knownBytes>=1000000000||files.length>100||unknownCount>0||approximateCount>0,byteThreshold:1000000000,fileThreshold:100};
  }
  function rawDownloadScript(id,requests) {
    return String.raw`#!/usr/bin/env python3
"""Prepared provider download. Run without flags to review; --download retrieves files."""
import argparse, hashlib, json, math, re, sys
from pathlib import Path
from urllib.request import Request, urlopen
from datetime import datetime, timezone
if hasattr(sys.stdout, 'reconfigure'): sys.stdout.reconfigure(errors='backslashreplace')
if hasattr(sys.stderr, 'reconfigure'): sys.stderr.reconfigure(errors='backslashreplace')

REQUESTS = ${pythonValue(requests)}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--download", action="store_true")
parser.add_argument("--file", type=int, action="append", help="One-based file number; repeat to select. Default: all listed files.")
parser.add_argument("--confirm-transfer", action="store_true", help="Explicitly allow a selected transfer of at least 1 GB, more than 100 files, or unknown/approximate sizes. Review the summary first.")
args = parser.parse_args()
if args.file and any(i < 1 or i > len(REQUESTS) for i in args.file): parser.error("File number is outside the prepared list")
associations = [r for i, r in enumerate(REQUESTS, 1) if not args.file or i in args.file]

def identity(item):
    return (item["url"], item.get("assetVersion") or item.get("version"), item.get("checksum") or None)

def filename(item):
    name = re.sub(r"[^A-Za-z0-9._-]", "_", item["name"])
    if not name or name in (".", ".."): name = 'provider-file-' + hashlib.sha256(item['url'].encode('utf-8')).hexdigest()[:16]
    return name

# Numbered selections refer to associations; each physical object transfers once.
groups = {}
for item in associations:
    key = identity(item)
    if key not in groups: groups[key] = {**item, "associations":[]}
    groups[key]["associations"].append(item)
selected = list(groups.values())
destinations = {}
for item in REQUESTS:
    destinations.setdefault(filename(item).casefold(), set()).add(identity(item))
for item in selected:
    name = filename(item)
    item["transferIdentity"] = hashlib.sha256(json.dumps(identity(item), ensure_ascii=True).encode()).hexdigest()
    if len(destinations[name.casefold()]) > 1:
        stem, suffix = Path(name).stem, Path(name).suffix
        name = stem + "-" + item["transferIdentity"] + suffix
    item["destination"] = name

def valid_size(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0

def transfer_summary(files):
    known, unknown, approximate = 0, 0, 0
    for item in files:
        size = item.get("sizeBytes")
        if size is None: size = item.get("bytes")
        estimate = item.get("bytesApproximate") is True
        if size is None and valid_size(item.get("sizeMB")):
            size, estimate = int(item["sizeMB"] * 1000000 + 0.5), True
        if valid_size(size): known += size
        else: unknown += 1
        approximate += int(estimate)
    return {"fileCount":len(files), "associationCount":sum(len(item["associations"]) for item in files), "knownBytes":known, "unknownCount":unknown, "approximateCount":approximate,
            "requiresConfirmation":known >= 1000000000 or len(files) > 100 or unknown > 0 or approximate > 0,
            "byteThreshold":1000000000, "fileThreshold":100}

for i, r in enumerate(REQUESTS, 1): print(i, r["name"], r.get("sizeBytes", "size unknown"), r["url"])
summary = transfer_summary(selected)
print("Selected transfer summary:", json.dumps(summary))
print("Known size:", format(summary["knownBytes"] / 1000000, ".1f"), "MB; unknown sizes:", summary["unknownCount"], "; approximate sizes:", summary["approximateCount"])
if not args.download:
    print("Review file sizes and provider terms. Use --download, optionally --file N, to retrieve raw provider files.")
    raise SystemExit(0)
if summary["requiresConfirmation"] and not args.confirm_transfer:
    parser.error("No payload request sent. Narrow the selection with --file N, or explicitly accept the displayed transfer using --confirm-transfer after reviewing its size and terms.")
folder = Path(${JSON.stringify(id+'_provider_files')})
folder.mkdir(exist_ok=True)
previous = []
for saved_receipt in folder.glob("receipt-*.json"):
    try: previous.extend(json.loads(saved_receipt.read_text(encoding="utf-8")).get("files", []))
    except (ValueError, OSError, AttributeError): pass
receipt = folder / ("receipt-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".json")
report = {"complete":False, "files":[], "failures":[], "transferSummary":summary, "explicitTransferConfirmation":args.confirm_transfer,
          "qualification":"Raw transfers and structural signatures only; no scientific suitability assessment. Reuse verifies local bytes against a prior receipt, not current provider freshness."}
def persist():
    receipt.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
persist()
network_bytes = 0
for r in selected:
    try:
        name = r["destination"]
        target = folder / name
        partial = folder / (name + ".part")
        if target.exists():
            if target.is_symlink() or not target.is_file(): raise FileExistsError("Existing destination is not a regular file")
            with target.open("rb") as saved:
                check = hashlib.sha256()
                for chunk in iter(lambda: saved.read(1048576), b""): check.update(chunk)
                saved_hash = check.hexdigest()
            prior = next((entry for entry in previous if entry.get("file") == name and entry.get("transferIdentity") == r["transferIdentity"] and entry.get("sha256") == saved_hash and entry.get("bytes") == target.stat().st_size), None)
            if not prior: raise FileExistsError("Existing file has no matching identity and verified receipt; it was preserved")
            report["files"].append({**prior, "reused":True, "associations":r["associations"], "verifiedAt":datetime.now(timezone.utc).isoformat()})
            print("Reused verified file", target)
            continue
        if partial.exists(): raise FileExistsError(str(partial) + " already exists; partial bytes were preserved")
        sha = hashlib.sha256()
        checksum = r.get("checksum") or ""
        md5 = hashlib.md5() if checksum.startswith("md5:") else None
        size = 0
        with urlopen(Request(r["url"], headers={"User-Agent":"Climate-Hazard-Inventory/0.2"}), timeout=90) as response:
            if response.status != 200: raise RuntimeError("Expected a complete HTTP200 response, got " + str(response.status))
            length = response.headers.get("Content-Length")
            if not args.confirm_transfer and length and network_bytes + int(length) >= 1000000000: raise RuntimeError("Response exceeds the 1 GB transfer safeguard; review before using --confirm-transfer")
            first = response.read(65536)
            network_bytes += len(first)
            if not args.confirm_transfer and network_bytes >= 1000000000: raise RuntimeError("Transfer exceeded the 1 GB safeguard; partial files retained")
            if "text/html" in response.headers.get("Content-Type", "").lower() or first.lstrip().lower().startswith((b"<!doctype html", b"<html")): raise RuntimeError("Provider returned an HTML/login page, not data")
            if not first: raise RuntimeError("Provider returned an empty file")
            lower = name.lower()
            if lower.endswith(".gz") and not first.startswith(b"\x1f\x8b"): raise RuntimeError("Expected gzip signature")
            if lower.endswith(".zip") and not first.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")): raise RuntimeError("Expected ZIP signature")
            if lower.endswith((".nc", ".nc4")) and not first.startswith((b"CDF\x01", b"CDF\x02", b"CDF\x05", b"\x89HDF\r\n\x1a\n")): raise RuntimeError("Expected NetCDF signature")
            if lower.endswith((".tif", ".tiff")) and not first.startswith((b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+")): raise RuntimeError("Expected TIFF signature")
            with partial.open("xb") as output:
                chunk = first
                while chunk:
                    output.write(chunk)
                    sha.update(chunk)
                    if md5: md5.update(chunk)
                    size += len(chunk)
                    chunk = response.read(1048576)
                    network_bytes += len(chunk)
                    if not args.confirm_transfer and network_bytes >= 1000000000: raise RuntimeError("Transfer exceeded the 1 GB safeguard; partial file retained")
            expected = response.headers.get("Content-Length")
            if expected and size != int(expected): raise RuntimeError("Incomplete response; .part retained")
            if md5 and md5.hexdigest() != checksum.split(":",1)[1]: raise RuntimeError("Provider checksum differs; .part retained")
        partial.rename(target)
        report["files"].append({"file":name,"url":r["url"],"bytes":size,"sha256":sha.hexdigest(),"retrievedAt":datetime.now(timezone.utc).isoformat(),"transferIdentity":r["transferIdentity"],"associations":r["associations"],"reused":False})
        print("Saved", target, size, "bytes")
    except KeyboardInterrupt:
        report["cancelled"] = True
        report["failures"].append({"request":r,"error":"Cancelled by the user; partial files retained", "type":"KeyboardInterrupt"})
        break
    except Exception as error:
        report["failures"].append({"request":r,"error":str(error),"type":type(error).__name__})
        print("Failed", r["name"], type(error).__name__, str(error))
    finally:
        persist()
report["complete"] = not report["failures"] and len(report["files"]) == len(selected)
persist()
print("Saved", len(report["files"]), "of", len(selected), "files; failed", len(report["failures"]), "; receipt:", receipt)
print("Files retain original support without clipping, time slicing, quality filtering or unit conversion. Inspect scientific metadata before use.")
raise SystemExit(130 if report.get("cancelled") else 0 if report["complete"] else 2)
`;
  }
  function instructions(profile,query,selection,notes) {
    return ['PROJECT ACCESS HANDOFF — '+profile.productId,'',
      'Requested period (inclusive): '+query.start+' through '+query.end,
      'Project: '+(query.mode==='area'?(query.areaName||'Uploaded footprint'):'Point '+query.lat+', '+query.lon),
      'Original geometry and source are retained in the manifest and project.geojson.',
      'Chosen options: '+JSON.stringify(selection),
      'Route: '+profile.summary,'Authentication / terms: '+profile.auth,
      'Spatial delivery: '+profile.spatialDelivery,'Temporal delivery: '+profile.temporalDelivery,
      'Verification: '+profile.verification.label,
      '',...(profile.steps||[]).map((s,i)=>(i+1)+'. '+s),
      ...(profile.kind!=='request'&&profile.requiredSelections?.length?['','Still to select or confirm with the provider:',...profile.requiredSelections.map(s=>'- '+s)]:[]),
      '',...notes.map(n=>'- '+n),'','Provider: '+profile.providerUrl,'Documentation: '+profile.docsUrl,
      ...(profile.relatedLinks||[]).map(l=>l.label+': '+l.url),
      '','This handoff is not a retrieved dataset or evidence of scientific suitability. No request has been sent by preparing these files.'].join('\n')+'\n';
  }
  function prepare(id,query,options={}) {
    const profile=profileFor(id),checked=validate(id,query),selection=choicesFor(profile,options),errors=[...checked.errors,...selection.errors];
    const base={manifestName:id+'_request_manifest.json',manifest:null,files:[],artifacts:[],notes:[],errors};
    if(errors.length)return base;
    const chosen=selection.chosen,product=checked.product;
    let files=[],requests=[],artifacts=[],notes=[...(profile.notes||[])],routeEvidence=profile.verification;
    if(checked.result.status!=='possible')notes.unshift('Catalog screening still requires further verification: '+checked.result.label+'. Preparing access does not resolve that status.');
    if(checked.result.spatialRelation==='partial'||checked.result.temporal.includes('Partial'))notes.unshift('Only partial nominal overlap was established. Requested dates and geometry have not been silently trimmed.');
    if(profile.strategy==='grid') {
      const plan=moduleFor('SiteGridAccess','grid-access.js').plan(id,query,chosen);
      files=plan.files;notes.push(...plan.notes);routeEvidence=plan.verification;
      base.uncoveredIntervals=plan.uncoveredIntervals;
    } else if(profile.strategy==='snapshot') {
      files=(profile.files||[]).filter(f=>Object.entries(f.selection||{}).every(([k,v])=>String(chosen[k])===String(v)))
        .filter(f=>(!f.start||f.start<=query.end)&&(!f.end||f.end>=query.start));
      notes.push('These are observed provider file links from a dated metadata snapshot. Files can change after review; no live availability check is performed by preparing this plan.');
      if(!files.length)notes.push('No file in this reviewed index overlaps the selected dates/options. This does not prove that the provider has no data; inspect its current archive.');
    } else if(profile.strategy==='erddap') {
      requests=erddapRequests(profile,query);
      artifacts.push({name:id+'_download_request.py',mime:'text/x-python',text:rawDownloadScript(id,requests),role:'request'});
    } else if(['cds','mrms'].includes(profile.strategy)) {
      const prepared=moduleFor('SiteProviderRequests','provider-requests.js').prepare(profile,query,chosen);
      requests=prepared.requests||[];artifacts.push(...prepared.artifacts||[]);notes.push(...prepared.notes||[]);errors.push(...prepared.errors||[]);
      base.requestTransferSummary=prepared.transferSummary||null;
    } else if(['daily-template','ims-daily-template','coolr-arcgis'].includes(profile.strategy)) {
      const prepared=moduleFor('SiteScienceRequests','science-requests.js').prepare(profile,query,chosen);
      requests=prepared.requests||[];artifacts.push(...prepared.artifacts||[]);notes.push(...prepared.notes||[]);errors.push(...prepared.errors||[]);
    } else if(profile.strategy==='cmr') {
      const earth=moduleFor('SiteEarthAccess','earth-access.js'),cmrProfile={...profile,kind:'cmr'};
      requests=earth.scopes(cmrProfile,query).map(scope=>({method:'GET',url:earth.requestURL(scope,query),collectionId:scope.collection.id,operation:'First metadata page; follow CMR-Search-After for remaining granules.'}));
      notes.push('Use Find matching files to traverse public metadata. Actual data files may require Earthdata authentication; these metadata URLs are not scientific data downloads.');
    } else if(profile.strategy==='stac') {
      requests=moduleFor('SiteStacAccess','stac-access.js').requestURLs(query).map(url=>({method:'GET',url,operation:'First STAC metadata page; continuation is required when a next link exists.'}));
    }
    files=files.map(f=>normalizeFile(f,profile));
    if(files.length)artifacts.push({name:id+'_download_files.py',mime:'text/x-python',text:rawDownloadScript(id,files),role:'request'});
    if(requests.length)artifacts.push({name:id+'_provider_requests.json',mime:'application/json',text:jsonText({productId:id,query,selection:chosen,requests,verification:routeEvidence}),role:'request'});
    const geometry=query.mode==='area'?copy(query.geometry):{type:'Point',coordinates:[query.lon,query.lat]};
    artifacts.push({name:id+'_project.geojson',mime:'application/geo+json',text:jsonText({type:'Feature',properties:{name:query.areaName||'Project point',source:query.areaSource||null,requestedStart:query.start,requestedEnd:query.end},geometry}),role:'geometry'});
    artifacts.push({name:id+'_access_instructions.txt',mime:'text/plain',text:instructions(profile,query,chosen,notes),role:'instructions'});
    const d=data(),sources=Array.isArray(d.sources)?Object.fromEntries(d.sources.map(s=>[s.evidence_id,s])):d.sources;
    const payloadRequestSummary=['daily-template','ims-daily-template','erddap'].includes(profile.strategy)
      ? {...transferSummary(requests),unit:'prepared file requests'} : null;
    const manifest={schemaVersion:1,preparedAt:new Date().toISOString(),productId:id,productName:product.product_name,query:copy(query),selection:chosen,
      accessCapability:profile.kind,accessProfile:copy(profile),screening:checked.result,sourceRecord:copy(product),
      referencedSources:Object.fromEntries(product.evidence_ids.filter(k=>sources[k]).map(k=>[k,sources[k]])),
      requests,files,transferSummary:base.requestTransferSummary||payloadRequestSummary||transferSummary(files),verification:routeEvidence,notes,requiredSelections:profile.requiredSelections||[],uncoveredIntervals:base.uncoveredIntervals||[],
      qualification:'Prepared access, not retrieval evidence. Files retain their documented spatial/temporal support. No clipping, averaging, interpolation, quality filtering or suitability assessment.'};
    return {...base,manifest,files,artifacts,notes,errors};
  }
  async function discover(id,query,options={}) {
    const profile=profileFor(id),checked=validate(id,query);if(checked.errors.length)throw new Error(checked.errors.join(' '));
    let result;
    if(profile.strategy==='cmr') {
      result=await moduleFor('SiteEarthAccess','earth-access.js').discover({...profile,kind:'cmr'},query,options);
      result={...result,cursor:result.continuation};
    } else if(profile.strategy==='stac')result=await moduleFor('SiteStacAccess','stac-access.js').discover(profile,query,options);
    else throw new Error('This access route does not offer live file discovery.');
    return {...result,files:(result.files||[]).map(f=>normalizeFile({...f,checkedAt:f.checkedAt||new Date().toISOString()},profile))};
  }
  function fileScript(id, files) {
    const profile = profileFor(id);
    if (profile.kind === 'external') return {artifact:null,reason:'This dataset requires the provider access workflow. Historical file links do not enable an anonymous batch download.'};
    if (!Array.isArray(files) || !files.length) return {artifact:null,reason:'Load provider files before preparing a batch download.'};
    if (files.some(file => file.authRequired === true || ['cmr','stac'].includes(profile.strategy) && file.authRequired !== false))
      return {artifact:null,reason:'These links require authentication or their public access is unconfirmed. Use the individual provider links; no credential-handling batch script is prepared.'};
    const requests = files.map(file => normalizeFile(file, profile));
    return {artifact:{name:id+'_download_files.py',mime:'text/x-python',text:rawDownloadScript(id,requests),role:'request'},reason:null};
  }
  function fileCoverage(id,files,query,search={}) {
    const step=data().screening.rules[id]?.time_step;
    const monthly=['monthly','monthly_annual','monthly_seasonal_annual'].includes(step);
    const unit=monthly?'months':step==='half_hourly'?'half-hour intervals':'days';
    const supported=monthly||['half_hourly','daily','daily_accumulations','daily_index','daily_monthly'].includes(step);
    const nominalDaily=id==='lhasa_model';
    const qualification=nominalDaily?'Counts use the nominal date in each LHASA 2.0.0 filename. CMR time bounds extend into the following day. Check the NetCDF time coordinate and valid cells before using a daily value.':'Listed time envelopes only: at least one file overlaps each counted interval. Tiles, layers, valid pixels, internal gaps and observations across the project have not been checked.';
    if(!supported)return {assessed:false,reason:'File-list temporal coverage is not assessed for this product cadence.',qualification};
    const width=step==='half_hourly'?1800000:86400000;
    const stamp=(value,end=false)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?Date.parse(value+'T00:00:00Z')+(end?86400000-1:0):Date.parse(value);
    const slot=ms=>monthly?new Date(ms).getUTCFullYear()*12+new Date(ms).getUTCMonth():Math.floor(ms/width);
    const label=n=>monthly?String(Math.floor(n/12)).padStart(4,'0')+'-'+String(n%12+1).padStart(2,'0'):new Date(n*width).toISOString().slice(0,step==='half_hourly'?16:10)+(step==='half_hourly'?'Z':'');
    const start=slot(stamp(query.start)),end=slot(stamp(query.end,true)),ranges=[];
    if(!Number.isFinite(start)||!Number.isFinite(end)||start>end)return {assessed:false,reason:'Valid project dates are required.',qualification};
    let undated=0;
    for(const file of files){
      if(file.role==='checksum')continue;
      let fileStart=file.start,fileEnd=file.end;
      if(nominalDaily){
        const parts=/^Global_Landslide_Nowcast_v2\.0\.0_(\d{4})(\d{2})(\d{2})\.nc4$/.exec(file.name);
        const nominal=parts&&parts.slice(1).join('-');
        if(!nominal||nominal!==file.start?.slice(0,10)){undated++;continue;}
        fileStart=fileEnd=nominal;
      }
      const a=stamp(fileStart),b=stamp(fileEnd,true);
      if(!Number.isFinite(a)||!Number.isFinite(b)||a>b){undated++;continue;}
      const first=Math.max(start,slot(a)),last=Math.min(end,slot(b));if(first<=last)ranges.push([first,last]);
    }
    if(undated)return {assessed:false,undatedFiles:undated,reason:undated+' file(s) have missing or unusable time bounds; interval counts are not asserted.',qualification};
    ranges.sort((a,b)=>a[0]-b[0]);const merged=[];
    for(const range of ranges){const last=merged.at(-1);if(last&&range[0]<=last[1]+1)last[1]=Math.max(last[1],range[1]);else merged.push([...range]);}
    const missing=[];let cursor=start,covered=0;
    for(const [a,b] of merged){if(a>cursor)missing.push({start:label(cursor),end:label(a-1),count:a-cursor});covered+=b-a+1;cursor=b+1;}
    if(cursor<=end)missing.push({start:label(cursor),end:label(end),count:end-cursor+1});
    return {assessed:true,unit,...(nominalDaily?{basis:'nominal_file_dates'}:{}),requestedIntervals:end-start+1,listedIntervals:covered,unlistedIntervals:end-start+1-covered,
      firstListed:merged.length?label(merged[0][0]):null,lastListed:merged.length?label(merged.at(-1)[1]):null,
      missingIntervals:missing,searchComplete:search.complete===true,origin:search.origin||'unknown',qualification};
  }
  const api={describe,prepare,discover,transferSummary,fileScript,fileCoverage};root.SiteAccess=api;
  if(typeof module==='object'&&module.exports)module.exports={...api,_test:{erddapRequests,lon360Boxes,rawDownloadScript}};
})(typeof globalThis!=='undefined'?globalThis:this);
