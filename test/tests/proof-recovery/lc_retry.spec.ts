import assert from "node:assert/strict";
import { blockWork, buildCreation, devFunding, hex, until, withNodeWorkspace } from "../lc_store_support";
import { isolateNodeNetwork } from "./node_network";

const SYNC_MS = 300_000;
const FETCH_MS = 300_000;
const HISTORY = 112;
const peerIds = (peers: any[]) => peers.map(peer => peer.node_id);
const txBody = (tx: any) => tx?.transaction;

describe("LC-RETRY 真实节点切换后的取证", function () {
  this.timeout(1_800_000);

  // TEST-MAP: LC-RETRY-01
  it("LC-RETRY-01 原节点优雅重启后无需重新登记即可取得区块头", async () => {
    // 1. 启动 A 与只连接 A 的轻客户端，确认同链和唯一连接。
    // 2. 在 A 挖出历史头 H 与后续块，确认轻端同步但未缓存 H。
    // 3. 优雅停 A，在无 peer 时仅登记一次 H，确认状态为 added 且只读仍为空。
    // 4. 重启原 A 并正常挖块，确认唯一已证明 peer 与新链尖，仅读取 H 至完整一致。
    // 5. 再优雅停 A，确认断连后本地 H 仍与全节点快照一致。
    await withNodeWorkspace("LC-RETRY-01", async run => {
      // 1. 启动 A 与只连接 A 的轻客户端，确认同链和唯一连接。
      const a = run.startCkbNode("A");
      await until("A RPC", 90_000, () => a.get_tip_header());
      const genesis = await a.get_block_by_number("0x0");
      const idA = (await a.local_node_info()).node_id;
      const light = run.startLightClient({ bootnodeId: idA });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[1] 轻客户端：创世哈希应与 A 相同");
      const initialPeers = await until("light connected A", SYNC_MS, async () => {
        const peers = await light.get_peers();
        return peerIds(peers).includes(idA) && peers;
      });
      assert.deepEqual(peerIds(initialPeers), [idA], "[1] 轻客户端：唯一 peer 应为 A");

      // 2. 在 A 挖出历史头 H 与后续块，确认轻端同步但未缓存 H。
      run.report.stage = "prepare_history";
      await a.generate_block();
      const hHash = await a.get_block_hash("0x1");
      for (let i = 0; i < HISTORY; i++) await a.generate_block();
      const expected = await a.get_header(hHash);
      const oldTip = await a.get_tip_header();
      assert.equal(expected.hash, hHash, "[2] A：历史头应与该高度主链哈希一致");
      await until("light accepted A tip", SYNC_MS, async () => {
        const tip = await light.get_tip_header();
        return tip.hash === oldTip.hash && tip;
      });
      const before = await light.get_header(hHash);
      assert.equal(before, null, "[2] 轻客户端：登记前 H 应未缓存");
      run.report.target = { hash: hHash, number: expected.number, old_tip: oldTip.hash };

      // 3. 优雅停 A，在无 peer 时仅登记一次 H，确认状态为 added 且只读仍为空。
      await run.stopCkbNode("A");
      const offlinePeers = await until("light disconnected A", 90_000, async () => {
        const peers = await light.get_peers();
        return peers.length === 0 && peers;
      });
      assert.deepEqual(offlinePeers, [], "[3] 轻客户端：A 离线后应无 peer");
      const registered = await light.fetch_header(hHash);
      assert.equal(registered.status, "added", "[3] 轻客户端：唯一一次 fetch 应登记未缓存的 H");
      const stillEmpty = await light.get_header(hHash);
      assert.equal(stillEmpty, null, "[3] 轻客户端：无 peer 时 H 仍应为空");

      // 4. 重启原 A 并正常挖块，确认唯一已证明 peer 与新链尖，仅读取 H 至完整一致。
      const restoreANetwork = isolateNodeNetwork(run.report.rpc_trace!, "A");
      let restartedA = run.startCkbNode("A");
      await until("isolated A RPC", 90_000, () => restartedA.get_tip_header());
      await restartedA.generate_block();
      const newTip = await restartedA.get_tip_header();
      const canonical = await restartedA.get_block_hash(expected.number);
      assert.equal(canonical, hHash, "[4] A：重启后 H 应仍在主链共同前缀");
      const beforeReconnect = await light.get_peers();
      assert.deepEqual(beforeReconnect, [], "[4] 轻客户端：A 挖出新 tip 前应保持无 peer");
      await run.stopCkbNode("A");
      restoreANetwork();
      restartedA = run.startCkbNode("A");
      await until("restarted A RPC", 90_000, () => restartedA.get_tip_header());
      const provedPeers = await until("A proved new tip", SYNC_MS, async () => {
        const peers = await light.get_peers();
        return peers.length === 1 && peers[0].node_id === idA
          && peers[0].sync_state?.proved_best_known_header?.hash === newTip.hash && peers;
      });
      assert.deepEqual(peerIds(provedPeers), [idA], "[4] 轻客户端：新链尖的唯一已证明 peer 应为 A");
      const recovered = await until("H recovered without another fetch", FETCH_MS,
        async () => light.get_header(hHash));
      assert.deepEqual(recovered, expected, "[4] 轻客户端：只读取得的完整 H 应等于 A 主链头");

      // 5. 再优雅停 A，确认断连后本地 H 仍与全节点快照一致。
      await run.stopCkbNode("A");
      const noPeersAgain = await until("light disconnected again", 90_000, async () => {
        const peers = await light.get_peers();
        return peers.length === 0 && peers;
      });
      assert.deepEqual(noPeersAgain, [], "[5] 轻客户端：再次断连后应无 peer");
      const retained = await light.get_header(hHash);
      assert.deepEqual(retained, expected, "[5] 轻客户端：断连后 H 应保留为同一完整头");
    });
  });

  // TEST-MAP: LC-RETRY-02
  it("LC-RETRY-02 原节点优雅重启后无需重新登记即可取得交易", async () => {
    // 1. 启动 A 与只连接 A 的轻客户端，确认同链和唯一连接。
    // 2. 在 A 创建并确认 T，再挖后续块，确认轻端同步但未缓存 T。
    // 3. 优雅停 A，在无 peer 时仅登记一次 T，确认 added 且只读仍未知。
    // 4. 重启 A 并正常挖块，确认唯一已证明 peer，仅读取 T 至交易体和提交块一致。
    await withNodeWorkspace("LC-RETRY-02", async run => {
      // 1. 启动 A 与只连接 A 的轻客户端，确认同链和唯一连接。
      const a = run.startCkbNode("A");
      await until("A RPC", 90_000, () => a.get_tip_header());
      const genesis = await a.get_block_by_number("0x0");
      const idA = (await a.local_node_info()).node_id;
      const light = run.startLightClient({ bootnodeId: idA });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[1] 轻客户端：创世哈希应与 A 相同");
      const initialPeers = await until("light connected A", SYNC_MS, async () => {
        const peers = await light.get_peers();
        return peerIds(peers).includes(idA) && peers;
      });
      assert.deepEqual(peerIds(initialPeers), [idA], "[1] 轻客户端：唯一 peer 应为 A");

      // 2. 在 A 创建并确认 T，再挖后续块，确认轻端同步但未缓存 T。
      run.report.stage = "prepare_transaction";
      const { chainConfig, genesisCell } = devFunding(genesis, run.funder);
      const t = await buildCreation(genesisCell, run.funder, run.watched, chainConfig);
      const submitted = await a.send_transaction(t.raw);
      assert.equal(submitted, t.hash, "[2] A：提交 T 应返回本地构造的哈希");
      const confirmed = await until("T committed", SYNC_MS, async () => {
        await a.generate_block();
        const value = await a.get_transaction(t.hash);
        return value?.tx_status?.status === "committed" && value;
      });
      const block = await a.get_block(confirmed.tx_status.block_hash);
      const canonical = await a.get_block_hash(block.header.number);
      assert.equal(confirmed.tx_status.block_hash, canonical, "[2] A：T 的确认块应为该高度主链块");
      assert.ok(block.transactions.some((row: any) => row.hash === t.hash), "[2] A：确认块应包含 T");
      for (let i = 0; i < HISTORY; i++) await a.generate_block();
      const oldTip = await a.get_tip_header();
      await until("light accepted A tip", SYNC_MS, async () => {
        const tip = await light.get_tip_header();
        return tip.hash === oldTip.hash && tip;
      });
      const before = await light.get_transaction(t.hash);
      assert.equal(txBody(before), null, "[2] 轻客户端：T 应尚无交易体");
      assert.equal(before.tx_status.status, "unknown", "[2] 轻客户端：T 应尚未知晓");
      run.report.target = { hash: t.hash, block_hash: canonical, old_tip: oldTip.hash };

      // 3. 优雅停 A，在无 peer 时仅登记一次 T，确认 added 且只读仍未知。
      await run.stopCkbNode("A");
      const offlinePeers = await until("light disconnected A", 90_000, async () => {
        const peers = await light.get_peers();
        return peers.length === 0 && peers;
      });
      assert.deepEqual(offlinePeers, [], "[3] 轻客户端：A 离线后应无 peer");
      const registered = await light.fetch_transaction(t.hash);
      assert.equal(registered.status, "added", "[3] 轻客户端：唯一一次 fetch 应登记 T");
      const stillUnknown = await light.get_transaction(t.hash);
      assert.equal(txBody(stillUnknown), null, "[3] 轻客户端：无 peer 时 T 应仍无交易体");

      // 4. 重启 A 并正常挖块，确认唯一已证明 peer，仅读取 T 至交易体和提交块一致。
      const restoreANetwork = isolateNodeNetwork(run.report.rpc_trace!, "A");
      let restartedA = run.startCkbNode("A");
      await until("isolated A RPC", 90_000, () => restartedA.get_tip_header());
      await restartedA.generate_block();
      const newTip = await restartedA.get_tip_header();
      const afterCanonical = await restartedA.get_block_hash(block.header.number);
      assert.equal(afterCanonical, canonical, "[4] A：T 的确认块重启后应仍为主链块");
      const beforeReconnect = await light.get_peers();
      assert.deepEqual(beforeReconnect, [], "[4] 轻客户端：A 挖出新 tip 前应保持无 peer");
      await run.stopCkbNode("A");
      restoreANetwork();
      restartedA = run.startCkbNode("A");
      await until("restarted A RPC", 90_000, () => restartedA.get_tip_header());
      const provedPeers = await until("A proved new tip", SYNC_MS, async () => {
        const peers = await light.get_peers();
        return peers.length === 1 && peers[0].node_id === idA
          && peers[0].sync_state?.proved_best_known_header?.hash === newTip.hash && peers;
      });
      assert.deepEqual(peerIds(provedPeers), [idA], "[4] 轻客户端：新链尖的唯一已证明 peer 应为 A");
      const recovered = await until("T recovered without another fetch", FETCH_MS, async () => {
        const value = await light.get_transaction(t.hash);
        return value?.transaction && value?.tx_status?.status === "committed" && value;
      });
      assert.deepEqual(recovered.transaction, confirmed.transaction, "[4] 轻客户端：T 的完整交易体应与 A 相同");
      assert.equal(recovered.tx_status.block_hash, canonical, "[4] 轻客户端：T 的提交块应等于 A 主链块");
    });
  });

  // TEST-MAP: LC-RETRY-03
  it("LC-RETRY-03 A 离线后同链 B 接替并完成区块头", async () => {
    // 1. 启动同创世 A、B 和只连接 A 的轻客户端，确认两节点可正常互联。
    // 2. A 挖出历史头 H 并同步到 B 与轻端，确认 H 未缓存。
    // 3. 优雅停 A，在无 peer 时只登记一次 H，确认 added。
    // 4. 只让 B 连轻端并挖新块，确认 B 唯一且已证明，仅读到与 B 相同的完整 H。
    // 5. 优雅停 B，确认离线后 H 仍保留。
    await withNodeWorkspace("LC-RETRY-03", async run => {
      // 1. 启动同创世 A、B 和只连接 A 的轻客户端，确认两节点可正常互联。
      const a = run.startCkbNode("A");
      let b = run.startCkbNode("B");
      await until("A RPC", 90_000, () => a.get_tip_header());
      await until("B RPC", 90_000, () => b.get_tip_header());
      const genesisA = await a.get_block_by_number("0x0");
      const genesisB = await b.get_block_by_number("0x0");
      assert.equal(genesisB.header.hash, genesisA.header.hash, "[1] B：创世哈希应与 A 相同");
      const idA = (await a.local_node_info()).node_id;
      const idB = (await b.local_node_info()).node_id;
      await run.stopCkbNode("B");
      const light = run.startLightClient({ bootnodes: [{ node: "A", nodeId: idA }, { node: "B", nodeId: idB }] });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesisA.header.hash, "[1] 轻客户端：创世哈希应与 A/B 相同");
      const initialPeers = await until("light connected A", SYNC_MS, async () => {
        const peers = await light.get_peers();
        return peerIds(peers).includes(idA) && peers;
      });
      assert.deepEqual(peerIds(initialPeers), [idA], "[1] 轻客户端：起初应只连接 A");
      b = run.startCkbNode("B");
      await until("restarted B RPC", 90_000, () => b.get_tip_header());
      await b.add_node(idA, run.p2pAddress("A"));

      // 2. A 挖出历史头 H 并同步到 B 与轻端，确认 H 未缓存。
      run.report.stage = "prepare_same_chain";
      await a.generate_block();
      const hHash = await a.get_block_hash("0x1");
      for (let i = 0; i < HISTORY; i++) await a.generate_block();
      const expected = await a.get_header(hHash);
      const oldTip = await a.get_tip_header();
      await until("B accepted A tip", SYNC_MS, async () => {
        const tip = await b.get_tip_header();
        return tip.hash === oldTip.hash && tip;
      });
      const bHash = await b.get_block_hash(expected.number);
      assert.equal(bHash, hHash, "[2] B：H 应在两节点共同主链");
      await until("light accepted A tip", SYNC_MS, async () => {
        const tip = await light.get_tip_header();
        return tip.hash === oldTip.hash && tip;
      });
      const before = await light.get_header(hHash);
      assert.equal(before, null, "[2] 轻客户端：H 应尚未缓存");
      run.report.target = { hash: hHash, number: expected.number, old_tip: oldTip.hash };

      // 3. 优雅停 A，在无 peer 时只登记一次 H，确认 added。
      await run.stopCkbNode("B");
      await run.stopCkbNode("A");
      const offlinePeers = await until("light disconnected A", 90_000, async () => {
        const peers = await light.get_peers();
        return peers.length === 0 && peers;
      });
      assert.deepEqual(offlinePeers, [], "[3] 轻客户端：A 离线后应无 peer");
      const registered = await light.fetch_header(hHash);
      assert.equal(registered.status, "added", "[3] 轻客户端：唯一一次 fetch 应登记 H");

      // 4. 只让 B 连轻端并挖新块，确认 B 唯一且已证明，仅读到与 B 相同的完整 H。
      const restoreBNetwork = isolateNodeNetwork(run.report.rpc_trace!, "B");
      b = run.startCkbNode("B");
      await until("isolated B RPC", 90_000, () => b.get_tip_header());
      await b.generate_block();
      const newTip = await b.get_tip_header();
      const bHeader = await b.get_header(hHash);
      assert.deepEqual(bHeader, expected, "[4] B：共同前缀 H 应保持完整一致");
      const beforeReconnect = await light.get_peers();
      assert.deepEqual(beforeReconnect, [], "[4] 轻客户端：B 挖出新 tip 前应保持无 peer");
      await run.stopCkbNode("B");
      restoreBNetwork();
      b = run.startCkbNode("B");
      await until("restarted B RPC", 90_000, () => b.get_tip_header());
      const provedPeers = await until("B proved new tip", SYNC_MS, async () => {
        const peers = await light.get_peers();
        return peers.length === 1 && peers[0].node_id === idB
          && peers[0].sync_state?.proved_best_known_header?.hash === newTip.hash && peers;
      });
      assert.deepEqual(peerIds(provedPeers), [idB], "[4] 轻客户端：唯一已证明 peer 应为 B");
      const recovered = await until("H recovered via B", FETCH_MS, async () => light.get_header(hHash));
      assert.deepEqual(recovered, bHeader, "[4] 轻客户端：只读取得的完整 H 应与 B 一致");

      // 5. 优雅停 B，确认离线后 H 仍保留。
      await run.stopCkbNode("B");
      const noPeers = await until("light disconnected B", 90_000, async () => {
        const peers = await light.get_peers();
        return peers.length === 0 && peers;
      });
      assert.deepEqual(noPeers, [], "[5] 轻客户端：B 离线后应无 peer");
      const retained = await light.get_header(hHash);
      assert.deepEqual(retained, bHeader, "[5] 轻客户端：离线后 H 应保持完整一致");
    });
  });

  // TEST-MAP: LC-RETRY-04
  it("LC-RETRY-04 A 离线后同链 B 接替并完成交易", async () => {
    // 1. 启动同创世 A、B 和只连接 A 的轻客户端，并正常互联全节点。
    // 2. A 创建确认 T 并挖后续块，B 与轻端跟上且轻端未缓存 T。
    // 3. 优雅停 A，在无 peer 时只登记一次 T，确认 added。
    // 4. B 正常挖新块并连接轻端，确认 B 唯一且已证明，仅读到完整已提交 T。
    await withNodeWorkspace("LC-RETRY-04", async run => {
      // 1. 启动同创世 A、B 和只连接 A 的轻客户端，并正常互联全节点。
      const a = run.startCkbNode("A");
      let b = run.startCkbNode("B");
      await until("A RPC", 90_000, () => a.get_tip_header());
      await until("B RPC", 90_000, () => b.get_tip_header());
      const genesisA = await a.get_block_by_number("0x0");
      const genesisB = await b.get_block_by_number("0x0");
      assert.equal(genesisB.header.hash, genesisA.header.hash, "[1] B：创世哈希应与 A 相同");
      const idA = (await a.local_node_info()).node_id;
      const idB = (await b.local_node_info()).node_id;
      await run.stopCkbNode("B");
      const light = run.startLightClient({ bootnodes: [{ node: "A", nodeId: idA }, { node: "B", nodeId: idB }] });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesisA.header.hash, "[1] 轻客户端：创世哈希应与 A/B 相同");
      const initialPeers = await until("light connected A", SYNC_MS, async () => {
        const peers = await light.get_peers();
        return peerIds(peers).includes(idA) && peers;
      });
      assert.deepEqual(peerIds(initialPeers), [idA], "[1] 轻客户端：起初应只连接 A");
      b = run.startCkbNode("B");
      await until("restarted B RPC", 90_000, () => b.get_tip_header());
      await b.add_node(idA, run.p2pAddress("A"));

      // 2. A 创建确认 T 并挖后续块，B 与轻端跟上且轻端未缓存 T。
      run.report.stage = "prepare_same_chain_transaction";
      const { chainConfig, genesisCell } = devFunding(genesisA, run.funder);
      const t = await buildCreation(genesisCell, run.funder, run.watched, chainConfig);
      const submitted = await a.send_transaction(t.raw);
      assert.equal(submitted, t.hash, "[2] A：提交 T 应返回本地哈希");
      const confirmed = await until("T committed", SYNC_MS, async () => {
        await a.generate_block();
        const value = await a.get_transaction(t.hash);
        return value?.tx_status?.status === "committed" && value;
      });
      const block = await a.get_block(confirmed.tx_status.block_hash);
      const canonical = await a.get_block_hash(block.header.number);
      assert.equal(canonical, confirmed.tx_status.block_hash, "[2] A：T 应属于主链块");
      assert.ok(block.transactions.some((row: any) => row.hash === t.hash), "[2] A：确认块应包含 T");
      for (let i = 0; i < HISTORY; i++) await a.generate_block();
      const oldTip = await a.get_tip_header();
      await until("B accepted A tip", SYNC_MS, async () => {
        const tip = await b.get_tip_header();
        return tip.hash === oldTip.hash && tip;
      });
      const bTx = await b.get_transaction(t.hash);
      assert.deepEqual(bTx.transaction, confirmed.transaction, "[2] B：同链 T 的交易体应与 A 一致");
      assert.equal(bTx.tx_status.block_hash, canonical, "[2] B：T 的提交块应与 A 一致");
      await until("light accepted A tip", SYNC_MS, async () => {
        const tip = await light.get_tip_header();
        return tip.hash === oldTip.hash && tip;
      });
      const before = await light.get_transaction(t.hash);
      assert.equal(txBody(before), null, "[2] 轻客户端：T 应尚无交易体");
      assert.equal(before.tx_status.status, "unknown", "[2] 轻客户端：T 应尚未知晓");
      run.report.target = { hash: t.hash, block_hash: canonical, old_tip: oldTip.hash };

      // 3. 优雅停 A，在无 peer 时只登记一次 T，确认 added。
      await run.stopCkbNode("B");
      await run.stopCkbNode("A");
      const offlinePeers = await until("light disconnected A", 90_000, async () => {
        const peers = await light.get_peers();
        return peers.length === 0 && peers;
      });
      assert.deepEqual(offlinePeers, [], "[3] 轻客户端：A 离线后应无 peer");
      const registered = await light.fetch_transaction(t.hash);
      assert.equal(registered.status, "added", "[3] 轻客户端：唯一一次 fetch 应登记 T");

      // 4. B 正常挖新块并连接轻端，确认 B 唯一且已证明，仅读到完整已提交 T。
      const restoreBNetwork = isolateNodeNetwork(run.report.rpc_trace!, "B");
      b = run.startCkbNode("B");
      await until("isolated B RPC", 90_000, () => b.get_tip_header());
      await b.generate_block();
      const newTip = await b.get_tip_header();
      const beforeReconnect = await light.get_peers();
      assert.deepEqual(beforeReconnect, [], "[4] 轻客户端：B 挖出新 tip 前应保持无 peer");
      await run.stopCkbNode("B");
      restoreBNetwork();
      b = run.startCkbNode("B");
      await until("restarted B RPC", 90_000, () => b.get_tip_header());
      const provedPeers = await until("B proved new tip", SYNC_MS, async () => {
        const peers = await light.get_peers();
        return peers.length === 1 && peers[0].node_id === idB
          && peers[0].sync_state?.proved_best_known_header?.hash === newTip.hash && peers;
      });
      assert.deepEqual(peerIds(provedPeers), [idB], "[4] 轻客户端：唯一已证明 peer 应为 B");
      const recovered = await until("T recovered via B", FETCH_MS, async () => {
        const value = await light.get_transaction(t.hash);
        return value?.transaction && value?.tx_status?.status === "committed" && value;
      });
      assert.deepEqual(recovered.transaction, bTx.transaction, "[4] 轻客户端：T 完整交易体应与 B 一致");
      assert.equal(recovered.tx_status.block_hash, canonical, "[4] 轻客户端：T 提交块应等于 B 主链块");
    });
  });

  // TEST-MAP: LC-RETRY-05
  it("LC-RETRY-05 换到较重分叉后共同前缀区块头继续完成", async () => {
    // 1. 启动同创世 A、B 和只连接 A 的轻客户端，先同步共同前缀。
    // 2. 断开 A/B 并分别正常挖出两条有效分叉，确认 B 较重、轻端已接受 A，且 H 未缓存。
    // 3. 优雅停 A，在无 peer 时仅登记共同前缀 H，确认 added。
    // 4. 只让 B 连接轻端，确认公开 tip 切至 B，仅读到与 B 相同的完整 H。
    // 5. 优雅停 B，确认 H 仍保留。
    await withNodeWorkspace("LC-RETRY-05", async run => {
      // 1. 启动同创世 A、B 和只连接 A 的轻客户端，先同步共同前缀。
      const a = run.startCkbNode("A");
      let b = run.startCkbNode("B");
      await until("A RPC", 90_000, () => a.get_tip_header());
      await until("B RPC", 90_000, () => b.get_tip_header());
      const genesisA = await a.get_block_by_number("0x0");
      const genesisB = await b.get_block_by_number("0x0");
      assert.equal(genesisB.header.hash, genesisA.header.hash, "[1] B：创世哈希应与 A 相同");
      const idA = (await a.local_node_info()).node_id;
      const idB = (await b.local_node_info()).node_id;
      await run.stopCkbNode("B");
      const light = run.startLightClient({ bootnodes: [{ node: "A", nodeId: idA }, { node: "B", nodeId: idB }] });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesisA.header.hash, "[1] 轻客户端：创世哈希应与 A/B 相同");
      const initialPeers = await until("light connected A", SYNC_MS, async () => {
        const peers = await light.get_peers();
        return peerIds(peers).includes(idA) && peers;
      });
      assert.deepEqual(peerIds(initialPeers), [idA], "[1] 轻客户端：起初应只连接 A");
      b = run.startCkbNode("B");
      await until("restarted B RPC", 90_000, () => b.get_tip_header());
      await b.add_node(idA, run.p2pAddress("A"));
      await a.generate_block();
      const hHash = await a.get_block_hash("0x1");
      for (let i = 0; i < HISTORY; i++) await a.generate_block();
      const fork = await a.get_tip_header();
      await until("B accepted common prefix", SYNC_MS, async () => {
        const tip = await b.get_tip_header();
        return tip.hash === fork.hash && tip;
      });
      const commonB = await b.get_block_hash(fork.number);
      assert.equal(commonB, fork.hash, "[1] B：分叉前两节点应有同一祖先");
      await until("light accepted common prefix", SYNC_MS, async () => {
        const tip = await light.get_tip_header();
        return tip.hash === fork.hash && tip;
      });

      // 2. 断开 A/B 并分别正常挖出两条有效分叉，确认 B 较重、轻端已接受 A，且 H 未缓存。
      run.report.stage = "normal_fork";
      await a.remove_node(idB);
      await b.remove_node(idA);
      await run.stopCkbNode("B");
      const restoreBNetwork = isolateNodeNetwork(run.report.rpc_trace!, "B");
      b = run.startCkbNode("B");
      await until("isolated B RPC", 90_000, () => b.get_tip_header());
      await until("A and B disconnected", 90_000, async () => {
        const peersA = await a.get_peers();
        const peersB = await b.get_peers();
        return !peerIds(peersA).includes(idB) && !peerIds(peersB).includes(idA);
      });
      const { chainConfig, genesisCell } = devFunding(genesisA, run.funder);
      const forkTx = await buildCreation(genesisCell, run.funder, run.newAccount(), chainConfig);
      const forkSubmitted = await a.send_transaction(forkTx.raw);
      assert.equal(forkSubmitted, forkTx.hash, "[2] A：分叉专属交易应只向 A 提交");
      const forkConfirmed = await until("A-only transaction committed", SYNC_MS, async () => {
        await a.generate_block();
        const value = await a.get_transaction(forkTx.hash);
        return value?.tx_status?.status === "committed" && value;
      });
      const forkBlock = await a.get_block(forkConfirmed.tx_status.block_hash);
      assert.ok(forkBlock.transactions.some((row: any) => row.hash === forkTx.hash), "[2] A：分叉专属交易应进入 A 的块");
      await a.generate_block();
      const aTip = await a.get_tip_header();
      await until("light accepted A branch", SYNC_MS, async () => {
        const tip = await light.get_tip_header();
        return tip.hash === aTip.hash && tip;
      });
      const bBlocks = Number(BigInt(aTip.number) - BigInt(fork.number) + 2n);
      for (let i = 0; i < bBlocks; i++) await b.generate_block();
      const bTip = await b.get_tip_header();
      const aNext = await a.get_block_hash(hex(BigInt(fork.number) + 1n));
      const bNext = await b.get_block_hash(hex(BigInt(fork.number) + 1n));
      const bAtATip = await b.get_block_hash(aTip.number);
      assert.notEqual(bAtATip, aTip.hash, "[2] A/B：A 的分叉专属交易确认后，两链同高度哈希应不同");
      let workA = 0n;
      for (let n = BigInt(fork.number) + 1n; n <= BigInt(aTip.number); n++) {
        const head = await a.get_header_by_number(hex(n));
        assert.ok(head, `[2] A：分叉高度 ${n} 应有主链头`);
        workA += blockWork(head.compact_target);
      }
      let workB = 0n;
      for (let n = BigInt(fork.number) + 1n; n <= BigInt(bTip.number); n++) {
        const head = await b.get_header_by_number(hex(n));
        assert.ok(head, `[2] B：分叉高度 ${n} 应有主链头`);
        workB += blockWork(head.compact_target);
      }
      assert.ok(workB > workA, `[2] B：分叉段累计工作量应高于 A，实测 A=${workA}、B=${workB}`);
      const before = await light.get_header(hHash);
      assert.equal(before, null, "[2] 轻客户端：共同前缀 H 应尚未缓存");
      const expected = await b.get_header(hHash);
      run.report.fork = { ancestor: fork.hash, a_tip: aTip.hash, b_tip: bTip.hash, b_at_a_tip: bAtATip, a_next: aNext, b_next: bNext, work_a: String(workA), work_b: String(workB) };
      await run.stopCkbNode("B");
      restoreBNetwork();

      // 3. 优雅停 A，在无 peer 时仅登记共同前缀 H，确认 added。
      await run.stopCkbNode("A");
      const offlinePeers = await until("light disconnected A", 90_000, async () => {
        const peers = await light.get_peers();
        return peers.length === 0 && peers;
      });
      assert.deepEqual(offlinePeers, [], "[3] 轻客户端：A 离线后应无 peer");
      const registered = await light.fetch_header(hHash);
      assert.equal(registered.status, "added", "[3] 轻客户端：唯一一次 fetch 应登记 H");

      // 4. 只让 B 连接轻端，确认公开 tip 切至 B，仅读到与 B 相同的完整 H。
      b = run.startCkbNode("B");
      await until("restarted B RPC", 90_000, () => b.get_tip_header());
      const provedPeers = await until("B proved heavier branch", SYNC_MS, async () => {
        const peers = await light.get_peers();
        return peers.length === 1 && peers[0].node_id === idB
          && peers[0].sync_state?.proved_best_known_header?.hash === bTip.hash && peers;
      });
      assert.deepEqual(peerIds(provedPeers), [idB], "[4] 轻客户端：新链唯一已证明 peer 应为 B");
      const adopted = await until("light adopted B branch", SYNC_MS, async () => {
        const tip = await light.get_tip_header();
        return tip.hash === bTip.hash && tip;
      });
      assert.equal(adopted.hash, bTip.hash, "[4] 轻客户端：公开 tip 应切至 B 的较重分叉");
      const canonical = await b.get_block_hash(expected.number);
      assert.equal(canonical, hHash, "[4] B：H 应仍在新主链共同前缀");
      const recovered = await until("H recovered after reorg", FETCH_MS, async () => light.get_header(hHash));
      assert.deepEqual(recovered, expected, "[4] 轻客户端：H 完整头应与 B 主链一致");

      // 5. 优雅停 B，确认 H 仍保留。
      await run.stopCkbNode("B");
      const noPeers = await until("light disconnected B", 90_000, async () => {
        const peers = await light.get_peers();
        return peers.length === 0 && peers;
      });
      assert.deepEqual(noPeers, [], "[5] 轻客户端：B 离线后应无 peer");
      const retained = await light.get_header(hHash);
      assert.deepEqual(retained, expected, "[5] 轻客户端：B 离线后应保留同一完整 H");
    });
  });

  // TEST-MAP: LC-RETRY-06
  it("LC-RETRY-06 换到较重分叉后共同前缀交易继续完成", async () => {
    // 1. 启动同创世 A、B 和只连接 A 的轻客户端，在共同前缀创建确认 T。
    // 2. 分离 A/B 并分别挖出不同的有效链，确认 B 较重、轻端先接受 A，且 T 未缓存。
    // 3. 优雅停 A，在无 peer 时仅登记共同前缀 T，确认 added。
    // 4. 只让 B 连接轻端，确认公开 tip 切至 B，仅读到完整已提交 T。
    await withNodeWorkspace("LC-RETRY-06", async run => {
      // 1. 启动同创世 A、B 和只连接 A 的轻客户端，在共同前缀创建确认 T。
      const a = run.startCkbNode("A");
      let b = run.startCkbNode("B");
      await until("A RPC", 90_000, () => a.get_tip_header());
      await until("B RPC", 90_000, () => b.get_tip_header());
      const genesisA = await a.get_block_by_number("0x0");
      const genesisB = await b.get_block_by_number("0x0");
      assert.equal(genesisB.header.hash, genesisA.header.hash, "[1] B：创世哈希应与 A 相同");
      const idA = (await a.local_node_info()).node_id;
      const idB = (await b.local_node_info()).node_id;
      await run.stopCkbNode("B");
      const light = run.startLightClient({ bootnodes: [{ node: "A", nodeId: idA }, { node: "B", nodeId: idB }] });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesisA.header.hash, "[1] 轻客户端：创世哈希应与 A/B 相同");
      const initialPeers = await until("light connected A", SYNC_MS, async () => {
        const peers = await light.get_peers();
        return peerIds(peers).includes(idA) && peers;
      });
      assert.deepEqual(peerIds(initialPeers), [idA], "[1] 轻客户端：起初应只连接 A");
      b = run.startCkbNode("B");
      await until("restarted B RPC", 90_000, () => b.get_tip_header());
      await b.add_node(idA, run.p2pAddress("A"));
      const { chainConfig, genesisCell } = devFunding(genesisA, run.funder);
      const t = await buildCreation(genesisCell, run.funder, run.watched, chainConfig);
      const submitted = await a.send_transaction(t.raw);
      assert.equal(submitted, t.hash, "[1] A：提交共同前缀 T 应返回本地哈希");
      const confirmed = await until("T committed", SYNC_MS, async () => {
        await a.generate_block();
        const value = await a.get_transaction(t.hash);
        return value?.tx_status?.status === "committed" && value;
      });
      const block = await a.get_block(confirmed.tx_status.block_hash);
      const canonical = await a.get_block_hash(block.header.number);
      assert.equal(canonical, confirmed.tx_status.block_hash, "[1] A：T 应属于共同前缀主链块");
      assert.ok(block.transactions.some((row: any) => row.hash === t.hash), "[1] A：确认块应包含 T");
      for (let i = 0; i < HISTORY; i++) await a.generate_block();
      const fork = await a.get_tip_header();
      await until("B accepted common prefix", SYNC_MS, async () => {
        const tip = await b.get_tip_header();
        return tip.hash === fork.hash && tip;
      });
      const bTx = await b.get_transaction(t.hash);
      assert.deepEqual(bTx.transaction, confirmed.transaction, "[1] B：共同前缀 T 应有相同交易体");
      assert.equal(bTx.tx_status.block_hash, canonical, "[1] B：共同前缀 T 应在同一块");
      await until("light accepted common prefix", SYNC_MS, async () => {
        const tip = await light.get_tip_header();
        return tip.hash === fork.hash && tip;
      });

      // 2. 分离 A/B 并分别挖出不同的有效链，确认 B 较重、轻端先接受 A，且 T 未缓存。
      run.report.stage = "normal_fork";
      await a.remove_node(idB);
      await b.remove_node(idA);
      await run.stopCkbNode("B");
      const restoreBNetwork = isolateNodeNetwork(run.report.rpc_trace!, "B");
      b = run.startCkbNode("B");
      await until("isolated B RPC", 90_000, () => b.get_tip_header());
      await until("A and B disconnected", 90_000, async () => {
        const peersA = await a.get_peers();
        const peersB = await b.get_peers();
        return !peerIds(peersA).includes(idB) && !peerIds(peersB).includes(idA);
      });
      const forkTx = await buildCreation(t.change, run.funder, run.newAccount(), chainConfig);
      const forkSubmitted = await a.send_transaction(forkTx.raw);
      assert.equal(forkSubmitted, forkTx.hash, "[2] A：分叉专属交易应只向 A 提交");
      const forkConfirmed = await until("A-only transaction committed", SYNC_MS, async () => {
        await a.generate_block();
        const value = await a.get_transaction(forkTx.hash);
        return value?.tx_status?.status === "committed" && value;
      });
      const forkBlock = await a.get_block(forkConfirmed.tx_status.block_hash);
      assert.ok(forkBlock.transactions.some((row: any) => row.hash === forkTx.hash), "[2] A：分叉专属交易应进入 A 的块");
      await a.generate_block();
      const aTip = await a.get_tip_header();
      await until("light accepted A branch", SYNC_MS, async () => {
        const tip = await light.get_tip_header();
        return tip.hash === aTip.hash && tip;
      });
      const bBlocks = Number(BigInt(aTip.number) - BigInt(fork.number) + 2n);
      for (let i = 0; i < bBlocks; i++) await b.generate_block();
      const bTip = await b.get_tip_header();
      const aNext = await a.get_block_hash(hex(BigInt(fork.number) + 1n));
      const bNext = await b.get_block_hash(hex(BigInt(fork.number) + 1n));
      const bAtATip = await b.get_block_hash(aTip.number);
      assert.notEqual(bAtATip, aTip.hash, "[2] A/B：A 的分叉专属交易确认后，两链同高度哈希应不同");
      let workA = 0n;
      for (let n = BigInt(fork.number) + 1n; n <= BigInt(aTip.number); n++) {
        const head = await a.get_header_by_number(hex(n));
        assert.ok(head, `[2] A：分叉高度 ${n} 应有主链头`);
        workA += blockWork(head.compact_target);
      }
      let workB = 0n;
      for (let n = BigInt(fork.number) + 1n; n <= BigInt(bTip.number); n++) {
        const head = await b.get_header_by_number(hex(n));
        assert.ok(head, `[2] B：分叉高度 ${n} 应有主链头`);
        workB += blockWork(head.compact_target);
      }
      assert.ok(workB > workA, `[2] B：分叉段累计工作量应高于 A，实测 A=${workA}、B=${workB}`);
      const before = await light.get_transaction(t.hash);
      assert.equal(txBody(before), null, "[2] 轻客户端：T 应尚无交易体");
      assert.equal(before.tx_status.status, "unknown", "[2] 轻客户端：T 应尚未知晓");
      run.report.fork = { ancestor: fork.hash, a_tip: aTip.hash, b_tip: bTip.hash, b_at_a_tip: bAtATip, a_next: aNext, b_next: bNext, work_a: String(workA), work_b: String(workB) };
      await run.stopCkbNode("B");
      restoreBNetwork();

      // 3. 优雅停 A，在无 peer 时仅登记共同前缀 T，确认 added。
      await run.stopCkbNode("A");
      const offlinePeers = await until("light disconnected A", 90_000, async () => {
        const peers = await light.get_peers();
        return peers.length === 0 && peers;
      });
      assert.deepEqual(offlinePeers, [], "[3] 轻客户端：A 离线后应无 peer");
      const registered = await light.fetch_transaction(t.hash);
      assert.equal(registered.status, "added", "[3] 轻客户端：唯一一次 fetch 应登记 T");

      // 4. 只让 B 连接轻端，确认公开 tip 切至 B，仅读到完整已提交 T。
      b = run.startCkbNode("B");
      await until("restarted B RPC", 90_000, () => b.get_tip_header());
      const provedPeers = await until("B proved heavier branch", SYNC_MS, async () => {
        const peers = await light.get_peers();
        return peers.length === 1 && peers[0].node_id === idB
          && peers[0].sync_state?.proved_best_known_header?.hash === bTip.hash && peers;
      });
      assert.deepEqual(peerIds(provedPeers), [idB], "[4] 轻客户端：新链唯一已证明 peer 应为 B");
      const adopted = await until("light adopted B branch", SYNC_MS, async () => {
        const tip = await light.get_tip_header();
        return tip.hash === bTip.hash && tip;
      });
      assert.equal(adopted.hash, bTip.hash, "[4] 轻客户端：公开 tip 应切至 B 的较重分叉");
      const bCanonical = await b.get_block_hash(block.header.number);
      assert.equal(bCanonical, canonical, "[4] B：T 的块应仍在新主链共同前缀");
      const recovered = await until("T recovered after reorg", FETCH_MS, async () => {
        const value = await light.get_transaction(t.hash);
        return value?.transaction && value?.tx_status?.status === "committed" && value;
      });
      assert.deepEqual(recovered.transaction, bTx.transaction, "[4] 轻客户端：T 的完整交易体应与 B 一致");
      assert.equal(recovered.tx_status.block_hash, canonical, "[4] 轻客户端：T 的提交块应等于 B 主链块");
    });
  });

  // TEST-MAP: LC-RETRY-07
  it("LC-RETRY-07 真实查无后上链的交易可公开重查取得", async () => {
    // 1. 启动 A 与只连接 A 的轻客户端，准备未广播的交易 U 并确认全节点未知。
    // 2. 轻端对 U 发起取证，在已证明的健康 peer 下见到真实 not_found 和空交易体。
    // 3. 经 A 提交原 U 并挖块确认，再挖后继块，确认轻端 tip 和 peer 证明均已更新。
    // 4. 轻端以原哈希公开重查，最终取得与 A 主链一致的完整已提交 U。
    await withNodeWorkspace("LC-RETRY-07", async run => {
      // 1. 启动 A 与只连接 A 的轻客户端，准备未广播的交易 U 并确认全节点未知。
      const a = run.startCkbNode("A");
      await until("A RPC", 90_000, () => a.get_tip_header());
      const genesis = await a.get_block_by_number("0x0");
      const idA = (await a.local_node_info()).node_id;
      const light = run.startLightClient({ bootnodeId: idA });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[1] 轻客户端：创世哈希应与 A 相同");
      const initialPeers = await until("light connected A", SYNC_MS, async () => {
        const peers = await light.get_peers();
        return peerIds(peers).includes(idA) && peers;
      });
      assert.deepEqual(peerIds(initialPeers), [idA], "[1] 轻客户端：唯一 peer 应为 A");
      const { chainConfig, genesisCell } = devFunding(genesis, run.funder);
      const u = await buildCreation(genesisCell, run.funder, run.watched, chainConfig);
      const unknown = await a.get_transaction(u.hash);
      assert.equal(unknown.tx_status.status, "unknown", "[1] A：未广播的 U 应未知");
      const before = await light.get_transaction(u.hash);
      assert.equal(txBody(before), null, "[1] 轻客户端：未广播的 U 应无交易体");
      run.report.target = { hash: u.hash };

      // 2. 轻端对 U 发起取证，在已证明的健康 peer 下见到真实 not_found 和空交易体。
      run.report.stage = "negative_proof";
      for (let i = 0; i < HISTORY; i++) await a.generate_block();
      const oldTip = await a.get_tip_header();
      await until("light proved old tip", SYNC_MS, async () => {
        const peers = await light.get_peers();
        return peers.length === 1 && peers[0].node_id === idA
          && peers[0].sync_state?.proved_best_known_header?.hash === oldTip.hash && peers;
      });
      const missing = await until("U really not found", 180_000, async () => {
        const status = await light.fetch_transaction(u.hash);
        return status.status === "not_found" && status;
      }, Error);
      assert.equal(missing.status, "not_found", "[2] 轻客户端：健康 peer 应报告 U 查无");
      const stillUnknown = await light.get_transaction(u.hash);
      assert.equal(txBody(stillUnknown), null, "[2] 轻客户端：查无后 U 仍无交易体");
      const fullUnknown = await a.get_transaction(u.hash);
      assert.equal(fullUnknown.tx_status.status, "unknown", "[2] A：首次查无时 U 仍未广播");

      // 3. 经 A 提交原 U 并挖块确认，再挖后继块，确认轻端 tip 和 peer 证明均已更新。
      run.report.stage = "confirm_U";
      const submitted = await a.send_transaction(u.raw);
      assert.equal(submitted, u.hash, "[3] A：提交应保持原 U 哈希");
      const confirmed = await until("U committed", SYNC_MS, async () => {
        await a.generate_block();
        const value = await a.get_transaction(u.hash);
        return value?.tx_status?.status === "committed" && value;
      });
      const block = await a.get_block(confirmed.tx_status.block_hash);
      const canonical = await a.get_block_hash(block.header.number);
      assert.equal(canonical, confirmed.tx_status.block_hash, "[3] A：U 应属于该高度主链块");
      assert.ok(block.transactions.some((row: any) => row.hash === u.hash), "[3] A：确认块应包含 U");
      await a.generate_block();
      const newTip = await a.get_tip_header();
      assert.ok(BigInt(newTip.number) > BigInt(block.header.number), "[3] A：新 tip 应严格高于 U 的确认块");
      const provedPeers = await until("light proved U successor", SYNC_MS, async () => {
        const peers = await light.get_peers();
        return peers.length === 1 && peers[0].node_id === idA
          && peers[0].sync_state?.proved_best_known_header?.hash === newTip.hash && peers;
      });
      assert.deepEqual(peerIds(provedPeers), [idA], "[3] 轻客户端：唯一 peer 应证明 U 后继主链头");
      const adopted = await until("light adopted U successor", SYNC_MS, async () => {
        const tip = await light.get_tip_header();
        return tip.hash === newTip.hash && tip;
      });
      assert.equal(adopted.hash, newTip.hash, "[3] 轻客户端：tip 应追上 U 的后继主链头");

      // 4. 轻端以原哈希公开重查，最终取得与 A 主链一致的完整已提交 U。
      run.report.stage = "refetch_U";
      const fetched = await until("U fetched after confirmation", 180_000, async () => {
        const status = await light.fetch_transaction(u.hash);
        return status.status === "fetched" && status;
      }, Error);
      assert.equal(fetched.status, "fetched", "[4] 轻客户端：上链后的原 U 应可取得");
      assert.deepEqual(fetched.data.transaction, confirmed.transaction, "[4] 轻客户端：U 完整交易体应等于 A 的确认交易");
      assert.equal(fetched.data.tx_status.status, "committed", "[4] 轻客户端：U 应为已提交");
      assert.equal(fetched.data.tx_status.block_hash, canonical, "[4] 轻客户端：U 的提交块应为 A 主链块");
    });
  });
});
