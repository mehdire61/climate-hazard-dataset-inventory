# NOAA archive fixtures

`US1VAFX0117.csv.gz` is the unchanged NOAA GHCN-Daily station archive retrieved on November 18, 2026. Its SHA-256 is `3e46138a531d868405141770fe4b5fc10cdf5fbd77020bc632302363bc031730`. [NOAA station archive](https://noaa-ghcn-pds.s3.amazonaws.com/csv.gz/by_station/US1VAFX0117.csv.gz)

`2026-11-PRCP-test.parquet` is a small test file containing selected native BWI precipitation rows and a second station ID to exercise station filtering. Its layout mirrors the NOAA annual Parquet fields. The original observation column uses tenths of a millimetre. The stored measurement, quality, source and observation-time fields are checked separately. [NOAA GHCN-Daily Open Data](https://registry.opendata.aws/noaa-ghcn/)
