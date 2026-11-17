#!/bin/sh
# Builds a dist to benchmark from this checkout's TypeScript and another build's wasm files
# (a release tarball's package/dist, or a lane's local dist), for changes that leave python.wasm alone.
# usage: sh bench/python/data/dist.sh <wasm dist> <out dir>
set -eu
wasm=$1
out=$2
rm -rf "$out"
mkdir -p "$out"
npx tsc -p tsconfig.build.json --outDir "$out" --declaration false
for file in "$wasm"/*.wasm "$wasm"/python.data "$wasm"/models.js; do cp "$file" "$out"/; done
