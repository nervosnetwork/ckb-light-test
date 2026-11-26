# 04 区块过滤、检查点与脚本索引用例

## 导读

- **这个改动要做什么**：在真实全节点与轻客户端正常通信时，过滤器筛出关注脚本的区块，下载命中区块并形成可查询的 cell 索引；检查点前后持续扫描。
- **行为变化**：v0.5.4 → develop 对过滤数据、过滤哈希边界和已证明区块入索引增加校验，并在检查点共识不足时先规范化已有 peer 检查点。正常链上的预期仍是按链上交易完整、准确地返回脚本结果；本设计不声称旧版必定失败。
- **最怕出什么问题**：交错的不命中区块造成漏扫或误报，检查点处停扫，或者命中区块下载后遗漏同一交易中的某个输出。
- **能测到什么**：隔离 dev 链的全节点提供交易和区块独立预期；轻客户端公开 `set_scripts`、`get_scripts`、`get_cells`、`get_cells_capacity` 给出扫描进度与结果。必须先确认扫描完成，再断言零余额或空集合。
- **测不到的**：#276、#277、#284–286、#288 的溢出/越界、畸形消息及缺失检查点拒绝分支，#290 的恶意块体拒绝，以及 #295 的 peer 检查点规范化本身，均不能仅靠正常真实节点的公开接口直接观察；不构造伪 peer、异常包或故障注入。轻端过滤哈希/最终化检查点本身也无公开查询入口，下面只能验证其正常路径的最终索引结果，不能把该结果当作内部逐项哈希校验证据。

