"""Build and catalog-preservation checks; uses only the standard library."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class BuildChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        for name in ("build.py", "index.html"):
            shutil.copy2(ROOT / name, self.folder / name)
        for name in ("data", "src", "vendor"):
            shutil.copytree(ROOT / name, self.folder / name)

    def tearDown(self):
        self.temp.cleanup()

    def run_build(self):
        return subprocess.run([sys.executable, str(self.folder / "build.py")], capture_output=True, text=True)

    def edit_json(self, name, edit):
        path = self.folder / "data" / name
        value = json.loads(path.read_text(encoding="utf-8"))
        edit(value)
        path.write_text(json.dumps(value), encoding="utf-8")

    def assert_rejected_unchanged(self):
        before = (self.folder / "index.html").read_bytes()
        result = self.run_build()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(before, (self.folder / "index.html").read_bytes())

    def test_repeat_build_preserves_sources_and_is_deterministic(self):
        hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (self.folder / "data").glob("*.json")}
        self.assertEqual(self.run_build().returncode, 0)
        first = (self.folder / "index.html").read_bytes()
        self.assertEqual(self.run_build().returncode, 0)
        self.assertEqual(first, (self.folder / "index.html").read_bytes())
        self.assertEqual(hashes, {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (self.folder / "data").glob("*.json")})
        page = first.decode("utf-8")
        payload = json.loads(re.search(r'<script id="inventory-data" type="application/json">(.*?)</script>', page, re.S)[1])
        self.assertEqual(len(payload["products"]), 57)
        source_records = json.loads((self.folder / "data/sources.json").read_text(encoding="utf-8"))
        self.assertEqual(set(payload["sources"]), {source["evidence_id"] for source in source_records})
        self.assertEqual(len(payload["hazard_groups"]), 9)
        availability_block = re.search(r'<script id="coops-availability-code">(.*?)</script>', page, re.S)
        self.assertIsNotNone(availability_block)
        self.assertEqual(availability_block[1].strip(), (self.folder / "src/coops-availability.js").read_text(encoding="utf-8").strip())
        self.assertLess(page.index('<script id="coops-availability-code">'), page.index('<script id="providers-code">'))
        catalog = json.loads((self.folder / "data/catalog.json").read_text(encoding="utf-8"))
        snapshot = payload["meta"]["snapshot_date"]
        self.assertGreaterEqual(snapshot, max(p["last_checked_date"] for p in payload["products"]))
        self.assertGreaterEqual(snapshot, max(s["checked_date"] for s in source_records))
        screening = payload["screening"]
        self.assertEqual(screening["catalog_revision"], catalog["catalog_revision"])
        self.assertGreaterEqual(screening["review_date"], max(r["curation_reviewed_on"] for r in screening["rules"].values()))
        original = {p["product_id"]: p for p in catalog["products"]}
        for product in payload["products"]:
            for key, value in product.items():
                self.assertEqual(value, original[product["product_id"]][key])

    def test_missing_screening_rule_rejected(self):
        self.edit_json("screening.json", lambda data: data["rules"].pop("ghcn_daily"))
        self.assert_rejected_unchanged()

    def test_unclassified_and_invalid_discovery_filters_rejected(self):
        self.edit_json("discovery.json", lambda data: data["records"]["ghcn_daily"].pop("origin"))
        self.edit_json("discovery.json", lambda data: data["records"]["isd_global_hourly"].update(lifecycle=["not-a-status"]))
        before = (self.folder / "index.html").read_bytes()
        result = self.run_build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ghcn_daily: missing, duplicate or unknown discovery.origin", result.stderr)
        self.assertIn("isd_global_hourly: missing, duplicate or unknown discovery.lifecycle", result.stderr)
        self.assertEqual((self.folder / "index.html").read_bytes(), before)

    def test_unrecognized_rights_codes_rejected_before_page_is_changed(self):
        def introduce_invalid_codes(data):
            data["products"][0]["commercial_use_status"] = "ALLOWED_WITH_CONDITIONS"
            data["products"][1]["redistribution_status"] = "ALLOWED_WITH_CONDITIONS"
            data["products"][2]["license_id"] = "CC_BY_4_0"
        self.edit_json("catalog.json", introduce_invalid_codes)
        before = (self.folder / "index.html").read_bytes()
        result = self.run_build()
        self.assertNotEqual(result.returncode, 0)
        for field in ("commercial_use_status", "redistribution_status", "license_id"):
            self.assertIn("unrecognized " + field, result.stderr)
        self.assertEqual((self.folder / "index.html").read_bytes(), before)

    def test_open_interval_requires_explicit_availability_basis(self):
        self.edit_json("screening.json", lambda data: data["rules"]["ims_snow_ice"]["time"].pop("latest_availability"))
        self.assert_rejected_unchanged()

    def test_build_id_changes_when_application_source_changes(self):
        self.assertEqual(self.run_build().returncode, 0)
        before = (self.folder / "index.html").read_text(encoding="utf-8")
        source = self.folder / "src/access.js"
        source.write_text(source.read_text(encoding="utf-8") + "\n// Build identity regression fixture.\n", encoding="utf-8")
        self.assertEqual(self.run_build().returncode, 0)
        after = (self.folder / "index.html").read_text(encoding="utf-8")
        identity = r'"build_id":"(v0\.3-[a-f0-9]{16})"'
        self.assertNotEqual(re.search(identity, before)[1], re.search(identity, after)[1])

    def test_missing_catalog_access_profile_rejected(self):
        self.edit_json("access.json", lambda data: data["profiles"].pop("era5_t2m"))
        self.assert_rejected_unchanged()

    def test_unsafe_provider_file_url_rejected(self):
        self.edit_json("access.json", lambda data: data["profiles"]["psmsl_rlr"]["files"][0].update(url="javascript:alert(1)"))
        self.assert_rejected_unchanged()

    def test_unpinned_collection_rejected(self):
        self.edit_json("access.json", lambda data: data["profiles"]["mcd64a1"]["collections"][0].update(id="latest"))
        self.assert_rejected_unchanged()

    def test_untraceable_screening_rule_rejected(self):
        self.edit_json("screening.json", lambda data: data["rules"]["ghcn_daily"].update(evidence_ids=["not-a-source"]))
        self.assert_rejected_unchanged()

    def test_cross_product_source_reference_rejected(self):
        self.edit_json("screening.json", lambda data: data["rules"]["ghcn_daily"].update(evidence_ids=["F04"]))
        self.assert_rejected_unchanged()

    def test_unknown_controlled_support_rejected(self):
        self.edit_json("screening.json", lambda data: data["rules"]["ghcn_daily"].update(support_type="not-a-real-kind"))
        self.assert_rejected_unchanged()

    def test_altered_saved_value_rejected(self):
        self.edit_json("examples.json", lambda data: data["examples"][0]["result"]["series"][0]["points"][0].update(value=999))
        self.assert_rejected_unchanged()

    def test_altered_saved_station_rejected(self):
        self.edit_json("examples.json", lambda data: data["examples"][0]["station"].update(id="USW00000000"))
        self.assert_rejected_unchanged()

    def test_example_without_original_payload_rejected(self):
        self.edit_json("examples.json", lambda data: data["examples"][0]["result"].update(rawText=""))
        self.assert_rejected_unchanged()

    def test_unsafe_script_boundary_rejected(self):
        path = self.folder / "src/site-check.js"
        path.write_text(path.read_text(encoding="utf-8") + '\n// </script><script>alert(1)</script>', encoding="utf-8")
        self.assert_rejected_unchanged()

    def test_catalog_script_text_is_escaped(self):
        self.edit_json("catalog.json", lambda data: data["products"][0].update(product_name="</script><img src=x onerror=alert(1)>"))
        self.assertEqual(self.run_build().returncode, 0)
        self.assertNotIn("</script><img src=x", (self.folder / "index.html").read_text(encoding="utf-8"))

    def test_altered_project_geometry_rejected(self):
        self.edit_json("geography.json", lambda data: data["examples"][0]["geometry"].update(coordinates=[]))
        self.assert_rejected_unchanged()

    def test_project_boundary_without_source_rejected(self):
        self.edit_json("geography.json", lambda data: data["examples"][0]["source"].update(url="", vintage=""))
        self.assert_rejected_unchanged()


if __name__ == "__main__":
    unittest.main()
