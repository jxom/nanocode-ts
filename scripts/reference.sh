#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ "${1:-}" = build ] || [ "${1:-}" = build-release ] || { echo 'usage: scripts/reference.sh build|build-release' >&2; exit 2; }
[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || { echo 'reference toolchain requires Linux x86_64' >&2; exit 1; }
archive="$root/vendor/reference/node-v24.22.3-linux-x64.tar.xz"
printf '%s  %s\n' 4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb "$archive" | sha256sum -c -
mkdir -p "$root/output"
tool=$(mktemp -d "$root/output/reference-toolchain-XXXXXX")
trap 'rm -rf "$tool"' EXIT HUP INT TERM
tar -xJf "$archive" -C "$tool"
bin="$tool/node-v24.22.3-linux-x64/bin"
mkdir -p "$tool/home"
unshare --user --map-root-user --net -- env -i HOME="$tool/home" PATH="$bin:/usr/bin:/bin" SHIPPY_REMOTE_BUILD=0 NANOCODE_REFERENCE_NETWORK=denied "$bin/node" "$root/scripts/reference.mjs" "$1"