依据：固定比较 [v0.5.4 → develop](https://github.com/nervosnetwork/ckb-light-client/compare/778590aa3ad7f71ee80b2d4c54af02c42e2dfa25...8ea49d477de44d0346d3be82c81ed627f0e66102)；新增校验见 [过滤数据](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/filter/block_filter.rs)、[过滤哈希](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/filter/components/block_filter_hashes_process.rs)、[检查点处理](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/light_client/mod.rs)、[命中块下载与索引](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/synchronizer.rs)。设计阶段通过所给只读裸仓库 `git rev-parse` 确认两端提交均存在，并检查了相关差异；随后在隔离临时目录执行了真实节点自动化，结果见文末。

现有覆盖：[`test/set_scripts.spec.ts`](../../test/set_scripts.spec.ts) 检查设置/返回脚本；[`test/get_cells.spec.ts`](../../test/get_cells.spec.ts) 多以既有测试网快照查询 cell；[`test/get_cells_capacity.spec.ts`](../../test/get_cells_capacity.spec.ts) 检查容量；[`test/dev/ckbLightClientCut.spec.ts`](../../test/dev/ckbLightClientCut.spec.ts) 侧重 dev 链回滚。实际查看 [`test/runners/mocha/.mocharc.jsonc`](../../test/runners/mocha/.mocharc.jsonc) 与 [`test/runners/mocha/.mocharc.dev.jsonc`](../../test/runners/mocha/.mocharc.dev.jsonc)：上述文件分别由普通/dev runner 收集，但未见“正常过滤交错 + 检查点两侧 + 精确 outpoint”组合；现有 [`compare_cells_result`](../../service/CkbDevService.ts) 只比较区块号和交易哈希，未比较输出序号。本设计补此缺口，不做分页、持久化或回滚重测。

## 需要你决定

- 已按 G2 设计确认采用**同一隔离 dev 链、两个真实且健康的全节点**；`max_outbound_peers = 3` 时，轻客户端必须实际连接两个不同 peer 并分别证明目标高度。低于 quorum 时只检验已最终化区间回扫，恢复双 peer 后另挖新区间再检验新输出；拓扑或最终化前置不成立即失败，不以单 peer 代替。

## 用例

公共约定：仅用正常挖块、交易、连接及优雅停止/重启。全节点的 `get_block_by_number`/`get_transaction` 确认每笔交易的块高、块哈希、输出脚本、容量及精确 `(tx_hash, index)`；先等待全节点 indexer 已追平目标高度，再用其 `get_cells`、`get_cells_capacity` 作交叉核对。轻客户端以公开 `set_scripts` 从首个测试块之前开始，轮询 `get_scripts` 中**目标脚本**的 `block_number ≥ 最后一个目标输出所在块高`，同时核对 `get_cells` 与全节点独立预期；进度、结果各设 10 分钟上限，超时失败，不因 RPC 成功、tip 已前进或余额为零而提前通过。轻端 `get_cells` 没有 block_hash 字段：从两端交易状态取提交块哈希，并以全节点 `get_block_hash(cell.block_number)` 和块内交易列表核实归属。允许过滤器正常的假阳性导致多下载；只对最终索引是否准确作断言。单节点轮次设置 `max_outbound_peers=1`；多节点轮次为 3，两个不同 peer ID 已获证，不能只数 TCP 连接。检查点夹具单列为慢测：正常挖至足够使目标输出后的过滤区间可扫描的证明高度，`LC-FILTER-02` 至少 6000；不把全节点 tip 高度误当轻端脚本必须扫到的高度。`LC-FILTER-02` 用全节点 `get_block_filter(block_hash)` 确认边界块及目标 tip 的过滤数据已生成；`LC-FILTER-04` 恢复双 peer 后正常分段续挖至 8001，并核对 A/B 同链、两个 peer 在线、轻端公开 tip 向前、脚本索引和完整集合，不在任一中间块强等两 peer 的已证明高度恰好等于当前 tip。按 `(block_number, tx_hash, 数值化 index)` 排序比较集合，不依赖返回顺序；空集合仅在脚本进度追平后断言。测试输出须留存全节点 tip/indexer tip、脚本进度、目标块哈希和两端规范化 outpoint 列表。

<!-- TEST-CASES-BEGIN -->
| 用例 | 场景 | 预期结果 | 防止的问题 | 优先级 |
| --- | --- | --- | --- | --- |
| `LC-FILTER-01` | - [x] 单真实 peer；监控脚本 A，依次挖 A 命中、只含 B 的不命中、A 命中及连续不命中块，A 与空脚本 C 都从首块前订阅，等两脚本进度越过末块后查询 A/C；不订阅 B。 | 10 分钟内 A 的 `get_cells` 精确等于全节点块内 A 的未花费 outpoint 集合与容量；未订阅的 B 不混入 A，已订阅且无输出的 C 在完成扫描后为零 cell/零容量。 | 最终索引误收或漏收，或空结果提前当作通过。 | P0 |
| `LC-FILTER-02` | - [x] 单真实 peer；正常挖至检查点 `2000` 两侧，在 `1999/2000/2001` 各放 A 输出并穿插无 A 块；继续挖至至少 `6000` 以便处理 2000 之后的过滤区间，再从 `1998` 前订阅 A。 | 10 分钟内脚本进度追平目标末块，A 的规范化 outpoint 集合与容量与全节点已追平 indexer/块内交易一致；边界前、当块、后各自的输出均存在且无旁邻块误报。 | 跨检查点停扫、过滤哈希窗口错位或边界块漏索引。 | P0 |
| `LC-FILTER-03` | - [x] 单真实 peer；在一个命中块内提交含相同 A lock 的两个不同输出及一个 B 输出的交易，正常挖块；从该块前订阅 A。 | 10 分钟内脚本进度追平后，A 返回该交易两个**不同 index** 的 `(tx_hash,index)`、对应容量和块高均与全节点块体一致，B 输出不混入；总容量等于全节点已追平 indexer 对 A 的结果。 | 只按交易哈希去重、命中块下载后漏一个输出或把旁支脚本并入。 | P0 |
| `LC-FILTER-04` | - [x] 两个真实 peer 共用隔离 dev 链；`max_outbound_peers = 3` 且 `get_peers` 证实两连接，在两 peer 的 `proved_best_known_header` 均到至少 4000，全节点暂停出块；确认 A 跨 2000 正常扫描，且轻端常规日志显示检查点 index ≥ 1 已最终化；随后优雅停止其中一个 peer，用 `set_scripts(..., "partial")` 添加此前未监控且在 2000 以前有独立输出的脚本 B，并回扫已证明区间（只要求该段，不要求单 peer 将 B 推到新 tip）。 | 两 peer 阶段及剩余单 peer 回扫阶段，均在各自 10 分钟内使 A（双 peer）/B（单 peer）各自进度达到对应目标高度，规范化 outpoint/容量与全节点块内交易及已追平 indexer 一致；重新优雅启动第二 peer 后正常续挖至 8001，轻端公开 tip 前进且新 A 输出的精确集合与容量可见。 | 把单 peer 当 quorum，或检查点完成后 peer 数下降导致正常历史区间无法回扫。 | P1 |
<!-- TEST-CASES-END -->

## 测试树

<!-- TEST-TREE-BEGIN -->
- 正常过滤与索引
  - 命中/不命中交错且空脚本真正扫完：LC-FILTER-01 [primary] -> SPEC-01
  - 检查点 `2000` 前、当块、后连续得到精确结果：LC-FILTER-02 [primary] -> SPEC-01, SPEC-02
  - 命中块内同一交易的不同输出完整入索引：LC-FILTER-03 [primary] -> SPEC-03
- 真实 peer 拓扑
  - 已连接双 peer 的健康扫描及 quorum 下降后的已证明区间回扫：LC-FILTER-04 [primary] -> SPEC-02, SPEC-04
- 不纳入正常通信端到端
  - 畸形过滤数据、哈希边界/溢出、缺失检查点和伪块拒绝 [not_applicable] — 不符合用例偏好：正常真实节点与公开接口无法构造或直接观察这些内部拒绝分支。
  - 后端分页、持久化、纯容量算术和 dev 回滚 [not_applicable] — 不符合本模块范围：已有相邻用例或由其他模块负责。
<!-- TEST-TREE-END -->

## Spec

### SPEC-01：完成扫描后仅呈现匹配脚本的链上未花费输出
- Condition: 真实全节点正常出块，轻客户端在目标区间之前订阅脚本。
- Expected: 命中与不命中块交错时，无遗漏或额外的 cell；零结果须以已完成扫描为前提。
- Observable: `get_scripts` 的目标脚本进度及 `get_cells`/`get_cells_capacity` 与全节点块内交易、已追平 indexer 对照。
- Basis: [过滤数据扫描与命中块请求](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/filter/components/block_filters_process.rs)；[原有 v0.5.4 实现](https://github.com/nervosnetwork/ckb-light-client/blob/778590aa3ad7f71ee80b2d4c54af02c42e2dfa25/light-client-lib/src/protocols/filter/components/block_filters_process.rs)。
- Source: explicit
- Testing: required

### SPEC-02：检查点边界的正常扫描不丢块
- Condition: 链高覆盖 `CHECK_POINT_INTERVAL = 2000` 两侧，真实 peer 提供同一条正常链，固定版本从创世进入检查点流程时已证明高度至少为 6000，以便扫描 2000 之后的输出。
- Expected: 边界前、边界块、边界后输出最终均可查询；不以内部检查点值作公开断言。
- Observable: 脚本进度与边界各块的规范化 outpoint、容量、块高；块哈希取全节点作诊断记录。
- Basis: [检查点间隔](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/mod.rs)、[过滤哈希处理](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/filter/components/block_filter_hashes_process.rs)。
- Source: explicit
- Testing: required

### SPEC-03：命中块下载后按精确输出位置索引
- Condition: 正常块体中同一交易有两个匹配输出，另有不匹配输出。
- Expected: 两个匹配输出各自以准确的 `(tx_hash,index)` 出现，不合并、不混入。
- Observable: `get_cells` 的 outpoint、块高及 `get_cells_capacity` 对照全节点块体和已追平 indexer。
- Basis: [已证明命中块下载后的过滤索引](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/synchronizer.rs)、[脚本过滤入库](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/storage/storage_trait.rs)。
- Source: explicit
- Testing: required

### SPEC-04：真实多 peer 正常变化后继续处理已证明区间
- Condition: 两个真实 peer 已连接且检查点已经正常最终化；随后其中一个优雅停止，剩余 peer 仍健康。
- Expected: 在已最终化、已证明区间内新增脚本的历史结果继续可见；恢复双 peer 后新块继续同步。此端到端结果不证明内部规范化动作逐次发生。
- Observable: `get_peers` 的真实连接数、脚本进度和规范化 outpoint/容量；常规最终化日志只作前置条件，不作结果。
- Basis: [检查点规范化先于 quorum 检查](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/light_client/mod.rs)、[所需 peer 数为配置上限的一半向上取整](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/light_client/peers.rs)。
- Source: inference
- Testing: required

## 验证设计

- **独立预期**：固定测试窗口后从全节点 `get_block_by_number` 的交易输出逐条构造脚本 A/B/C 的 `(block_number, block_hash, tx_hash, index, capacity)` 表；对未花费输出再由已追平的全节点 indexer 复核。容量为这些输出的和，但不以轻客户端容量反推期望。对 `LC-FILTER-03` 必须保留两个不同 index；不使用现有忽略 index 的 `compare_cells_result` 作为判定。
- **实际入口与观察**：正常挖块/提交交易 → 轻客户端 `set_scripts` → 有界轮询 `get_scripts` → 新鲜调用 `get_cells`、`get_cells_capacity`；`LC-FILTER-04` 另用 `get_peers` 确认连接数，优雅停止/重启真实全节点。轻客户端 tip 前进只作诊断，不能代替目标脚本进度与完整结果。
- **证明边界**：这是正常真实节点的端到端正向回归；能发现过滤与命中块索引导致的漏/误报，不能分别证明过滤哈希、检查点和块体异常数据的拒绝分支。`LC-FILTER-04` 在拓扑未证实时不计为已验证；单 peer 配 `max_outbound_peers = 1` 时所需 peer 数为 1，而 `max_outbound_peers = 3` 时为 2，不能混淆。
- **复查**：`npm run test:integration -- --fgrep LC-FILTER-` 运行当前后端的四条用例。两种后端各自的真实结果、节点数量与阶段记录见当轮 CI 的 `result.json`；评审表的勾选只代表已有自动化映射。
