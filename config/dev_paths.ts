// Dev 构建目录与 prepare_dev.sh 的布局一致。路径相对仓库根目录，不依赖机器或后端。
export const DEV_PATH = "tmp/startBlockchain/ckbDevWithIndexAndLightClient";
export const CKB_DEV_PATH = DEV_PATH + "/ckb/target/release";
export const CKB_DEV_LIGHT_CLIENT_PATH = DEV_PATH + "/ckb-light-client/target/release";
export const CKB_DEV_BROWSER_BUNDLE = DEV_PATH + "/ckb-light-client/wasm/light-client-js/dist/index.js";
