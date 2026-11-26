#!/bin/sh
# Archive only the executable and (for CKB) the tracked legacy dev fixture.
# Do not transfer Rust sources, target/, running nodes or test data between jobs.
set -eu
target=${1:?expected ckb, rocksdb or sqlite}
out=${2:?expected artifact directory}
mkdir -p "$out"
out=$(cd "$out" && pwd)
fixture=tmp/startBlockchain
base=ckbDevWithIndexAndLightClient
case "$target" in
  ckb)
    bin="$base/ckb/target/release/ckb"
    git -C "$fixture" archive --format=tar HEAD "$base" > "$out/$target.tar"
    "$fixture/$bin" --version
    tar -rf "$out/$target.tar" -C "$fixture" "$bin"
    ;;
  rocksdb|sqlite)
    bin="$base/ckb-light-client/target/release/ckb-light-client"
    "$fixture/$bin" --version
    tar -cf "$out/$target.tar" -C "$fixture" "$bin"
    ;;
  *) echo "unknown target: $target" >&2; exit 2 ;;
esac
(cd "$out" && sha256sum "$target.tar" > "$target.sha256")
