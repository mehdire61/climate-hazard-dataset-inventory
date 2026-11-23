#!/usr/bin/env python3
"""Validate and embed catalog data, Site check rules, examples and source assets.

Usage: python build.py

The JSON files contain the public catalog, source descriptions and browsing groups.
Only fields used by the page or metadata export are embedded. The source JSON files
are never changed. The script stops without changing index.html if validation fails.
"""
import json
import copy
import hashlib
import math
import re
import sys
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
PAGE = ROOT / "index.html"

PRODUCT_FIELDS = [
    "product_id", "product_name", "provider", "version", "hazard_family", "variable", "units",
    "data_nature", "spatial_support", "temporal_support", "temporal_coverage", "geographic_coverage",
    "supported_use_cases", "non_uses", "limitations", "dependence_notes", "evidence_ids",
    "documentation_url", "access_url", "access_example_url", "access_method", "license_id",
    "license_url", "license_url_label", "license_notes", "commercial_use_status",
    "redistribution_status", "formats", "unresolved_questions", "last_checked_date",
    "vertical_reference", "vertical_reference_sources",
]
SOURCE_FIELDS = [
    "evidence_id", "title", "url", "doi", "claims", "checked_date", "verification",
    "link_status", "alternate_url", "alternate_label", "link_history",
]
LIST_FIELDS = {"hazard_family", "supported_use_cases", "non_uses", "limitations", "evidence_ids", "formats", "unresolved_questions", "vertical_reference_sources"}
OPTIONAL_PRODUCT_FIELDS = {"access_example_url", "license_url", "license_url_label", "vertical_reference", "vertical_reference_sources"}
RIGHTS_VALUES = {
    "commercial_use_status": {
        "PERMITTED_WITH_CONDITIONS", "PROHIBITED_WITHOUT_PERMISSION", "LICENSE_REQUIRED",
        "RECORD_SPECIFIC", "UNKNOWN",
    },
    "redistribution_status": {"PERMITTED_WITH_CONDITIONS", "RESTRICTED", "RECORD_SPECIFIC", "UNKNOWN"},
    "license_id": {
        "CC-BY-4.0", "CC-BY-NC-4.0", "CC-BY-SA-3.0", "CC0-1.0", "CC0_PUBLIC_DOMAIN",
        "CC-BY_DATASET_TERMS", "DWD_OPEN_DATA_TERMS", "ESA_CCI_SM_CUSTOM", "GRDC_RESEARCH_TERMS",
        "MODEL_AND_INPUT_TERMS", "NASA_FIRMS_OPEN_DATA", "NASA_MISSION_DATA_POLICY",
        "NASA_REPOSITORY_TERMS_UNRESOLVED", "NOAA_NODD_OPEN_DATA", "NOAA_PROVIDER_TERMS",
        "PROVIDER_LICENSE_TEXT_CONFLICT", "PROVIDER_SPECIFIC_MIXED", "PROVIDER_SPECIFIC_TERMS",
        "SOURCE_SPECIFIC", "SOURCE_SPECIFIC_TERMS_UNRESOLVED", "UK_OGL", "UNKNOWN",
        "US_GOVERNMENT_DATA_TERMS", "VENDOR_LICENSE",
    },
}
PRODUCT_URL_FIELDS = ("documentation_url", "access_url", "access_example_url", "license_url")
REQUIRED_SOURCE_FIELDS = ("title", "url", "claims", "checked_date", "verification")
OPTIONAL_SOURCE_TEXT_FIELDS = ("doi", "link_status", "alternate_url", "alternate_label")
DATA_BLOCK = re.compile(r'(<script id="inventory-data" type="application/json">).*?(</script>)', re.S)
PAGE_ASSETS = {
    "leaflet-styles": ("style", "vendor/leaflet.css"),
    "site-check-styles": ("style", "src/site-check.css"),
    "turf-code": ("script", "vendor/turf.min.js"),
    "leaflet-code": ("script", "vendor/leaflet.js"),
    "geometry-code": ("script", "src/geometry.js"),
    "screening-code": ("script", "src/screening.js"),
    "shortlist-code": ("script", "src/shortlist.js"),
    "coops-availability-code": ("script", "src/coops-availability.js"),
    "ghcn-parquet-code": ("script", "vendor/hyparquet-ghcn.min.js"),
    "ghcn-gzip-code": ("script", "vendor/pako-inflate.min.js"),
    "ghcn-archive-code": ("script", "src/ghcn-archive.js"),
    "providers-code": ("script", "src/providers.js"),
    "station-download-code": ("script", "src/station-download.js"),
    "observation-chart-code": ("script", "src/observation-chart.js"),
    "project-state-code": ("script", "src/project-state.js"),
    "coverage-timeline-code": ("script", "src/coverage-timeline.js"),
    "areas-code": ("script", "src/areas.js"),
    "reference-renderer-code": ("script", "vendor/protomaps-leaflet.js"),
    "reference-map-code": ("script", "src/reference-map.js"),
    "project-map-code": ("script", "src/project-map.js"),
    "grid-access-code": ("script", "src/grid-access.js"),
    "earth-access-code": ("script", "src/earth-access.js"),
    "stac-access-code": ("script", "src/stac-access.js"),
    "provider-requests-code": ("script", "src/provider-requests.js"),
    "science-requests-code": ("script", "src/science-requests.js"),
    "access-code": ("script", "src/access.js"),
    "access-guide-code": ("script", "src/access-guide.js"),
    "grdc-catalogue-code": ("script", "src/grdc-catalogue.js"),
    "site-check-code": ("script", "src/site-check.js"),
}
SUPPORT_TYPES = {"station", "grid", "event", "track", "climate_state", "acquisition", "model"}
TIME_STEPS = {"accumulation_specific", "acquisition", "annual_monthly_seasonal", "daily", "daily_accumulations", "daily_index",
              "daily_monthly", "event", "half_hourly", "hourly", "hourly_interval", "hourly_or_finer",
              "hourly_synoptic", "irregular_track", "mixed", "monthly", "monthly_annual", "monthly_irregular",
              "monthly_seasonal_annual", "overpass", "return_period_scenario", "six_minute_hourly", "three_hourly", "two_minute"}
