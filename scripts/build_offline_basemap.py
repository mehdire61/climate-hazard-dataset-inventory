"""Build the embedded world overview from HTTP ranges of an official OpenFreeMap archive.

Generation dependencies only: pmtiles==3.8.1 and mapbox-vector-tile==2.2.0.
Use --cache outside the release directory. The published app needs no Python packages.
"""
import argparse
import base64
import concurrent.futures
import gzip
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

from mapbox_vector_tile.Mapbox import vector_tile_pb2
from pmtiles.tile import Compression, deserialize_directory, deserialize_header, tileid_to_zxy
from split_basemap import write_pyramid


ARCHIVE = 'https://btrfs.openfreemap.com/areas/planet/20261115_080022_pt/tiles.pmtiles'
RELEASE = '20261115_080022_pt'
SOURCE_BYTES = 87494821440
BLOCK = 4 * 1024 * 1024
LAYERS = {'water', 'waterway', 'water_name', 'boundary', 'place', 'transportation'}
PROPERTIES = {'class', 'name', 'name:en', 'rank', 'admin_level'}


def keep_tile(raw):
    source = vector_tile_pb2.tile.FromString(gzip.decompress(raw))
    result = vector_tile_pb2.tile()
    for layer in source.layers:
        if layer.name not in LAYERS:
            continue
        out = result.layers.add(name=layer.name, extent=layer.extent, version=layer.version)
        keys, values = {}, {}
        for feature in layer.features:
            tags = list(zip(feature.tags[::2], feature.tags[1::2]))
            if layer.name == 'water_name' and feature.type != 1:
                continue
            if layer.name == 'transportation' and any(layer.keys[k] == 'class' and layer.values[v].string_value == 'ferry' for k, v in tags):
                continue
            f = out.features.add()
            f.CopyFrom(feature)  # Preserve clipped polygon exteriors, holes, linework and point coordinates.
            f.ClearField('tags')
            for key_index, value_index in tags:
                key = layer.keys[key_index]
                if key not in PROPERTIES:
                    continue
                if key_index not in keys:
                    keys[key_index] = len(out.keys)
                    out.keys.append(key)
                if value_index not in values:
                    values[value_index] = len(out.values)
                    out.values.add().CopyFrom(layer.values[value_index])
                f.tags.extend([keys[key_index], values[value_index]])
    return gzip.compress(result.SerializeToString(deterministic=True), compresslevel=6, mtime=0)


