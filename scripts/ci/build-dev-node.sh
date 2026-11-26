#!/bin/sh
# Build exactly one product; kept common to local setup and Actions producers.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
fixture="$root/tmp/startBlockchain"
base="$fixture/ckbDevWithIndexAndLightClient"
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

case "${1:-}" in
  ckb)
    checkout_at "$fixture" https://github.com/gpBlockchain/startBlockchain.git e7e98c5cfe73a7e53ed6a973c3509f1d8a0e6645
    checkout_at "$base/ckb" https://github.com/nervosnetwork/ckb.git "${CKB_REF:-13adbb869278662c5b79a0d62c066281451f5e3e}"
    cd "$base/ckb"
    make build
    ;;
  rocksdb|sqlite|browser)
    checkout_at "$base/ckb-light-client" "${CKB_LIGHT_CLIENT_URL:-https://github.com/nervosnetwork/ckb-light-client.git}" "${CKB_LIGHT_CLIENT_BRANCH:-develop}"
    cd "$base/ckb-light-client"
    case "$1" in
      rocksdb) cargo build --locked --release -p ckb-light-client ;;
      sqlite)  cargo build --locked --release -p ckb-light-client --no-default-features --features sqlite ;;
      browser)
        rustup target add wasm32-unknown-unknown
        cargo install --locked wasm-pack --version 0.15.0
        make build-wasm
        test -s wasm/light-client-js/dist/index.js
        ;;
    esac
    ;;
  *) echo "usage: $0 ckb|rocksdb|sqlite|browser" >&2; exit 2 ;;
esac
