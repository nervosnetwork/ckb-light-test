# ckb-light-test


### quickly start 

```
npm install 
sh prepare.sh
npm run test
```

### 正常通信集成回归（隔离 dev 链）

使用 Node 24。每个用例自己启动所需节点，只使用回环地址、独立目录和本轮数据；不复用旧 dev 服务或公共测试网。两个程序的位置由 `config/dev_paths.ts` 固定，不用设置二进制路径；全节点使用内置索引器。

```sh
npm ci
sh prepare_dev.sh --build-only                      # 构建，暂不启动任何常驻节点
npm run test:integration                            # 当前 native 构建的全部正常通信用例
npm run test:integration -- --fgrep LC-STORE-003    # 单条
npm run test:integration -- --fgrep LC-STORE-       # 一个模块
```

本机要复核另一个后端，等当前一轮结束后执行 `sh prepare_dev.sh --build-only --backend sqlite`（或 `rocksdb`），再运行同一条 `npm run test:integration`。两个构建使用相同的固定程序路径，测试数据则每轮重新创建；CI 在两个独立环境中并行运行。

- **CI：** PR 和推送到 `master` 时，[公共构建流程](.github/workflows/ci-node-regressions.yml)只触发一次。它固定两个源码提交，构建一份 CKB 全节点和各一份 RocksDB、SQLite 轻客户端；各测试 runner 从**同一次运行**下载并校验产物，不重新编译或共享节点数据。每个后端只等自己的轻客户端和公共全节点。
- **两套独立检查：** [ci-dev](.github/workflows/ci-dev.yml) 用 Node 16 启动旧的固定端口服务，执行 `npm run test-dev`；[ci-integration](.github/workflows/ci-integration.yml) 用 Node 24 执行 `npm run test:integration`。二者不互相等待。手动回归时，在 **Actions** 选择对应套件，再点 **Run workflow**，两者都可以指定全节点版本、轻客户端仓库和版本。PR 上的两套检查由同一次运行调度；单独手动启动的运行自行构建，不读取其他 PR 的产物。
- **浏览器：** IndexedDB 是独立部署，不算作 native 双后端之一。用选定版本在 `tmp/startBlockchain/ckbDevWithIndexAndLightClient/ckb-light-client/` 下执行 `make build-wasm`（需要 wasm-pack、wasm32 target 和 clang），准备 Chrome，再回到仓库根目录运行 `npm run test:integration -- --browser`。CI 单独收集这类用例一次；没有真实浏览器或配套 JS bundle 应报告前置条件缺失，不以跳过算成功。
- **新增用例：** 在 `test/tests/` 的模块目录放 `*.spec.ts`（浏览器为 `*.browser.spec.ts`），让标题、`TEST-MAP` 和评审表共用稳定 Case ID。无需新增 npm 命令或 CI 步骤。`node test/runners/mocha/check-integration-cases.cjs` 可单独核对登记和映射，不启动节点。
- **暂时跳过：** 原生回归保留 `LC-STORE-006`、`LC-STORE-007` 的断言，两个后端均报告为 pending，不启动这两例的节点。原因及恢复步骤见[存储用例说明](reviews/normal-communication/05-storage-pagination.md)；其他用例意外跳过仍会使 CI 失败。
- **结果：** 每个实际运行的用例在系统临时目录（CI 为 `RUNNER_TEMP`）的 `ckb-light-integration/<case-id>/run-*/` 留下 `result.json`、RPC 记录和节点日志；浏览器用例使用同层的 `ckb-light-integration-browser/`，另存浏览器调用记录。CI 按后端保存结果，失败时另存诊断。用例被收集或在评审表中勾选不代表运行通过。
