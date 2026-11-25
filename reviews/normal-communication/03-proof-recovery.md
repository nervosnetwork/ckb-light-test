# 节点切换期间的待取区块头与交易

## 导读

[#305](https://github.com/nervosnetwork/ckb-light-client/commit/b916c25) 调整了证明请求的归属与重试。这里测用户能观察的结果：已登记、尚未取得的目标，在真实节点恢复、换成另一节点或遇到新主链后，**不用应用再提交一次**也能取回。固定网络连接和切换时间的办法是先让唯一节点正常下线，再登记待办；不跟毫秒级的网络回复抢时间。

[已有区块头](../../test/fetch_header.spec.ts)与[交易取证](../../test/fetch_transaction.spec.ts)在同一连接反复调用 `fetch_*`；[已有回滚](../../test/dev/ckbLightClientCut.spec.ts)检查索引。下面用只读查询观察已登记的工作是否自己完成。测试的是网络重新可用后的请求进度，不把“无 peer 时排队”等同于“已在途的证明被重新派发”。

## 需要你决定

已确认“一次登记，无需应用重发”和“真实查无后、上链可重新取得”为本仓库的外部验收标准（LC-RETRY-01 至 LC-RETRY-07）。本模块没有新增待决定项。精确的在途切换仍不列为必跑项：正常 RPC 没有在“发出但未完成”之间设置屏障的能力。

## 用例

**共同准备与观测。** 保持同一个轻端进程/数据目录，不订阅目标交易的脚本，也不调用其他潜在取证入口。先只连 A 并同步到新鲜的非创世链尖（目标与 tip 相距超过最近 100 个块头窗口）。全节点保存远离最近 100 个块头窗口、非创世的历史主链头 H 及非 cellbase 已提交交易 T 的完整快照，记录 T 所在块、块内索引和该高度哈希；分叉实验从共同祖先之前选目标。轻端必须尚无 H/T（`get_header(H)=null`、`get_transaction(T)` 无交易体且为 `unknown`）。优雅停止 A 或关闭本实验的正常连接；`get_peers()` 为空、项目内没有其他入口时，**恰好一次**调用目标 `fetch_header` 或 `fetch_transaction`，断言为 `added`。01–06 此后绝不再调用任一 `fetch_*`；对相应 `get_*` 每秒轮询。01–04 在无连接时让将接回的节点正常挖至少一块，形成严格高于轻端旧 tip 的同链头；停挖后再建立唯一连接。例如先正常断开 A 并由公开 peer 列表确认，在隔离的 A 上挖完新块、优雅停机，再按原链数据/原端口启动并重新接入。禁止其他自动发现节点提前连入。05–06 用高于旧 tip 的较重 B 分支。接入前目标无数据；从建立连接起 5 分钟内须同时看到 `get_peers()[0].sync_state.proved_best_known_header.hash` 等于目标节点的新 tip 以及对应内容，不能把恢复到未获证的旧 tip 当作就绪。在头用例收尾优雅断开唯一 peer，确认 `get_peers()=[]` 后再只读一次 H，仍须返回同一头；这样排除重连时附带的临时头缓存。两类目标分别使用新链路夹具，避免取交易顺带把其块头放入缓存。07 是另一条入口：它观察到健康节点真正报告缺失后的公开重查，**不**用于证明自动重试。

<!-- TEST-CASES-BEGIN -->
| 用例 | 场景 | 预期结果 | 防止的问题 | 优先级 |
| --- | --- | --- | --- | --- |
| `LC-RETRY-01` | - [x] A 离线时登记 H，按原配置和数据目录重启 A，确认轻端只重新连到 A。 | 只读 `get_header(H)` 从空变为与 A 主链相同的完整头。 | 恢复连接后丢失已登记的头。 | P1 |
| `LC-RETRY-02` | - [x] A 离线时登记 T，按原配置重启 A。 | 只读 `get_transaction(T)` 从无数据变为已提交，交易体与所属主链块哈希均匹配 A。 | 把头恢复误当作交易也能恢复。 | P1 |
| `LC-RETRY-03` | - [x] A、B 预先同步同一链。A 离线时登记 H，保持 A 下线，只让同链 B 接入。 | 确认 B 是唯一 peer；只读返回 H 完整头，与 B 的按高度主链哈希及头相同。 | 工作只等原节点，不转到可用节点。 | P1 |
| `LC-RETRY-04` | - [x] 与上一例相同，在 A 离线时只登记 T，再只连 B。 | B 的主链块包含 T；轻端只读出现同一交易体、`committed` 和正确块哈希。 | 切换节点后只有头可恢复，交易滞留。 | P1 |
| `LC-RETRY-05` | - [x] A、B 在共同祖先后正常独立挖块；轻端已接受 A 的较轻分支。离线登记共同前缀 H，随后只连持有较重链的 B。 | 轻端最终 tip 对齐 B，且只读取得 H；两项都须成立，但不规定谁先出现。 | 旧 tip 或旧节点绑定造成换链后待取目标不再完成。 | P1 |
| `LC-RETRY-06` | - [x] 同样的真实分叉，离线登记仍在共同前缀的 T，只连 B。 | 轻端 tip 对齐 B；只读取得 T 的完整交易体、已提交状态及 B 同高度主链块哈希。 | 换链后仍有效的交易被当作缺失或归错块。 | P1 |
| `LC-RETRY-07` | - [x] 单健康节点、稳定旧 tip。离线签好尚未广播的普通交易 U（未订阅其 lock），全节点未知 U，用轻端 `fetch_transaction(U)` 先等到真实 `not_found`。仅向全节点提交原交易，记其提交高度 h；正常再挖至少一个后继块并停挖。确认轻端 tip 和唯一 peer 的已证明头哈希均为该新主链头（高度 ≥h+1），再以原哈希重查。 | 两阶段各限 180 秒。第一次无交易体；上链后该哈希最终为 `fetched`，交易体、`tx_status.status=committed` 及 `tx_status.block_hash` 与全节点及包含 U 的主链块一致。首次重查仍可能读到旧的 `not_found`；以有界窗口内最终的已确认内容为判据。记录两阶段调用；不要求缺失永久缓存或用例命中特定请求槽。 | 正常负结果把随后真实上链的交易永远标为缺失。 | P1 |
<!-- TEST-CASES-END -->

## 测试树

<!-- TEST-TREE-BEGIN -->
- 同一条主链
  - 原节点重新上线：LC-RETRY-01 [primary] -> SPEC-01
  - 原节点的交易：LC-RETRY-02 [primary] -> SPEC-01
  - 同链另一节点的头：LC-RETRY-03 [primary] -> SPEC-01
  - 同链另一节点的交易：LC-RETRY-04 [primary] -> SPEC-01
- 分叉后的较重主链
  - 共同前缀的头：LC-RETRY-05 [primary] -> SPEC-02
  - 共同前缀的交易：LC-RETRY-06 [primary] -> SPEC-02
- 同一交易从尚未上链变为已提交
  - 健康 peer 先返回缺失，公开重查后出现完整已确认数据：LC-RETRY-07 [primary] -> SPEC-03
- 内部归属、旧回复竞争、特定 peer 的在途接管 [not_applicable] — `fetching.first_sent` 或发送前日志都不能证明切换时对端尚未回复；不用异常报文、代理延迟或内部钩子强造窗口。
<!-- TEST-TREE-END -->

## Spec

### SPEC-01：健康节点重新可用后，登记的目标能完成
- Condition: 未缓存目标已在没有 peer 的窗口内登记一次，之后只有指定真实 peer 可用。
- Expected: 调用方无需再次请求；目标在有限时间内出现在轻端的本地查询中。
- Observable: 轻端只读接口从无数据变为与全节点一致的头或已提交交易；peer 列表由空变为本轮唯一节点。
- Basis: [fetch 登记与只读接口](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/service/impls.rs#L610-L751)、[选择已证明节点并调度待取目标](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/light_client/mod.rs#L718-L826)。
- Source: explicit
- Testing: required

### SPEC-02：采纳新主链与共同前缀目标的完成可以同时成立
- Condition: 合法短分叉，旧节点离线；两链共同前缀上有已登记但未缓存的目标。
- Expected: 新主链可用后，既能跟随更重链，又能取得该目标。
- Observable: 轻端 tip、H/T 只读结果；B 全节点的规范链哈希与块内容。
- Basis: [已接受状态和取证调度](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/protocols/light_client/mod.rs)、[#305 正向兼容边界](https://github.com/nervosnetwork/ckb-light-client/pull/305)。
- Source: explicit
- Testing: required

### SPEC-03：曾查无的合法交易在真实上链后可以重新取得
- Condition: 同一有效交易先未广播、后经全节点正常提交；轻端未监控该交易，且双方 tip 及已证明头高于交易所在块。
- Expected: 首次缺失不妨碍后续按需取得正确的已确认交易。
- Observable: 全节点提交前后状态、主链块成员关系，轻端的 `not_found → fetched` 与交易内容。
- Basis: [公开取证在 missing 时允许重查](https://github.com/nervosnetwork/ckb-light-client/blob/8ea49d477de44d0346d3be82c81ed627f0e66102/light-client-lib/src/service/impls.rs#L724-L751)。
- Source: explicit
- Testing: required

## 验证设计

全节点数据是预期值，不使用轻端 fetch 的响应生成预期。记录未连接窗口、轻端实际 peer ID、请求次数和两端同高度的头。重组先记录共同祖先和 A 专属正常交易确认后的同高度链哈希差异；逐高度读取两分叉公开块头的 `compact_target`，累加工作量并断言 B 高于 A，而非仅凭块数推定。使用稳定的 tip，不截链或直接改数据库。拓扑或未缓存条件未达成时报告环境未就绪；已满足条件却在 5 分钟内未取得对应数据，判失败。此处不声称覆盖 #305 的防错分支，也不要求某条内部日志出现。自动化映射见 `test/tests/proof-recovery/lc_retry.spec.ts`；`[x]` 仅表示唯一 `TEST-MAP` 已存在，不代表运行通过。验证限定为本模块真实节点和公开 RPC；具体运行结果以独立证据文件为准。
