# Watch release packaging

Run `npm run build:watch:release` with the Pebble SDK installed. This builds the
normal `build/codey.pbw`, then creates `build/release/codey.pbw` and runs the
bridge regression tests against the generated minified bundle. The minifier is
the SDK's UglifyJS (tested with 2.7.5); override its module directory with
`UGLIFYJS` or `scripts/package-watch-release.py --uglify /path/to/uglify-js`.
No package download is required.

The release PBW omits the source map and minifies local identifiers, preserving
property names and license comments. Native executables, resources, app info,
and platform manifests are copied byte for byte and verified. ZIP entries stay
uncompressed for compatibility. Development output remains unchanged.

Archive the entire `build/release/debug` directory and `SHA256SUMS` with each
release. The directory contains the exact shipped JS plus its composed source
map with original source contents. Use this pair to map release stack trace
line/column positions to the original source. Checksums identify the matching
PBW and debug files. Repackaging the same development PBW is deterministic.

The bridge test harness exercises the generated code with mocked Pebble and
network APIs. A physical phone/watch install remains part of release
qualification; this test does not measure battery or native RAM usage.
