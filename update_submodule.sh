#!/bin/bash
set -e

if [ $# -lt 2 ]; then
    echo "Usage: $0 <url> <branch>"
    exit 1
fi

URL=$1
BRANCH=$2

echo "Updating submodule 'ckb-light-wasm-demo' configuration..."
echo "  URL: $URL"
echo "  Branch: $BRANCH"

# Ensure we are in the script's directory
cd "$(dirname "$0")"

# Update .gitmodules
git config -f .gitmodules submodule.ckb-light-wasm-demo.url "$URL"
git config -f .gitmodules submodule.ckb-light-wasm-demo.branch "$BRANCH"

# Sync configuration to .git/config
git submodule sync ckb-light-wasm-demo

# Initialize and update the submodule
git submodule update --init --recursive --remote ckb-light-wasm-demo

# Checkout the specific branch
cd ckb-light-wasm-demo
git fetch origin
git checkout "$BRANCH"
git pull origin "$BRANCH"

echo "Submodule 'ckb-light-client' updated successfully."