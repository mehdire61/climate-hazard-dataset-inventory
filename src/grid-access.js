/* Date selection from observed provider file listings. No browser fetch or spatial processing. */
(function (root) {
  'use strict';
  const supported = Object.freeze(['chirps_v2_daily', 'chirps_v3_daily_rnl', 'chirps_v3_daily_sat', 'gpcc_monthly_v2025']);
  const CHIRPS = 'https://data.chc.ucsb.edu/products/CHIRPS/v2.0/global_daily/netcdf/p05/by_month/';
  const GPCC = 'https://opendata.dwd.de/climate_environment/GPCC/GPCC_Precipitation_Analysis_Monthly/Version_2025/';
  const gpccCodes = {'0.25': '025', '0.5': '050', '1': '100', '2.5': '250'};
  const copy = value => JSON.parse(JSON.stringify(value));
  function fail(message, code) {const error = new Error(message); error.code = code; throw error;}
  function validDate(value) {
    if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
  }
  function moveDay(value, days) {return new Date(Date.parse(value + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);}
  function monthEnd(year, month) {
    const start = year + '-' + month + '-01'; if (!validDate(start)) return null;
    const date = new Date(start + 'T00:00:00Z'); date.setUTCMonth(date.getUTCMonth() + 1, 0); return date.toISOString().slice(0, 10);
  }
  function source(id, options) {
    if (!supported.includes(id)) fail('This product has no indexed raw-file route.', 'UNSUPPORTED');
    const index = options.index || root.InventoryApp?.data?.gridAccess || (typeof module === 'object' && module.exports ? require('../data/grid-access-index.json') : null);
    const product = index?.products?.[id];
    if (index?.schemaVersion !== 1 || !product || !Array.isArray(product.files) || !Array.isArray(product.resolutions) || !Array.isArray(product.listingChecks)) fail('The verified file index is missing or invalid. Reload the inventory.', 'INDEX');
    return {index, product};
  }
  function describe(id, options = {}) {
    const {product} = source(id, options);
    const {files, ...description} = product;
    return {...copy(description), productId: id, indexedFileCount: files.length, mode: 'dated-provider-directory-snapshot'};
  }
  function checkFile(id, file) {
    let match, base, start, end;
    if (id.startsWith('chirps_')) {
      const variant = id === 'chirps_v2_daily' ? null : id.slice(-3);
      match = new RegExp('^chirps-v' + (variant ? '3' : '2') + '\\.0\\.(\\d{4})\\.(\\d{2})\\.days_p05\\.nc$').exec(file.name);
      if (match && file.resolution === '0.05') {
        base = variant ? 'https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/' + variant + '/netcdf/byMonth/' : CHIRPS;
        start = match[1] + '-' + match[2] + '-01'; end = monthEnd(match[1], match[2]);
        if (variant && file.variant !== variant) fail('The indexed CHIRPS variant does not match the selected product.', 'INDEX');
      }
    } else {
      const code = gpccCodes[file.resolution];
      match = new RegExp('^gpcc_precipitation_analysis_monthly_(\\d{4})_(\\d{4}|\\d{2})_v2025_' + code + '\\.nc\\.gz$').exec(file.name);
      if (match && code) {
        base = GPCC + code + '_degree/';
        start = match[2].length === 4 ? match[1] + '-01-01' : match[1] + '-' + match[2] + '-01';
        end = match[2].length === 4 ? match[2] + '-12-31' : monthEnd(match[1], match[2]);
      }
    }
    if (!base || file.url !== base + file.name || !validDate(start) || !validDate(end) || start > end || file.start !== start || file.end !== end || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || typeof file.bytesApproximate !== 'boolean' || !Number.isFinite(Date.parse(file.metadataCheckedAt))) fail('A file-index entry has an invalid URL, period or verification record. No download plan was accepted.', 'INDEX');
    if (file.payloadVerifiedAt && (!Number.isFinite(Date.parse(file.payloadVerifiedAt)) || !/^[a-f0-9]{64}$/.test(file.payloadSha256 || ''))) fail('A payload-verification record is malformed.', 'INDEX');
  }
  function plan(id, query, options = {}) {
    if (!query || !validDate(query.start) || !validDate(query.end) || query.start > query.end) fail('Enter valid inclusive project dates.', 'INPUT');
    if (query.end > new Date().toISOString().slice(0, 10)) fail('Historical file plans cannot request future dates.', 'INPUT');
    const {index, product} = source(id, options);
    const resolution = options.resolution === undefined ? product.defaultResolution : String(Number(options.resolution));
    if (!product.resolutions.some(item => item.value === resolution)) fail('Select one of the documented grid resolutions.', 'INPUT');
    const selectedResolution = product.files.filter(file => file.resolution === resolution), seen = new Set();
    for (const file of selectedResolution) {
      checkFile(id, file);
      if (seen.has(file.url)) fail('The file index contains duplicate entries.', 'INDEX');
      seen.add(file.url);
    }
    const files = selectedResolution.filter(file => file.start <= query.end && file.end >= query.start)
      .sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name))
      .map(file => ({...copy(file), spatialDelivery: product.spatialDelivery, domainBounds: copy(product.domainBounds), temporalDelivery: product.temporalDelivery,
        overlapStart: file.start < query.start ? query.start : file.start, overlapEnd: file.end > query.end ? query.end : file.end,
        payloadVerifiedAt: file.payloadVerifiedAt || null, verificationStatus: file.payloadVerifiedAt ? 'Representative full payload inspected on the stated date' : 'Filename observed in the dated provider directory; this individual payload was not inspected'}));
    const uncoveredIntervals = [];
    let next = query.start;
    for (const file of files) {
      if (file.overlapStart > next) uncoveredIntervals.push({start: next, end: moveDay(file.overlapStart, -1)});
      if (file.overlapEnd >= next) next = moveDay(file.overlapEnd, 1);
    }
    if (next <= query.end) uncoveredIntervals.push({start: next, end: query.end});
    const notes = ['These are provider files for their full spatial and temporal blocks. No polygon clipping, area averaging, date slicing, unit conversion or missing-value filling is performed.',
      'The file list is a dated provider-directory snapshot. Links were observed, not guessed. Browser CORS does not permit live directory verification; a file can change or become unavailable after the check.',
      'File-period overlap does not establish valid cells at the project geometry, complete observations or suitability for a client decision.', ...product.notes];
    if (uncoveredIntervals.length) notes.push('Some requested dates are not covered by this indexed file selection. This means the snapshot has no listed file for those dates, not that the provider has no data. Inspect the provider directory for updates.');
    if (files.some(file => file.bytesApproximate)) notes.push('Some file sizes are approximate directory labels. Total size estimates are not exact byte counts.');
    return {productId: id, query: copy(query), resolution, files, uncoveredIntervals, notes, fileCount: files.length,
      estimatedTotalBytes: files.reduce((sum, file) => sum + file.bytes, 0), totalBytesApproximate: files.some(file => file.bytesApproximate),
      verification: {mode: index.verificationMode, metadataCheckedAt: product.listingChecks.map(item => item.metadataCheckedAt).sort().at(-1), listingChecks: copy(product.listingChecks),
        payloadVerifications: copy(product.payloadVerifications), qualification: index.qualification, dateCoverage: !files.length ? 'none_indexed' : uncoveredIntervals.length ? 'partially_indexed' : 'all_requested_dates_indexed'},
      manifestScope: 'All selected observed file URLs are included without a display-row cap. The original project query is retained only as selection context; provider files are delivered at their full stated extent.'};
  }
  const api = {supported, describe, plan};
  root.SiteGridAccess = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
