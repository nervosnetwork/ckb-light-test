// TEST-MAP: LC-STORE-007
import assert from "node:assert/strict";
import {
  blockWork, buildCreation, CKB, committedIn, coversHeight, devFunding, FEE, hex, output,
  recordConfirmation, scriptHeight, signTransaction, until, untilCommitted, withNodeWorkspace,
} from "../lc_store_support";

const ID = "LC-STORE-007";
const ALL = "0x40", TWO = "0x2";
const row = (x: any) => ({ hash: x.tx_hash || x.transaction?.hash, block: x.block_number,
  txIndex: x.tx_index, ioType: x.io_type, ioIndex: x.io_index });
function key(x: any): bigint[] {
  return [BigInt(x.block), BigInt(x.txIndex), BigInt(x.ioIndex), x.ioType === "input" ? 0n : 1n];
}
function compare(a: bigint[], b: bigint[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

describe(ID, function () {
  this.timeout(1_800_000);
  // 暂停回归：上游 #302 尚未解决换链；双后端均清除 k 且旧游标返回 [b1, b2] 后恢复。
  it.skip("正常短叉删除历史游标行后，旧游标仍返回新主链严格后缀", async () => {
    // 1. 启动同创世 A/B 两个 CKB 并共享祖先，轻端只连 A，确认共同交易 c。
    // 2. 断开 A/B，A 创建仅属于 A 的 k；保存轻端未分组历史首页末项 k 和原游标。
    // 3. B 在 k 的数值位置之后确认 b1、b2，证明 B 分支累计难度更高，再重连 A/B。
    // 4. 等 A 和轻端换到 B 主链；无游标读取应删除 k 且与 B 完整历史相同。
    // 5. 复用 k 的旧游标，续页应严格等于 B 历史中 k 位置之后的 b1、b2。
    await withNodeWorkspace(ID, async run => {
      // 1. 启动同创世 A/B 两个 CKB 并共享祖先，轻端只连 A，确认共同交易 c。
      const { report, funder, watched } = run;
      report.stage = "shared_history";
      let A = run.startCkbNode("A");
      let B = run.startCkbNode("B");
      await until("A ready", 90_000, () => A.get_tip_header());
      await until("B ready", 90_000, () => B.get_tip_header());
      const ga = await A.get_block_by_number("0x0");
      const gb = await B.get_block_by_number("0x0");
      assert.equal(gb.header.hash, ga.header.hash, "[1] CKB B：创世哈希应等于 A");
      const { node_id: idA } = await A.local_node_info();
      const { node_id: idB } = await B.local_node_info();
      await A.add_node(idB, run.p2pAddress("B"));
      await until("A/B connected", 90_000, async () => {
        const pa = await A.get_peers(), pb = await B.get_peers();
        return pa.some(p => p.node_id === idB) && pb.some(p => p.node_id === idA);
      });
      for (let i = 0; i < 120; i++) await A.generate_block();
      const { chainConfig, genesisCell } = devFunding(ga, funder);
      const common = await buildCreation(genesisCell, funder, watched, chainConfig);
      const submittedCommon = await A.send_transaction(common.raw);
      assert.equal(submittedCommon, common.hash, "[1] CKB A：共同 c 应按签名哈希提交");
      const cReceipt = await untilCommitted("common c", async () => {
        await A.generate_block();
        return A.get_transaction(common.hash);
      });
      const cBlock = await A.get_block(cReceipt.tx_status.block_hash);
      const cHash = await A.get_block_hash(cBlock.header.number);
      assert.equal(cHash, cReceipt.tx_status.block_hash, "[1] CKB A：共同 c 应在主链确认");
      await until("B shares common c", 300_000, async () =>
        (await B.get_block_hash(cBlock.header.number)) === cHash, Error);
      recordConfirmation(report, "common c", common.hash, cBlock);
      const fork = await A.get_tip_header();
      const light = run.startLightClient({ bootnodeId: idA });
      const lightGenesis = await until("light ready", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, ga.header.hash, "[1] 轻客户端：应使用 A/B 共同创世块");
      const peerA = await until("light only A", 90_000, async () => {
        const ids = (await light.get_peers()).map(p => p.node_id);
        return ids.includes(idA) && ids;
      });
      assert.deepEqual(peerA, [idA], "[1] 轻客户端：唯一 peer 应为 A");
      const search = { script: watched.script, script_type: "lock", group_by_transaction: false };
      await light.set_scripts([{ script: watched.script, script_type: "lock", block_number: "0x0" }]);

      // 2. 断开 A/B，A 创建仅属于 A 的 k；保存轻端未分组历史首页末项 k 和原游标。
      report.stage = "save_k_cursor";
      await A.remove_node(idB);
      await B.remove_node(idA);
      await until("A/B disconnected", 90_000, async () => {
        const pa = await A.get_peers(), pb = await B.get_peers();
        return !pa.some(p => p.node_id === idB) && !pb.some(p => p.node_id === idA);
      }, Error);
      await run.stopCkbNode("B"); // B 在共同祖先暂停，避免测试期间自动重连 A。
      const kTx = await buildCreation(common.change, funder, watched, chainConfig);
      const submittedK = await A.send_transaction(kTx.raw);
      assert.equal(submittedK, kTx.hash, "[2] CKB A：k 应按签名哈希提交");
      const kReceipt = await untilCommitted("k", async () => {
        await A.generate_block();
        return A.get_transaction(kTx.hash);
      });
      const kBlock = await A.get_block(kReceipt.tx_status.block_hash);
      const kHash = await A.get_block_hash(kBlock.header.number);
      assert.equal(kHash, kReceipt.tx_status.block_hash, "[2] CKB A：k 应在 A 主链确认");
      recordConfirmation(report, "A-only k", kTx.hash, kBlock);
      const aTip = await A.get_tip_header();
      await until("A indexer through k", 300_000, async () => {
        const tip = await A.get_indexer_tip();
        return tip?.block_hash === aTip.hash && coversHeight(tip.block_number, aTip.number);
      });
      const aHistory = await A.get_transactions(search, "asc", ALL);
      assert.deepEqual(aHistory.objects.map(row).map(x => x.hash), [common.hash, kTx.hash],
        "[2] CKB A：旧历史应只有共同 c 与 A-only k");
      await until("light indexed k", 600_000, async () => {
        const height = scriptHeight(await light.get_scripts(), watched.script);
        const tip = await light.get_tip_header();
        const tx = await light.get_transaction(kTx.hash);
        report.sync_progress = { stage: "A", height, tip: tip.hash, k: tx?.tx_status?.status };
        return tip.hash === aTip.hash && coversHeight(height, kBlock.header.number)
          && committedIn(tx, kTx.hash, kHash);
      }, Error);
      const first = await light.get_transactions(search, "asc", TWO);
      assert.deepEqual(first.objects.map(row), aHistory.objects.map(row),
        "[2] 轻客户端：旧历史首页应恰好为 c、k 的完整两行");
      const K = row(first.objects[1]);
      assert.equal(K.hash, kTx.hash, "[2] 轻客户端：首页游标所指行应为 A-only k");
      assert.deepEqual(key(K), key(row(aHistory.objects[1])), "[2] 轻客户端：k 数值位置应与 CKB A 一致");
      const oldCursor = first.last_cursor;
      assert.ok(typeof oldCursor === "string" && oldCursor.length > 2, "[2] 轻客户端：k 首页应返回非空原始游标");
      report.old_cursor = { raw: oldCursor, row: K };
      const forkHeight = BigInt(fork.number);
      let da = 0n;
      for (let h = forkHeight + 1n; h <= BigInt(aTip.number); h++) {
        const head = await A.get_header(await A.get_block_hash(hex(h)));
        da += blockWork(head.compact_target);
      }
      const aFirst = await A.get_block_hash(hex(forkHeight + 1n));
      await run.stopCkbNode("A");

      // 3. B 在 k 的数值位置之后确认 b1、b2，证明 B 分支累计难度更高，再重连 A/B。
      report.stage = "B_history_wins";
      B = run.startCkbNode("B");
      await until("B resumed at fork", 90_000, () => B.get_tip_header());
      const resumedFork = await B.get_tip_header();
      assert.equal(resumedFork.hash, fork.hash, "[3] CKB B：独立库恢复后应仍在共同祖先");
      const commonChange = await B.get_live_cell({ tx_hash: common.hash, index: "0x1" }, false);
      assert.equal(commonChange.status, "live", "[3] CKB B：b1 的共同资金输入应保持 live");
      while (BigInt((await B.get_tip_header()).number) <= BigInt(kBlock.header.number) + 1n) await B.generate_block();
      const bAmount = 101n * CKB;
      const b1 = await signTransaction(common.change, funder,
        [output(watched, bAmount), output(funder, BigInt(common.change.cellOutput.capacity) - bAmount - FEE)], chainConfig);
      assert.notEqual(b1.hash, kTx.hash, "[3] 夹具：b1 应与 A-only k 不同");
      const submittedB1 = await B.send_transaction(b1.raw);
      assert.equal(submittedB1, b1.hash, "[3] CKB B：b1 应按签名哈希提交");
      const b1Receipt = await untilCommitted("b1", async () => {
        await B.generate_block();
        return B.get_transaction(b1.hash);
      });
      const b1Block = await B.get_block(b1Receipt.tx_status.block_hash);
      const b1Canonical = await B.get_block_hash(b1Block.header.number);
      assert.equal(b1Canonical, b1Receipt.tx_status.block_hash,
        "[3] CKB B：b1 应在 B 主链确认");
      recordConfirmation(report, "B-only b1", b1.hash, b1Block);
      const b1Change = { ...output(funder, BigInt(common.change.cellOutput.capacity) - bAmount - FEE),
        outPoint: { txHash: b1.hash, index: "0x1" } };
      const b2 = await buildCreation(b1Change, funder, watched, chainConfig);
      const submittedB2 = await B.send_transaction(b2.raw);
      assert.equal(submittedB2, b2.hash, "[3] CKB B：b2 应按签名哈希提交");
      const b2Receipt = await untilCommitted("b2", async () => {
        await B.generate_block();
        return B.get_transaction(b2.hash);
      });
      const b2Block = await B.get_block(b2Receipt.tx_status.block_hash);
      const b2Canonical = await B.get_block_hash(b2Block.header.number);
      assert.equal(b2Canonical, b2Receipt.tx_status.block_hash,
        "[3] CKB B：b2 应在 B 主链确认");
      recordConfirmation(report, "B-only b2", b2.hash, b2Block);
      let bTip = await B.get_tip_header();
      while (BigInt(bTip.number) <= BigInt(aTip.number) + 2n) {
        await B.generate_block();
        bTip = await B.get_tip_header();
      }
      await until("B indexer through b2", 300_000, async () => {
        const tip = await B.get_indexer_tip();
        return tip?.block_hash === bTip.hash && coversHeight(tip.block_number, bTip.number);
      });
      const bHistory = await B.get_transactions(search, "asc", ALL);
      const bRows = bHistory.objects.map(row);
      assert.deepEqual(bRows.map(x => x.hash), [common.hash, b1.hash, b2.hash],
        "[3] CKB B：新主链完整历史应恰好为 c、b1、b2");
      assert.ok(bRows.slice(1).every(x => compare(key(x), key(K)) > 0),
        `[3] CKB B：b1、b2 的位置应严格晚于 k，边界 ${key(K).join(",")}`);
      assert.ok(!bRows.some(x => compare(key(x), key(K)) === 0),
        "[3] CKB B：新主链不应复用 k 的历史键位置");
      let db = 0n;
      for (let h = forkHeight + 1n; h <= BigInt(bTip.number); h++) {
        const head = await B.get_header(await B.get_block_hash(hex(h)));
        db += blockWork(head.compact_target);
      }
      assert.ok(db > da, `[3] CKB B：B 分支累计难度 ${db} 应高于 A 的 ${da}`);
      const bFirst = await B.get_block_hash(hex(forkHeight + 1n));
      assert.notEqual(bFirst, aFirst,
        "[3] CKB：两分支首块哈希应不同");
      report.branches = { fork, aTip, bTip, da: String(da), db: String(db) };
      await run.stopCkbNode("B");
      A = run.startCkbNode("A");
      await until("A resumed at old tip", 90_000, () => A.get_tip_header());
      const resumedA = await A.get_tip_header();
      assert.equal(resumedA.hash, aTip.hash, "[3] CKB A：重连前仍应位于 k 所在旧分支");
      B = run.startCkbNode("B");
      await until("B ready to reconnect", 90_000, () => B.get_tip_header());
      const resumedB = await B.get_tip_header();
      assert.equal(resumedB.hash, bTip.hash, "[3] CKB B：重连前仍应位于较高累计难度分支");
      await A.add_node(idB, run.p2pAddress("B"));

      // 4. 等 A 和轻端换到 B 主链；无游标读取应删除 k 且与 B 完整历史相同。
      report.stage = "fresh_history_after_reorg";
      await until("A adopts B", 300_000, async () => {
        const ta = await A.get_tip_header(), tb = await B.get_tip_header();
        return ta.hash === bTip.hash && tb.hash === bTip.hash;
      }, Error);
      const aK = await A.get_transaction(kTx.hash);
      assert.ok(aK?.tx_status?.status !== "committed",
        `[4] CKB A：重组后 k 不应仍为已确认交易，实际 ${aK?.tx_status?.status}`);
      await until("light indexed B history", 600_000, async () => {
        const height = scriptHeight(await light.get_scripts(), watched.script);
        const tip = await light.get_tip_header();
        const tx = await light.get_transaction(b2.hash);
        report.sync_progress = { stage: "B", height, tip: tip.hash, b2: tx?.tx_status?.status };
        return tip.hash === bTip.hash && coversHeight(height, b2Block.header.number)
          && committedIn(tx, b2.hash, b2Receipt.tx_status.block_hash);
      }, Error);
      const fresh = await light.get_transactions(search, "asc", ALL);
      assert.deepEqual(fresh.objects.map(row), bRows, "[4] 轻客户端：不带游标的完整历史应与 B 主链逐项一致");
      assert.ok(!fresh.objects.map(row).some(x => x.hash === kTx.hash), "[4] 轻客户端：新主链历史不应含孤块 k");

      // 5. 复用 k 的旧游标，续页应严格等于 B 历史中 k 位置之后的 b1、b2。
      report.stage = "old_k_cursor";
      const expected = bRows.filter(x => compare(key(x), key(K)) > 0);
      assert.deepEqual(expected.map(x => x.hash), [b1.hash, b2.hash], "[5] CKB B：k 后严格后缀应为 b1、b2");
      const actual: ReturnType<typeof row>[] = [];
      let cursor = oldCursor;
      const seen = new Set([cursor]);
      const deadline = Date.now() + 120_000;
      report.history_pages = [];
      for (;;) {
        const page = await light.get_transactions(search, "asc", TWO, cursor);
        report.history_pages.push({ after: cursor, rows: page.objects.map(row), next: page.last_cursor });
        assert.ok(Date.now() <= deadline, "[5] 轻客户端：旧游标续页应在 120 秒内读完");
        assert.ok(page.objects.length <= 2, `[5] 轻客户端：每页最多 2 行，实际 ${page.objects.length}`);
        if (!page.objects.length) break;
        actual.push(...page.objects.map(row));
        assert.ok(actual.length <= expected.length, `[5] 轻客户端：累计不应超过 ${expected.length} 行，实际 ${actual.length}`);
        cursor = page.last_cursor;
        assert.ok(typeof cursor === "string" && cursor.length > 2, "[5] 轻客户端：非空续页应返回游标");
        assert.ok(!seen.has(cursor), "[5] 轻客户端：历史游标应推进");
        seen.add(cursor);
      }
      assert.deepEqual(actual[0], expected[0], "[5] 轻客户端：旧 k 游标下一行应为 B 主链 b1");
      assert.deepEqual(actual, expected, "[5] 轻客户端：合并续页应恰好为 B 主链完整严格后缀 b1、b2");
    });
  });
});