ACCESS_REQUIREMENTS = {"cds_account_and_terms", "commercial_licence", "earthdata_account", "platform_account",
                       "provider_terms", "public_api", "registration_or_terms", "request", "route_dependent"}
INDEXED_SCREENING_PRODUCTS = {"chirps_v2_daily", "chirps_v3_daily_rnl", "chirps_v3_daily_sat", "gpcc_monthly_v2025"}


def screening_source_urls_valid(urls):
    if not isinstance(urls, list) or not urls:
        return False
    try:
        return all(isinstance(url, str) and urlsplit(url).scheme == "https" and urlsplit(url).hostname
                   and not urlsplit(url).username and not urlsplit(url).password for url in urls)
    except ValueError:
        return False


def derive_screening_index_metadata(screening, grid):
    """Derive soft listing horizons in memory; never change source catalog or JSON."""
    derived = copy.deepcopy(screening)
    for pid, rule in derived.get("rules", {}).items():
        period = rule.get("time", {})
        reference = period.get("index_reference")
        if reference is None:
            continue
        if reference not in INDEXED_SCREENING_PRODUCTS or reference != pid:
            raise ValueError(f"{pid}: invalid screening file-index reference")
        product = grid.get("products", {}).get(reference, {})
        files, checks = product.get("files"), product.get("listingChecks")
        if not isinstance(files, list) or not files or any(not isinstance(f, dict) or not is_iso_date(f.get("start")) or not is_iso_date(f.get("end")) or f["start"] > f["end"] for f in files):
            raise ValueError(f"{pid}: cannot derive screening from missing/invalid indexed file intervals")
        if not isinstance(checks, list) or not checks or any(not isinstance(c, dict) or not isinstance(c.get("metadataCheckedAt"), str) or not is_iso_date(c["metadataCheckedAt"][:10]) for c in checks) or not screening_source_urls_valid([c.get("url") for c in checks]):
            raise ValueError(f"{pid}: cannot derive screening without dated provider listing sources")
        snapshot = {"source": "data/grid-access-index.json", "first_file_start": min(f["start"] for f in files),
                    "last_file_end": max(f["end"] for f in files), "checked_on": min(c["metadataCheckedAt"][:10] for c in checks),
                    "source_urls": list(dict.fromkeys(c["url"] for c in checks)), "file_count": len(files)}
        period["known_through"] = snapshot["last_file_end"]
        period["index_snapshot"] = snapshot
    return derived


