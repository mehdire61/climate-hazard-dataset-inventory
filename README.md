# Climate-Hazard Dataset Inventory v0.2

Find climate and water datasets for a project location and period. The inventory contains **53 records in nine overlapping hazard groups**, with links to 213 sources. [Open the inventory on GitHub Pages](https://mehdire61.github.io/climate-hazard-dataset-inventory/)

v0.2 adds **Site check** and one dataset to the v0.1 catalog. **Copernicus satellite lake water levels** (v5.0) reports water surface height and uncertainty for monitored lakes. [Copernicus Climate Data Store](https://cds.climate.copernicus.eu/datasets/satellite-lake-water-level)

## Using the inventory

1. Open **Site check** and choose a point with a search radius, a named boundary or your own area. Set the project dates.
2. Choose a hazard group to see the shortlist. Each record explains what the product measures, its spatial and temporal resolution, and how to get it. Screening uses documented coverage. Actual availability can vary by station, grid cell, event and date.
3. For supported stations, preview observations and inspect units, gaps, flags and the reporting period. For gridded products, follow the access route to the provider or prepare a file request. Some providers require an account.
4. Export the project brief or screening CSV to share your findings. The **Inventory** tab also lets you browse, filter and export catalog metadata across all hazard groups.

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

```sh
python build.py
python -B -m unittest discover -s tests -p "build_test.py"
node --test "tests/*.test.cjs"
```

## Sources and reuse

Records link to provider documentation, access conditions and scientific limitations. The three NOAA Storm Events entries describe hazard-specific views of one reporting collection. For corrections, include the record name and a supporting source. [Report a correction](https://github.com/mehdire61/climate-hazard-dataset-inventory/issues)

Each provider sets the terms for its data. Source records, station previews and file checks describe the product, place and period examined. Project suitability also depends on scale, completeness and the analysis you intend to perform. The map credits OpenFreeMap, OpenMapTiles and OpenStreetMap contributors. [Map sources and attribution](docs/BASEMAP.md) · [Map data licence](data/offline-basemap-LICENSE.txt)
