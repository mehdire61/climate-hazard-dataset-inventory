"""Package an OpenFreeMap overview for on-demand HTTP and local-file use."""
from pathlib import Path
import hashlib
import json


def write_pyramid(outputfile, raw):
    output = Path(outputfile)
    embedded_zoom = min(2, raw['maxZoom'])
    local = {}
    groups = {}
    for key, tile in raw['tiles'].items():
        z, x, y = map(int, key.split('/'))
        if z <= embedded_zoom:
            local[key] = tile
        else:
            group = f'{z}-{x // 4}-{y // 4}'
            groups.setdefault(group, {})[key] = tile
    directory = output.parent / 'map-tiles'
    directory.mkdir(parents=True, exist_ok=True)
    manifest = {k: v for k, v in raw.items() if k != 'tiles'}
    manifest.update(embeddedZoom=embedded_zoom, tiles=local, shards={})
    for key, tiles in sorted(groups.items()):
        data = json.dumps(tiles, sort_keys=True, separators=(',', ':'))
        payload = f'window.ProjectReferenceMap.receive("{key}",{data});\n'.encode()
        digest = hashlib.sha256(payload).hexdigest()
        (directory / f'{key}.{digest[:16]}.js').write_bytes(payload)
        manifest['shards'][key] = digest
    output.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':'))+'\n',encoding='utf8')
