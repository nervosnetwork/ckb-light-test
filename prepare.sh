mkdir tmp
cd tmp
git clone https://github.com/gpBlockchain/startBlockchain.git
cd startBlockchain
git checkout gp/support-sqlite
cd ckbLightClient
sh prepare.sh
sh start.sh
sh status.sh
cat ckb-light-client/target/release/node.log
echo "prepare ckb Light Client finish"