def rule_is_valid(rule):
    if not isinstance(rule, dict) or rule.get("support_type") not in SUPPORT_TYPES or rule.get("time_step") not in TIME_STEPS or rule.get("access_requirement") not in ACCESS_REQUIREMENTS:
        return False
    if not is_iso_date(rule.get("curation_reviewed_on")):
        return False
    domain, period = rule.get("domain", {}), rule.get("time", {})
    if domain.get("kind") not in {"global", "envelope", "station", "regional", "unknown"} or period.get("kind") not in {"range", "station", "event", "scenario", "unknown"}:
        return False
    bounds = domain.get("bounds")
    if domain.get("kind") == "envelope" and bounds is None:
        return False
    if bounds is not None:
        if not isinstance(bounds, list) or len(bounds) != 4 or any(type(n) not in (int, float) or not math.isfinite(n) for n in bounds):
            return False
        if not (-180 <= bounds[0] <= 180 and -180 <= bounds[2] <= 180 and -90 <= bounds[1] <= bounds[3] <= 90):
            return False
    if type(domain.get("hard_bounds")) is not bool:
        return False
    if "regions" in domain:
        if not isinstance(domain["regions"], list) or not domain["regions"]:
            return False
        for region in domain["regions"]:
            if not isinstance(region, dict):
                return False
            b = region.get("bounds")
            if not isinstance(b, list) or len(b) != 4 or any(type(v) not in (int, float) or not math.isfinite(v) for v in b) or not (-180 <= b[0] <= 180 and -180 <= b[2] <= 180 and -90 <= b[1] <= b[3] <= 90):
                return False
            if any(region.get(k) is not None and not is_iso_date(region[k]) for k in ("start", "end")):
                return False
    if "access_route_start" in period and not is_iso_date(period["access_route_start"]):
        return False
    if "return_period_years" in period and (period["kind"] != "scenario" or type(period["return_period_years"]) is not int or period["return_period_years"] <= 0):
        return False
    for key in ("intervals", "uncertain_windows"):
        if not isinstance(period.get(key), list):
            return False
        for interval in period[key]:
            if not isinstance(interval, dict) or any(interval.get(k) is not None and not is_iso_date(interval[k]) for k in ("start", "end")):
                return False
            if interval.get("start") and interval.get("end") and interval["start"] > interval["end"]:
                return False
    if "solution_calendar" in period:
        rows = period["solution_calendar"]
        if not isinstance(rows, list) or not rows or not is_iso_date(period.get("known_through")):
            return False
        previous_month = ""
        for row in rows:
            if not isinstance(row, dict):
                return False
            month, stamp = row.get("month"), row.get("timestamp")
            lo, hi = row.get("samplingStart"), row.get("samplingEnd")
            if not isinstance(month, str) or not is_iso_date(month + "-01") or month <= previous_month or not is_iso_date(stamp):
                return False
            if (lo is not None or hi is not None) and not (is_iso_date(lo) and is_iso_date(hi) and lo <= stamp <= hi):
                return False
            previous_month = month
        if previous_month != period["known_through"][:7]:
            return False
    if "index_reference" in period and period["index_reference"] not in INDEXED_SCREENING_PRODUCTS:
        return False
    if "index_snapshot" in period:
        snapshot = period["index_snapshot"]
        if not period.get("index_reference") or not isinstance(snapshot, dict) or any(not is_iso_date(snapshot.get(k)) for k in ("first_file_start", "last_file_end", "checked_on")) or snapshot["first_file_start"] > snapshot["last_file_end"] or snapshot.get("source") != "data/grid-access-index.json" or type(snapshot.get("file_count")) is not int or snapshot["file_count"] <= 0 or not screening_source_urls_valid(snapshot.get("source_urls")) or period.get("known_through") != snapshot["last_file_end"]:
            return False
    if "access_route_end" in period and (not is_iso_date(period["access_route_end"]) or not isinstance(period.get("access_route_note"), str) or not period["access_route_note"]):
        return False
    if "publication_policy" in period:
        policy = period["publication_policy"]
        if not isinstance(policy, dict) or policy.get("kind") not in {"era5_cds", "merra2_monthly", "mcd64a1_monthly"} or not is_iso_date(policy.get("checked_on")) or not screening_source_urls_valid(policy.get("source_urls")):
            return False
    if period.get("latest_availability") == "unchecked" and (type(period.get("recent_window_days")) is not int or not 1 <= period["recent_window_days"] <= 366):
        return False
    if period.get("latest_availability") not in (None, "unchecked"):
        return False
    if any(i.get("end") is None for i in period["intervals"]) and not any(period.get(k) for k in ("known_through", "index_reference", "publication_policy", "access_route_end", "latest_availability")):
        return False
    return period.get("known_through") is None or is_iso_date(period["known_through"])


