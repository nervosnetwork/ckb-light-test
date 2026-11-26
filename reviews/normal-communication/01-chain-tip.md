# 链尖订阅、追块与短重组

## 导读

轻客户端原先可以直接采用紧接前一块的订阅通知；现在即使只前进一块，也要先取得证明。对用户，可验收的结果是：单块推进、从创世追赶、或正常换链后，轻客户端读出的链尖应为全节点**在该高度的主链块**，而不仅是全节点曾见过的某个块。成功终态不证明内部报文先后，也不覆盖异常证明或整数边界。

[固定比较](https://github.com/nervosnetwork/ckb-light-client/compare/v0.5.4...8ea49d477de44d0346d3be82c81ed627f0e66102)。现有 [get_tip_header](../../test/get_tip_header.spec.ts) 用轻端给的哈希查询全节点一次；[dev 回滚](../../test/dev/ckbLightClientCut.spec.ts) 则主要核对 cells/容量。新用例固定全节点的高度和哈希，在每个停挖点独立判定。

## 需要你决定

无额外产品规则。短重组需要两个同 genesis、可独立挖块的隔离 dev 全节点；缺少拓扑时记录未执行，不以截链代替。

## 用例

全程仅使用同一隔离 dev 链的真实节点；关闭外部发现和额外 bootnodes，核对双方 genesis。全节点暂停挖矿后，以 `get_tip_header()` 得到高度 `h`，用 `get_block_hash(h)`、`get_block_hash(h−1)` 和 `get_header(hash)` 固定主链块与父块。每秒读取轻端 `get_tip_header()`，比对高度、哈希、父哈希及公共头字段。订阅逐块用例还要求同一已连接 peer 在 `get_peers().sync_state.proved_best_known_header` 公布该步目标哈希；两项都要在该步时限内出现，但不推断线上的先后顺序。若矿工意外推进或未形成所需分叉，报告夹具失败，不算通过。每例从独立目录开始。

<!-- TEST-CASES-BEGIN -->
| 用例 | 场景 | 预期结果 | 防止的问题 | 优先级 |
| --- | --- | --- | --- | --- |
| `LC-TIP-001` | - [x] 全节点挖到 20 后停挖；新轻端先在未连接时查到创世，再正常连接。 | 180 秒内轻端链尖等于全节点第 20 块的头，父哈希等于第 19 块哈希。 | 只连上节点，却未采纳正确的初始链尖。 | P0 |
| `LC-TIP-002` | - [x] 双方已在同一个非创世块，保持连接；连续三次挖一块即停，当前断言成功后才挖下一块。 | 每一步 120 秒内，轻端均到达该步的全节点主链头；每个新头均指向上一步的哈希。 | 最后一块碰巧对齐，掩盖中间订阅未推进。 | P0 |
| `LC-TIP-003` | - [x] 全节点已有 240 块且停挖；从未连接的创世轻端起步，建立唯一连接。 | 900 秒内从创世追到第 240 块；各次读数不超出固定链高，终态头与全节点相同。 | 近距离正常，但超过最近头窗口后追赶停滞。 | P1 |
| `LC-TIP-004` | - [x] A、B 从同一祖先 F≥120 正常分开；A 挖两块，轻端只连 A 并先读到 A-tip；B 独立挖四块，两边停挖后让 A/B 正常重连。 | 先在 120 秒内读到 A-tip；重连后 300 秒内，A、B 的同高度主链哈希都选定 B 分支，仍只连 A 的轻端也读到 B-tip 及其正确父块。 | 只看高度增加，漏掉轻端仍停留在旧分叉。 | P1 |
<!-- TEST-CASES-END -->

## 测试树

<!-- TEST-TREE-BEGIN -->
- 从创世连接
  - 最近头窗口内：LC-TIP-001 [primary] -> SPEC-01
  - 超出最近头窗口：LC-TIP-003 [primary] -> SPEC-01
- 已同步的连接
  - 连续订阅：LC-TIP-002 [primary] -> SPEC-01
  - 正常短分叉：LC-TIP-004 [primary] -> SPEC-02
  - 异常证明、越界和消息顺序 [not_applicable] — 公开终态不是内部校验或时序的证据。
<!-- TEST-TREE-END -->

## Spec

### SPEC-01：有可用的真实节点时，轻端可追到并跟随其有证明的主链头
- Condition: 同一有效主链；新连接或已同步后收到正常新块。
- Expected: 每个固定观察点的轻端链尖等于该高度的全节点主链头。
- Observable: 两端链尖、全节点按高度取的哈希与父块。
- Basis: [订阅新状态后请求证明，#289](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/light_client/components/send_last_state.rs)、[证明处理，#291](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/light_client/components/send_last_state_proof.rs)、[最近 100 块窗口](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/mod.rs)。
- Source: explicit
- Testing: required

### SPEC-02：正常短重组后跟随累计难度更高的主链
- Condition: A/B 在测试控制的连接拓扑中形成两条合法分叉，轻端已观察到旧主链头。
- Expected: 经真实全节点收敛后，轻端接受胜出分叉的头。
- Observable: 两端全节点在 F+1 和新链尖的按高哈希；轻端切换前后的头。
- Basis: [比较累计难度、查找分叉并提交状态](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/light_client/mod.rs#L336-L416)。
- Source: explicit
- Testing: required

## 验证设计

短分叉用隔离的对等节点配置与正常连接/断开，保留共同祖先与两条 F+1 头；要求 F+1 哈希不同，并由两边祖先之后各块的 `compact_target` 换算难度相加，证实 B 分支累计难度严格更高（不是只比高度）。所有例均记录固定全节点快照、轻端首次/末次读数及截止时间，不抓取或修改协议消息。对逐块订阅，若要另报 #289 的正向证明路径证据，可在单 peer 下启用原版轻端 trace，按本步之后的新哈希、高度、peer 对照 [新最后状态证明的接收日志](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/light_client/components/send_last_state_proof.rs#L89-L99) 及公开已证明头；缺少对应日志时只报告“正常订阅终态”，旧版也可能通过这个终态断言。本页四案已映射到 `test/tests/chain-tip/chain_tip.spec.ts`，勾选仅表示自动化正文已写入且可静态收集，不代表真实节点通过。真实执行状态另以该案 `result.json` 为准。

### 本轮真实验证（独立临时布局）

- `LC-TIP-001`、`LC-TIP-002`、`LC-TIP-003`：RocksDB 与 SQLite 构建均在隔离 dev 链上实际通过；每次均使用新目录。`003` 初次运行发现连续发出 240 次造块请求时节点仅确认到 238，已改为逐次读取全节点链尖直到真正到 240，并复验两后端通过。
- `LC-TIP-004`：初次真实双节点运行发现 `add_node` 后握手即断，原因为共享夹具的 dev 创世时间为零、节点互认 IBD。共享夹具修正为相同且接近当前时间的创世时间后，**未放宽本案断言**，SQLite 与 RocksDB 构建均以正常双节点连接、分叉、重连和规范链尖比较实际通过。未用截链、改库或伪 peer 替代。
- 收集检查识别到四个稳定 `TEST-MAP`/`it` 标题；本机的旧 `ts-node` 与新 Node 类型声明不兼容，收集检查使用独立临时的 TypeScript 转译注册器，未把 dry-run 记为真实通过。各次原始 RPC 与日志保存在对应 `result.json` 指向的临时目录。
- 按最终静态复核将 5 处 `assert.*(await RPC…)` 全部拆为“先取 RPC 结果，再断言”，判据与链上操作未变；随后用最新共享夹具完整复跑 `LC-TIP-001～004`：RocksDB 4/4、SQLite 4/4 均真实通过。
