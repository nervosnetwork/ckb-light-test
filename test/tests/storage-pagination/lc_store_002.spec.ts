// TEST-MAP: LC-STORE-002
import assert from "node:assert/strict";
import {
  buildCreation, committedIn, coversHeight, devFunding, hex, outPoints,
  recordConfirmation, scriptHeight, until, untilCommitted, withNodeWorkspace,
} from "../lc_store_support";

const ID = "LC-STORE-002";
const ALL = "0x40";
const rows = (page: any) => page.objects.map((r: any) => ({ hash: r.tx_hash || r.transaction?.hash,
  block: r.block_number, txIndex: r.tx_index, ioType: r.io_type, ioIndex: r.io_index }));

describe(ID, function () {
  this.timeout(1_800_000);
  it("同库优雅重启后离线保留 tip 与索引，回连后继续同步新交易", async () => {
    // 1. 启动 1 个隔离 dev 全节点和只连接它的 1 个轻客户端。
    // 2. 创建并确认 A、B，等双方索引目标脚本，保存 H/hash、活集和历史。
    // 3. 优雅停轻客户端与全节点，用同库先重启轻客户端；无 peer 时数据仍等于快照。
    // 4. 同库重启全节点并正常创建 C；回连后 tip、活集与历史追上 CKB。
    await withNodeWorkspace(ID, async run => {
      // 1. 启动 1 个隔离 dev 全节点和只连接它的 1 个轻客户端。
      let ckb = run.startCkbNode();
      await until("CKB RPC", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      const { node_id: ckbId } = await ckb.local_node_info();
      let light = run.startLightClient({ bootnodeId: ckbId });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      const { funder, watched, report } = run;
      report.genesis = genesis.header.hash;
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[1] 轻客户端：创世哈希应等于本轮 CKB");
      const peerIds = await until("light connected to CKB", 90_000, async () => {
        const ids = (await light.get_peers()).map(p => p.node_id);
        return ids.includes(ckbId) && ids;
      });
      assert.deepEqual(peerIds, [ckbId], "[1] 轻客户端：唯一连接应为本轮 CKB");

      // 2. 创建并确认 A、B，等双方索引目标脚本，保存 H/hash、活集和历史。
      report.stage = "snapshot_H";
      const search = { script: watched.script, script_type: "lock" };
      const { chainConfig, genesisCell } = devFunding(genesis, funder);
      let funding = genesisCell;
      const created: any[] = [];
      for (const label of ["A", "B"]) {
        const tx = await buildCreation(funding, funder, watched, chainConfig);
        const submitted = await ckb.send_transaction(tx.raw);
        assert.equal(submitted, tx.hash, `[2] CKB：${label} 提交应返回签名哈希`);
        const receipt = await untilCommitted(label, async () => {
          await ckb.generate_block();
          return ckb.get_transaction(tx.hash);
        });
        const block = await ckb.get_block(receipt.tx_status.block_hash);
        const canonical = await ckb.get_block_hash(block.header.number);
        assert.equal(receipt.tx_status.block_hash, canonical, `[2] CKB：${label} 应在主链确认`);
        const i = block.transactions.findIndex(t => t.hash === tx.hash);
        assert.ok(i > 0, `[2] CKB：${label} 应位于 cellbase 之后，实际交易序号 ${i}`);
        created.push({ label, out_point: { tx_hash: tx.hash, index: "0x0" }, block_hash: canonical,
          block_number: block.header.number, tx_index: hex(BigInt(i)) });
        recordConfirmation(report, label, tx.hash, block);
        funding = tx.change;
      }
      report.created = created;
      const [A, B] = outPoints(created);
      await light.set_scripts([{ ...search, block_number: "0x0" }]);
      const H = await ckb.get_tip_header();
      await until("CKB indexer at H", 300_000, async () => {
        const tip = await ckb.get_indexer_tip();
        return tip?.block_hash === H.hash && coversHeight(tip.block_number, H.number);
      });
      const fullCellsH = await ckb.get_cells(search, "asc", ALL);
      const fullTxH = await ckb.get_transactions({ ...search, group_by_transaction: false }, "asc", ALL);
      assert.deepEqual(outPoints(fullCellsH.objects), [A, B], "[2] CKB：H 时监控活集应恰好为 A、B");
      assert.deepEqual(rows(fullTxH).map(r => r.hash), [A.tx_hash, B.tx_hash], "[2] CKB：H 时历史应包含 A、B 的创建交易");
      await until("light indexed B at H", 600_000, async () => {
        const height = scriptHeight(await light.get_scripts(), watched.script);
        const tip = await light.get_tip_header();
        const tx = await light.get_transaction(B.tx_hash);
        report.sync_progress = { stage: "H", height, tip: tip.hash, B: tx?.tx_status?.status };
        return tip.hash === H.hash && coversHeight(height, created[1].block_number)
          && committedIn(tx, B.tx_hash, created[1].block_hash);
      }, Error);
      const lightCellsH = await light.get_cells(search, "asc", ALL);
      const lightTxH = await light.get_transactions({ ...search, group_by_transaction: false }, "asc", ALL);
      assert.deepEqual(outPoints(lightCellsH.objects), outPoints(fullCellsH.objects), "[2] 轻客户端：H 时活集应与 CKB 一致");
      assert.deepEqual(rows(lightTxH), rows(fullTxH), "[2] 轻客户端：H 时历史应与 CKB 一致");
      report.snapshot = { H: { number: H.number, hash: H.hash }, cells: outPoints(fullCellsH.objects), history: rows(fullTxH) };

      // 3. 优雅停轻客户端与全节点，用同库先重启轻客户端；无 peer 时数据仍等于快照。
      report.stage = "offline_restart";
      await run.stopLightClient();
      await run.stopCkbNode();
      light = run.startLightClient({ bootnodeId: ckbId });
      await until("restarted light RPC", 90_000, () => light.get_genesis_block());
      const offlinePeers = await light.get_peers();
      assert.deepEqual(offlinePeers, [], "[3] 轻客户端：CKB 离线时不应有 peer");
      const offlineTip = await light.get_tip_header();
      assert.deepEqual({ number: offlineTip.number, hash: offlineTip.hash },
        { number: H.number, hash: H.hash }, "[3] 轻客户端：离线同库重启应保留 H 高度和哈希");
      const offlineScripts = await light.get_scripts();
      const offlineHeight = scriptHeight(offlineScripts, watched.script);
      assert.ok(coversHeight(offlineHeight, created[1].block_number),
        `[3] 轻客户端：离线重启后监控脚本应覆盖 B，高度为 ${offlineHeight}`);
      const offlineCells = await light.get_cells(search, "asc", ALL);
      assert.deepEqual(outPoints(offlineCells.objects), outPoints(fullCellsH.objects), "[3] 轻客户端：离线重启后活集应与 H 快照逐项相同");
      const offlineTx = await light.get_transactions({ ...search, group_by_transaction: false }, "asc", ALL);
      assert.deepEqual(rows(offlineTx), rows(fullTxH), "[3] 轻客户端：离线重启后历史应与 H 快照逐项相同");

      // 4. 同库重启全节点并正常创建 C；回连后 tip、活集与历史追上 CKB。
      report.stage = "resume_C";
      ckb = run.startCkbNode();
      await until("restarted CKB RPC", 90_000, () => ckb.get_tip_header());
      const resumedCkbTip = await ckb.get_tip_header();
      assert.deepEqual({ number: resumedCkbTip.number, hash: resumedCkbTip.hash },
        { number: H.number, hash: H.hash }, "[4] CKB：同库重启应保持 H 主链头");
      const reconnected = await until("light reconnects to CKB", 90_000, async () => {
        const ids = (await light.get_peers()).map(p => p.node_id);
        return ids.includes(ckbId) && ids;
      });
      assert.deepEqual(reconnected, [ckbId], "[4] 轻客户端：回连后唯一 peer 应仍是本轮 CKB");
      await ckb.generate_block(); // H+1 的普通新块；下面继续正常提交并确认 C。
      const newTx = await buildCreation(funding, funder, watched, chainConfig);
      const submittedC = await ckb.send_transaction(newTx.raw);
      assert.equal(submittedC, newTx.hash, "[4] CKB：新 C 应按签名哈希提交");
      const receiptC = await untilCommitted("C", async () => {
        await ckb.generate_block();
        return ckb.get_transaction(newTx.hash);
      });
      const blockC = await ckb.get_block(receiptC.tx_status.block_hash);
      const hashC = await ckb.get_block_hash(blockC.header.number);
      assert.equal(hashC, receiptC.tx_status.block_hash, "[4] CKB：新 C 应在主链确认");
      recordConfirmation(report, "C", newTx.hash, blockC);
      const C = { tx_hash: newTx.hash, index: "0x0" };
      const finalTip = await ckb.get_tip_header();
      await until("CKB indexer through C", 300_000, async () => {
        const tip = await ckb.get_indexer_tip();
        return tip?.block_hash === finalTip.hash && coversHeight(tip.block_number, finalTip.number);
      });
      const fullCellsC = await ckb.get_cells(search, "asc", ALL);
      const fullTxC = await ckb.get_transactions({ ...search, group_by_transaction: false }, "asc", ALL);
      assert.deepEqual(outPoints(fullCellsC.objects), [A, B, C], "[4] CKB：续链后监控活集应恰好为 A、B、C");
      await until("light indexed C after restart", 600_000, async () => {
        const height = scriptHeight(await light.get_scripts(), watched.script);
        const tip = await light.get_tip_header();
        const tx = await light.get_transaction(newTx.hash);
        report.sync_progress = { stage: "C", height, tip: tip.hash, C: tx?.tx_status?.status };
        return tip.hash === finalTip.hash && coversHeight(height, blockC.header.number)
          && committedIn(tx, newTx.hash, hashC);
      }, Error);
      const finalLightTip = await light.get_tip_header();
      assert.deepEqual({ number: finalLightTip.number, hash: finalLightTip.hash },
        { number: finalTip.number, hash: finalTip.hash }, "[4] 轻客户端：续扫后 tip 应与 CKB 同高同哈希");
      const lightCellsC = await light.get_cells(search, "asc", ALL);
      assert.deepEqual(outPoints(lightCellsC.objects), outPoints(fullCellsC.objects), "[4] 轻客户端：续扫后活集应与 CKB 逐项一致");
      const lightTxC = await light.get_transactions({ ...search, group_by_transaction: false }, "asc", ALL);
      assert.deepEqual(rows(lightTxC), rows(fullTxC), "[4] 轻客户端：续扫后历史应与 CKB 逐项一致");
    });
  });
});