def example_payload_matches(example):
    """Independently check saved plotted values/flags against the preserved JSON."""
    try:
        result, station = example["result"], example["station"]
        raw = result["rawText"]
        if result["station"]["id"] != station["id"] or result["provenance"]["rawSha256"] != hashlib.sha256(raw.encode("utf-8")).hexdigest():
            return False
        rows = json.loads(raw)
        expected = {}

        def number(value):
            if value is None or isinstance(value, bool) or str(value).strip() == "":
                return None
            try:
                value = float(value)
                return value if math.isfinite(value) else None
            except (ValueError, TypeError):
                return None

        def add(key, unit, time, value, flags):
            expected.setdefault((key, unit), []).append({"time": time, "value": value, "flags": flags})

        pid = example["productId"]
        if pid == "ghcn_daily":
            for row in rows:
                if row["STATION"] != station["id"]:
                    return False
                for key, unit in (("TMAX", "°C"), ("TMIN", "°C"), ("PRCP", "mm")):
                    attr = row.get(key + "_ATTRIBUTES")
                    parts = attr.split(",") if isinstance(attr, str) else []
                    parts += [None] * (4 - len(parts))
                    value = number(row.get(key))
                    flags = dict(zip(("measurementFlag", "qualityFlag", "sourceFlag", "observationTime"), parts[:4]))
                    flags["attributes"] = attr
                    if value == -9999:
                        value, flags["missingSentinel"] = None, "-9999"
                    add(key, unit, row["DATE"], value, flags)
        elif pid == "noaa_coops_water_level":
            if str(rows["metadata"]["id"]) != station["id"]:
                return False
            for row in rows["data"]:
                add("water_level", "m", row["t"].replace(" ", "T") + ":00Z", number(row.get("v")),
                    {"quality": row.get("q"), "dataFlags": row.get("f"), "sigma": row.get("s")})
        elif pid == "usgs_streamflow":
            for feature in rows["features"]:
                row = feature["properties"]
                if row["monitoring_location_id"] != station["id"] or row["parameter_code"] != "00060" or row["statistic_id"] != "00003":
                    return False
                add(row["time_series_id"] + "|" + row["unit_of_measure"], row["unit_of_measure"], row["time"], number(row.get("value")),
                    {"approvalStatus": row.get("approval_status"), "qualifier": row.get("qualifier"), "lastModified": row.get("last_modified"), "timeSeriesId": row["time_series_id"]})
        else:
            return False
        actual = {(s["key"], s["unit"]): s["points"] for s in result["series"]}
        if len(actual) != len(result["series"]):
            return False
        for points in expected.values():
            points.sort(key=lambda point: point["time"])
        return expected == actual
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


def screening_problems(screening, examples, products, sources):
    """Check that screening rules and examples reference catalog products and sources."""
    problems = []
    ids = {p["product_id"] for p in products}
    product_sources = {p["product_id"]: set(p["evidence_ids"]) for p in products}
    rules = screening.get("rules", {})
    if set(rules) != ids:
        problems.append("screening.rules must have exactly one rule per catalog product")
    for pid, rule in rules.items():
        evidence = rule.get("evidence_ids", [])
        if not evidence or any(e not in sources or e not in product_sources.get(pid, set()) for e in evidence):
            problems.append(f"{pid}: screening must cite evidence belonging to the same catalog record")
        if not rule_is_valid(rule):
            problems.append(f"{pid}: invalid controlled screening metadata")
        if rule.get("time", {}).get("index_reference", pid) != pid:
            problems.append(f"{pid}: screening file-index reference belongs to a different record")
    example_ids = set()
    for example in examples.get("examples", []):
        label = example.get("id", "<missing example id>")
        if label in example_ids or not example.get("id"):
            problems.append(f"{label}: missing or duplicate example id")
        example_ids.add(label)
        if example.get("productId") not in ids:
            problems.append(f"{label}: example product missing from catalog")
        query = example.get("query", {})
        if not all(is_iso_date(query.get(d)) for d in ("start", "end")):
            problems.append(f"{label}: example dates invalid")
        result = example.get("result", {})
        if not result.get("rawText") or not result.get("requests"):
            problems.append(f"{label}: example must retain original payload and request receipt")
        if not example_payload_matches(example):
            problems.append(f"{label}: saved values, flags, units or station do not match the hashed provider payload")
        for request in result.get("requests", []):
            if not is_web_url(request.get("url")) or not request.get("retrievedAt"):
                problems.append(f"{label}: example receipt lacks a URL or retrieval time")
    if not example_ids:
        problems.append("examples.json must contain real saved examples")
    return problems


def load(name):
    return json.loads((ROOT / "data" / name).read_text(encoding="utf-8"))


