set -x
git submodule init
git submodule update
cd ckb-light-wasm-demo
git log -1
git submodule init
git submodule update
cd ckb-light-client
git log -1
cd ../
bash build_node.sh
