#!/usr/bin/env python3
"""Refresh the data block embedded in index.html from the JSON files in data/.

Usage: python build.py

The JSON files contain the public catalog, source descriptions and browsing groups.
Only fields used by the page or metadata export are embedded. The source JSON files
are never changed. The script stops without changing index.html if validation fails.
"""
import json
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
]
SOURCE_FIELDS = [
    "evidence_id", "title", "url", "doi", "claims", "checked_date", "verification",
    "link_status", "alternate_url", "alternate_label", "link_history",
]
LIST_FIELDS = {"hazard_family", "supported_use_cases", "non_uses", "limitations", "evidence_ids", "formats", "unresolved_questions"}
OPTIONAL_PRODUCT_FIELDS = {"access_example_url", "license_url", "license_url_label"}
PRODUCT_URL_FIELDS = ("documentation_url", "access_url", "access_example_url", "license_url")
REQUIRED_SOURCE_FIELDS = ("title", "url", "claims", "checked_date", "verification")
OPTIONAL_SOURCE_TEXT_FIELDS = ("doi", "link_status", "alternate_url", "alternate_label")
DATA_BLOCK = re.compile(r'(<script id="inventory-data" type="application/json">).*?(</script>)', re.S)


def load(name):
    return json.loads((ROOT / "data" / name).read_text(encoding="utf-8"))


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
    for field in PRODUCT_URL_FIELDS:
        if product.get(field) is not None and not is_web_url(product[field]):
            problems.append(f"{label}: {field} is not a web address")
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


def main():
    catalog = load("catalog.json")
    source_list = load("sources.json")
    groups = load("hazard_groups.json")
    sources_by_id = {source["evidence_id"]: source for source in source_list}
    products = catalog["products"]

    problems = find_problems(products, sources_by_id, groups)
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
    if problems:
        sys.exit("index.html was not changed:\n  " + "\n  ".join(dict.fromkeys(problems)))

    payload = {
        "meta": {
            "revision": revision_parts[0],
            "snapshot_date": revision_parts[1],
            "rights_note": catalog["status_definitions"]["commercial_use_status"],
        },
        "hazard_groups": groups,
        "products": public_products,
        "sources": public_sources,
    }
    # "<" is escaped so catalog text can never close the surrounding script element.
    block = json.dumps(payload, ensure_ascii=False, indent=1).replace("<", "\\u003c")

    page = PAGE.read_text(encoding="utf-8")
    page, replaced = DATA_BLOCK.subn(lambda m: f"{m.group(1)}\n{block}\n{m.group(2)}", page)
    if replaced != 1:
        sys.exit("index.html was not changed: could not find its inventory-data block")
    PAGE.write_text(page, encoding="utf-8", newline="\n")
    print(f"index.html: {len(products)} records, {len(groups)} hazard groups, "
          f"{len(linked_ids)} linked sources, catalog {revision_parts[0]} ({revision_parts[1]})")


if __name__ == "__main__":
    main()
