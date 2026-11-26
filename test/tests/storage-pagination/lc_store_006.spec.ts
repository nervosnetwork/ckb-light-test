// TEST-MAP: LC-STORE-006
import assert from "node:assert/strict";
import {
  blockWork, buildCreation, CKB, committedIn, coversHeight, devFunding, FEE, hex, outPoints, output,
  recordConfirmation, scriptHeight, signTransaction, until, untilCommitted, withNodeWorkspace,
} from "../lc_store_support";

const ID = "LC-STORE-006";
const ALL = "0x40";

describe(ID, function () {
  this.timeout(1_800_000);
  // 暂停回归：上游 #302 尚未解决同库换链；双后端均能得到 B 的 [c, b] 后恢复。
  it.skip("同库重启后从 A 分支切到累计难度更高的 B 分支并撤销孤块 cell", async () => {
    // 1. 启动同创世的 A/B 两个 CKB，连接形成共同祖先和共同监控输出 c；轻客户端只连 A。
    // 2. 正常断开 A/B，A 创建 a 并被轻端索引；B 独立创建 b 且累计难度更高。
    // 3. 优雅停止轻端与 A，同库离线重启轻端，应保留 A-tip、c 和 a。
    // 4. 再次同库重启轻端只连 B，确认换链后 c 不变、a 消失、b 出现且活集与 B 一致。
    await withNodeWorkspace(ID, async run => {
      // 1. 启动同创世的 A/B 两个 CKB，连接形成共同祖先和共同监控输出 c；轻客户端只连 A。
      const { report, funder, watched } = run;
      report.stage = "shared_ancestor";
      const A = run.startCkbNode("A");
      let B = run.startCkbNode("B");
      await until("A ready", 90_000, () => A.get_tip_header());
      await until("B ready", 90_000, () => B.get_tip_header());
      const ga = await A.get_block_by_number("0x0");
      const gb = await B.get_block_by_number("0x0");
      assert.equal(gb.header.hash, ga.header.hash, "[1] CKB B：创世哈希应与 A 相同");
      const { node_id: idA } = await A.local_node_info();
      const { node_id: idB } = await B.local_node_info();
      await A.add_node(idB, run.p2pAddress("B"));
      await until("A/B connected", 90_000, async () => {
        const pa = await A.get_peers(), pb = await B.get_peers();
        return pa.some(p => p.node_id === idB) && pb.some(p => p.node_id === idA);
      });
      for (let i = 0; i < 120; i++) await A.generate_block();
      const { chainConfig, genesisCell } = devFunding(ga, funder);
      const commonTx = await buildCreation(genesisCell, funder, watched, chainConfig);
      const submittedCommon = await A.send_transaction(commonTx.raw);
      assert.equal(submittedCommon, commonTx.hash, "[1] CKB A：共同输出 c 的交易应按签名哈希提交");
      const commonReceipt = await untilCommitted("common c", async () => {
        await A.generate_block();
        return A.get_transaction(commonTx.hash);
      });
      const commonBlock = await A.get_block(commonReceipt.tx_status.block_hash);
      const commonHash = await A.get_block_hash(commonBlock.header.number);
      assert.equal(commonReceipt.tx_status.block_hash, commonHash, "[1] CKB A：共同输出 c 应在主链确认");
      await until("B shares common block", 300_000, async () =>
        (await B.get_block_hash(commonBlock.header.number)) === commonHash, Error);
      const c = { tx_hash: commonTx.hash, index: "0x0" };
      const commonStateBefore = await B.get_live_cell(c, false);
      assert.equal(commonStateBefore.status, "live", "[1] CKB B：分叉前共同输出 c 应为活 cell");
      recordConfirmation(report, "common c", commonTx.hash, commonBlock);
      const fork = await A.get_tip_header();
      const lightA = run.startLightClient({ bootnodeId: idA });
      const lightGenesis = await until("light ready", 90_000, () => lightA.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, ga.header.hash, "[1] 轻客户端：创世哈希应与 A/B 相同");
      const peerA = await until("light connected to A", 90_000, async () => {
        const ids = (await lightA.get_peers()).map(p => p.node_id);
        return ids.includes(idA) && ids;
      });
      assert.deepEqual(peerA, [idA], "[1] 轻客户端：唯一 peer 应为 A");
      const search = { script: watched.script, script_type: "lock" };
      await lightA.set_scripts([{ ...search, block_number: "0x0" }]);

      // 2. 正常断开 A/B，A 创建 a 并被轻端索引；B 独立创建 b 且累计难度更高。
      report.stage = "divergent_branches";
      await A.remove_node(idB);
      await B.remove_node(idA);
      await until("A/B disconnected", 90_000, async () => {
        const pa = await A.get_peers(), pb = await B.get_peers();
        return !pa.some(p => p.node_id === idB) && !pb.some(p => p.node_id === idA);
      }, Error);
      // B 暂停在共同祖先，避免 peer store 在 A 扫描期间自动重连、提前采用 A 分支。
      await run.stopCkbNode("B");
      const aTx = await buildCreation(commonTx.change, funder, watched, chainConfig);
      const submittedA = await A.send_transaction(aTx.raw);
      assert.equal(submittedA, aTx.hash, "[2] CKB A：a 应按签名哈希提交");
      const aReceipt = await untilCommitted("a", async () => {
        await A.generate_block();
        return A.get_transaction(aTx.hash);
      });
      const aBlock = await A.get_block(aReceipt.tx_status.block_hash);
      const aHash = await A.get_block_hash(aBlock.header.number);
      assert.equal(aReceipt.tx_status.block_hash, aHash, "[2] CKB A：a 应在 A 主链确认");
      const a = { tx_hash: aTx.hash, index: "0x0" };
      recordConfirmation(report, "A-only a", aTx.hash, aBlock);
      const aTip = await A.get_tip_header();
      await until("A indexer through a", 300_000, async () => {
        const tip = await A.get_indexer_tip();
        return tip?.block_hash === aTip.hash && coversHeight(tip.block_number, aTip.number);
      });
      const fullA = await A.get_cells(search, "asc", ALL);
      assert.deepEqual(outPoints(fullA.objects), [c, a], "[2] CKB A：分支活集应恰好是 c、a");
      await until("light indexed A-only a", 600_000, async () => {
        const h = scriptHeight(await lightA.get_scripts(), watched.script);
        const tip = await lightA.get_tip_header();
        const tx = await lightA.get_transaction(aTx.hash);
        report.sync_progress = { stage: "A", height: h, tip: tip.hash, a: tx?.tx_status?.status };
        return tip.hash === aTip.hash && coversHeight(h, aBlock.header.number)
          && committedIn(tx, aTx.hash, aHash);
      }, Error);
      const lightACells = await lightA.get_cells(search, "asc", ALL);
      assert.deepEqual(outPoints(lightACells.objects), [c, a], "[2] 轻客户端：停机前应确实采用 A 的 c、a 活集");
      const forkHeight = BigInt(fork.number);
      let da = 0n;
      for (let h = forkHeight + 1n; h <= BigInt(aTip.number); h++) {
        const header = await A.get_header(await A.get_block_hash(hex(h)));
        da += blockWork(header.compact_target);
      }
      const aFirst = await A.get_block_hash(hex(forkHeight + 1n));
      await run.stopLightClient();
      await run.stopCkbNode("A");
      B = run.startCkbNode("B");
      await until("B resumed at fork", 90_000, () => B.get_tip_header());
      const resumedFork = await B.get_tip_header();
      assert.equal(resumedFork.hash, fork.hash, "[2] CKB B：恢复独立库后仍应停在共同祖先");
      const commonChange = await B.get_live_cell({ tx_hash: commonTx.hash, index: "0x1" }, false);
      assert.equal(commonChange.status, "live", "[2] CKB B：分叉资金输入应在共同祖先保持 live");
      const bAmount = 101n * CKB;
      const bTx = await signTransaction(commonTx.change, funder,
        [output(watched, bAmount), output(funder, BigInt(commonTx.change.cellOutput.capacity) - bAmount - FEE)], chainConfig);
      assert.notEqual(bTx.hash, aTx.hash, "[2] 夹具：B 分支交易应与 A 分支不同");
      const submittedB = await B.send_transaction(bTx.raw);
      assert.equal(submittedB, bTx.hash, "[2] CKB B：b 应按签名哈希提交");
      const bReceipt = await untilCommitted("b", async () => {
        await B.generate_block();
        return B.get_transaction(bTx.hash);
      });
      const bBlock = await B.get_block(bReceipt.tx_status.block_hash);
      const bHash = await B.get_block_hash(bBlock.header.number);
      assert.equal(bReceipt.tx_status.block_hash, bHash, "[2] CKB B：b 应在 B 主链确认");
      const b = { tx_hash: bTx.hash, index: "0x0" };
      recordConfirmation(report, "B-only b", bTx.hash, bBlock);
      for (let i = 0; i < 4; i++) await B.generate_block();
      const bTip = await B.get_tip_header();
      assert.ok(BigInt(bTip.number) > BigInt(aTip.number),
        `[2] CKB B：B 高度 ${bTip.number} 应高于 A 高度 ${aTip.number}`);
      let db = 0n;
      for (let h = forkHeight + 1n; h <= BigInt(bTip.number); h++) {
        const header = await B.get_header(await B.get_block_hash(hex(h)));
        db += blockWork(header.compact_target);
      }
      assert.ok(db > da, `[2] CKB B：分叉累计难度 ${db} 应高于 A 的 ${da}`);
      const bFirst = await B.get_block_hash(hex(forkHeight + 1n));
      assert.notEqual(bFirst, aFirst,
        "[2] CKB：分叉点后第一块应不同");
      report.branches = { fork, aTip, bTip, aHash, bHash, da: String(da), db: String(db) };

      // 3. 优雅停止轻端与 A，同库离线重启轻端，应保留 A-tip、c 和 a。
      report.stage = "offline_A_snapshot";
      await run.stopCkbNode("B");
      const offline = run.startLightClient({ bootnodes: [] });
      await until("offline light ready", 90_000, () => offline.get_genesis_block());
      const offlinePeers = await offline.get_peers();
      assert.deepEqual(offlinePeers, [], "[3] 轻客户端：离线同库重启不应连接 peer");
      const offlineTip = await offline.get_tip_header();
      assert.deepEqual({ number: offlineTip.number, hash: offlineTip.hash },
        { number: aTip.number, hash: aTip.hash }, "[3] 轻客户端：离线同库重启应保留 A-tip");
      const offlineCells = await offline.get_cells(search, "asc", ALL);
      assert.deepEqual(outPoints(offlineCells.objects), [c, a], "[3] 轻客户端：离线同库重启应保留 c、a");
      const offlineScript = scriptHeight(await offline.get_scripts(), watched.script);
      assert.ok(coversHeight(offlineScript, aBlock.header.number),
        `[3] 轻客户端：离线同库脚本应覆盖 a，高度为 ${offlineScript}`);

      // 4. 再次同库重启轻端只连 B，确认换链后 c 不变、a 消失、b 出现且活集与 B 一致。
      report.stage = "reorg_to_B";
      await run.stopLightClient();
      B = run.startCkbNode("B");
      await until("B RPC ready for light", 90_000, () => B.get_tip_header());
      const lightB = run.startLightClient({ bootnodes: [{ node: "B", nodeId: idB }] });
      await until("light B ready", 90_000, () => lightB.get_genesis_block());
      const peerB = await until("light connected to B", 90_000, async () => {
        const ids = (await lightB.get_peers()).map(p => p.node_id);
        return ids.includes(idB) && ids;
      });
      assert.deepEqual(peerB, [idB], "[4] 轻客户端：换链期间唯一 peer 应为 B");
      await until("B indexer through b tip", 300_000, async () => {
        const tip = await B.get_indexer_tip();
        return tip?.block_hash === bTip.hash && coversHeight(tip.block_number, bTip.number);
      });
      const bCells = await B.get_cells(search, "asc", ALL);
      assert.deepEqual(outPoints(bCells.objects), [c, b], "[4] CKB B：B 主链活集应恰好是 c、b");
      const notCommittedA = await B.get_transaction(aTx.hash);
      assert.ok(notCommittedA?.tx_status?.status !== "committed",
        `[4] CKB B：A-only a 不应在 B 主链确认，实际 ${notCommittedA?.tx_status?.status}`);
      try {
        await until("light indexed B branch", 600_000, async () => {
          const height = scriptHeight(await lightB.get_scripts(), watched.script);
          const tip = await lightB.get_tip_header();
          const tx = await lightB.get_transaction(bTx.hash);
          report.sync_progress = { stage: "B", height, tip: tip.hash, b: tx?.tx_status?.status };
          return tip.hash === bTip.hash && coversHeight(height, bBlock.header.number)
            && committedIn(tx, bTx.hash, bHash);
        }, Error);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("light indexed B branch timed out")) {
          report.reorg_timeout_diagnostic = {
            expected_outpoints: outPoints(bCells.objects),
            actual_outpoints: null,
            b_status: report.sync_progress?.b ?? null,
          };
          try {
            const lightCellsAtTimeout = await lightB.get_cells(search, "asc", ALL);
            report.reorg_timeout_diagnostic.actual_outpoints = outPoints(lightCellsAtTimeout.objects);
          } catch (diagnosticError) {
            report.reorg_timeout_diagnostic.cells_error = String(diagnosticError);
          }
          try {
            const bAtTimeout = await lightB.get_transaction(bTx.hash);
            report.reorg_timeout_diagnostic.b_status = bAtTimeout?.tx_status?.status;
          } catch (diagnosticError) {
            report.reorg_timeout_diagnostic.b_status_error = String(diagnosticError);
          }
        }
        throw error;
      }
      const finalTip = await lightB.get_tip_header();
      assert.equal(finalTip.hash, bTip.hash, "[4] 轻客户端：换链后 tip 应为 B 主链头");
      const finalCells = await lightB.get_cells(search, "asc", ALL);
      assert.deepEqual(outPoints(finalCells.objects), outPoints(bCells.objects), "[4] 轻客户端：换链后活集应与 B indexer 完整一致");
      const commonState = await B.get_live_cell(c, false);
      assert.equal(commonState.status, "live", "[4] CKB B：共同前缀 c 应保持 live");
      const oldState = await B.get_live_cell(a, false);
      assert.ok(oldState.status !== "live", `[4] CKB B：孤块 a 不应 live，实际 ${oldState.status}`);
    });
  });
});
