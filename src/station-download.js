/* Explicit project-period station transfers. Planning never starts a download. */
(function (root) {
  'use strict';
  const DAY = 86400000, SLOT = 360000;
  const moduleFor = (name, file) => root[name] || (typeof require === 'function' ? require('./' + file) : null);
  const copy = value => JSON.parse(JSON.stringify(value));
  const iso = value => new Date(value).toISOString();
  const date = value => iso(value).slice(0, 10);
  function prepare(productId, station, query) {
    try {
      const providers = moduleFor('SiteProviders', 'providers.js');
      // Reuse station, query and known-overlap validation, but never the preview's duration cap.
      const base = new URL(providers.requestURL(productId, station, query));
      const requests = [], notes = [], unrequestedIntervals = [];
      const start = Date.parse(query.start + 'T00:00:00Z'), end = Date.parse(query.end + 'T00:00:00Z');
      let datum = null, directUrl = null;
      const add = (url, first, last, exact = false) => {
        const number = requests.length + 1;
        requests.push({url: url.href, start: date(first), end: date(last),
          ...(exact ? {startTime: iso(first), endTime: iso(last)} : {}),
          name: productId + '_' + station.id + '_' + date(first) + '_' + date(last) + '_part' + number + '.json'});
      };
      if (productId === 'ghcn_daily') {
        const direct = new URL(base); direct.searchParams.set('startDate', query.start);
        direct.searchParams.set('endDate', query.end); direct.searchParams.set('format', 'csv'); directUrl = direct.href;
        for (let cursor = start; cursor <= end;) {
          const last = Math.min(end, Date.parse(date(cursor).slice(0, 4) + '-12-31T00:00:00Z'));
          const url = new URL(base); url.searchParams.set('startDate', date(cursor)); url.searchParams.set('endDate', date(last));
          add(url, cursor, last); cursor = last + DAY;
        }
        notes.push('GHCN requests TMAX, TMIN, PRCP and SNOW plus MDPR/DAPR and MDSF/DASF multi-day context with provider attributes in metric units. Multi-day totals are retained separately, never distributed across daily values. The direct CSV uses the exact project dates; the optional script splits the same dates by calendar year for recoverable transfers. Both routes request only the project dates.');
      } else if (productId === 'noaa_coops_water_level') {
        const inventory = moduleFor('SiteCoopsAvailability', 'coops-availability.js');
        const spec = inventory.productSpec(station), SLOT = spec.cadenceMs;
        const availability = providers.assessCoopsStation(station, query);
        if (!['match', 'partial'].includes(availability.state) || !availability.selectedDatum) throw new Error('Check the selected product inventory and select a supported datum before preparing the project-period transfer.');
        datum = availability.selectedDatum;
        const lastRequested = end + DAY - SLOT;
        const intervals = inventory.observationIntervals(availability.selectedPeriods, SLOT)
          .map(p => ({start: Math.max(start, p.start), end: Math.min(lastRequested, p.end)})).filter(p => p.start <= p.end);
        let cursor = start;
        for (const interval of intervals) {
          if (interval.start > cursor) unrequestedIntervals.push({startTime: iso(cursor), endTime: iso(interval.start - SLOT),
            reason: 'Not scheduled: outside retained ' + spec.periodLabel + ' inventory intervals. Later availability can be unresolved; this is not proof of absence.'});
          for (let first = interval.start; first <= interval.end;) {
            const last = Math.min(interval.end, Math.floor(first / DAY) * DAY + spec.maxDays * DAY - SLOT);
            const url = new URL(base);
            const format = value => iso(value).slice(0, 16).replace(/-/g, '').replace('T', ' ');
            url.searchParams.set('begin_date', format(first)); url.searchParams.set('end_date', format(last));
            url.searchParams.set('datum', datum); add(url, first, last, true); first = last + SLOT;
          }
          cursor = interval.end + SLOT;
        }
        if (cursor <= lastRequested) unrequestedIntervals.push({startTime: iso(cursor), endTime: iso(lastRequested),
          reason: 'Not scheduled: outside retained ' + spec.periodLabel + ' inventory intervals. Inventory freshness may be unresolved; this is not a permanent archive endpoint.'});
        notes.push('All listed ' + spec.periodLabel + ' intervals intersecting the project are scheduled in requests of at most ' + spec.maxDays + ' calendar days. Listed gaps are not bridged. Original project dates and unscheduled intervals remain in the manifest.',
          'Values are requested in metres, UTC, relative to ' + datum + '. Preliminary/verified quality flags and sigma remain in the original JSON. No local datum conversion is applied.');
      } else if (productId === 'usgs_streamflow') {
        const url = new URL(base); url.searchParams.set('time', query.start + '/' + query.end);
        add(url, start, end);
        notes.push('USGS daily mean discharge (00060 / 00003), retaining native units, series identifiers, approval status and qualifiers. The script follows validated next-page links and saves each original GeoJSON page separately. Total page count is unknown until pagination finishes.');
      } else throw new Error('This record has no project-period station download route.');
      if (!requests.length) throw new Error('No overlapping requests can be scheduled for this station and project.');
      let transferEstimate = null;
      if (productId === 'noaa_coops_water_level') {
        const spec = moduleFor('SiteCoopsAvailability', 'coops-availability.js').productSpec(station);
        let slots = 0;
        for (const request of requests) {
          const count = Math.max(0, Math.floor(Date.parse(request.endTime)/spec.cadenceMs) - Math.ceil(Date.parse(request.startTime)/spec.cadenceMs) + 1);
          slots += count;
          request.estimatedBytes = {min:count*50+128,central:count*75+1024,max:count*110+1024};
        }
        transferEstimate = {minBytes:slots*50+requests.length*128,centralBytes:slots*75+requests.length*1024,maxBytes:slots*110+requests.length*1024,
          nominalSlots:slots,approximate:true,basis:'Planning range of 50–110 bytes per nominal JSON row plus 128–1024 bytes per response; central estimate 75 bytes/row plus 1024 bytes/response. Retained evidence: 505061 bytes / 6720 six-minute rows (Washington, July 2020) and 4447 bytes / 72 hourly rows (The Battery, January 1960). This is uncompressed response size, not a provider quote or statistical confidence interval. Missing rows, response formatting and compression change actual transfer size.'};
        notes.push(transferEstimate.basis);
      }
      notes.push((transferEstimate ? 'Transfer size is approximate; the actual size is unknown before retrieval.' : 'Transfer size is unknown before retrieval.') + ' Review the request count and dates, then explicitly choose one request or the full batch. No overall transfer-size or file-count cap is imposed.',
        'A completed transfer means the scheduled requests were read. It does not establish continuous, quality-approved observations or scientific suitability. Missing rows remain missing.');
      const folderName = productId + (productId === 'noaa_coops_water_level' ? '_' + moduleFor('SiteCoopsAvailability', 'coops-availability.js').productSpec(station).id : '') + '_' + station.id + '_' + query.start + '_' + query.end + '_data';
      const manifest = {schemaVersion: 1, preparedAt: new Date().toISOString(), productId, station: copy(station), query: copy(query),
        requestedWindow: {start: query.start, end: query.end}, datum, coopsProduct: productId === 'noaa_coops_water_level' ? base.searchParams.get('product') : null, requests, unrequestedIntervals, notes,
        transferSummary: {initialRequests: requests.length, totalPagesKnown: productId !== 'usgs_streamflow', estimatedTotalBytes: transferEstimate?.centralBytes ?? null, estimate: transferEstimate, requiresConfirmation: true},
        folderName, qualification: 'Prepared request, not retrieval evidence. Original provider payloads retain their units and flags.'};
      return {errors: [], requests, requestCount: requests.length, estimatedTotalBytes: transferEstimate?.centralBytes ?? null, transferEstimate, directUrl, notes, unrequestedIntervals,
        folderName, manifest, script: {name: folderName + '_download.py', mime: 'text/x-python', text: python(manifest)}};
    } catch (error) {return {errors: [error.message], requests: [], requestCount: 0, notes: [], unrequestedIntervals: []};}
  }
  function python(config) {
    return '#!/usr/bin/env python3\n"""Review without flags; --download --confirm-transfer starts the selected transfer."""\nimport json\nCONFIG = json.loads(' + JSON.stringify(JSON.stringify(config)) + ')\n' + String.raw`
import argparse, datetime as dt, hashlib, time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qs
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError

def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def canonical(url):
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.username or parts.password or parts.fragment:
        raise ValueError('Only credential-free HTTPS provider URLs are accepted')
    return parts.netloc, parts.path, parse_qs(parts.query, keep_blank_values=True)

def checked_next(url, original):
    host, path, query = canonical(url)
    expected_host, expected_path, expected_query = canonical(original)
    if (host, path) != (expected_host, expected_path):
        raise ValueError('Pagination changed the provider endpoint')
    for key, value in expected_query.items():
        if query.get(key) != value:
            raise ValueError('Pagination changed or removed the ' + key + ' filter')
    if set(query) - set(expected_query) - {'offset', 'cursor'}:
        raise ValueError('Unexpected pagination controls')
    offset = query.get('offset', ['0'])
    if len(offset) != 1 or not offset[0].isdigit():
        raise ValueError('Invalid pagination offset')
    if 'cursor' in query and (len(query['cursor']) != 1 or not query['cursor'][0] or len(query['cursor'][0]) > 4096):
        raise ValueError('Invalid pagination cursor')
    return url

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Provider redirected the request; inspect before retrying')

def validate_payload(payload, request, seen):
    product, station = CONFIG['productId'], CONFIG['station']['id']
    if isinstance(payload, dict) and payload.get('error'):
        error = payload['error']
        raise ValueError('Provider response: ' + str(error.get('message', error) if isinstance(error, dict) else error))
    if product == 'ghcn_daily':
        if not isinstance(payload, list): raise ValueError('Expected NCEI observation array')
        rows = payload
        for row in rows:
            if not isinstance(row, dict) or row.get('STATION') != station: raise ValueError('Unexpected NCEI station')
            day = row.get('DATE', '')
            if dt.date.fromisoformat(day).isoformat() != day or not request['start'] <= day <= request['end']:
                raise ValueError('NCEI date outside the requested interval')
            if day in seen: raise ValueError('Repeated NCEI daily record')
            seen.add(day)
    elif product == 'noaa_coops_water_level':
        if not isinstance(payload, dict) or payload.get('metadata', {}).get('id') != station or not isinstance(payload.get('data'), list):
            raise ValueError('Unexpected CO-OPS station or response')
        rows = payload['data']
        first = dt.datetime.fromisoformat(request['startTime'].replace('Z', '+00:00'))
        last = dt.datetime.fromisoformat(request['endTime'].replace('Z', '+00:00'))
        for row in rows:
            if not isinstance(row, dict): raise ValueError('Invalid CO-OPS row')
            stamp = dt.datetime.strptime(row.get('t', ''), '%Y-%m-%d %H:%M').replace(tzinfo=dt.timezone.utc)
            if stamp.strftime('%Y-%m-%d %H:%M') != row['t']: raise ValueError('Noncanonical CO-OPS timestamp')
            if not first <= stamp <= last: raise ValueError('CO-OPS timestamp outside the requested interval')
            if row['t'] in seen: raise ValueError('Repeated CO-OPS timestamp')
            seen.add(row['t'])
    else:
        if not isinstance(payload, dict) or payload.get('type') != 'FeatureCollection' or not isinstance(payload.get('features'), list) or not isinstance(payload.get('links'), list):
            raise ValueError('Expected USGS FeatureCollection with features and links arrays')
        rows = payload['features']
        if 'numberReturned' in payload and (type(payload['numberReturned']) is not int or payload['numberReturned'] != len(rows)):
            raise ValueError('USGS numberReturned differs from the feature count')
        if any(not isinstance(link, dict) or not isinstance(link.get('rel'), str) or not isinstance(link.get('href'), str) or not link['href'] for link in payload['links']):
            raise ValueError('Invalid USGS pagination link structure')
        for row in rows:
            p = row.get('properties', {}) if isinstance(row, dict) else {}
            if p.get('monitoring_location_id') != station or p.get('parameter_code') != '00060' or p.get('statistic_id') != '00003' or not p.get('time_series_id') or not p.get('unit_of_measure'):
                raise ValueError('USGS station, parameter, statistic, series or units differ')
            day = p.get('time', '')
            if dt.date.fromisoformat(day).isoformat() != day or not request['start'] <= day <= request['end']:
                raise ValueError('USGS date outside the requested interval')
            key = (p['time_series_id'], p['unit_of_measure'], day)
            if key in seen: raise ValueError('Repeated USGS series/date across pages')
            seen.add(key)
    next_links = [link.get('href') for link in payload.get('links', []) if isinstance(link, dict) and link.get('rel') == 'next'] if product == 'usgs_streamflow' else []
    if len(next_links) > 1 or next_links and (not isinstance(next_links[0], str) or not rows):
        raise ValueError('Ambiguous or empty-page pagination')
    return len(rows), next_links[0] if next_links else None

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--confirm-transfer', action='store_true', help='Explicitly accept the selected transfer; actual size is unknown')
    parser.add_argument('--file', type=int, action='append', help='One-based prepared request number; repeat to select. Default: all requests.')
    parser.add_argument('--output', help='Optional output folder; existing data files are never overwritten')
    args = parser.parse_args()
    requests = CONFIG['requests']
    if args.file and any(i < 1 or i > len(requests) for i in args.file): parser.error('Request number is outside the prepared list')
    selected = [(i, r) for i, r in enumerate(requests, 1) if not args.file or i in args.file]
    print(CONFIG['productId'], CONFIG['station']['id'], 'Project:', CONFIG['requestedWindow'])
    print('Selected initial requests:', len(selected))
    if CONFIG['transferSummary'].get('estimate'):
        low = sum(r['estimatedBytes']['min'] for _, r in selected)
        high = sum(r['estimatedBytes']['max'] for _, r in selected)
        print('Estimated selected JSON bytes:', low, 'to', high, '(approximate; actual transfer size may differ)')
    else:
        print('Total transfer size: unknown; additional provider pages may be required.')
    for i, r in selected: print(i, r['name'], r.get('startTime', r['start']), 'to', r.get('endTime', r['end']), r['url'])
    for note in CONFIG['notes']: print(note)
    for gap in CONFIG['unrequestedIntervals']: print('Not scheduled:', gap['startTime'], gap['endTime'], gap['reason'])
    if not args.download:
        print('No network request made. Use --download --confirm-transfer after reviewing; optionally add --file N.')
        return 0
    if not args.confirm_transfer: parser.error('No payload request sent. Transfer size is unknown; review and add --confirm-transfer.')
    folder = Path(args.output or CONFIG['folderName'])
    folder.mkdir(parents=True, exist_ok=True)
    receipt = folder / ('receipt-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.json')
    report = {'prepared': CONFIG, 'startedAt': utc_now(), 'complete': False, 'scheduledRequestsComplete': False,
              'selectedRequests': [i for i, _ in selected], 'explicitTransferConfirmation': True, 'files': [], 'attempts': [], 'failures': [],
              'qualification': 'Transfer completion is not observation completeness or scientific suitability. Original JSON is preserved without resampling, unit conversion or quality filtering.'}
    def persist(): receipt.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    persist()
    opener = build_opener(NoRedirect())
    completed = 0
    for number, request in selected:
        url, page, seen_links, seen_rows = request['url'], 1, set(), set()
        try:
            while url:
                checked_next(url, request['url'])
                identity = (canonical(url)[0:2], sorted((key, tuple(value)) for key, value in canonical(url)[2].items()))
                identity = repr(identity)
                if identity in seen_links: raise ValueError('Repeated pagination URL')
                seen_links.add(identity)
                stem = Path(request['name']).stem
                target = folder / (stem + ('_page' + str(page) if CONFIG['productId'] == 'usgs_streamflow' else '') + '.json')
                partial = target.with_suffix('.json.part')
                if target.exists() or partial.exists(): raise FileExistsError(str(target) + ' or its partial file already exists')
                time.sleep(0.25)
                attempt = {'requestNumber': number, 'page': page, 'url': url, 'requestedAt': utc_now()}
                report['attempts'].append(attempt); persist()
                with opener.open(Request(url, headers={'User-Agent': 'Climate-Hazard-Inventory/0.2', 'Accept': 'application/json'}), timeout=90) as response:
                    attempt['httpStatus'] = response.status
                    if response.status != 200: raise ValueError('Expected HTTP200')
                    if 'html' in response.headers.get('Content-Type', '').lower(): raise ValueError('Provider returned an HTML page')
                    digest, size = hashlib.sha256(), 0
                    with partial.open('xb') as output:
                        while True:
                            chunk = response.read(1048576)
                            if not chunk: break
                            output.write(chunk); digest.update(chunk); size += len(chunk)
                    length = response.headers.get('Content-Length')
                    if length and int(length) != size: raise ValueError('Incomplete HTTP payload')
                payload = json.loads(partial.read_text(encoding='utf-8-sig'))
                count, next_url = validate_payload(payload, request, seen_rows)
                if next_url: checked_next(next_url, request['url'])
                partial.rename(target)
                report['files'].append({'requestNumber': number, 'page': page, 'file': target.name, 'url': url,
                                        'bytes': size, 'sha256': digest.hexdigest(), 'returnedRows': count,
                                        'retrievedAt': utc_now(), 'emptyResponse': count == 0})
                attempt['accepted'] = True; persist()
                print('Saved', target, size, 'bytes;', count, 'returned rows')
                url, page = next_url, page + 1
            completed += 1
        except KeyboardInterrupt:
            report['cancelled'] = True
            report['failures'].append({'requestNumber': number, 'error': 'Cancelled; accepted files and partial transfers retained'})
            persist(); break
        except Exception as error:
            entry = {'requestNumber': number, 'page': page, 'url': url, 'type': type(error).__name__, 'error': str(error)}
            if isinstance(error, HTTPError):
                entry['httpStatus'] = error.code
                try: entry['providerResponse'] = error.read(8192).decode('utf-8', errors='replace')
                except Exception as diagnostic_error: entry['diagnosticError'] = type(diagnostic_error).__name__ + ': ' + str(diagnostic_error)
            report['failures'].append(entry); persist()
            print('Failed request', number, entry['error'])
            if isinstance(error, HTTPError) and error.code == 429:
                report['rateLimited'] = True
                print('Provider rate limit: remaining requests were not started. Wait before retrying.'); break
    report['finishedAt'] = utc_now()
    report['scheduledRequestsComplete'] = completed == len(selected) and not report['failures']
    report['complete'] = report['scheduledRequestsComplete']
    report['completedInitialRequests'] = completed
    persist()
    print('Completed', completed, 'of', len(selected), 'selected initial requests; receipt:', receipt)
    return 0 if report['complete'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
`;
  }
  root.SiteStationDownload = {prepare};
  if (typeof module === 'object' && module.exports) module.exports = {...root.SiteStationDownload, _test:{python}};
})(typeof globalThis !== 'undefined' ? globalThis : this);
