Frozen provider responses and application-exported structures used by the automated tests. Request URLs and retrieval metadata are retained where present in the source material. Fixtures are not current provider checks or independent proof of the application output. Additional synthetic cases are constructed in the test code.

usgs/buffalo-bayou-daily-2017-08-25_31.json
Exact provider response checked on 2026-11-17, SHA-256 b0c23028eac6b617e3e66491b7322e19390f9343c640b1f26a1290e4b9efbffd.
https://api.waterdata.usgs.gov/ogcapi/v1/collections/daily/items?f=json&monitoring_location_id=USGS-08074000&parameter_code=00060&statistic_id=00003&time=2017-08-25%2F2017-08-31&limit=10000
August 26–28 carry Approved, ESTIMATED and REVISED together. August 25 has no returned row.

ghcn-daily/bwi-ghcn-daily-2026-10-18_11-13.json
Exact provider response checked on 2026-11-17, SHA-256 aa250893886751847fe4a20bd1eb3482410bbda0c974df2de8aa82b4240f55e2.
https://www.ncei.noaa.gov/access/services/data/v1?dataset=daily-summaries&stations=USW00093721&startDate=2026-10-18&endDate=2026-11-13&dataTypes=TMAX%2CTMIN%2CPRCP%2CSNOW%2CMDPR%2CDAPR%2CMDSF%2CDASF&units=metric&includeAttributes=true&includeStationName=true&includeStationLocation=true&format=json
All 27 precipitation records carry source flag 1 with blank measurement and QC fields. The NCEI GHCN-Daily README defines 1 as NWS CF6 and D as the same reports supplied through the High Plains Regional Climate Center. Lowercase d identifies a different report. NCEI and NWS describe Form F-6 as preliminary Local Climatological Data.
https://www.ncei.noaa.gov/pub/data/ghcn/daily/readme.txt
https://www.ncei.noaa.gov/access/search/publications/
https://www.weather.gov/help-past-weather
