/* Pure prepared requests. Creating an artifact never contacts a provider. */
(function(root){
  'use strict';
  const moduleFor=(name,file)=>root[name]||(typeof require==='function'?require('./'+file):null);
  const DAY=86400000,copy=x=>JSON.parse(JSON.stringify(x));
  const pythonConfig=value=>'json.loads('+JSON.stringify(JSON.stringify(value))+')';
  function nextDay(value){return new Date(Date.parse(value+'T00:00:00Z')+DAY).toISOString().slice(0,10);}
  function dailyRequests(config){
    const requests=[];
    for(let d=Date.parse(config.start+'T00:00:00Z'),end=Date.parse(config.end+'T00:00:00Z');d<=end;d+=DAY){
      const date=new Date(d),iso=date.toISOString().slice(0,10),year=iso.slice(0,4),doy=String(Math.floor((d-Date.parse(year+'-01-01T00:00:00Z'))/DAY)+1).padStart(3,'0');
      const name=config.productId==='esa_cci_sm_combined_v09_2'?'ESACCI-SOILMOISTURE-L3S-SSMV-COMBINED-'+iso.replaceAll('-','')+'000000-fv09.2.nc':'ims'+year+doy+'_00UTC_'+config.grid+'_v'+config.minorVersion+'.asc.gz';
      const base=config.productId==='esa_cci_sm_combined_v09_2'?'https://dap.ceda.ac.uk/neodc/esacci/soil_moisture/data/daily_files/COMBINED/v09.2/':'https://noaadata.apps.nsidc.org/NOAA/G02156/'+config.grid+'/';
      requests.push({method:'GET',url:base+year+'/'+name,name,date:iso,operation:'Prepared whole-domain daily file; existence unverified until retrieval.'});
    }
    return requests;
  }
  function dailyPython(config){return `#!/usr/bin/env python3
"""Prepared whole-domain files. Dry-run by default; unknown-size retrieval requires --download --confirm-transfer."""
import argparse, gzip, hashlib, json
from datetime import date, timedelta, datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

CONFIG = ${pythonConfig(config)}

def build_requests():
    day, end = date.fromisoformat(CONFIG["start"]), date.fromisoformat(CONFIG["end"])
    requests = []
    while day <= end:
        if CONFIG["productId"] == "esa_cci_sm_combined_v09_2":
            name = "ESACCI-SOILMOISTURE-L3S-SSMV-COMBINED-" + day.strftime("%Y%m%d") + "000000-fv09.2.nc"
            base = "https://dap.ceda.ac.uk/neodc/esacci/soil_moisture/data/daily_files/COMBINED/v09.2/"
        else:
            name = "ims" + day.strftime("%Y%j") + "_00UTC_" + CONFIG["grid"] + "_v" + CONFIG["minorVersion"] + ".asc.gz"
            base = "https://noaadata.apps.nsidc.org/NOAA/G02156/" + CONFIG["grid"] + "/"
        requests.append({"url":base + str(day.year) + "/" + name, "name":name, "date":day.isoformat()})
        day += timedelta(days=1)
    return requests

def download(requests, folder, opener=urlopen, selection=None):
    folder.mkdir(parents=True, exist_ok=True)
    receipt_path = folder / ("receipt-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".json")
    receipts = []
    for item in requests:
        target, partial = folder / item["name"], folder / (item["name"] + ".part")
        record = {**item, "status":"failed", "retrievedAt":datetime.now(timezone.utc).isoformat()}
        try:
            if target.exists() or partial.exists(): raise FileExistsError("Target or partial already exists; nothing overwritten")
            digest, size = hashlib.sha256(), 0
            with opener(Request(item["url"], headers={"User-Agent":"Climate-Hazard-Inventory/0.2"}), timeout=90) as response:
                if response.status != 200: raise ValueError("Expected complete HTTP 200 response")
                first = response.read(65536)
                if not first or "text/html" in response.headers.get("Content-Type", "").lower() or first.lstrip().lower().startswith((b"<!doctype html", b"<html")): raise ValueError("Empty or HTML response is not scientific data")
                if item["name"].endswith(".gz"):
                    if not first.startswith(b"\\x1f\\x8b"): raise ValueError("Expected gzip signature")
                elif not first.startswith((b"\\x89HDF\\r\\n\\x1a\\n", b"CDF\\x01", b"CDF\\x02", b"CDF\\x05")): raise ValueError("Expected NetCDF/HDF5 signature")
                with partial.open("xb") as stream:
                    chunk = first
                    while chunk:
                        stream.write(chunk); digest.update(chunk); size += len(chunk)
                        chunk = response.read(1048576)
                length = response.headers.get("Content-Length")
                if length is not None and size != int(length): raise ValueError("Incomplete content length; partial retained")
            if item["name"].endswith(".gz"):
                with gzip.open(partial, "rb") as stream:
                    while stream.read(1048576): pass
            partial.rename(target)
            record.update(status="downloaded", bytes=size, sha256=digest.hexdigest(), payloadMeaning="Original whole-domain file; no scientific QA, clipping or unit conversion")
        except HTTPError as error:
            record["error"] = "Provider returned HTTP " + str(error.code) + "; response detail and redirected URL omitted"
        except URLError:
            record["error"] = "Provider connection failed; network error detail omitted"
        except Exception as error:
            record["error"] = str(error)
        receipts.append(record)
        receipt_path.write_text(json.dumps({"configuration":CONFIG,"selection":selection,"receipts":receipts}, indent=2) + "\\n", encoding="utf-8")
    return receipts

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--file", type=int, action="append", help="One-based day/file number; repeat to select. Default: all prepared files.")
    parser.add_argument("--confirm-transfer", action="store_true", help="Explicitly accept the selected files' unknown transfer size after reviewing the plan.")
    parser.add_argument("--output", default=CONFIG["productId"] + "_provider_files")
    args = parser.parse_args(argv)
    requests = build_requests()
    if args.file and any(i < 1 or i > len(requests) for i in args.file): parser.error("File number is outside the prepared list")
    selected_numbers = sorted(set(args.file)) if args.file else None
    selected = [item for i,item in enumerate(requests,1) if selected_numbers is None or i in selected_numbers]
    for i,item in enumerate(requests,1):
        if selected_numbers is None or i in selected_numbers: print(i, item["date"], "size unknown", item["url"])
    summary = {"fileCount":len(selected),"totalPreparedCount":len(requests),"knownBytes":0,"unknownCount":len(selected),"requiresConfirmation":bool(selected)}
    print("Selected transfer summary:", json.dumps(summary))
    print(str(len(selected)) + " selected whole-domain files; total transfer size unknown. URL existence unverified until retrieval. No clipping, QA filtering or aggregation.")
    if not args.download:
        print("Dry run only. Repeat --file N to choose days. After reviewing the selected count, unknown size and terms, use --download --confirm-transfer.")
        return 0
    if selected and not args.confirm_transfer:
        parser.error("No payload request sent. Select days with --file N or keep the full plan, then explicitly accept its unknown transfer size with --confirm-transfer.")
    selection = {"fileNumbers":selected_numbers,"mode":"selected" if selected_numbers is not None else "all","transferSummary":summary,"explicitTransferConfirmation":args.confirm_transfer}
    receipts = download(selected, Path(args.output), selection=selection)
    print("Downloaded", sum(r["status"] == "downloaded" for r in receipts), "of", len(receipts), "files. Inspect receipt for failures.")
    return 1 if any(r["status"] != "downloaded" for r in receipts) else 0

if __name__ == "__main__": raise SystemExit(main())
`;}
  function coolrPython(config){return `#!/usr/bin/env python3
"""COOLR candidate-query request. Dry-run default; --download retrieves public GeoJSON."""
import argparse, json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

CONFIG = ${pythonConfig(config)}

def get_json(url, opener=urlopen):
    with opener(Request(url, headers={"User-Agent":"Climate-Hazard-Inventory/0.2"}), timeout=90) as response:
        if response.status != 200: raise ValueError("Expected complete HTTP 200 response")
        value = json.loads(response.read().decode("utf-8"))
    if not isinstance(value, dict) or value.get("error"): raise ValueError("Provider error or malformed response")
    if value.get("exceededTransferLimit"): raise ValueError("Provider transfer limit reached; incomplete response")
    return value

def retrieve(folder, opener=urlopen):
    folder.mkdir(parents=True, exist_ok=True)
    tag = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    partial = folder / ("coolr-" + tag + ".partial.geojson")
    receipt_path = folder / ("coolr-" + tag + "-receipt.json")
    ids, features, requests = set(), [], []
    receipt = {"configuration":CONFIG,"retrievedAt":datetime.now(timezone.utc).isoformat(),"complete":False,"requests":requests}
    try:
        for request in CONFIG["requests"]:
            payload = get_json(request["url"], opener)
            values = payload.get("objectIds")
            if payload.get("objectIdFieldName", "").lower() != "objectid" or not isinstance(values,list) or any(type(x) is not int or x < 0 for x in values) or len(values) != len(set(values)): raise ValueError("Invalid or duplicate object-ID enumeration")
            requests.append({"url":request["url"],"objectIdCount":len(values)})
            ids.update(values)
        ordered = sorted(ids)
        receipt["expectedFeatureCount"] = len(ordered)
        seen = set()
        for offset in range(0, len(ordered), 200):
            batch = ordered[offset:offset+200]
            params = {"f":"geojson", "objectIds":",".join(map(str,batch)), "where":"1=1", "outFields":"*", "returnGeometry":"true", "outSR":"4326"}
            url = CONFIG["endpoint"] + "/query?" + urlencode(params)
            payload = get_json(url, opener)
            rows = payload.get("features")
            if payload.get("type") != "FeatureCollection" or not isinstance(rows,list): raise ValueError("Expected GeoJSON FeatureCollection")
            row_ids = []
            for feature in rows:
                if not isinstance(feature,dict) or feature.get("type") != "Feature": raise ValueError("Malformed feature")
                properties = feature.get("properties") or {}
                oid = properties.get("objectid")
                if type(oid) is not int: raise ValueError("Missing objectid")
                row_ids.append(oid)
            if len(row_ids) != len(set(row_ids)) or set(row_ids) != set(batch) or seen.intersection(row_ids): raise ValueError("Missing, extra or repeated feature IDs; earlier pages retained")
            features.extend(rows); seen.update(row_ids)
            requests.append({"url":url,"featureCount":len(rows)})
            partial.write_text(json.dumps({"type":"FeatureCollection","features":features}) + "\\n", encoding="utf-8")
        if seen != ids: raise ValueError("Enumeration and retrieved feature IDs differ")
        if not partial.exists(): partial.write_text('{"type":"FeatureCollection","features":[]}\\n', encoding="utf-8")
        target = folder / ("coolr-" + tag + ".geojson")
        partial.rename(target)
        receipt.update(complete=True, file=target.name, featureCount=len(features), unknownDateCount=sum((f.get("properties") or {}).get("event_date") is None for f in features))
    except Exception as error:
        receipt.update(error=str(error), featureCount=len(features), partialFile=partial.name if partial.exists() else None)
    finally:
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\\n", encoding="utf-8")
    return receipt

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--output", default="coolr_provider_features")
    args = parser.parse_args(argv)
    for request in CONFIG["requests"]: print(request["url"])
    print("Enumerate all IDs, then verified 200-ID pages. Keep unknown dates. Original project geometry is supplied separately.")
    print("Candidate geometries are not clipped. Provider holdings can change between enumeration and retrieval; this is not an atomic snapshot.")
    if not args.download:
        print("Dry run only. Use --download to retrieve public candidates.")
        return 0
    receipt = retrieve(Path(args.output))
    print(json.dumps(receipt, indent=2))
    return 0 if receipt["complete"] else 1

if __name__ == "__main__": raise SystemExit(main())
`;}
  function prepare(profile,query,options={}){
    const result={requests:[],artifacts:[],notes:[],errors:[]};
    const errors=moduleFor('SiteScreening','screening.js').validate(query);if(errors.length){result.errors.push(...errors);return result;}
    const id=profile?.productId,known={esa_cci_sm_combined_v09_2:'daily-template',ims_snow_ice:'ims-daily-template',nasa_coolr:'coolr-arcgis'};
    if(!known[id]||known[id]!==profile.strategy){result.errors.push('No reviewed prepared-request route matches this product.');return result;}
    const config={productId:id,start:query.start,end:query.end};let script;
    if(id==='esa_cci_sm_combined_v09_2'){
      if(query.start<'1978-11-01'||query.end>'2024-12-31')result.errors.push('ESA CCI COMBINED v09.2 files cover 1978-11-01 through 2024-12-31. Choose a period within this release; dates were not trimmed.');
    }else if(id==='ims_snow_ice'){
      config.grid=options.grid??'4km';config.minorVersion=options.minorVersion;
      if(!['24km','4km','1km'].includes(config.grid))result.errors.push('Choose an IMS grid: 24km, 4km or 1km.');
      if(!['1.1','1.2','1.3'].includes(config.minorVersion))result.errors.push('Choose the historical IMS file minor version explicitly.');
      if(!result.errors.length){
        const starts={'24km':'1997-02-01','4km':'2004-01-01','1km':'2014-12-01'};
        if(query.start<starts[config.grid])result.errors.push('The requested period begins before the documented '+config.grid+' grid era. No dates were trimmed.');
        if(config.minorVersion==='1.1'&&(config.grid!=='24km'||query.end>='2004-03-01'))result.errors.push('IMS 1.1 is the original 24km era; the requested grid or period requires another minor version. Split transition periods explicitly.');
        if(config.minorVersion==='1.2'&&(config.grid==='1km'||query.start<'2004-01-01'||query.end>='2015-01-01'))result.errors.push('IMS 1.2 predates the 1km grid and belongs to the 2004–2014 era. Split transition periods explicitly.');
        if(config.minorVersion==='1.3'&&query.start<'2014-12-01')result.errors.push('IMS 1.3 was introduced in December 2014. The requested period includes earlier dates.');
        result.notes.push('Transition-month filenames still require provider-directory verification. These broad version-era checks do not assert exact first/last file dates.','Current YYYYDDD_00UTC filename is the valid date; do not shift it using the processing-date header.');
      }
    }else{
      const layer=options.layer??'Reports_Points';if(!['Reports_Points','Reports_Polygons','Events_Points','Events_Polygons'].includes(layer))result.errors.push('Choose one reviewed COOLR report/event geometry layer.');
      if(!result.errors.length){
        config.layer=layer;config.endpoint='https://gis.earthdata.nasa.gov/portal/rest/services/Landslides/COOLR_'+layer+'/FeatureServer/0';
        const bounds=query.mode==='area'?moduleFor('SiteGeometry','geometry.js').searchBoxes({...query,bufferKm:0}).map(b=>({geometry:b.join(','),geometryType:'esriGeometryEnvelope',providerBounds:b})):[{geometry:query.lon+','+query.lat,geometryType:'esriGeometryPoint'}];
        config.requests=bounds.map(b=>{const {providerBounds,...spatial}=b;const params={f:'json',where:"(event_date >= DATE '"+query.start+"' AND event_date < DATE '"+nextDay(query.end)+"') OR event_date IS NULL",...spatial,inSR:'4326',spatialRel:'esriSpatialRelIntersects',returnIdsOnly:'true'};return {method:'GET',url:config.endpoint+'/query?'+new URLSearchParams(params),operation:'Enumerate IDs including unknown dates; then retrieve and verify every ID',...(providerBounds?{providerBounds}:{}),stationBufferApplied:false};});
        result.requests=config.requests;script=coolrPython(config);
        result.notes.push(query.mode==='area'?'Original-area bounding envelopes are candidate filters. Holes and exact polygon intersection require a later explicit step; station buffer is excluded.':'Exact-point intersection only; the station radius is excluded. Nearby point reports require an explicit area project.','Unknown event dates are retained and must be assessed separately. Completeness means the selected query IDs were retrieved, not that landslide occurrence is completely observed.','All ID pages are checked; missing, extra or repeated IDs leave an explicit partial result. Holdings can change between requests.');
      }
    }
    if(result.errors.length)return {...result,requests:[],artifacts:[]};
    if(id!=='nasa_coolr'){
      result.requests=dailyRequests(config);script=dailyPython(config);
      result.notes.push(result.requests.length+' whole-domain daily file requests prepared. No network call has been made; each generated URL requires retrieval to confirm existence.','Python defaults to a dry run. Repeat --file N to select days; their transfer sizes are unknown, so payload retrieval requires --download --confirm-transfer. The complete batch remains available with explicit confirmation. Receipts record file hashes and failures without clipping, regridding, aggregation, unit conversion or scientific QA.');
    }
    result.artifacts.push({name:id+'_prepared_request.py',mime:'text/x-python',text:script,role:'request'});
    return result;
  }
  root.SiteScienceRequests={prepare};
  if(typeof module==='object'&&module.exports)module.exports={prepare,_test:{dailyRequests,dailyPython,coolrPython}};
})(typeof globalThis!=='undefined'?globalThis:this);
