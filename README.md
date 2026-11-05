# Climate-Hazard Dataset Inventory

A searchable inventory of climate-hazard datasets, with documented quantities, coverage, uses, limitations and links to the original sources.

**Version v0.1 · Updated 4 November 2026**

**[Open the inventory](https://mehdire61.github.io/climate-hazard-dataset-inventory/)** — use it directly in your browser; no download or installation is needed.

Use this website address when sharing the inventory: https://mehdire61.github.io/climate-hazard-dataset-inventory/. The [GitHub repository](https://github.com/mehdire61/climate-hazard-dataset-inventory) provides the source files and issue tracker.

The inventory contains 52 records across nine overlapping hazard groups. Search or filter the records, open their details and supporting sources, or download the displayed metadata as CSV. The three NCEI Storm Events entries are views of one reporting collection; record counts do not represent independent datasets.

The inventory summarizes documentation and publications. Scientific data files have not been downloaded or tested here. Coverage is selective, and the severe-thunderstorm entries currently focus on the United States. Dataset-specific limitations and access conditions are stated in each record.

## Open locally

Open [index.html](index.html) in a browser. The page is self-contained and does not require installation, a server or an internet connection to browse the embedded inventory. External source links require internet access.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Complete page, styling, JavaScript and embedded public metadata |
| `data/catalog.json` | Public dataset records and catalog revision |
| `data/sources.json` | Linked source descriptions, review dates and access qualifications |
| `data/hazard_groups.json` | Browsing groups and record membership |
| `build.py` | Validates and embeds the JSON metadata in the page |

The JSON files contain the public text used by the page. No separate wording transformation is required. Groups overlap; the total is calculated from unique product records.

## Update the inventory

1. Edit the relevant files in `data/`. Link sources through each record's `evidence_ids`, and include each new record in at least one browsing group.
2. Update `catalog_revision` in `data/catalog.json`, preserving the `revision | YYYY-MM-DD | note` format. This tracks metadata changes separately from the public release version and is retained in JSON and CSV, rather than displayed on the page. Source checked dates should reflect when the documentation was reviewed.
3. With Python 3.10 or later, run:

   ```sh
   python build.py
   ```

4. Open the page and check the affected records, filters and CSV export.

The build uses only the Python standard library. It validates required record and source fields, dates, web addresses, identifiers and group membership before rewriting the embedded data. It leaves the source JSON files unchanged. Edit `index.html` directly for layout or interface changes; the build replaces only its `inventory-data` block.

The CSV contains the filtered public catalog metadata, in the displayed order. It includes scientific qualifications and source URLs, but not the complete source annotations or the underlying scientific data files. Its quantity column is named `quantity_represented`.

## Website deployment

GitHub Pages publishes this repository from **main → / (root)**. After rebuilding and checking a change locally, commit and push it to `main`; GitHub deploys the updated files at the same website address. The included `.nojekyll` file allows the static files to be served without Jekyll processing. No custom deployment workflow or server-side application is required.

The page's canonical URL identifies the public website. `REPOSITORY_URL` in `index.html` points to the source repository so the correction link opens GitHub Issues.

See [GitHub's Pages setup documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site).

## Corrections and reuse

To suggest a correction, [open a GitHub issue](https://github.com/mehdire61/climate-hazard-dataset-inventory/issues) with the record name, the text to change and a link to supporting provider documentation or a scientific publication.

Linked datasets retain their providers' access and reuse conditions. A metadata listing does not grant permission to redistribute the underlying data. No repository-wide reuse licence has been selected for this release.
