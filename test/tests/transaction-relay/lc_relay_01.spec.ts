// TEST-MAP: LC-RELAY-01
import assert from "node:assert/strict";
import {
  buildCreation, buildSpend, CKB, committedIn, coversHeight, devFunding, FEE,
  hex, outPoints, rpc, scriptHeight, until, untilCommitted, withNodeWorkspace,
} from "../lc_store_support";

const CASE_ID = "LC-RELAY-01";
const SEARCH_LIMIT = "0x20";

describe(CASE_ID, function () {
  this.timeout(1_200_000);

  it("轻端单次提交后，全节点先入池再入规范块，轻端索引同一新输出", async () => {
    // 1. 启动一台隔离 dev CKB 和只连接它的一台轻客户端，确认创世与唯一 peer。
    // 2. 全节点创建受监控的可花费 cell 并挖块，轻端追上该交易且索引同一 out point。
    // 3. 停止出块，构造签名交易并确认全节点此前未知该 hash，仅向轻端提交一次。
    // 4. 保持停挖，确认全节点交易池及 pending/proposed 查询实际收到同一笔交易。
    // 5. 正常挖块，确认全节点交易位于规范链区块且新输出为活 cell。
    // 6. 等轻端脚本索引追上确认块，核对同 hash、同块及精确新输出。

    await withNodeWorkspace(CASE_ID, async run => {
      const { report, funder, watched } = run;

      // 1. 启动一台隔离 dev CKB 和只连接它的一台轻客户端，确认创世与唯一 peer。
      report.stage = "start_and_connect";
      const ckb = run.startCkbNode();
      await until("CKB RPC", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      const { node_id: ckbId } = await ckb.local_node_info();
      const light = run.startLightClient({ bootnodeId: ckbId });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      report.genesis = genesis.header.hash;
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[1] 轻客户端：创世应与本轮 CKB 相同");
      const peers = await until("light connected to sole CKB", 90_000, async () => {
        const ids = (await light.get_peers()).map(peer => peer.node_id);
        return ids.includes(ckbId) && ids;
      });
      assert.deepEqual(peers, [ckbId], "[1] 轻客户端：唯一 peer 应为本轮 CKB");

      // 2. 全节点创建受监控的可花费 cell 并挖块，轻端追上该交易且索引同一 out point。
      report.stage = "create_watched_cell";
      const { chainConfig, genesisCell } = devFunding(genesis, funder);
      const creation = await buildCreation(genesisCell, funder, watched, chainConfig);
      const creationHash = await ckb.send_transaction(creation.raw);
      assert.equal(creationHash, creation.hash, "[2] CKB：创建受监控 cell 应返回离线计算的 hash");
      const created = await untilCommitted("monitored cell creation", async () => {
        await ckb.generate_block();
        return ckb.get_transaction(creation.hash);
      });
      const creationBlock = await ckb.get_block(created.tx_status.block_hash);
      const creationCanonical = await ckb.get_block_hash(creationBlock.header.number);
      assert.equal(created.tx_status.block_hash, creationCanonical, "[2] CKB：创建交易应位于该高度规范块");
      assert.ok(creationBlock.transactions.some(tx => tx.hash === creation.hash), "[2] CKB：规范块体应包含创建交易");
      const fundingPoint = { tx_hash: creation.hash, index: "0x0" };
      const fundingCell = await ckb.get_live_cell(fundingPoint, false);
      assert.equal(fundingCell.status, "live", "[2] CKB：受监控输入应是可花费活 cell");
      const search = { script: watched.script, script_type: "lock" };
      await light.set_scripts([{ ...search, block_number: "0x0" }]);
      await until("light indexed watched funding cell", 300_000, async () => {
        const script = scriptHeight(await light.get_scripts(), watched.script);
        const tip = await light.get_tip_header();
        const tx = await light.get_transaction(creation.hash);
        report.sync_progress = { stage: "funding", script, tip: tip.hash, status: tx?.tx_status?.status };
        return tip.hash === creationCanonical && coversHeight(script, creationBlock.header.number)
          && committedIn(tx, creation.hash, creationCanonical);
      }, Error);
      const indexedFunding = await light.get_cells(search, "asc", SEARCH_LIMIT);
      assert.deepEqual(outPoints(indexedFunding.objects), [fundingPoint], "[2] 轻客户端：受监控活 cell 应恰为本轮创建的一个 out point");
      assert.equal(indexedFunding.objects[0].output.capacity, hex(100n * CKB), "[2] 轻客户端：受监控 cell 容量应等于全节点创建交易的输出");

      // 3. 停止出块，构造签名交易并确认全节点此前未知该 hash，仅向轻端提交一次。
      report.stage = "pre_submit_unknown";
      const spend = await buildSpend(indexedFunding.objects[0], watched, watched, chainConfig);
      const signedInputs = spend.raw.inputs.map(input => input.previous_output);
      assert.deepEqual(signedInputs, [fundingPoint], "[3] 签名交易：唯一输入应为本轮受监控 cell");
      report.relay_hash = spend.hash;
      report.relay_input = fundingPoint;
      const beforeTx = await ckb.get_transaction(spend.hash);
      assert.ok(beforeTx == null || beforeTx.tx_status?.status === "unknown", "[3] CKB：轻端提交前应不认识这笔新交易");
      const beforePool = await rpc(report.ports.fullRpc, "get_raw_tx_pool", [false], report, "full");
      assert.ok(![...beforePool.pending, ...beforePool.proposed].includes(spend.hash), "[3] CKB：轻端提交前交易池应无该 hash");
      const submittedHash = await rpc(report.ports.lightRpc, "send_transaction", [spend.raw], report, "light");
      assert.equal(submittedHash, spend.hash, "[3] 轻客户端：单次提交应返回离线计算的精确 hash");

      // 4. 保持停挖，确认全节点交易池及 pending/proposed 查询实际收到同一笔交易。
      report.stage = "full_pool_before_mining";
      const pooled = await until("full-node transaction pool contains relay hash", 120_000, async () => {
        const pool = await rpc(report.ports.fullRpc, "get_raw_tx_pool", [false], report, "full");
        report.pool = pool;
        return [...pool.pending, ...pool.proposed].includes(spend.hash) && pool;
      }, Error);
      assert.ok([...pooled.pending, ...pooled.proposed].includes(spend.hash), "[4] CKB：停挖时交易池应含轻端提交的精确 hash");
      const fullPending = await until("full-node transaction pending or proposed", 120_000, async () => {
        const tx = await ckb.get_transaction(spend.hash);
        return ["pending", "proposed"].includes(tx?.tx_status?.status) && tx;
      }, Error);
      assert.equal(fullPending.transaction.hash, spend.hash, "[4] CKB：池中交易应为该笔签名交易");
      assert.deepEqual(fullPending.transaction.inputs.map(input => input.previous_output), [fundingPoint], "[4] CKB：池中交易唯一输入应与签名交易一致");

      // 5. 正常挖块，确认全节点交易位于规范链区块且新输出为活 cell。
      report.stage = "mine_and_confirm";
      const confirmed = await until("full-node committed relay transaction", 180_000, async () => {
        await ckb.generate_block();
        const tx = await ckb.get_transaction(spend.hash);
        return tx?.tx_status?.status === "committed" && tx;
      }, Error);
      assert.equal(confirmed.transaction.hash, spend.hash, "[5] CKB：确认交易应是轻端单次提交的 hash");
      const block = await ckb.get_block(confirmed.tx_status.block_hash);
      const canonical = await ckb.get_block_hash(block.header.number);
      assert.equal(confirmed.tx_status.block_hash, canonical, "[5] CKB：确认块应是该高度规范块");
      assert.ok(block.transactions.some(tx => tx.hash === spend.hash), "[5] CKB：规范块体应包含该交易");
      const outputPoint = { tx_hash: spend.hash, index: "0x0" };
      const liveOutput = await ckb.get_live_cell(outputPoint, false);
      assert.equal(liveOutput.status, "live", "[5] CKB：新受监控输出应为活 cell");
      assert.equal(confirmed.transaction.outputs[0].capacity, hex(100n * CKB - FEE), "[5] CKB：新输出容量应等于签名交易预期");
      report.confirmation = { hash: spend.hash, block_hash: canonical, block_number: block.header.number, out_point: outputPoint };

      // 6. 等轻端脚本索引追上确认块，核对同 hash、同块及精确新输出。
      report.stage = "light_indexed_relay_output";
      await until("light indexed confirmed relay output", 180_000, async () => {
        const script = scriptHeight(await light.get_scripts(), watched.script);
        const tip = await light.get_tip_header();
        const tx = await light.get_transaction(spend.hash);
        report.sync_progress = { stage: "relay", script, tip: tip.hash, status: tx?.tx_status?.status };
        return tip.hash === canonical && coversHeight(script, block.header.number)
          && committedIn(tx, spend.hash, canonical);
      }, Error);
      const lightTx = await light.get_transaction(spend.hash);
      assert.equal(lightTx.transaction.hash, spend.hash, "[6] 轻客户端：确认交易应与全节点精确同 hash");
      assert.equal(lightTx.tx_status.status, "committed", "[6] 轻客户端：该交易应已确认");
      assert.equal(lightTx.tx_status.block_hash, canonical, "[6] 轻客户端：确认块应与全节点规范块相同");
      const indexedOutput = await light.get_cells(search, "asc", SEARCH_LIMIT);
      assert.deepEqual(outPoints(indexedOutput.objects), [outputPoint], "[6] 轻客户端：已索引的受监控活 cell 应恰为新输出");
      assert.equal(indexedOutput.objects[0].output.capacity, confirmed.transaction.outputs[0].capacity,
        "[6] 轻客户端：新输出容量应与全节点确认交易一致");
    });
  });
});
