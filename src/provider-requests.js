/* Prepared requests only. Generated scripts are dry-run by default; no credentials are read here. */
(function (root) {
  'use strict';
  const CDS = Object.freeze({
    era5_t2m: ['2m_temperature'],
    era5_t2m_interval_extrema: ['maximum_2m_temperature_since_previous_post_processing', 'minimum_2m_temperature_since_previous_post_processing'],
    era5_wind10: ['10m_u_component_of_wind', '10m_v_component_of_wind'],
    era5_gust10: ['10m_wind_gust_since_previous_post_processing']
  });
  const MRMS = Object.freeze({
    mrms_radaronly_qpe: ['CONUS/RadarOnly_QPE_01H_00.00/'],
    mrms_multisensor_qpe: ['CONUS/MultiSensor_QPE_01H_Pass1_00.00/', 'CONUS/MultiSensor_QPE_01H_Pass2_00.00/'],
    mrms_mesh: ['CONUS/MESH_00.50/']
  });
  const supported = Object.freeze([...Object.keys(CDS), ...Object.keys(MRMS),'c3s_lake_water_level']);
  const copy = value => JSON.parse(JSON.stringify(value));
  function geometry() {return root.SiteGeometry || (typeof module === 'object' && module.exports ? require('./geometry.js') : null);}
  function validDate(value) {
    if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z'); return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
  }
  function describeOptions(id) {
    if (!MRMS[id]) return [];
    return [{key: 'mrmsField', label: 'CONUS field / pass', value: MRMS[id][0], choices: MRMS[id].map(value => ({value, label: value.split('/')[1]}))}];
  }
  function requestBoxes(query) {
    let boxes;
    if (query.mode === 'area') boxes=geometry().searchBoxes({...query, geometry: geometry().normalize(query.geometry), bufferKm: 0})
      .map(box=>[Math.max(-180,Math.floor(box[0]*4)/4),Math.max(-90,Math.floor(box[1]*4)/4),Math.min(180,Math.ceil(box[2]*4)/4),Math.min(90,Math.ceil(box[3]*4)/4)]);
    else {
      const west=query.lon-0.125,east=query.lon+0.125,south=Math.max(-90,query.lat-0.125),north=Math.min(90,query.lat+0.125);
      boxes=west < -180?[[west+360,south,180,north],[-180,south,east,north]]:east > 180?[[west,south,180,north],[-180,south,east-360,north]]:[[west,south,east,north]];
    }
    // ERA5's 0.25-degree grid has one dateline column. Keep -180 once when
    // partitions include it; +180 is the same meridian, not another cell.
    if (boxes.some(b=>b[0]===-180)) boxes=boxes.map(b=>b[2]===180?[b[0],b[1],179.75,b[3]]:b).filter(b=>b[0]<=b[2]);
    return boxes;
  }
  function cdsRequests(config) {
    if (config.intervalParameters) {
      const next=date=>new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10);
      const first=cdsRequests({...config,end:config.start,intervalParameters:false}).map(plan=>({...plan,request:{...plan.request,time:plan.request.time.slice(1)},target:plan.target.replace('.grib','_first-day.grib')}));
      const middle=config.start<config.end?cdsRequests({...config,start:next(config.start),intervalParameters:false}):[];
      const last=cdsRequests({...config,start:next(config.end),end:next(config.end),intervalParameters:false}).map(plan=>({...plan,request:{...plan.request,time:['00:00']},target:plan.target.replace('.grib','_closing-hour.grib')}));
      return [...first,...middle,...last];
    }
    const requests = [], start = new Date(config.start + 'T00:00:00Z'), end = new Date(config.end + 'T00:00:00Z');
    let year = start.getUTCFullYear(), month = start.getUTCMonth() + 1;
    while (year < end.getUTCFullYear() || year === end.getUTCFullYear() && month <= end.getUTCMonth() + 1) {
      const first = year === start.getUTCFullYear() && month === start.getUTCMonth() + 1 ? start.getUTCDate() : 1;
      const last = year === end.getUTCFullYear() && month === end.getUTCMonth() + 1 ? end.getUTCDate() : new Date(Date.UTC(year, month, 0)).getUTCDate();
      const day = Array.from({length: last - first + 1}, (_, i) => String(i + first).padStart(2, '0'));
      config.boxes.forEach((box, i) => requests.push({dataset: config.dataset, request: {product_type: ['reanalysis'], variable: config.variables, year: [String(year)], month: [String(month).padStart(2, '0')], day, time: Array.from({length: 24}, (_, h) => String(h).padStart(2, '0') + ':00'), data_format: 'grib', download_format: 'unarchived', area: [box[3], box[0], box[1], box[2]]}, target: config.productId + '_' + year + String(month).padStart(2, '0') + '_box' + (i + 1) + '.grib'}));
      month++; if (month === 13) {month = 1; year++;}
    }
    return requests;
  }
  function scriptHeader(config) {return '# Prepared by Climate-Hazard Dataset Inventory. Review before --execute.\nimport json\nCONFIG = json.loads(' + JSON.stringify(JSON.stringify(config)) + ')\n';}
  function cdsScript(config) {
    return scriptHeader(config) + String.raw`
import argparse
import calendar
import datetime as dt
import hashlib
import os
import re
from pathlib import Path

def safe_diagnostic(error, client=None):
    message = str(error).replace('\\/', '/')[:8192]
    for value in (os.environ.get('CDSAPI_KEY'), getattr(client, 'key', None)):
        if isinstance(value, str) and len(value) >= 4:
            message = message.replace(value, '[redacted]')
            for part in value.split(':'):
                if len(part) >= 4: message = message.replace(part, '[redacted]')
    message = re.sub(r'https?://[^\s<>"\']+', '[provider URL omitted]', message, flags=re.I)
    message = re.sub(r'\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+', r'\1 [redacted]', message, flags=re.I)
    message = re.sub(r'''\b(authorization|proxy-authorization|x-api-key|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|secret|client_secret|key|x-amz-(?:credential|security-token|signature)|x-goog-(?:credential|signature))["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)''', r'\1=[redacted]', message, flags=re.I)
    message = re.sub(r'''\b(token|password|secret|api key|key)\s+["'][^"']+["']''', r'\1 [redacted]', message, flags=re.I)
    message = re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b', '[redacted token]', message)
    message = re.sub(r'[\x00-\x1f\x7f]+', ' ', message)
    return (type(error).__name__ + ': ' + ' '.join(message.split()))[:800]

def planned_requests():
    yield from CONFIG['requests']

def main():
    parser = argparse.ArgumentParser(description='Dry-run CDS requests. --execute uses your locally configured CDS credentials.')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--confirm-transfer', action='store_true', help='Explicitly accept the unknown total transfer size after reviewing the selected requests.')
    parser.add_argument('--request', type=int, action='append', help='Choose a prepared request by number, starting at 1. Repeat to select several. The default includes all prepared requests.')
    parser.add_argument('--output', type=Path, default=Path(CONFIG['productId'] + '_data'))
    args = parser.parse_args()
    available = list(planned_requests())
    if args.request and any(number < 1 or number > len(available) for number in args.request):
        parser.error('Request number is outside the prepared list; no request was sent')
    selected_numbers = [number for number in range(1, len(available) + 1) if not args.request or number in args.request]
    plans = [available[number - 1] for number in selected_numbers]
    summary = {'fileCount':len(plans), 'requestCount':len(plans), 'knownBytes':0, 'unknownCount':len(plans), 'approximateCount':0,
               'requiresConfirmation':bool(plans), 'byteThreshold':1000000000, 'fileThreshold':100, 'unit':CONFIG.get('requestUnit','monthly/spatial requests')}
    if not args.execute:
        print(json.dumps({'mode': 'dry-run', 'requestCount': len(plans), 'availableRequestCount':len(available), 'selectedRequestNumbers':selected_numbers, 'requests': plans, 'transferSummary':summary,
                          'qualification': CONFIG['qualification']}, indent=2))
        return 0
    if plans and not args.confirm_transfer:
        parser.error('No CDS client or network request started. Selected request count: ' + str(len(plans)) + '; total transfer size is unknown. Review the dry run, narrow with --request N if needed, and explicitly accept with --confirm-transfer.')
    if (args.output / 'retrieval-manifest.json').exists() or any((args.output / plan['target']).exists() for plan in plans):
        raise FileExistsError('Use a new output folder; existing data or a manifest will not be overwritten.')
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = {'configuration': CONFIG, 'requests': plans, 'selectedRequestNumbers':selected_numbers, 'availableRequestCount':len(available),
                'transferSummary':summary, 'explicitTransferConfirmation':args.confirm_transfer, 'files': [], 'complete': False,
                'qualification': 'Downloaded bytes only; scientific metadata and suitability still require inspection.'}
    status = 0
    client = None
    try:
        import cdsapi
        client = cdsapi.Client(quiet=True, debug=False, progress=False)
        for plan in plans:
            target = args.output / plan['target']
            client.retrieve(plan['dataset'], plan['request'], str(target))
            if not target.is_file() or target.stat().st_size == 0:
                raise RuntimeError('CDS retrieval returned without a nonempty target file')
            digest = hashlib.sha256()
            with target.open('rb') as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b''):
                    digest.update(chunk)
            manifest['files'].append({'path': str(target), 'bytes': target.stat().st_size,
                                      'sha256': digest.hexdigest(), 'retrievedAt': dt.datetime.now(dt.timezone.utc).isoformat()})
            (args.output / 'retrieval-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        manifest['complete'] = True
    except (Exception, KeyboardInterrupt) as error:
        manifest['error'] = safe_diagnostic(error, client)
        status = 2
    finally:
        (args.output / 'retrieval-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'complete': manifest['complete'], 'filesReceived': len(manifest['files']),
                      'manifest': str(args.output / 'retrieval-manifest.json'), 'error': manifest.get('error')}, indent=2))
    return status

if __name__ == '__main__':
    raise SystemExit(main())
`;
  }
  function mrmsScript(config) {
    return scriptHeader(config) + String.raw`
import argparse
import datetime as dt
import gzip
import hashlib
import html
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

def days():
    day, end = dt.date.fromisoformat(CONFIG['start']), dt.date.fromisoformat(CONFIG['end'])
    while day <= end:
        yield day
        day += dt.timedelta(days=1)

def listing_url(prefix, token=None):
    params = {'list-type': '2', 'prefix': prefix, 'max-keys': '1000'}
    if token is not None:
        params['continuation-token'] = token
    return CONFIG['endpoint'] + '?' + urllib.parse.urlencode(params)

def file_links_html(manifest, manifest_path):
    escape = lambda value: html.escape(str(value), quote=True)
    status = 'Complete listing' if manifest['complete'] else 'Partial or failed listing'
    rows = ''.join('<tr><td>' + str(number) + '</td><td><a href="' + escape(item['url']) + '" target="_blank" rel="noopener noreferrer">' + escape(item['key'].rsplit('/', 1)[-1]) + '</a></td><td>' + format(item['bytes'], ',') + '</td></tr>' for number, item in enumerate(manifest['files'], 1))
    error = '<p><strong>Stopped:</strong> ' + escape(manifest['error']) + '</p>' if manifest.get('error') else ''
    transfer = manifest.get('transfer') or {}
    transfer_note = '<p>Optional script transfer: ' + str(len(transfer.get('files', []))) + ' files saved; ' + str(len(transfer.get('failures', []))) + ' failed. ' + escape(transfer.get('blocked', 'Complete selected transfer.' if transfer.get('complete') else 'Selected transfer incomplete.')) + '</p>' if transfer.get('requested') else ''
    warnings = ''.join('<p><strong>Archive warning:</strong> ' + escape(warning) + '</p>' for warning in manifest.get('warnings', []))
    return ('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>MRMS provider file links</title><style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:0 20px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:10px;border-bottom:1px solid #ccc}a{overflow-wrap:anywhere}td:last-child{white-space:nowrap}</style>'
            '<h1>' + escape(CONFIG['productId']) + ': provider files</h1><h2>' + status + '</h2><p>' + escape(CONFIG['start']) + ' through ' + escape(CONFIG['end']) + ': ' + str(len(manifest['files'])) + ' observed file links.</p>'
            '<p>Select a link to retrieve that provider file. Nothing is downloaded automatically by this page. These are whole CONUS grids, without project clipping or averaging. Listing metadata do not verify scientific payloads.</p>'
            '<p>' + escape(manifest['qualification']) + '</p>' + warnings + error + transfer_note + '<p><a href="' + escape(urllib.parse.quote(manifest_path.name)) + '">Open the accompanying provenance JSON</a></p>'
            '<table><thead><tr><th>File number</th><th>Provider file</th><th>Bytes</th></tr></thead><tbody>' + rows + '</tbody></table>'
            + ('<p>No links were returned. This is not evidence that no observations exist.</p>' if not rows else '') + '</html>')

def download_files(manifest, args, persist):
    files = manifest['files']
    report = manifest['transfer'] = {'requested':True, 'complete':False, 'files':[], 'failures':[], 'explicitTransferConfirmation':args.confirm_transfer,
                                    'qualification':'Original compressed bytes, gzip integrity and GRIB2 header only; no scientific QA, clipping or conversion.'}
    if not manifest['complete']:
        report['blocked'] = 'Metadata listing is incomplete. No payloads were requested; inspect the retained links and listing error.'
        return 2
    if args.file and any(number < 1 or number > len(files) for number in args.file):
        report['blocked'] = 'A --file number is outside the observed listing. No payloads were requested.'
        return 2
    selected = [(number, item) for number, item in enumerate(files, 1) if not args.file or number in args.file]
    total = sum(item['bytes'] for _, item in selected)
    report['transferSummary'] = {'fileCount':len(selected), 'knownBytes':total, 'unknownCount':0, 'approximateCount':0,
                                 'requiresConfirmation':total >= 1000000000 or len(selected) > 100, 'byteThreshold':1000000000, 'fileThreshold':100}
    report['selectedFileNumbers'] = [number for number, _ in selected]
    if report['transferSummary']['requiresConfirmation'] and not args.confirm_transfer:
        report['blocked'] = 'No payloads requested: selection is at least 1 GB or more than 100 files. Review the totals and narrow with --file N. If deliberately accepting this transfer, use --confirm-transfer; the matching saved listing will be reused without overwriting it.'
        return 2
    if not selected:
        report['blocked'] = 'No provider files were listed for download. Empty listings do not prove absent observations.'
        return 2
    args.download_dir.mkdir(parents=True, exist_ok=True)
    persist()
    for number, item in selected:
        name = re.sub(r'[^A-Za-z0-9._-]', '_', item['key'].rsplit('/', 1)[-1])
        target, partial = args.download_dir / name, args.download_dir / (name + '.part')
        try:
            if not name or name in ('.', '..') or target.exists() or partial.exists():
                raise FileExistsError('Target or partial already exists, or filename is invalid; nothing overwritten')
            digest, size = hashlib.sha256(), 0
            with urllib.request.urlopen(urllib.request.Request(item['url'], headers={'User-Agent':'Climate-Hazard-Inventory/0.2'}), timeout=90) as response:
                if response.status != 200: raise ValueError('Expected complete HTTP 200 response')
                expected = response.headers.get('Content-Length')
                if expected is not None and int(expected) != item['bytes']: raise ValueError('Response size differs from the observed object listing')
                first = response.read(min(65536, item['bytes'] + 1))
                if len(first) > item['bytes']: raise ValueError('Response exceeds its observed object size')
                if not first.startswith(b'\x1f\x8b') or 'text/html' in response.headers.get('Content-Type', '').lower(): raise ValueError('Expected gzip-compressed GRIB2, not an HTML/login response')
                with partial.open('xb') as output:
                    chunk = first
                    while chunk:
                        output.write(chunk); digest.update(chunk); size += len(chunk)
                        chunk = response.read(min(1048576, item['bytes'] - size + 1))
                        if size + len(chunk) > item['bytes']: raise ValueError('Response exceeds observed object size; partial retained')
                if size != item['bytes']: raise ValueError('Incomplete transfer; partial retained')
            with gzip.open(partial, 'rb') as compressed:
                header = compressed.read(8)
                if len(header) != 8 or header[:4] != b'GRIB' or header[7] != 2: raise ValueError('Decompressed payload is not a GRIB2 header; partial retained')
                while compressed.read(1048576): pass
            partial.rename(target)
            report['files'].append({'fileNumber':number, 'file':name, 'path':str(target), 'url':item['url'], 'bytes':size,
                                    'sha256':digest.hexdigest(), 'providerETag':item.get('providerETag'), 'retrievedAt':dt.datetime.now(dt.timezone.utc).isoformat()})
            print('Saved', name, size, 'bytes', file=sys.stderr)
        except KeyboardInterrupt:
            report['cancelled'] = True
            report['failures'].append({'fileNumber':number, 'url':item['url'], 'error':'Cancelled by user; partial files retained', 'partialFile':str(partial) if partial.exists() else None})
            return 130
        except Exception as error:
            report['failures'].append({'fileNumber':number, 'url':item['url'], 'error':type(error).__name__ + ': ' + str(error), 'partialFile':str(partial) if partial.exists() else None})
        finally:
            persist()
    report['complete'] = not report['failures'] and len(report['files']) == len(selected)
    return 0 if report['complete'] else 2

def validate_saved_listing(manifest):
    if not isinstance(manifest, dict) or manifest.get('configuration') != CONFIG or manifest.get('complete') is not True or manifest.get('error'):
        raise ValueError('Saved listing is incomplete or does not match this exact prepared configuration. No payload request sent; choose a fresh --output to make a new listing.')
    if not isinstance(manifest.get('files'), list) or not isinstance(manifest.get('requests'), list):
        raise ValueError('Saved listing files or request records are invalid; no payload request sent')
    expected_days = {day.strftime('%Y%m%d') for day in days()}
    counts, seen_keys = {}, set()
    for item in manifest['files']:
        key = item.get('key', '') if isinstance(item, dict) else ''
        match = re.fullmatch(re.escape(CONFIG['prefix']) + r'(\d{8})/([^/]+\.grib2\.gz)', key)
        if not match or match[1] not in expected_days or key in seen_keys or item.get('url') != CONFIG['endpoint'] + urllib.parse.quote(key, safe='/') or type(item.get('bytes')) is not int or item['bytes'] < 0:
            raise ValueError('Saved listing contains an invalid or unexpected provider file; no payload request sent')
        seen_keys.add(key); counts[match[1]] = counts.get(match[1], 0) + 1
    pages, last, next_tokens, seen_urls = {}, {}, {}, set()
    for request in manifest['requests']:
        if not isinstance(request, dict): raise ValueError('Saved listing request is invalid; no payload request sent')
        url = urllib.parse.urlsplit(request.get('url', ''))
        params = urllib.parse.parse_qs(url.query, keep_blank_values=True)
        prefix = params.get('prefix', [''])[0]
        date = prefix[len(CONFIG['prefix']):-1] if prefix.startswith(CONFIG['prefix']) and prefix.endswith('/') else ''
        if url.scheme + '://' + url.netloc + url.path != CONFIG['endpoint'] or url.fragment or date not in expected_days or params.get('list-type') != ['2'] or params.get('max-keys') != ['1000'] or any(len(v) != 1 for v in params.values()) or not set(params).issubset({'list-type','prefix','max-keys','continuation-token'}) or request['url'] in seen_urls or last.get(date) is False or type(request.get('objects')) is not int or not 0 <= request['objects'] <= 1000 or type(request.get('isTruncated')) is not bool:
            raise ValueError('Saved listing pagination record is inconsistent; no payload request sent')
        token = params.get('continuation-token', [None])[0]
        expected_token = next_tokens.get(date)
        following = request.get('nextContinuationToken')
        if token != expected_token or (request['isTruncated'] and (not isinstance(following, str) or not following or following == token)) or (not request['isTruncated'] and following is not None):
            raise ValueError('Saved listing is missing its initial page or has an inconsistent continuation chain; no payload request sent')
        seen_urls.add(request['url']); pages[date] = pages.get(date, 0) + request['objects']; last[date] = request['isTruncated']; next_tokens[date] = following
    if set(last) != expected_days or any(last[date] or pages[date] != counts.get(date, 0) for date in expected_days):
        raise ValueError('Saved listing does not establish complete metadata traversal for these dates; no payload request sent')

def main():
    parser = argparse.ArgumentParser(description='Dry-run unsigned MRMS listings. --execute lists links only; --download explicitly lists then downloads selected original files.')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--download', action='store_true', help='Discover files and download the selected original gzip GRIB2 payloads; implies --execute.')
    parser.add_argument('--file', type=int, action='append', help='One-based file number from the listing; repeat to select. Download default is all listed files.')
    parser.add_argument('--confirm-transfer', action='store_true', help='Explicitly accept at least 1 GB or more than 100 files after reviewing the transfer summary.')
    parser.add_argument('--download-dir', type=Path, default=Path(CONFIG['productId'] + '_provider_files'))
    parser.add_argument('--output', type=Path, default=None, help='JSON manifest path; an HTML file-link page is written beside it.')
    args = parser.parse_args()
    html_path = args.output.with_suffix('.html') if args.output is not None else Path(CONFIG['productId'] + '_file-links.html')
    args.output = args.output or Path(CONFIG['productId'] + '_file-manifest.json')
    if html_path == args.output:
        parser.error('--output must name a JSON manifest, not the companion .html page')
    start, end = dt.date.fromisoformat(CONFIG['start']), dt.date.fromisoformat(CONFIG['end'])
    if not args.execute and not args.download:
        print(json.dumps({'mode': 'dry-run', 'initialDateListings': (end - start).days + 1,
                          'firstListing': listing_url(CONFIG['prefix'] + start.strftime('%Y%m%d') + '/'),
                          'lastListing': listing_url(CONFIG['prefix'] + end.strftime('%Y%m%d') + '/'),
                          'manifest': str(args.output), 'fileLinksPage': str(html_path), 'warnings': CONFIG.get('archiveWarnings', []),
                          'pagination': 'All returned continuation tokens will be followed; pages may increase the request count.',
                          'actionOnExecute': 'Discover metadata and write links only; no GRIB2 files are downloaded.',
                          'actionOnDownload':'List then stream selected original gzip GRIB2 files; at least 1 GB or more than 100 files requires --confirm-transfer.'}, indent=2))
        return 0
    reused = args.download and args.output.exists()
    if not reused and (html_path.exists() or args.output.exists()):
        raise FileExistsError('The HTML file-link page or JSON manifest already exists. Choose a new --output basename; no request has been sent.')
    manifest = {'configuration': CONFIG, 'requests': [], 'files': [], 'complete': False,
                'warnings':CONFIG.get('archiveWarnings', []),
                'qualification': 'Completion refers only to these unsigned object listings. Empty listings do not establish absent observations in other archives. Payload transfer status is reported separately; site validity remains unassessed.'}
    if reused:
        manifest = json.loads(args.output.read_text(encoding='utf-8'))
        validate_saved_listing(manifest)
    def persist():
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    seen_keys, status = set(), 0
    if not reused:
        try:
            for day in days():
                prefix, token, seen_tokens = CONFIG['prefix'] + day.strftime('%Y%m%d') + '/', None, set()
                while True:
                    url = listing_url(prefix, token)
                    with urllib.request.urlopen(urllib.request.Request(url, headers={'Accept': 'application/xml'}), timeout=45) as response:
                        raw = response.read(8 * 1024 * 1024 + 1)
                        if len(raw) > 8 * 1024 * 1024:
                            raise ValueError('Provider listing exceeds the response-size bound')
                    document = ET.fromstring(raw)
                    if document.tag.rsplit('}', 1)[-1] != 'ListBucketResult' or document.findtext('{*}Prefix') != prefix:
                        raise ValueError('Unexpected object-list response or prefix')
                    truncated = document.findtext('{*}IsTruncated')
                    if truncated not in ('true', 'false'):
                        raise ValueError('Missing pagination status')
                    next_token = document.findtext('{*}NextContinuationToken') if truncated == 'true' else None
                    if truncated == 'true' and (not next_token or next_token in seen_tokens):
                        raise ValueError('Missing or repeated continuation token')
                    contents, key_count = document.findall('{*}Contents'), document.findtext('{*}KeyCount')
                    if key_count is None or not key_count.isdigit() or int(key_count) != len(contents):
                        raise ValueError('Object count disagrees with the page; completeness unresolved')
                    page_files, page_keys = [], set()
                    for item in contents:
                        key, size = item.findtext('{*}Key'), item.findtext('{*}Size')
                        if not key or not key.startswith(prefix) or any(part in ('.', '..') for part in key.split('/')) or not key.endswith('.grib2.gz') or not size or not size.isdigit():
                            raise ValueError('Unexpected object key or size; no partial page accepted')
                        if key in seen_keys or key in page_keys:
                            raise ValueError('Repeated object key; listing completeness unresolved')
                        page_keys.add(key)
                        page_files.append({'key': key, 'url': CONFIG['endpoint'] + urllib.parse.quote(key, safe='/'),
                                           'bytes': int(size), 'lastModified': item.findtext('{*}LastModified'),
                                           'providerETag': item.findtext('{*}ETag'), 'payloadVerified': False,
                                           'spatialDelivery': 'Full CONUS grid; no clipping or averaging.'})
                    manifest['files'].extend(page_files)
                    seen_keys.update(page_keys)
                    manifest['requests'].append({'url': url, 'retrievedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'objects': len(page_files), 'isTruncated': truncated == 'true', 'nextContinuationToken': next_token})
                    if next_token is None:
                        break
                    seen_tokens.add(next_token)
                    token = next_token
                    time.sleep(1)
                time.sleep(1)
            manifest['complete'] = True
        except (Exception, KeyboardInterrupt) as error:
            manifest['error'] = type(error).__name__ + ': ' + str(error)
            status = 2
        finally:
            persist()
    if not html_path.exists():
        with html_path.open('x', encoding='utf-8') as output:
            output.write(file_links_html(manifest, args.output))
    transfer_receipt = None
    if args.download:
        source_bytes = args.output.read_bytes()
        manifest['listingReceipt'] = {'path':str(args.output), 'sha256':hashlib.sha256(source_bytes).hexdigest(), 'reused':bool(reused)}
        transfer_receipt = args.output.with_name(args.output.stem + '_transfer-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.json')
        with transfer_receipt.open('x', encoding='utf-8') as output:
            output.write(json.dumps(manifest, indent=2) + '\n')
        def persist_transfer():
            transfer_receipt.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        try:
            status = download_files(manifest, args, persist_transfer)
        except Exception as error:
            manifest.setdefault('transfer', {'requested':True, 'complete':False, 'files':[], 'failures':[]})['blocked'] = type(error).__name__ + ': ' + str(error)
            status = 2
        finally:
            persist_transfer()
    transfer = manifest.get('transfer') or {}
    print(json.dumps({'complete': manifest['complete'], 'objectsListed': len(manifest['files']),
                      'payloadsDownloaded': len(transfer.get('files', [])), 'downloadComplete':transfer.get('complete'),
                      'transferSummary':transfer.get('transferSummary'), 'transferBlocked':transfer.get('blocked'), 'payloadFailures':len(transfer.get('failures', [])),
                      'manifest': str(args.output), 'fileLinksPage': str(html_path), 'transferReceipt':str(transfer_receipt) if transfer_receipt else None, 'reusedListing':bool(reused), 'error': manifest.get('error')}, indent=2))
    return status

if __name__ == '__main__':
    raise SystemExit(main())
`;
  }
  function prepare(profile, query, options = {}) {
    const errors = [], notes = [], requests = [], artifacts = [];
    const id = profile?.id || profile?.product_id || profile?.productId;
    if (!supported.includes(id)) errors.push('This product has no executable request preparation route.');
    if (!query || !validDate(query.start) || !validDate(query.end) || query.start > query.end) errors.push('Enter valid inclusive project dates.');
    else if (query.end > new Date().toISOString().slice(0, 10)) errors.push('Historical request dates cannot extend into the future.');
    if (!geometry()) errors.push('Project geometry validation is unavailable.');
    else errors.push(...geometry().validate(query));
    if (errors.length) return {requests, artifacts, notes, errors};
    const mapping = profile.parameterMapping || {};
    let config, script, instructions, transferSummary = null;
    if (id==='c3s_lake_water_level') {
      const target=options.lakeTarget;
      if (!target || !profile.options?.find(o=>o.key==='lakeTarget')?.choices.some(c=>c.value===target))
        return {requests,artifacts,notes,errors:['Choose a monitored lake from the provider catalogue.']};
      if (query.end<'1992-01-01') return {requests,artifacts,notes,errors:['The lake altimetry collection starts in 1992.']};
      const [region,lake]=target.split('/');
      requests.push({dataset:'satellite-lake-water-level',request:{variable:'all',region:[region],lake:[lake]},target:lake+'_water_level.download'});
      config={productId:id,query:copy(query),requestUnit:'lake records',requests,qualification:'Full named-lake record; filter the delivered dates to the project window and check height reference and uncertainty.'};
      script=cdsScript(config);
      instructions='Review the prepared request with python '+id+'_request.py. After accepting the CDS terms and configuring cdsapi locally, add --execute --confirm-transfer to retrieve the full lake record. The .download file contains the provider response; inspect it for NetCDF or a packaged NetCDF file.';
      notes.push(config.qualification);
      transferSummary={requestCount:1,fileCount:1,knownBytes:0,unknownCount:1,requiresConfirmation:true,unit:'lake records'};
    } else if (CDS[id]) {
      const intervalParameters=id==='era5_t2m_interval_extrema'||id==='era5_gust10';
      if (query.start < '1940-01-01') errors.push('This ERA5 route starts in 1940. Choose an in-scope period; dates will not be silently discarded.');
      if (intervalParameters && query.end>=new Date().toISOString().slice(0,10)) errors.push('Hourly interval variables need 00:00 UTC on the following day. Choose a completed UTC day as the end date.');
      if (mapping.dataset !== 'reanalysis-era5-single-levels' || JSON.stringify(mapping.variable) !== JSON.stringify(CDS[id]) || JSON.stringify(mapping.product_type) !== '["reanalysis"]' || mapping.data_format !== 'grib') errors.push('The ERA5 profile does not match the verified dataset, variables, stream or format.');
      if (errors.length) return {requests, artifacts, notes, errors};
      const latestTypicalDay=new Date(Date.now()-5*86400000).toISOString().slice(0,10);
      const lastRequestedDay=intervalParameters?new Date(Date.parse(query.end+'T00:00:00Z')+86400000).toISOString().slice(0,10):query.end;
      if (lastRequestedDay>latestTypicalDay) notes.push(`Availability warning: this request includes ${lastRequestedDay}, within the usual ERA5T publication delay of about five days. The newest requested hours may not exist yet. ${intervalParameters?'Interval variables also require 00:00 UTC after the final project day. ':''}Choose an earlier end or check the CDS file dates before running; the request dates are unchanged.`);
      notes.push('Prepared CDS requests only. Authenticated retrieval has not been tested here; no credentials were accessed.',
        query.mode === 'area' ? 'Requests use bounding boxes around the original project geometry, with zero station-search buffer. Dateline parts are requested separately. The output is not polygon clipped or area averaged.' : 'The point is represented by an explicit 0.25-degree longitude by 0.25-degree latitude coordinate bracket (clamped at the poles and split at the dateline). This requests grid support, not point interpolation or a guaranteed nearest grid cell.',
        intervalParameters ? 'Requests are split by month, spatial box and boundary-hour selections. Reanalysis HRES and GRIB are fixed; values are not aggregated or converted.' : 'Each calendar month and spatial box is a separate request, using the requested days and all 24 UTC hours. Reanalysis HRES and GRIB are fixed; values are not aggregated or converted.',
        'Inspect received GRIB grid, time, forecast-step and interval metadata. Later ERA5T records can be revised; successful transfer does not qualify the data scientifically.');
      if (intervalParameters) notes.push('Hourly intervals are requested from 01:00 UTC on the first project day through 00:00 UTC on the day after the final project day. The first midnight is omitted and the closing midnight is added. Each value describes the preceding hour; no daily aggregation is performed.');
      if (query.mode==='area') notes.push('Each area bounding box is expanded outward to the 0.25-degree grid. The requested grid can extend outside the original project area; inspect or clip it after download.');
      config = {productId: id, dataset: mapping.dataset, variables: copy(CDS[id]), start: query.start, end: query.end, intervalParameters, boxes: requestBoxes(query), originalQuery: copy(query), temporalDelivery: profile.temporalDelivery || null, parameterMetadata: copy(mapping.fields || {}), documentationUrls: copy(profile.documentationUrls || []), qualification: notes.join(' ')};
      config.requests=cdsRequests(config);requests.push(...config.requests); script = cdsScript(config);
      transferSummary = {fileCount:requests.length,requestCount:requests.length,knownBytes:0,unknownCount:requests.length,approximateCount:0,requiresConfirmation:requests.length>0,byteThreshold:1000000000,fileThreshold:100,unit:'monthly/spatial requests'};
      instructions = 'Run python ' + id + '_request.py to inspect the dry-run request count, numbered monthly/spatial requests and unknown total size. No network request or credential access occurs in dry-run. Repeat --request N to select individual requests; omitting it selects all prepared requests.\nTo retrieve: accept the dataset terms on CDS, configure your own local personal access token as documented at https://cds.climate.copernicus.eu/how-to-api, and install cdsapi>=0.7.7. --execute alone stops before client/network access because size is unknown. Only after reviewing and accepting the transfer, run python ' + id + '_request.py --execute --confirm-transfer --output chosen-folder, adding --request N if selecting a subset. There is no size cap after explicit confirmation.\nAuthenticated retrieval was not tested. GRIB files and a transfer manifest with SHA-256 hashes will be written only on execution. Provider failures are reported with bounded, redacted diagnostics. The manifest does not replace scientific metadata checks.\n';
    } else {
      const prefix = options.mrmsField === undefined ? MRMS[id][0] : options.mrmsField;
      if (!MRMS[id].includes(prefix) || JSON.stringify(mapping.verifiedCONUSPrefixes) !== JSON.stringify(MRMS[id])) errors.push('Select a verified CONUS field/pass from this product profile.');
      if (errors.length) return {requests, artifacts, notes, errors};
      const endpoint = 'https://noaa-mrms-pds.s3.amazonaws.com/', days = Math.round((Date.parse(query.end + 'T00:00:00Z') - Date.parse(query.start + 'T00:00:00Z')) / 86400000) + 1;
      const archiveReview = {firstObservedDate:'2020-10-14', checkedAt:'2026-11-14',
        listingUrl:endpoint+'?'+new URLSearchParams({'list-type':'2',prefix,delimiter:'/', 'max-keys':'1'}),
        documentationUrl:'https://registry.opendata.aws/noaa-mrms-pds/', qualification:'Earliest current date prefix observed for this field in a dated S3 directory lookup; not a guarantee of complete holdings or absence in other archives.'};
      const archiveWarnings = query.start < archiveReview.firstObservedDate ? ['The requested period includes dates before '+archiveReview.firstObservedDate+', the earliest date prefix observed for this field in the NOAA AWS archive on '+archiveReview.checkedAt+'. Earlier date listings may be empty; this does not establish absence of MRMS observations elsewhere. Original request dates are unchanged. Source: '+archiveReview.listingUrl] : [];
      notes.push(...archiveWarnings,
        '--execute performs unsigned S3 discovery and saves file links only. Optional --download additionally transfers selected original gzip GRIB2 files with byte counts, SHA-256 and failure receipts.',
        'Only the explicitly selected, verified CONUS product prefix is prepared. Project geometry is retained as context; full domain files are not clipped or area averaged.',
        'The script iterates every requested UTC date and all returned continuation tokens. Date URLs are listing requests, not guessed file URLs. Empty or failed listings do not establish absence of observations in other archives.',
        'Payload selections of at least 1 GB or more than 100 files require explicit --confirm-transfer after reviewing the totals. --file N can restrict the transfer to individual listed files; listing JSON/HTML alone never starts a payload download.',
        'Pin field, pass, accumulation window and algorithm/date. An MRMS field timestamp or refresh interval does not redefine its accumulation period.');
      config = {productId: id, endpoint, prefix, start: query.start, end: query.end, originalQuery: copy(query), archiveReview, archiveWarnings, temporalDelivery: profile.temporalDelivery || null, parameterMetadata: copy(mapping.fields || {}), missingValue: mapping.missing ?? null, outsideCoverageValue: mapping.outsideCoverage ?? null, documentationUrls: copy(profile.documentationUrls || []), qualification: notes.join(' ')};
      const firstPrefix = prefix + query.start.replace(/-/g, '') + '/';
      requests.push({method: 'GET', url: endpoint + '?' + new URLSearchParams({'list-type': '2', prefix: firstPrefix, 'max-keys': '1000'}), purpose: 'First date listing; the script generates all dates lazily and follows pagination.', dateRange: {start: query.start, end: query.end}, initialDateListings: days, payloadDownload: false});
      script = mrmsScript(config);
      instructions = 'Run python ' + id + '_request.py for the date-listing count, archive warning and first/last URLs. It does not contact the network.\nRun with --execute to discover object metadata and write ' + id + '_file-manifest.json and ' + id + '_file-links.html. Double-click the HTML file to choose provider data downloads. No credentials or extra Python packages are required. --execute does NOT download the GRIB2 files.\nOptional: run with --download --file 1 to download file number 1. A completed saved listing is reused only after its exact project configuration, provider paths and pagination records are validated. Without a saved listing, the script first discovers files. Repeat --file N for more files; omitting it selects all current listed files. Payloads go to ' + id + '_provider_files/ unless --download-dir is supplied. A reused listing is a dated snapshot; inspect dates and names. Use a fresh --output filename to request a new listing.\nThe script blocks transfers of at least 1 GB or more than 100 files before requesting payloads. Review its totals, choose fewer files, or explicitly accept the size with --confirm-transfer. Do not add this flag without reviewing the transfer.\nWith --output chosen.json, the companion link page is chosen.html beside it. Existing listing JSON/HTML, payloads and partial files are preserved. Each --download attempt writes a new dated transfer receipt beside the listing; a blocked large transfer can be narrowed or explicitly confirmed on the next run without changing filenames.\nListing complete and transfer complete are separate. A failed payload is retained in the receipt and later files are attempted; partial failures return exit code 2. Cancel stops further transfers and retains received bytes. Provider files are checked for compressed length, gzip integrity and a GRIB2 header, not scientific suitability. The source archive is live, not an atomic snapshot.\n';
    }
    artifacts.push({name: id + '_request.py', mime: 'text/x-python', text: script, role: 'request'}, {name: id + '_request-config.json', mime: 'application/json', text: JSON.stringify(config, null, 2) + '\n', role: 'request'}, {name: id + '_instructions.txt', mime: 'text/plain', text: instructions + '\n' + notes.join('\n') + '\n', role: 'instructions'});
    return {productId: id, query: copy(query), requests, artifacts, notes, errors, transferSummary};
  }
  const api = {supported, describeOptions, prepare};
  root.SiteProviderRequests = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