def build(cache, destination, max_zoom):
    if not 0 <= max_zoom <= 8:
        raise ValueError('This overview generator supports zoom levels 0 through 8.')
    cache.mkdir(parents=True, exist_ok=True)
    destination.mkdir(parents=True, exist_ok=True)
    receipts = {}

    def read(offset, length):
        path = cache / f'{offset}-{length}'
        if not path.exists():
            headers = {'Range': f'bytes={offset}-{offset + length - 1}',
                       'User-Agent': 'Climate-Hazard-Dataset-Inventory/0.2 (PMTiles archive extraction)'}
            with urlopen(Request(ARCHIVE, headers=headers), timeout=90) as response:
                if response.status != 206 or response.headers['Content-Range'] != f'bytes {offset}-{offset + length - 1}/{SOURCE_BYTES}':
                    raise ValueError('Archive lacks the requested bounded byte range.')
                buf = response.read(length + 1)
            if len(buf) != length:
                raise ValueError('Incomplete archive response.')
            path.write_bytes(buf)
        data = path.read_bytes()
        if len(data) != length:
            raise ValueError(f'Incomplete cache entry {path}')
        receipts[offset, length] = hashlib.sha256(data).hexdigest()
        return data

    header = deserialize_header(read(0, 127))
    if not header['clustered'] or header['tile_compression'] != Compression.GZIP or header['internal_compression'] != Compression.GZIP:
        raise ValueError('Unexpected PMTiles archive layout or encoding.')
    metadata = json.loads(gzip.decompress(read(header['metadata_offset'], header['metadata_length'])))
    limit = (4 ** (max_zoom + 1) - 1) // 3

    def directory_items(offset, length):
        for entry in deserialize_directory(read(offset, length)):
            if entry.tile_id >= limit:
                break
            if entry.run_length:
                yield entry
            else:
                yield from directory_items(header['leaf_directory_offset'] + entry.offset, entry.length)

    items = list(directory_items(header['root_offset'], header['root_length']))
    end = max(entry.offset + entry.length for entry in items)
    # Clustered, Hilbert-ordered archive: all lower zooms form a bounded prefix of tile payloads.
    spans = [(header['tile_data_offset'] + start, min(BLOCK, end - start)) for start in range(0, end, BLOCK)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        payload = b''.join(pool.map(lambda span: read(*span), spans))
    tiles, seen = {}, {}
    for entry in items:
        key = entry.offset, entry.length
        if key not in seen:
            raw = payload[entry.offset:entry.offset + entry.length]
            seen[key] = base64.b64encode(keep_tile(raw)).decode('ascii')
        for tile_id in range(entry.tile_id, min(limit, entry.tile_id + entry.run_length)):
            z, x, y = tileid_to_zxy(tile_id)
            tiles[f'{z}/{x}/{y}'] = seen[key]
    if len(tiles) != limit:
        raise ValueError('Expected a complete global tile pyramid.')
    output = {'schemaVersion': 1, 'maxZoom': max_zoom, 'archiveRelease': RELEASE,
              'osmDate': metadata['osm_date'], 'encoding': 'base64+gzip+mvt', 'tiles': tiles}
    index = destination / 'offline-basemap.json'
    write_pyramid(index, output)
    shards = json.loads(index.read_bytes())['shards']
    shard_bytes = sum((destination / 'map-tiles' / f'{key}.{digest[:16]}.js').stat().st_size for key, digest in shards.items())
    provenance = {
        'archive': ARCHIVE, 'officialDownloads': 'https://github.com/hyperknot/openfreemap',
        'archiveRelease': RELEASE, 'archiveBytes': SOURCE_BYTES, 'osmDate': metadata['osm_date'],
        'osmReplicationTime': metadata['planetiler:osm:osmosisreplicationtime'], 'schemaVersionOpenMapTiles': metadata['version'],
        'sourceTileJSON': 'https://tiles.openfreemap.org/planet', 'minimumZoom': 0, 'maximumZoom': max_zoom,
        'tiles': len(tiles), 'originalUniqueTiles': len(seen), 'retainedLayers': sorted(LAYERS),
        'retainedProperties': sorted(PROPERTIES), 'featureSelection': 'All original features in retained layers except ferry routes and nonpoint water labels, which the inventory style does not draw.',
        'geometryProcessing': 'Retains original MVT feature geometry commands, including polygon inner rings.',
        'usage': 'Generalized geographic context. Beyond the offline native zoom the existing geometry can be enlarged; local shoreline or street detail may be absent. This layer is not used to determine data eligibility.',
        'dataLicense': 'https://www.openstreetmap.org/copyright', 'schemaLicense': 'https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md',
        'lowZoomSources': 'https://openmaptiles.org/docs/schema/#water',
        'manifestSHA256': hashlib.sha256(index.read_bytes()).hexdigest(), 'manifestBytes': index.stat().st_size,
        'shardCount': len(shards), 'shardBytes': shard_bytes,
        'archiveBytesRead': sum(length for _, length in receipts), 'rangeReceipts': [
            {'start': offset, 'bytes': length, 'sha256': sha} for (offset, length), sha in sorted(receipts.items())],
    }
    (destination / 'offline-basemap-source.json').write_text(json.dumps(provenance, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(f'{len(tiles):,} tiles, {index.stat().st_size:,} embedded bytes, {shard_bytes:,} on-demand shard bytes, {provenance["archiveBytesRead"]:,} archive bytes')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', required=True, type=Path)
    parser.add_argument('--destination', type=Path, default=Path(__file__).resolve().parents[1] / 'data')
    parser.add_argument('--max-zoom', type=int, default=6)
    args = parser.parse_args()
    build(args.cache, args.destination, args.max_zoom)
