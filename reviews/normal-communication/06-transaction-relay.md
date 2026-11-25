# 轻客户端交易广播到全节点用例

## 导读

- **这个改动要做什么**：验证轻客户端提交的真实有效交易，经正常连接的真实 CKB 全节点接收、入块，最后由轻端重新索引。
- **行为变化**：上游 v0.5.4 → develop 将轻端 `send_transaction` 逻辑抽至公共服务，并将 Relay 连接时提取 PeerId 的强制解包改为有条件处理；正常有效 PeerId 下，外部应仍能完成广播。此处是回归目标，不推断内部代码必经哪一分支。
- **最怕出什么问题**：轻端只在本地显示 pending 或返回 hash，全节点始终没有收到交易；或者全节点已入块而轻端未索引。
- **能测到什么**：隔离 dev 链上，用公开 RPC 分别观察全节点交易池、规范链和轻端索引的同一 hash。
- **测不到的**：真实有效 PeerId 分支、Relay 消息次数及格式无独立公开观察入口；只证明正常连接下的外部广播结果，不宣称覆盖特定内部分支。缺失 PeerId、异常消息及故障注入均不在本设计范围。

依据：固定比较 [v0.5.4 → develop](https://github.com/nervosnetwork/ckb-light-client/compare/778590aa3ad7f71ee80b2d4c54af02c42e2dfa25...8ea49d477de44d0346d3be82c81ed627f0e66102)；[#286 的 Relay 变更](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/relayer.rs#L141-L169)、[#270 的公共服务提交与本地 pending](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/service/impls.rs#L644-L720)、[公开 RPC 接线](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-bin/src/rpc.rs#L199-L212)。已从给定只读裸仓库检查固定提交源码；本轮未启动节点或运行集成测试。

## 需要你决定

- 无额外产品规则。

## 用例

公共约定：仅一个轻客户端连接隔离 dev 链的真实 CKB 全节点；轻端配置 `network.max_outbound_peers=1`，全节点开启正常 Relay、LightClient 和 Filter 服务。公开 RPC 确认二者 genesis 一致、正常连接且已同步到同一 tip。准备已确认、被轻端监控且可花费的 cell；暂停出块后构造并签名一笔新有效交易，输出仍匹配监控脚本，离线计算其精确 hash `H`。提交前全节点 `get_transaction(H)` 为 unknown/null，全节点 `get_raw_tx_pool(false)` 的 pending/proposed 哈希列表亦无 `H`；除轻端 `send_transaction` 一次外，不向全节点或其他节点提交/补发。轮询超时即失败，不把轻端返回 hash 或本地 pending 当成全节点接收。只有全节点交易池实际列出 H 后才恢复正常出块。

<!-- TEST-CASES-BEGIN -->
| 用例 | 场景 | 预期结果 | 防止的问题 | 优先级 |
| --- | --- | --- | --- | --- |
| `LC-RELAY-01` | - [x] 按公共约定暂停出块、确认全节点未知 `H`，仅向轻端公开 `send_transaction` 提交一次；全节点入池后正常挖块，并等待轻端同步。 | 轻端返回精确 `H`；120 秒内全节点公开 `get_transaction(H)` 为同一交易且 `pending`（或 `proposed`），其 `get_raw_tx_pool(false)` 列表含 `H`；恢复出块后 180 秒内全节点为 `committed`，其 `block_hash` 对应规范链区块且区块交易含 `H`；再于 180 秒内轻端 `get_transaction(H)` 为同一交易的 `committed`、同一规范块 hash，`get_cells` 能索引新输出的精确 outpoint 与容量。 | 本地接收冒充网络广播、挖块前未入池、非规范块误报入块、轻端确认后索引缺失。 | P0 |
<!-- TEST-CASES-END -->

## 测试树

<!-- TEST-TREE-BEGIN -->
- 正常交易 Relay 闭环
  - 轻端单次提交 → 全节点先入池 → 正常入规范链 → 轻端索引：LC-RELAY-01 [primary] -> SPEC-01
<!-- TEST-TREE-END -->

## Spec

### SPEC-01：仅经轻端提交的新有效交易须到达全节点，并在正常出块后成为轻端可查询的规范链结果
- Condition: 同一隔离 dev 链；唯一真实连接；双方同步；已监控的有效可花费 cell；全节点提交前未知交易；暂停出块。
- Expected: 同一精确 hash 先被全节点交易池接受，再进入规范链，最终由轻端索引。
- Observable: 轻端 `send_transaction` 返回值、全节点 `get_transaction`/交易池/规范链区块、轻端 `get_transaction`/`get_cells`；每阶段有独立超时。
- Basis: 本轮明确的端到端正常 Relay 需求；上游固定提交的服务与 Relay 源码链接见导读。
- Source: explicit
- Testing: required

## 验证设计

- **独立预期**：从签名后原始交易离线计算 `H`，使用构造时记录的输出索引、容量和脚本作为预期；全节点提交前的 unknown/null 与空池读数是新交易前置基线。轻端响应不充当全节点接收的 oracle。
- **实际入口与观察**：轻端公开 `send_transaction` 一次；全节点公开 `get_transaction(H)` 与交易池在暂停出块时观察 `pending`/`proposed` 和精确 `H`；正常挖块后以全节点 `get_transaction(H).tx_status.block_hash`、该区块交易列表及同高度 `get_block_hash` 互证规范链包含；再查轻端同 hash、同块的 `committed` 与新输出索引。若 full RPC 对 proposed 的可见性有差异，仍须在出块前直接证实交易池含 `H`，不以轻端 pending 代替。
- **证明边界**：真实 CKB 与真实轻客户端的公开接口端到端；不监视内部 peer_id、消息格式、次数或本地 pending 状态。连接不可用、交易无效、同步前置不成立时记环境/前置失败，不将其解释为 Relay 回归。
- **已有用例与新增价值**：[`test/scenes.test.ts`](../../test/scenes.test.ts) 的 `send_transaction` 有成功提交/打印 hash，但未在暂停出块时证明全节点入池；[`test/dev/DaoScriptSizeVerifier.spec.ts`](../../test/dev/DaoScriptSizeVerifier.spec.ts) 提交后挖块并断言全节点 `committed`，主目标是 DAO 规则，未区分入池和本地 pending，也未核对轻端索引；[`scripts/stability/run.js`](../../scripts/stability/run.js) 在手动 testnet 上比对双端已确认块与监控输出，但未建立隔离单连接、预先未知及挖块前入池的因果链。本用例保留其双端同 hash/同块与输出校验，新增入池阶段、规范链核对及有限超时。
