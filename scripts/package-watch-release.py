#!/usr/bin/env python3
"""Minify a development PBW without modifying its native payloads."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--input', type=Path, default=Path('build/codey.pbw'))
parser.add_argument('--output', type=Path, default=Path('build/release/codey.pbw'))
parser.add_argument('--uglify', default=os.environ.get('UGLIFYJS', str(Path.home() / '.local/share/pebble-sdk/SDKs/current/node_modules/uglify-js')))
args = parser.parse_args()
if args.input.resolve() == args.output.resolve():
    parser.error('release output must differ from development input')
args.output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(args.input) as original, tempfile.TemporaryDirectory() as directory:
    work = Path(directory)
    for name in ('pebble-js-app.js', 'pebble-js-app.js.map'):
        (work / name).write_bytes(original.read(name))
    subprocess.run(['node', str(Path(__file__).with_name('minify-watch.js').resolve()),
                    str(Path(args.uglify).resolve())], cwd=work, check=True)
    script = (work / 'release.js').read_bytes()
    source_map = json.loads((work / 'release.js.map').read_text())
    source_map['file'] = 'pebble-js-app.js'
    # Keep debug artifacts together, with the exact distributed script and sources.
    debug = args.output.parent / 'debug'
    debug.mkdir(exist_ok=True)
    (debug / 'pebble-js-app.js').write_bytes(script)
    (debug / 'pebble-js-app.js.map').write_text(json.dumps(source_map, separators=(',', ':')))
    with zipfile.ZipFile(args.output, 'w', compression=zipfile.ZIP_STORED) as release:
        for entry in original.infolist():
            if entry.filename.endswith('.js.map'):
                continue
            release.writestr(copy.copy(entry), script if entry.filename == 'pebble-js-app.js' else original.read(entry))
    with zipfile.ZipFile(args.output) as release:
        for entry in original.namelist():
            if entry not in ('pebble-js-app.js', 'pebble-js-app.js.map'):
                assert release.read(entry) == original.read(entry), entry
    artifacts = [args.output, debug / 'pebble-js-app.js', debug / 'pebble-js-app.js.map']
    (args.output.parent / 'SHA256SUMS').write_text(''.join(
        hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + str(p.relative_to(args.output.parent)) + '\n'
        for p in artifacts))
print(f'{args.input.stat().st_size} -> {args.output.stat().st_size} bytes; debug artifacts: {debug}')
