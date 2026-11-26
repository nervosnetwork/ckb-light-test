#!/bin/sh
# Build at the same repository-relative paths used by config/dev_paths.ts.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fixture="$root/tmp/startBlockchain"
base="$fixture/ckbDevWithIndexAndLightClient"
usage() { echo "usage: $0 [--build-only|--start-only|--build-and-start] [--backend rocksdb|sqlite]" >&2; exit 2; }
mode=--build-and-start
backend=rocksdb
if [ -n "${RUSQLITE:-}" ]; then backend=sqlite; fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-only|--start-only|--build-and-start) mode=$1;;
    --backend)
      [ "$#" -ge 2 ] || usage
      case "$2" in rocksdb|sqlite) backend=$2;; *) usage;; esac
      shift;;
    *) usage;;
  esac
  shift
done

if [ "$mode" != --start-only ]; then
  sh "$root/scripts/ci/build-dev-node.sh" ckb
  sh "$root/scripts/ci/build-dev-node.sh" "$backend"
fi
"$base/ckb/target/release/ckb" --version
"$base/ckb-light-client/target/release/ckb-light-client" --version
# Only the older test-dev suite uses the long-lived processes prepared by this script.
if [ "$mode" != --build-only ]; then (cd "$base" && sh -e start.sh); fi
