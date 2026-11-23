# Climate-Hazard Dataset Inventory v0.3

Find climate and water datasets for a project location and period. This v0.3 development build contains **57 records in nine overlapping hazard groups** and links to 242 sources. The inventory focuses on historical observations and reference products. [Open this inventory](index.html#inventory) · [Public site](https://mehdire61.github.io/climate-hazard-dataset-inventory/)

In **Inventory**, choose a hazard, provider or commercial-use status. Open **More filters** for data origin, product lifecycle, spatial scale, temporal scale and geographic scope. Products can have several origins or scales. Each option counts the matching records when the other filters are applied. **Copy filtered view** preserves your filters, search text and sort order. The metadata CSV follows the visible rows and includes their classifications. Use **Copy record link** to cite an individual dataset. Links copied from a local preview open on the same computer. The CSV includes a portable `record_fragment` that can be appended to another copy of the same catalog.

**SNOTEL daily snow water equivalent** measures snowpack water storage at individual western U.S. and Alaska stations. Site check lists stations in the project search area from the reviewed NRCS directory, including inactive stations for historical periods. Choose one to open NRCS daily values with units and flags for the project dates. The checked example covers Brundage Reservoir, Idaho, on April 1–3, 2024. [Open the record](index.html#inventory?record=nrcs_snotel_daily_swe) · [Provider responses and retrieval details](docs/evidence/snotel/receipts.json)

**SNODAS daily gridded snow water equivalent** covers the conterminous United States. Site check prepares the requested daily archives and flags provider-documented gaps and erroneous SWE. On April 1, 2024 the masked grid cell containing Brundage Reservoir, Idaho, held 609 mm at 06:00 UTC. [Open the record](index.html#inventory?record=nohrsc_snodas_daily_swe) · [Original-file inspection](docs/evidence/snodas/receipt.json)

## Using the inventory

Use **Compare** on a record or open **Compare datasets** to line up two to four editions. The table includes time support, spatial scale, shared inputs, reuse terms and any documented vertical reference. Selections persist when the filters change. **Copy comparison link** opens the same records in order. [Compare CHIRPS, IMERG and GPCC](index.html#inventory?compare=chirps_v3_daily_rnl,gpm_imerg_final_v07b,gpcc_monthly_v2025)

**JRC global river flood depth** gives continuous depth in metres for the fixed 100-year scenario. Site check matches the project footprint to the public raw GeoTIFF tiles. The file directory also supplies permanent-water and spurious-depth masks. [Open the record](index.html#inventory?record=jrc_glofas_rp100_depth) · [Checked tile and sample cells](docs/evidence/jrc-flood/receipt.json)

**GLEAM v4.2a actual evapotranspiration** covers 1980–2023 on a 0.1° land grid. The annual 1980 file reports 762.392 mm for the cell at 38.95°N, 77.05°W. Calculating a HUC12 mean requires intersecting its boundary with the valid cells. The record flags the different reuse terms on Zenodo and the GLEAM website. [Open the record](index.html#inventory?record=gleam_v4_2a_actual_evaporation) · [File inspection](docs/evidence/gleam/receipt.json)

For a U.S. assessment, choose **Project area → U.S. hydrologic unit (HUC)**. HUC12 is the default level. Search USGS by code or name, or open **Find a unit by location** to click the map or enter coordinates. Select a returned boundary and click **Check site** to apply it. HUC10 and HUC8 are also available. Drainage upstream of an outlet can extend beyond its containing unit.

The default geometry is explicitly generalized by USGS at 0.00001° in WGS84. Choose **Full USGS geometry** when boundary detail matters and the polygon fits the browser limits. Near-edge station inclusion can change. Project files preserve the exact polygon used, code and precision. Reopened files label source attribution as unverified until the unit is selected again from USGS. [Six-unit boundary comparison](docs/evidence/wbd/boundary-trial.json)

1. Open **Site check** and choose a point with a search radius, a named boundary or your own area. Set the project dates.
2. Choose a hazard group to see the shortlist. Each record explains what the product measures, its spatial and temporal resolution, and how to get it. Screening uses documented coverage. Actual availability can vary by station, grid cell, event and date.
3. For supported stations, preview observations and inspect units, gaps, flags and the reporting period. For gridded products, follow the access route to the provider or prepare a file request. Some providers require an account.
4. Export the project brief or screening CSV to share your findings. The **Inventory** tab also lets you browse, filter and export catalog metadata across all hazard groups.

The SNOTEL and SNODAS records include an offline April 1, 2024 map of Brundage Reservoir, Idaho. Select a native grid cell to inspect SWE alongside the station reading and HUC12 boundary. The source links identify the station reporting day, 06:00 UTC grid and USGS geometry. [Map data and source URLs](data/brundage-swe.json) · [Rebuild the subset](scripts/build_snow_example.py)

## Running locally

Open [index.html](index.html) in a browser. Keep the directory structure intact so the map can load its regional tiles. The catalog, screening, saved examples and overview map work offline. Live station searches, provider downloads and optional online map detail need internet access.

To use a local web server, run the following from this folder. It opens the app in your default browser. Windows users can also double-click **Start preview.cmd**.

```sh
python preview.py
```

## Maintaining the site

The site is static. GitHub Pages can serve it from the repository root. The page embeds the catalog and application code. Regional map tiles are loaded from `data/map-tiles/`.

| Location | Contents |
| --- | --- |
| `data/` | Catalog records, sources, hazard groups, screening rules, access profiles, saved examples and map data |
| `src/` | Site-check interface, screening, provider adapters, charts and exports |
| `docs/evidence/` | Provider metadata and selected sample records referenced by the access profiles |
| `vendor/` | Bundled browser libraries and their licences |
| `tests/` | Automated application and build tests, with sample provider responses |

After editing the data or application source, rebuild with Python 3.10 or later and run the tests. The build uses the Python standard library. The JavaScript tests use Node.js 22 or later and Python on the command path.

For each enhancement, exercise the affected workflow and its existing entry and exit points. Browser regressions replay searches, sorts and CSV downloads captured from the published v0.2 application, check the relative order of its 53 records as new ones are added, and reopen a project file exported by that release. The suite also checks shared links, map selection, observation gaps and offline record navigation. [Published v0.2 regression fixture](tests/fixtures/inventory-v02.json)

The GitHub Actions workflow rebuilds the committed page, runs both suites and checks record navigation, filters and CSV downloads in Chromium on pushes and pull requests. The build validates commercial-use, redistribution and license codes. v0.3 uses `PERMITTED_WITH_CONDITIONS` for the five records previously exported as `ALLOWED_WITH_CONDITIONS`. The Copernicus lake record uses `CC-BY-4.0`. CHIRPS retains its version-specific provider terms.

```sh
python build.py
python -B -m unittest discover -s tests -p "build_test.py"
node --test "tests/*.test.cjs"
```

## Sources and reuse

Records link to provider documentation, access conditions and scientific limitations. The three NOAA Storm Events entries describe hazard-specific views of one reporting collection. For corrections, include the record name and a supporting source. [Report a correction](https://github.com/mehdire61/climate-hazard-dataset-inventory/issues)

Each provider sets the terms for its data. Source records, station previews and file checks describe the product, place and period examined. Project suitability also depends on scale, completeness and the analysis you intend to perform. The map credits OpenFreeMap, OpenMapTiles and OpenStreetMap contributors. [Map sources and attribution](docs/BASEMAP.md) · [Map data licence](data/offline-basemap-LICENSE.txt)
