# 05 存储后端、重启续扫与分页

## 导读

- 对比固定为 [`778590aa` → `8ea49d4`](https://github.com/nervosnetwork/ckb-light-client/compare/778590aa3ad7f71ee80b2d4c54af02c42e2dfa25...8ea49d477de44d0346d3be82c81ed627f0e66102)。只在隔离 dev 链连接正常运行的真实 CKB 全节点；创建、花费交易并正常挖块，轻客户端经公开接口查询，允许优雅停启。`LC-STORE-001` 至 `007` 均已编写自动化；`005` 只在具备真实浏览器构建与 WebSocket 的 browser 入口收集，其余为 native 入口。表内勾选表示代码已映射，**不表示实测通过**。
- 范围：[#270](https://github.com/nervosnetwork/ckb-light-client/commit/876eb7a) 的 native RocksDB/SQLite、[#301](https://github.com/nervosnetwork/ckb-light-client/commit/2ca833e) 的已接受 tip 正常重启续扫、[#304](https://github.com/nervosnetwork/ckb-light-client/commit/e9393a2) 的已删除游标后分页；[#299](https://github.com/nervosnetwork/ckb-light-client/commit/f69349b) 只作为具备真实 dev 链浏览器连接时的 IndexedDB 部署变体。
- 判定：先由全节点 `get_tip_header`、`get_transaction` 和全节点索引器 `get_cells` 形成期望集；再等轻客户端完成索引。RPC 返回成功、看见源码分支、后端文件存在或 tip 数字单独增长，均不构成端到端通过。每次比较固定同一链高、同一受监控脚本与同一查询参数；若全节点索引器尚未追上，先等待它而非降低断言。
- 边界：[#304 的说明](https://github.com/nervosnetwork/ckb-light-client/blob/e9393a2/docs/STORAGE_READS.md) 明确新 `get_many`/`try_collect_iterator` 暂无生产调用者；`get_cells` 仍走旧 `collect_iterator`，所以本文只以真实 `get_cells` 覆盖旧游标路径中可观察的“删键后继续翻页”，不宣称验证新快照、checked scan 或读失败传播。正常停机不验证崩溃原子性；不直接读写数据库、不改库、不注入故障或伪 peer。

## 需要你决定

范围已确认：native 的 RocksDB 与 SQLite 使用相同的测试与断言，但数据目录互相隔离，不做跨格式迁移。IndexedDB 单独用真实浏览器、匹配版本的 WASM、同源页面和 dev CKB WebSocket 验收，不用原生或离线模拟替代。

## 用例

索引状态和 tip 独立等待：每轮正式对照前，轻端目标脚本的 `get_scripts.block_number` 与全节点 indexer 的 `get_indexer_tip` 均覆盖最后一笔测试交易，且后者哈希匹配全节点同高度主链块；整个读取窗口停止挖矿。只比较容量的 `capacity` 值，不把不同服务的进度元数据当金额。历史查询用相同脚本、方向及 `group_by_transaction=false` 翻到空页；将轻端 `transaction.hash`、全节点 indexer 的 `tx_hash` 归一为哈希，再依次比对 `(hash, block_number, tx_index, io_type, io_index)`，不要求两种 RPC 的原始 JSON 相同。

公共准备：做索引的轻端均设 `network.max_outbound_peers=1`，全节点开启 LightClient、Filter 和内置的 Indexer RPC；索引查询与链查询使用同一个全节点 RPC 地址，不启动独立索引服务。双后端指两个独立轮次，不是同一轻端连接两个 peer。隔离 dev 链正常连接与挖块，同一 genesis；每轮停挖后固定全节点 tip/hash，再等待全节点索引器追到该高度。全节点的 `get_transaction`/索引器 `get_cells` 提供已确认交易与活 cell oracle；轻客户端不拿自己的返回值生成预期。每次分页记录首尾 out_point、cursor 和耗时；不把两个实现的 opaque cursor 互传。

<!-- TEST-CASES-BEGIN -->
| 用例 | 场景 | 预期结果 | 防止的问题 | 优先级 |
| --- | --- | --- | --- | --- |
| `LC-STORE-001` | - [x] #270：同一 dev 链对受监控 lock 在不同块创建至少 5 个可花费 cell，再正常花费其中 1 个；全节点 `get_transaction` 为 committed、索引器 `get_cells` 给出活 out_point/容量。默认 RocksDB 与 SQLite feature 各用独立空库、同一脚本；分别 `set_scripts` 后查询 `get_cells`（双向、limit=2 翻到空页）、`get_cells_capacity`、`get_transactions` 和 tip。 | 每个后端 **10 分钟**内 tip hash 对齐全节点稳定高度；其后 **5 分钟**内活 cell 集、顺序、容量和交易历史与全节点索引器/已确认交易逐项一致，花费项消失；两后端各自对其独立全节点 oracle 完整相等，容量与历史/顺序模式按逻辑夹具归一化后等价；独立轮次的交易哈希不作字节相等。feature 与存储路径形态只证明实际部署变体，不替代行为断言。 | 存储抽象后两 native 后端的索引、翻页和历史结果漂移。 | P0 |
| `LC-STORE-002` | - [x] #301：先由全节点记录已确认高度 `H`/hash、交易列表和活 cell 集，待轻端同 hash；在 RocksDB/SQLite 各自轮次给轻端正常退出信号并等退出，优雅停止唯一全节点，不清理 store；轻端按原配置重启，在 `get_peers=[]` 时先查 tip/scripts/cells，之后再启动全节点并正常挖 `H+1` 与含监控输出的新块再查。 | 退出与重启可服务各 **90 秒**内；尚无 peer 时 tip 高度/hash 原样为 `H`，脚本与活 cell 集逐项不丢；新块后 **10 分钟**内 tip hash 对齐全节点、再 **5 分钟**内新增 cell 和交易历史与全节点索引器/已确认列表一致。仅验证优雅停启与续扫。 | 重启丢已接受状态、仅保留脚本数却丢索引，或停在旧 tip。 | P0 |
| `LC-STORE-003` | - [x] #304 升序：同一 lock 在不同块至少 5 个活 cell；全节点索引器与轻端升序第一页（limit=2）一致，末项 `X` 后仍有至少 2 项。存轻端 `last_cursor=C` 和 `X` 创建位置；正常花费 **X 本身**、挖块，等全节点已确认且双方活集均不再含 `X`，再用旧 `C` 逐页查轻端 `get_cells`。 | 提交与索引收敛各 **5 分钟**；旧游标翻完限 **2 分钟**。全节点当前完整升序活集按创建位置（块高、交易序号、输出序号）取严格在 `X` 后的项作 oracle；轻端后续页合并与之逐项相等，无漏项、重复、`X`，cursor 逐页推进。 | 花费游标所指 cell 后，正向 seek 跳过下一项或返回已花费项。 | P0 |
| `LC-STORE-004` | - [x] #304 降序：另建独立的至少 5 个不同块活 cell；全节点索引器与轻端降序第一页（limit=2）一致，末项 `Y` 后至少 2 项。存轻端游标 `D` 与 `Y` 创建位置；正常花费 **Y 本身**、挖块，待全节点 committed 且双方活集不含 `Y`，用旧 `D` 继续降序分页。 | 提交与索引收敛各 **5 分钟**，旧游标翻完限 **2 分钟**；全节点当前降序活集中严格在 `Y` 后的 out_point 序列，与轻端后续页合并结果逐项相等，无重复或 `Y`。RocksDB 和 SQLite 均跑 `003/004`。 | 反向 seek 的独立边界错误；升序通过不代替降序。 | P0 |
| `LC-STORE-005` | - [x] #299 浏览器部署变体：在真实 dev 全节点可经 WebSocket 正常连接且同源 IndexedDB 可复用时，JS `LightClient` 以 `DevNet` 启动、设脚本，让普通父交易 P 创建受监控 outpoint，子交易 Q 花费它并产生受监控的新输出；两笔走正常提案/提交，由全节点块体验证在同一非创世块且 P 先于 Q。正常扫描后 `stop()`、优雅停止唯一全节点，重建同源页面/worker；先在无 peer 时读取同一库，再恢复全节点、挖新块续扫。 | 仅在独立 browser 任务具备真实 dev WebSocket、同源 IndexedDB 与已构建 WASM bundle 时执行；本轮隔离浏览器已使用同提交 bundle 实测通过。适用时，初次和重启后各 **10 分钟**内 tip hash 对齐全节点稳定高度，随后各 **5 分钟**内 P 的已花费 outpoint 不在活集中，Q 的新 outpoint 正好一次，容量和 P/Q 历史与全节点一致；无 peer 的重启首读也保持这些值，回连后新块继续同步；不以离线 IndexedDB 单测或浏览器异常退出替代。 | 浏览器写批次部署后重启丢索引或无法续扫；不混同 native 后端。 | P2 |
| `LC-STORE-006` | - [x] #301：两节点有正常短分叉。A 的分支含仅在 A 上的监控输出 a；轻端只连 A，确认已索引 a 和 A-tip 后优雅停止。B 在其分支确认不同的监控输出 b 并取得更高累计难度，暂停出块、保持 A 离线。用原库重启轻端，无 peer 先读到 A-tip/a，再只连 B。 | 每个 native 后端独立执行：回连后 10 分钟内 tip 哈希等于 B；目标脚本追平后，a 消失、b 的精确 outpoint/容量出现，共同前缀输出不变，活集等于 B 已追平的 indexer。确认 B 的主链未重新收录 a 的来源交易。 | 普通重启后顺链还能前进，但遇短叉时仍显示旧分支资产。 | P1 |
| `LC-STORE-007` | - [x] #304：另建同类有效短分叉，轻客户端本身不重启。轻端在 A 上保存未分组 `get_transactions` 升序页的末项位置 K 和旧游标。B 胜出后，先在轻端不用旧游标、从头翻完当前历史，断言旧交易哈希/位置 K 的行已消失；B 的完整历史同位置无匹配行且 K 之后有至少两条。确认后才回到保存的旧游标。 | 脚本在 10 分钟内追平 B，2 分钟内用旧游标翻至空页；逐条等于 B 主链在 K 之后的未分组历史，无漏项或重复。不把旧游标传给 B 的 indexer。 | 交易历史的游标键随正常重组删除后，首条新历史被跳过。 | P1 |
<!-- TEST-CASES-END -->

## 用例入口与证据

- [原生存储用例](../../test/tests/storage-pagination/)按场景拆分；[LC-STORE-003 源码](../../test/tests/lc_store_003.spec.ts)保留在原位置。运行 `npm run test:integration -- --fgrep LC-STORE-` 可只回归当前原生后端的存储模块。后端由实际打开的数据库标志确认。
- **暂时跳过，不计为通过：** `LC-STORE-006`、`LC-STORE-007` 在 [ckb-light-client #302](https://github.com/nervosnetwork/ckb-light-client/pull/302) 的 `6946274` 上仍未通过。复核修复时，把对应的 `it.skip` 恢复为 `it` 并从 [native 跳过名单](../../test/runners/mocha/native-pending.cjs) 移除该 ID。原断言须在 RocksDB、SQLite 均通过。
- [浏览器用例](../../test/tests/storage-pagination/lc_store_005.browser.spec.ts)在 `npm run test:integration -- --browser` 下执行，覆盖同块 P/Q、同源页面重建、离线读取及回连索引 R。构建准备与[上游 WASM 说明](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/wasm/README.md)对应。
- 每轮以 [CI](../../.github/workflows/ci-dev.yml) 保存的 `result.json`、全节点及轻端 RPC 记录为准。006 在重启换链超时时记录两端活 cell 和新交易状态；007 先核对换链后的无游标历史，只有旧分支行已消失才验证旧游标。这样能区分换链索引问题与游标本身的问题。

## 测试树

<!-- TEST-TREE-BEGIN -->
- native 两后端：RocksDB 默认 feature 与 SQLite `--no-default-features --features sqlite`，各自独立空库、相同真实链夹具
  - 活 cell、容量、历史和分页结果等价：LC-STORE-001 [primary] -> SPEC-01
  - 已接受 tip 正常停启并继续索引：LC-STORE-002 [primary] -> SPEC-02
  - 同库重启遇正常短叉，孤块上的 cell 正确退出：LC-STORE-006 [primary] -> SPEC-02
  - 升序花费游标所指 cell 后续页：LC-STORE-003 [primary] -> SPEC-03
  - 降序花费游标所指 cell 后续页：LC-STORE-004 [primary] -> SPEC-03
  - 短叉删除历史行后继续翻交易明细：LC-STORE-007 [primary] -> SPEC-05
- browser / IndexedDB：真实 dev WebSocket 连接与同源持久库满足时
  - 页面及 worker 重建后续扫：LC-STORE-005 [primary] -> SPEC-04
- 内部存储边界
  - 新 `get_many`/`try_collect_iterator` 快照和 checked scan：[not_applicable] — 无现有生产调用者，公开链路不可观察，故不设计直接 DB 测试。
  - #301 崩溃瞬间原子性与 #299 异常退出批次原子性：[not_applicable] — 正常优雅停启不能证明故障路径，本轮不注入故障。
<!-- TEST-TREE-END -->

## Spec

### SPEC-01：两个 native 后端公开索引结果相同且与全节点一致
- Condition: 相同隔离 dev 链和脚本；RocksDB/SQLite 各用独立空库；全节点已确认创建和花费，索引器已追到固定高度。
- Expected: 两后端的活 cell、容量、交易历史与全节点独立预期一致，花费项不再列出。
- Observable: 双后端 `get_cells`/`get_cells_capacity`/`get_transactions`/`get_tip_header` 与全节点索引器、交易及 tip RPC；各阶段超时见表。
- Basis: [#270 固定提交的后端选择](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/storage/db/mod.rs) 与本仓库现有 CI 中的双 native 后端矩阵。
- Source: explicit
- Testing: required

### SPEC-02：正常重启后保留已接受 tip 并继续索引
- Condition: 停挖时轻客户端已对齐全节点 `H/hash`；同一 native 库优雅停启，先在唯一节点仍离线时读取，再重连并正常挖新块。
- Expected: 重启后未出新块时准确保留 tip、脚本和索引集；新块后继续达到全节点当前结果，包括在合法短叉胜出时撤销旧分支独有输出。
- Observable: 全节点 tip/已确认交易/索引器，与轻客户端 tip/scripts/cells/transactions 的前后快照；各阶段超时见表。
- Basis: [#301 固定提交的同批次状态写入](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/storage/storage_trait.rs)；正常停机不推断崩溃原子性。
- Source: explicit
- Testing: required

### SPEC-03：删除游标指向的受监控 cell 后仍可双向继续翻页
- Condition: 第一页末项已确认存在，后面仍有至少 2 项；花费该 cell 后全节点与轻端索引均已反映。
- Expected: 用花费前的轻客户端旧 cursor，升序/降序后续页分别等于全节点当前活集的严格后缀。
- Observable: 全节点 `get_transaction`/索引器 `get_cells` 当前列表，轻客户端 `get_cells` 每页 out_point/cursor；各阶段超时见表。
- Basis: [#304 后仍用旧 collector 的 `get_cells`](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/service/impls.rs) 与 [花费时删索引键](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/storage/storage_trait.rs)。
- Source: explicit
- Testing: required

### SPEC-04：浏览器 IndexedDB 部署变体按区块内交易顺序更新活集并在正常重建后续扫
- Condition: 浏览器可连真实 dev 全节点，同源 IndexedDB 可复用；以 `DevNet` 及相同 spec 启动；全节点块体验证父子交易同块并按序。
- Expected: 同块先创建再花费的 outpoint 不复活；无 peer 重建后旧索引保留，重连后续扫新块。
- Observable: JS 公开 tip/cells/transactions 与全节点 tip、已确认交易和索引器当前活集；各阶段超时见表。
- Basis: [#299 固定提交的 browser 后端](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/storage/db/browser.rs) 与 [JS DevNet 入口](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/wasm/light-client-js/src/types.ts)。
- Source: explicit
- Testing: required

### SPEC-05：交易历史游标对应的行从主链移除后仍可继续翻页
- Condition: 在旧分支记录一页的末项；新链同一索引位置无同脚本记录，其后有已确认的新匹配项。
- Expected: 从旧位置严格向后读取，返回新主链完整后缀。
- Observable: 轻端的未分组交易/输入输出位置，与全节点当前块内容及 indexer 的当前排序比较。
- Basis: [#304 旧 collector 的排他边界](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/docs/STORAGE_READS.md)、[重组删除历史索引](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/storage/storage_trait.rs#L790-L829)、[交易历史查询](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/service/impls.rs#L215-L435)。
- Source: explicit
- Testing: required

## 验证设计

1. **静态检查结果。** 已在固定上游 Git 对象核对：[#270 的 `storage/db/mod.rs`](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/storage/db/mod.rs) 按 native feature 选 RocksDB/SQLite、WASM 选 browser；[#301 的 `update_last_state`](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/storage/storage_trait.rs) 同一 batch 写 accepted state 和 recent headers；[#304 后的 `service/impls.rs`](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/service/impls.rs) 中 `get_cells` 仍调 `collect_iterator`；[`filter_block`](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/storage/storage_trait.rs) 对花费的 lock/type cell 删索引键；[`build_query_options`](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/service/helpers.rs) 把 `after_cursor` 映射为 `IteratorStart::After`。因此旧 cursor 在删键后仍可作为位置边界；这里不假定全节点与轻客户端 cursor 字节互通。
2. **现有用例实际位置。** [`test/get_cells.spec.ts`](../../test/get_cells.spec.ts) 已有 asc/desc、limit、静态 `after_cursor`；[`test/get_scripts.spec.ts`](../../test/get_scripts.spec.ts) 已有停启后脚本数和 cell 数检查；[`test/runners/mocha/.mocharc.jsonc`](../../test/runners/mocha/.mocharc.jsonc) 收录两者，配置默认指向 testnet 而非本设计的隔离 dev 链；[`scripts/stability/ckb.js`](../../scripts/stability/ckb.js) 有全节点/轻客户端共享的 `get_cells` 翻页请求形态。现有文件没有本设计的双后端同夹具比较、已接受 hash 重启续扫或花费 cursor 本身再用旧 cursor 的断言。
3. **分叉与历史游标。** 复用 [正常短叉的造链与对照方法](01-chain-tip.md)，但独立建数据。按正常提案窗口让两条分支先分别确认各自交易，不套用固定 2/4 块；叉深小于最近 100 头窗口，B 的高度及累计难度均严格大于 A。保持 A、B 隔离且 B 在比较窗口停挖；A-only、B-only 交易由各自主链的块体和按高哈希确认。007 的边界是 K 的数值位置 `(block_number, tx_index, io_index, io_type)`（同一方向上 input 在 output 之前），不是交易哈希或 opaque cursor 的字典序。用 B 的独立数据选出严格后缀并确认边界键未复用。
4. **执行时记录。** 每案记录链尖高度与哈希、交易及所在块、独立的全节点活集、轻端各页 outpoint 与游标、同步进度和失败差异。003/004 以首页末项的创建位置作为严格边界，轻端旧游标不传给全节点。两种后端由 [ci-dev](../../.github/workflows/ci-dev.yml) 分别执行同一套断言；单案可用 `npm run test:integration -- --fgrep LC-STORE-003` 重跑。
