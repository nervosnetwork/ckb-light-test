# 区块头与交易按需取证用例

## 导读

- **这个改动要做什么**：在隔离 dev 链上，用真实 CKB 全节点与原生 ckb-light-client 通信，检验历史区块头、已确认交易从未缓存状态按需取得后，内容确实与全节点主链一致。
- **行为变化**：固定比较为 [v0.5.4 `778590a` → develop `8ea49d4`](https://github.com/nervosnetwork/ckb-light-client/compare/778590aa3ad7f71ee80b2d4c54af02c42e2dfa25...8ea49d477de44d0346d3be82c81ed627f0e66102)；其中交易请求去重、证明消息字段校验、旧版证明额外承诺校验、请求归属/重试管理发生变化。这里仅检验正常通信下的外部结果，不把内部路径是否走到当作通过条件。
- **最怕出什么问题**：未缓存目标一直停在中间状态、返回别的块/交易、交易归属块不对、重复请求后结果漂移，或不存在的哈希被误报为已取得。
- **能测到什么**：全节点公开 RPC 先提供独立主链快照，轻客户端公开 `get_*` 证实目标尚未缓存，再以 `fetch_*` 取得新结果并逐字段比较；只用正常挖块、提交交易、连接与优雅启动。
- **测不到的**：正常节点不保证产出可观察的特定证明协议版本、叔块或扩展字段；故不宣称覆盖 #288/#293 的特定分支。重复 RPC 的数量也不证明 #283 的线上请求去重；不靠伪 peer、异常包或中断恢复强行触发 #305 的内部所有权分支。上游已有单元/协议测试不纳入本轮端到端用例。

**依据与实际检查**：只读裸仓库的两个固定 Git 对象已核对；[#283 发送交易证明请求去重](https://github.com/nervosnetwork/ckb-light-client/blob/784caea413ae2a1a1a2a4fc2d92ab42afba48c1c/light-client-lib/src/protocols/light_client/mod.rs#L780-L815)、[#288 区块/交易证明字段校验](https://github.com/nervosnetwork/ckb-light-client/blob/0295a19774da9778774f58d4dee2b529309843c1/light-client-lib/src/protocols/light_client/components/send_transactions_proof.rs#L52-L98)、[#293 旧版额外承诺校验](https://github.com/nervosnetwork/ckb-light-client/blob/d8695b5b3662ecf486768eac725ffe2a2cbabb34/light-client-lib/src/protocols/light_client/components/send_blocks_proof.rs#L160-L185)、[#305 证明请求归属/完成](https://github.com/nervosnetwork/ckb-light-client/blob/b916c252296b584fb38c3794e50c703327946b8f/light-client-lib/src/protocols/light_client/components/send_transactions_proof.rs#L38-L65)。最终提交的[公开 RPC](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-bin/src/rpc.rs#L67-L86)和[按需状态语义](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/service/impls.rs#L615-L640)亦已查看。仓库现有 `test/fetch_header.spec.ts:13-56` 用固定创世哈希、固定高度和随机缺失哈希，历史块仅断言 `fetched`，创世比较只是 JSON 长度；`test/fetch_transaction.spec.ts:10-33` 用创世及高度 1 交易，后者只断言状态，未验归属/完整内容；`test/sdk/fetch_transaction.spec.ts:16-30` 深比较仍是创世交易。`test/runners/mocha/.mocharc.jsonc` 收录这两个文件，但 `test/runners/mocha/.mocharc.dev.jsonc` 未收录；`config/config.ts` 默认指向测试网而非隔离 dev 链。设计阶段未运行服务；本轮自动化已在隔离临时目录运行真实节点，且未改动项目内落后 5 个提交的工作副本。

## 需要你决定

无。本文只列能由现有公开接口独立判定的正常结果；特定协议分支覆盖留在边界说明，不作为待确认的通过断言。

## 用例

**公共约定**：单独隔离 dev 链的全节点和与之相连的原生轻客户端，记录全节点版本；轻客户端使用本次固定的目标提交，使用该 dev 链的独立配置，不沿用仓库默认测试网 URL。先让全节点正常形成至少 220 个新鲜非创世块（可先恢复同链正常挖得的夹具并续挖新块），从 tip−101 或更早的非创世高度选头目标，必要时提交一笔普通交易并挖块确认；在轻客户端当前已接受的链高之下动态挑选稳定的历史块/交易；正向头目标在最近 100 头窗口之外，且不订阅相关脚本，不使用当前 tip、创世或固定哈希。选择前由全节点 `get_block_by_number`/`get_header`、`get_transaction`/`get_block` 固定期望快照；由轻客户端 `get_header` 返回空、`get_transaction` 返回无交易且 `unknown` 证实候选尚未缓存，若不满足则重选并记录，不能把已缓存命中算作按需取证。交易须为非创世、非 cellbase 且全节点状态 `committed`，其 `block_hash` 对应的块确实包含该哈希；避免将其锁脚本预先订阅到轻客户端。请求期间保持正常连接和主链稳定；初次状态允许 `added`/`fetching`，只在 1 秒间隔、180 秒硬超时内以终态和内容判定。在启用链上扩展的标准 dev 配置，另外以全节点 `get_block` 明确带有非空 `extension` 的正常历史块分别重做 01、04；为 04 在这样的块内正常确认一笔交易。旧配置缺少这类样本时单列该变体未执行。它验证含扩展块的正常读结果，而非报文版本。比较 JSON 公共字段时只规范化命名/数值编码，不以序列化长度代替内容比较；任何 RPC 错误、超时、`not_found`（存在目标）或 `fetched`（缺失目标）均为失败。

<!-- TEST-CASES-BEGIN -->
| 用例 | 场景 | 预期结果 | 防止的问题 | 优先级 |
| --- | --- | --- | --- | --- |
| `LC-FETCH-01` | - [x] 全节点选出未缓存的非创世历史主链块，轻客户端调用 `fetch_header(hash)` 并轮询，180 秒截止。 | 取得 `fetched`；`data.hash` 等于请求哈希，且 `number`、`parent_hash`、其余双方共有头字段与全节点 `get_header` 快照逐字段相等；轻客户端随后 `get_header` 返回同一头。 | 只报成功状态却取错块、头内容不一致或一直不完成。 | P0 |
| `LC-FETCH-02` | - [x] 对另一个未缓存历史块，同一哈希先发多个正常并发 `fetch_header`，完成后再重复请求，整体 180 秒截止。 | 各调用最终均为 `fetched`，数据均与同一全节点头快照逐字段相等且彼此一致；不得出现另一哈希或永久中间状态。 | 同目标请求竞合使结果丢失或漂移。 | P1 |
| `LC-FETCH-03` | - [x] 生成合法 32 字节哈希，先确认全节点 `get_header` 为空且轻客户端未缓存，再 `fetch_header` 轮询，180 秒截止。 | 观察到 `not_found`，期间从不出现 `fetched`；轻客户端 `get_header` 始终为空，全节点复核仍无此头。 | 不存在的头被误标为已取回或永无终态。 | P1 |
| `LC-FETCH-04` | - [x] 全节点选出未缓存的非创世、非 cellbase 已确认交易，轻客户端调用 `fetch_transaction(hash)` 并轮询，180 秒截止。 | 取得 `fetched`；交易哈希及全部双方共有交易内容与全节点 `get_transaction` 快照相等，`tx_status` 为 `committed` 且 `block_hash` 等于全节点记录、对应区块确实包含该交易；轻客户端随后 `get_transaction` 同值。 | 只凭哈希或状态通过，漏掉交易内容和区块归属错误。 | P0 |
| `LC-FETCH-05` | - [x] 对另一笔未缓存已确认交易，同一哈希先发多个正常并发 `fetch_transaction`，完成后再重复请求，整体 180 秒截止。 | 各调用最终均为 `fetched`，完整交易内容和 `committed`/`block_hash` 均与同一全节点快照一致且彼此一致；不得永久停在中间状态。 | 同目标请求竞合导致交易结果不稳定；不将 RPC 次数解释为线上去重证据。 | P1 |
| `LC-FETCH-06` | - [x] 生成合法 32 字节哈希，先确认全节点 `get_transaction` 为 `unknown` 且轻客户端未缓存，再 `fetch_transaction` 轮询，180 秒截止。 | 观察到 `not_found`，期间从不出现 `fetched`；轻客户端 `get_transaction` 始终无交易且 `unknown`，全节点复核仍未知。 | 不存在的交易被误报取得或永无终态。 | P1 |
| `LC-FETCH-07` | - [x] 头、交易分两轮：并发登记一个全节点确认存在、另一个格式合法但全节点未知的未缓存哈希，在同一稳定链上分别观察两个结果。 | 180 秒内已知目标的完整内容与所属块匹配全节点，未知目标出现 `not_found` 且没有本地内容；两者不可串号，不要求被合入同一条协议消息。 | 有效目标与缺失目标并行时互相污染或一直等待。 | P1 |
<!-- TEST-CASES-END -->

## 测试树

<!-- TEST-TREE-BEGIN -->
- 正常全节点上的按需区块头
  - 未缓存历史头取回且逐字段吻合：LC-FETCH-01 [primary] -> SPEC-01
  - 同一头并发及后续重复仍得到同值：LC-FETCH-02 [primary] -> SPEC-01
  - 不存在头以缺失终态结束且不伪造内容：LC-FETCH-03 [primary] -> SPEC-03
- 正常全节点上的按需交易
  - 未缓存已确认交易内容及归属块吻合：LC-FETCH-04 [primary] -> SPEC-02
  - 同一交易并发及后续重复仍得到同值：LC-FETCH-05 [primary] -> SPEC-02
  - 不存在交易以缺失终态结束且不伪造内容：LC-FETCH-06 [primary] -> SPEC-03
- 正常混合请求
  - 存在与缺失目标独立完成：LC-FETCH-07 [primary] -> SPEC-01, SPEC-02, SPEC-03
- 仅内部可见的分支
  - 协议版本、字段长度与旧版额外承诺检查：[not_applicable] — 正常真实节点和公开接口不能强制/确认特定证明报文路径。
  - 线上交易证明请求去重、请求归属及失败重试：[not_applicable] — 重复公开 RPC 或健康链成功只证明结果，不证明内部请求次数、持有者或故障恢复。
<!-- TEST-TREE-END -->

## Spec

### SPEC-01：已存在的历史主链区块头可按需取得且内容稳定
- Condition: 全节点确认该非创世历史块在稳定主链，轻客户端公开读接口确认目标未缓存，正常连接。
- Expected: `fetch_header` 最终返回所请求主链头；同一目标的正常并发与重复访问不改变结果。
- Observable: `fetched` 数据及随后 `get_header` 与全节点 `get_header` 的哈希、区块号、父哈希及双方共有头字段一致。
- Basis: [最终提交的 fetch_header 实现](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/service/impls.rs#L615-L640)；[证明请求入口](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/light_client/mod.rs#L740-L779)。
- Source: explicit
- Testing: required

### SPEC-02：已确认交易可按需取得且内容和区块归属稳定
- Condition: 全节点确认该非创世非 cellbase 交易已在稳定主链提交，轻客户端公开读接口确认未缓存，正常连接。
- Expected: `fetch_transaction` 最终返回该交易与已确认归属；同一目标的正常并发与重复访问不改变结果。
- Observable: `fetched` 数据及随后 `get_transaction` 的交易内容、`committed` 状态、`block_hash` 与全节点 `get_transaction` 和所属块一致。
- Basis: [最终提交的 fetch_transaction 实现](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/service/impls.rs#L724-L751)；[#283 去重后的发送路径](https://github.com/nervosnetwork/ckb-light-client/blob/784caea413ae2a1a1a2a4fc2d92ab42afba48c1c/light-client-lib/src/protocols/light_client/mod.rs#L780-L815)。
- Source: explicit
- Testing: required

### SPEC-03：全节点不存在的合法哈希不会变成已取得内容
- Condition: 32 字节格式合法的哈希经全节点确认不存在，轻客户端公开读接口确认未缓存，正常连接。
- Expected: 对应 `fetch_*` 进入 `not_found`，不返回伪造的 `fetched` 内容。
- Observable: 轻客户端 `fetch_*` 状态及 `get_*` 空/未知，与全节点复核一致。
- Basis: [区块头缺失状态](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/service/impls.rs#L621-L640)；[交易缺失状态](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/service/impls.rs#L730-L751)。
- Source: explicit
- Testing: required

## 验证设计

- **独立预期**：全节点公开 RPC 的请求前快照是唯一内容 oracle；区块头用 `get_block_by_number` 选主链、`get_header(hash)` 固定全部共有字段，交易用 `get_transaction(hash)` 固定交易和 `block_hash`，再由 `get_block(block_hash)` 验证交易成员关系。缺失哈希先由全节点确认无记录，测试结束再复核。轻客户端自身返回值只作被测结果，不参与生成期望内容。
- **实际入口与观察**：轻客户端 `get_header`/`get_transaction` 的前置空/未知证明不是缓存命中；调用原生 `fetch_header`/`fetch_transaction`，记录每轮状态、最终数据和公开读接口后置值，按每条 180 秒硬截止判定。并发组使用同一未缓存目标，先同时提交请求，再各自轮询至终态，最后做一次重复请求；只断言数据一致和完成，不推断网络消息数。
- **证明边界**：这是隔离 dev 链上真实全节点—轻客户端的 RPC 端到端结果验证，不是协议报文或安全拒绝分支验证。#288/#293 即使相关源码改变，正常请求成功也不能证明特定版本/叔块/扩展分支执行；#305 的对等端中断恢复由其他模块负责。`not_found` 之后公开 API 可能重新排队，故只要求本次出现缺失终态且始终无伪造数据，不要求该状态永久保持。
- **本轮实测**：2026-11-25，在两个独立临时固定布局分别使用 CKB `0.210.0 (13adbb8)` 与目标轻客户端 `0.5.5 (8ea49d4)` 的 RocksDB、SQLite 构建；`LC-FETCH-01～07` 两种后端各 7/7 通过，退出码均为 0。01、04 的全节点目标块均记录非空 `extension`，其头/交易正常取回，但不据此推断证明报文版本。结构与映射检查针对本模块均为 7/7、退出码 0；勾选只表示 TEST-MAP 存在，行为通过另由上述真实执行记录支持。