def geography_problems(geography):
    """Keep context and exact project fixtures distinct and detect fixture changes."""
    problems = []
    if geography.get("schema_version") != 1 or geography.get("context", {}).get("type") != "FeatureCollection":
        problems.append("geography.json: missing supported schema or context collection")
    if not geography.get("contextSource", {}).get("note") or not geography.get("provenance"):
        problems.append("geography.json: missing map provenance or context qualification")
    ids = set()
    for example in geography.get("examples", []):
        shape, source = example.get("geometry", {}), example.get("source", {})
        label = example.get("id")
        if not label or label in ids or shape.get("type") not in {"Polygon", "MultiPolygon"}:
            problems.append("geography.json: invalid project fixture identity or geometry")
        ids.add(label)
        geometry_hash = hashlib.sha256(json.dumps(shape, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
        if source.get("geometrySha256") != geometry_hash:
            problems.append(f"{label}: project geometry does not match its retained hash")
        if not is_web_url(source.get("url")) or not source.get("vintage") or not source.get("rawSha256"):
            problems.append(f"{label}: missing boundary source, vintage or payload hash")
    if not ids or not geography.get("states") or not geography.get("countries"):
        problems.append("geography.json: missing sourced project examples or boundary indexes")
    return problems


def is_web_url(value):
    if not isinstance(value, str):
        return False
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and bool(parts.hostname) and "." in parts.hostname and not re.search(r"\s", value)


def is_iso_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def filled(value):
    return bool(value.strip()) if isinstance(value, str) else bool(value)


def product_problems(product, label):
    """Checks one record's field types and required values."""
    problems = []
    for field in PRODUCT_FIELDS:
        value = product.get(field)
        if value is None:
            if field not in OPTIONAL_PRODUCT_FIELDS:
                problems.append(f"{label}: missing {field}")
        elif field in LIST_FIELDS:
            if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
                problems.append(f"{label}: {field} must be a list of non-empty text")
            elif not value and field != "unresolved_questions":
                problems.append(f"{label}: {field} is empty")
        elif not isinstance(value, str) or not value.strip():
            problems.append(f"{label}: {field} must be non-empty text")
        elif field in RIGHTS_VALUES and value not in RIGHTS_VALUES[field]:
            problems.append(f"{label}: unrecognized {field} {value!r}")
    for field in PRODUCT_URL_FIELDS:
        if product.get(field) is not None and not is_web_url(product[field]):
            problems.append(f"{label}: {field} is not a web address")
    vertical_sources = product.get("vertical_reference_sources")
    if bool(product.get("vertical_reference")) != bool(vertical_sources) or (
        isinstance(vertical_sources, list) and any(source not in (product.get("evidence_ids") or []) for source in vertical_sources)
    ):
        problems.append(f"{label}: vertical reference must cite supporting evidence in this record")
    if product.get("last_checked_date") is not None and not is_iso_date(product["last_checked_date"]):
        problems.append(f"{label}: last_checked_date is not a valid YYYY-MM-DD date")
    return problems


def source_problems(source, label):
    problems = [f"{label}: {field} must be non-empty text" for field in REQUIRED_SOURCE_FIELDS
                if not isinstance(source.get(field), str) or not source[field].strip()]
    for field in OPTIONAL_SOURCE_TEXT_FIELDS:
        if source.get(field) is not None and not isinstance(source[field], str):
            problems.append(f"{label}: {field} must be text")
    history = source.get("link_history")
    if history is not None and (not isinstance(history, dict) or not isinstance(history.get("reason"), str)):
        problems.append(f"{label}: link_history must include a text reason")
    if isinstance(source.get("url"), str) and source["url"].strip() and not is_web_url(source["url"]):
        problems.append(f"{label}: url is not a web address")
    if source.get("alternate_url") and not is_web_url(source["alternate_url"]):
        problems.append(f"{label}: alternate_url is not a web address")
    if isinstance(source.get("checked_date"), str) and source["checked_date"].strip() and not is_iso_date(source["checked_date"]):
        problems.append(f"{label}: checked_date is not a valid YYYY-MM-DD date")
    return problems


def find_problems(products, sources_by_id, groups):
    problems = []
    seen = set()
    for product in products:
        pid = product.get("product_id", "<missing product_id>")
        if pid in seen:
            problems.append(f"{pid}: duplicate product_id")
        seen.add(pid)
        problems += product_problems(product, pid)
        for evidence_id in product.get("evidence_ids", []) if isinstance(product.get("evidence_ids"), list) else []:
            if evidence_id not in sources_by_id:
                problems.append(f"{pid}: no source with evidence_id {evidence_id}")

    group_ids = [group.get("id") for group in groups]
    for group_id in sorted({g for g in group_ids if group_ids.count(g) > 1}, key=str):
        problems.append(f"hazard group {group_id}: duplicate id")
    grouped = set()
    for group in groups:
        members = group.get("products", [])
        for field in ("id", "label", "icon", "color"):
            if not isinstance(group.get(field), str) or not group[field].strip():
                problems.append(f"hazard group {group.get('id')}: {field} must be non-empty text")
        if len(members) != len(set(members)):
            problems.append(f"hazard group {group.get('id')}: lists a product twice")
        for pid in members:
            if pid not in seen:
                problems.append(f"hazard group {group.get('id')}: unknown product {pid}")
        grouped.update(members)
    for pid in sorted(seen - grouped):
        problems.append(f"{pid}: not in any group in data/hazard_groups.json")
    return problems


def discovery_problems(discovery, products):
    keys = {"origin", "lifecycle", "spatial", "frequency", "geography"}
    ids = {product["product_id"] for product in products}
    facets = discovery.get("facets", {})
    records = discovery.get("records", {})
    notes = discovery.get("notes", {})
    if set(facets) != keys or set(records) != ids:
        return ["discovery.json must classify every catalog product with the five discovery filters"]
    problems = []
    for key, facet in facets.items():
        options = facet.get("options")
        if not isinstance(options, dict) or not options or not all(isinstance(facet.get(f), str) and facet[f].strip() for f in ("label", "all", "description")):
            problems.append(f"discovery.{key}: missing filter definition")
            continue
        if not all(re.fullmatch(r"[a-z0-9-]+", code) and isinstance(label, str) and label.strip() for code, label in options.items()):
            problems.append(f"discovery.{key}: invalid option")
        for pid, record in records.items():
            values = record.get(key) if isinstance(record, dict) else None
            if not isinstance(values, list) or not values or not all(isinstance(v, str) and v in options for v in values) or len(set(values)) != len(values):
                problems.append(f"{pid}: missing, duplicate or unknown discovery.{key} value")
    if any(not isinstance(r, dict) or set(r) != keys for r in records.values()):
        problems.append("discovery.json has an unexpected record field")
    if not isinstance(notes, dict) or any(pid not in ids or not isinstance(note, str) or not note.strip() for pid, note in notes.items()):
        problems.append("discovery.json has an invalid qualification")
    return problems


def access_problems(access, grid, products):
    problems = []
    ids = {p["product_id"] for p in products}
    profiles = access.get("profiles", {})
    if access.get("schemaVersion") != 1 or set(profiles) != ids:
        problems.append("access.json must contain exactly one reviewed profile for every catalog record")
    strategies = {"station", "grid", "snapshot", "cmr", "stac", "cds", "mrms", "erddap",
                  "daily-template", "ims-daily-template", "awdb-daily", "coolr-arcgis", "portal", "versioned-model-handoff"}
    def https(value):
        try:
            url = urlsplit(value)
            return url.scheme == "https" and bool(url.netloc) and not url.username and not url.password
        except (ValueError, TypeError):
            return False
    for pid, profile in profiles.items():
        label = f"access.json {pid}"
        if profile.get("productId") != pid or profile.get("kind") not in {"station", "files", "request", "external"} or profile.get("strategy") not in strategies:
            problems.append(f"{label}: invalid identity or route")
        if any(not isinstance(profile.get(k), str) or not profile[k] for k in ("summary", "auth", "spatialDelivery", "temporalDelivery")):
            problems.append(f"{label}: missing access qualification")
        verification = profile.get("verification", {})
        if not verification.get("label") or not is_iso_date(str(verification.get("checkedAt", ""))[:10]):
            problems.append(f"{label}: missing dated verification")
        if any(not https(profile.get(k)) for k in ("providerUrl", "docsUrl")):
            problems.append(f"{label}: unsafe provider/documentation URL")
        options = profile.get("options", [])
        if len({o.get("key") for o in options}) != len(options):
            problems.append(f"{label}: duplicate option key")
        for option in options:
            values = [str(c.get("value")) for c in option.get("choices", [])]
            if not option.get("key") or not option.get("label") or len(set(values)) != len(values) or str(option.get("value")) not in values:
                problems.append(f"{label}: invalid option choices/default")
        files = profile.get("files", [])
        if len({f.get("id", f.get("url")) for f in files}) != len(files):
            problems.append(f"{label}: duplicate file identity")
        for file in files:
            if not https(file.get("url")) or not file.get("name"):
                problems.append(f"{label}: unsafe or unnamed file")
            if "bounds" in file:
                box = file["bounds"]
                if not (isinstance(box, list) and len(box) == 4 and all(type(n) in (int, float) and math.isfinite(n) for n in box)
                        and abs(box[0]) <= 180 and abs(box[2]) <= 180 and -90 <= box[1] < box[3] <= 90 and box[0] != box[2]):
                    problems.append(f"{label}: invalid file bounds")
            if file.get("checksum") and not re.fullmatch(r"md5:[a-fA-F0-9]{32}", str(file["checksum"])):
                problems.append(f"{label}: invalid provider checksum")
        if profile.get("strategy") == "cmr" and (not profile.get("collections") or any(not re.fullmatch(r"C\d+-[A-Za-z0-9_]+", c.get("id", "")) or not c.get("shortName") or not c.get("version") for c in profile["collections"])):
            problems.append(f"{label}: invalid exact CMR collection")
    grid_ids = {pid for pid, p in profiles.items() if p.get("strategy") == "grid"}
    if grid.get("schemaVersion") != 1 or set(grid.get("products", {})) != grid_ids:
        problems.append("grid-access-index.json does not match the reviewed grid routes")
    for pid, product in grid.get("products", {}).items():
        files = product.get("files", [])
        if not files or len({f.get("url") for f in files}) != len(files):
            problems.append(f"{pid}: missing or duplicate grid files")
        for file in files:
            if not https(file.get("url")) or not is_iso_date(file.get("start")) or not is_iso_date(file.get("end")) or file["start"] > file["end"] or not is_iso_date(str(file.get("metadataCheckedAt", ""))[:10]):
                problems.append(f"{pid}: invalid grid file URL, dates or verification")
    return problems


def main():
    catalog = load("catalog.json")
    source_list = load("sources.json")
    groups = load("hazard_groups.json")
    screening = load("screening.json")
    examples = load("examples.json")
    geography = load("geography.json")
    country_boundaries = load("country-boundaries.json")
    station_reference = load("station-reference.json")
    access = load("access.json")
    discovery = load("discovery.json")
    snotel = load("snotel-stations.json")
    grid_access = load("grid-access-index.json")
    sources_by_id = {source["evidence_id"]: source for source in source_list}
    products = catalog["products"]

    problems = find_problems(products, sources_by_id, groups)
    problems += discovery_problems(discovery, products)
    stations = snotel.get("stations", [])
    if not stations or len({s.get("id") for s in stations}) != len(stations) or any(
        not re.fullmatch(r"\d+:[A-Z]{2}:SNTL", str(s.get("id"))) or not s.get("name")
        or not all(type(s.get(key)) in (float, int) and abs(s[key]) <= limit for key, limit in (("lat", 90), ("lon", 180)))
        or any(s.get(key) is not None and not is_iso_date(s[key]) for key in ("start", "end")) for s in stations
    ):
        problems.append("snotel-stations.json contains an invalid station directory")
    if len(sources_by_id) != len(source_list):
        problems.append("sources.json contains a duplicate evidence_id")

    revision_parts = [part.strip() for part in str(catalog.get("catalog_revision", "")).split("|")]
    if len(revision_parts) < 2 or not revision_parts[0] or not is_iso_date(revision_parts[1]):
        problems.append("catalog_revision must look like: revision | YYYY-MM-DD | note")

    linked_ids = sorted({e for p in products if isinstance(p.get("evidence_ids"), list) for e in p["evidence_ids"]})
    public_products = [
        {f: p[f] for f in PRODUCT_FIELDS if p.get(f) is not None} for p in products
    ]
    public_sources = {
        i: {f: sources_by_id[i][f] for f in SOURCE_FIELDS if sources_by_id[i].get(f) is not None}
        for i in linked_ids if i in sources_by_id
    }
    for evidence_id, source in public_sources.items():
        problems += source_problems(source, evidence_id)
    problems += screening_problems(screening, examples, products, public_sources)
    problems += geography_problems(geography)
    for name, reference in (("country-boundaries", country_boundaries), ("station-reference", station_reference)):
        if reference.get("schema_version") != 1 or not re.fullmatch(r"[a-f0-9]{64}", reference.get("source", {}).get("sha256", "")):
            problems.append(name + ": missing reference schema or source hash")
    if not country_boundaries.get("features") or not station_reference.get("elevationsM") or not station_reference.get("locationChecks"):
        problems.append("Missing country or station reference data")
    problems += access_problems(access, grid_access, products)
    if problems:
        sys.exit("index.html was not changed:\n  " + "\n  ".join(dict.fromkeys(problems)))

    try:
        derive_screening_index_metadata(screening, grid_access)  # Validate the index; embed the source rules unchanged.
    except ValueError as error:
        sys.exit("index.html was not changed:\n  " + str(error))

    payload = {
        "meta": {
            "revision": revision_parts[0],
            "snapshot_date": revision_parts[1],
            "rights_note": catalog["status_definitions"]["commercial_use_status"],
            "review_version": revision_parts[0].removeprefix("v"),
            "build_id": "__INVENTORY_BUILD_ID__",
        },
        "hazard_groups": groups,
        "discovery": discovery,
        "snotelStations": snotel,
        "products": public_products,
        "sources": public_sources,
        "screening": screening,
        "examples": examples,
        "geography": {k: v for k, v in geography.items() if k not in {"context", "contextSource"}},
        "countryBoundaries": country_boundaries,
        "stationReference": station_reference,
        "access": access,
        "gridAccess": grid_access,
    }
    # "<" is escaped so catalog text can never close the surrounding script element.
    block = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")

    page = PAGE.read_text(encoding="utf-8")
    page, replaced = DATA_BLOCK.subn(lambda m: f"{m.group(1)}\n{block}\n{m.group(2)}", page)
    if replaced != 1:
        sys.exit("index.html was not changed: could not find its inventory-data block")
    overview = load("offline-basemap.json")
    if not isinstance(overview.get("maxZoom"), int) or not overview.get("tiles", {}).get("0/0/0"):
        sys.exit("Invalid OpenFreeMap overview")
    for key, digest in overview.get("shards", {}).items():
        if not re.fullmatch(r"\d+-\d+-\d+", key) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            sys.exit("Invalid OpenFreeMap tile archive identifier")
        shard = ROOT / "data" / "map-tiles" / f"{key}.{digest[:16]}.js"
        if not shard.is_file() or hashlib.sha256(shard.read_bytes()).hexdigest() != digest:
            sys.exit(f"Invalid or missing OpenFreeMap tile archive: {key}")
    packed = json.dumps(overview, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    pattern = re.compile(r'(<script id="reference-map-data" type="application/json">).*?(</script>)', re.S)
    page, count = pattern.subn(lambda m: m[1] + packed + m[2], page)
    if count != 1:
        sys.exit("Missing or duplicate reference-map-data block")
    if '<script id="grdc-catalogue-code">' not in page:
        page = page.replace('<script id="site-check-code">', '<script id="grdc-catalogue-code"></script>\n<script id="site-check-code">')
    if '<script id="ghcn-archive-code">' not in page:
        page = page.replace('<script id="providers-code">', '<script id="ghcn-parquet-code"></script>\n<script id="ghcn-archive-code"></script>\n<script id="providers-code">')
    if '<script id="ghcn-gzip-code">' not in page:
        page = page.replace('<script id="ghcn-archive-code">', '<script id="ghcn-gzip-code"></script>\n<script id="ghcn-archive-code">')
    if '<script id="shortlist-code">' not in page:
        page = page.replace('<script id="screening-code">', '<script id="shortlist-code"></script>\n<script id="screening-code">')
    for asset_id, (tag, filename) in PAGE_ASSETS.items():
        content = (ROOT / filename).read_text(encoding="utf-8")
        if re.search(fr"</{tag}", content, re.I):
            sys.exit(f"index.html was not changed: unsafe closing tag in {filename}")
        pattern = re.compile(fr'(<{tag} id="{asset_id}">).*?(</{tag}>)', re.S)
        page, count = pattern.subn(lambda m: f"{m.group(1)}\n{content.rstrip()}\n{m.group(2)}", page)
        if count != 1:
            sys.exit(f"index.html was not changed: missing or duplicate {asset_id} block")
    # Compute the content identifier before inserting it into the page.
    if page.count("__INVENTORY_BUILD_ID__") != 1:
        sys.exit("index.html was not changed: invalid build identity placeholder")
    build_id = revision_parts[0] + "-" + hashlib.sha256(page.encode("utf-8")).hexdigest()[:16]
    page = page.replace("__INVENTORY_BUILD_ID__", build_id)
    PAGE.write_text(page, encoding="utf-8", newline="\n")
    print(f"index.html: {len(products)} records, {len(groups)} hazard groups, "
          f"{len(linked_ids)} linked sources, catalog {revision_parts[0]} ({revision_parts[1]})")


if __name__ == "__main__":
    main()
