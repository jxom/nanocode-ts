#!/bin/sh
# NC_BIN wrapper for bench/sla/run.ts: turns the nc lane's Vercel-gateway arguments into
# nanocode's Codex harness on a custom OpenAI Responses endpoint, with the same model name
# (bench/model) and base URL the codex lane gives Codex CLI, so both arms send matched
# requests to the fixture's /v1/responses.
# usage: NC_REAL=/path/to/nanocode NC_BIN=bench/sla/nc-codex.sh node bench/sla/run.ts --lanes=nc,codex
set -eu
real=${NC_REAL:-nanocode}
url=
set -- "$@" --end--
while [ "$1" != --end-- ]; do
  case $1 in
    --gateway) shift 2; continue ;;
    --gateway-base-url) url=$2; shift 2; continue ;;
    -m) shift 2; set -- "$@" -m bench/model; continue ;;
  esac
  set -- "$@" "$1"; shift
done
shift
[ -n "$url" ] || { echo "nc-codex.sh: no --gateway-base-url" >&2; exit 2; }
NANOCODE_OPENAI_BASE_URL=$url NANOCODE_OPENAI_API_KEY=fixture-key exec "$real" --harness codex "$@"
