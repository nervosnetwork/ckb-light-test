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

# Never reset a user's dirty checkout. Only switch revisions after a successful fetch.
checkout_at() (
  directory=$1 url=$2 revision=$3
  case "$revision" in ''|-*) echo "invalid git revision: $revision" >&2; exit 2;; esac
  case "$url" in https://*) ;; *) echo "expected an HTTPS source URL" >&2; exit 2;; esac
  if [ ! -e "$directory/.git" ]; then
    if [ -e "$directory" ]; then echo "non-Git directory already exists: $directory" >&2; exit 1; fi
    mkdir -p "$directory"
    git -C "$directory" init -q
    git -C "$directory" remote add origin "$url"
  fi
  current=$(git -C "$directory" rev-parse --verify HEAD 2>/dev/null || true)
  if [ "$current" != "$revision" ]; then
    git -C "$directory" fetch --no-tags --depth=1 "$url" "$revision"
    wanted=$(git -C "$directory" rev-parse FETCH_HEAD)
    if [ "$wanted" != "$current" ]; then
      if [ -n "$current" ] && ! git -C "$directory" diff --quiet HEAD --; then
        echo "local changes in $directory; keep them and select a clean build directory" >&2; exit 1
      fi
      git -C "$directory" -c advice.detachedHead=false checkout -q --detach "$wanted"
    fi
  fi
  printf '%s: %s\n' "$directory" "$(git -C "$directory" rev-parse HEAD)"
)

if [ "$mode" != --start-only ]; then
  checkout_at "$fixture" https://github.com/gpBlockchain/startBlockchain.git e7e98c5cfe73a7e53ed6a973c3509f1d8a0e6645
  checkout_at "$base/ckb" https://github.com/nervosnetwork/ckb.git "${CKB_REF:-13adbb869278662c5b79a0d62c066281451f5e3e}"
  checkout_at "$base/ckb-light-client" "${CKB_LIGHT_CLIENT_URL:-https://github.com/nervosnetwork/ckb-light-client.git}" "${CKB_LIGHT_CLIENT_BRANCH:-develop}"
  (cd "$base/ckb" && make build)
  if [ "$backend" = sqlite ]; then
    (cd "$base/ckb-light-client" && cargo build --locked --release -p ckb-light-client --no-default-features --features sqlite)
  else
    (cd "$base/ckb-light-client" && cargo build --locked --release -p ckb-light-client)
  fi
fi
"$base/ckb/target/release/ckb" --version
"$base/ckb-light-client/target/release/ckb-light-client" --version
# Only the older test-dev suite uses the long-lived processes prepared by this script.
if [ "$mode" != --build-only ]; then (cd "$base" && sh -e start.sh); fi
