"""Rebuild the Brundage map from the retained station evidence, WBD response and original SNODAS tar."""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import struct
import tarfile
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]
WBD = "https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer/6/query"


def make_example(archive, boundary):
    evidence = ROOT / "docs/evidence"
    receipt = json.loads((evidence / "snodas/receipt.json").read_bytes())
    station = json.loads((evidence / "snotel/brundage-station.json").read_bytes())[0]
    daily = json.loads((evidence / "snotel/brundage-daily-wteq.json").read_bytes())[0]
    series = next(s for s in daily["data"] if s["stationElement"]["elementCode"] == "WTEQ")
    day = receipt["validTime"][:10]
    reading = next(r for r in series["values"] if r["date"] == day)
    features = json.loads(boundary.read_bytes())["features"]
    feature, = features
    props = feature["properties"]
    if (props["huc12"] != station["huc"] or feature["geometry"]["type"] != "Polygon"
            or daily["stationTriplet"] != station["stationTriplet"] or series["stationElement"]["storedUnitCode"] != "in"):
        raise ValueError("Unexpected watershed or station evidence")
    rings = feature["geometry"]["coordinates"]
    if hashlib.sha256(archive.read_bytes()).hexdigest() != receipt["sha256"]:
        raise ValueError("Archive differs from the retained SNODAS receipt")
    with tarfile.open(archive) as tar:
        raster = gzip.decompress(tar.extractfile(receipt["raster"]).read())
    if hashlib.sha256(raster).hexdigest() != receipt["rasterSha256"]:
        raise ValueError("SWE member differs from the retained raster")
    grid = receipt["grid"]
    x, y, dx, dy = (grid[k] for k in ("westEdge", "northEdge", "dx", "dy"))
    corners = [(math.floor((y-lat)/dy), math.floor((lon-x)/dx)) for ring in rings for lon, lat in ring]
    rows, cols = zip(*corners)
    top, bottom, left, right = min(rows)-2, max(rows)+2, min(cols)-2, max(cols)+2
    # Keep the north-up map nearly square at this latitude, including surrounding cells for context.
    mid_lat = y - (top+bottom+1)/2*dy
    width = math.ceil((bottom-top+1)*dy / (dx*math.cos(math.radians(mid_lat))))
    left -= max(0, width-(right-left+1))//2
    right = max(right, left+width-1)
    height, stride = receipt["shape"]
    if not (0 <= top <= bottom < height and 0 <= left <= right < stride):
        raise ValueError("Map crop exceeds the native grid")
    values = []
    for row in range(top, bottom+1):
        cells = struct.unpack_from(">"+"h"*(right-left+1), raster, 2*(row*stride+left))
        values.append([None if value == receipt["noData"] else value for value in cells])
    params = dict(where=f"huc12='{props['huc12']}'", outFields="huc12,name,states,areasqkm,loaddate,globalid",
                  outSR=4326, maxAllowableOffset=0.00001, returnGeometry="true", f="geojson")
    station_url = next(r["url"] for r in json.loads((evidence / "snotel/receipts.json").read_bytes())
                       if r["file"] == "brundage-daily-wteq.json")
    return dict(date=day, watershed=dict(code=props["huc12"], name=props["name"], rings=rings,
                url=WBD+"?"+urlencode(params), responseSha256=hashlib.sha256(boundary.read_bytes()).hexdigest()),
                station=dict(id=station["stationTriplet"], name=station["name"], lat=station["latitude"],
                lon=station["longitude"], inches=reading["value"], qc=reading["qcFlag"], qa=reading["qaFlag"], url=station_url),
                grid=dict(west=x+left*dx, north=y-top*dy, dx=dx, dy=dy, row=top, col=left, values=values,
                validTime=receipt["validTime"], url=receipt["url"], member=receipt["raster"], sha256=receipt["rasterSha256"]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tar", type=Path)
    parser.add_argument("wbd_geojson", type=Path)
    args = parser.parse_args()
    output = make_example(args.tar, args.wbd_geojson)
    (ROOT / "data/brundage-swe.json").write_text(json.dumps(output, separators=(",", ":"))+"\n", encoding="utf-8")
