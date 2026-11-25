// TEST-MAP: LC-STORE-001
import assert from "node:assert/strict";
import {
  buildCreation, buildSpend, committedIn, coversHeight, devFunding, hex, outPoints,
  recordConfirmation, scriptHeight, until, untilCommitted, withNodeWorkspace,
} from "../lc_store_support";

const ID = "LC-STORE-001";
const LIMIT = "0x2";
const ALL = "0x40";
type TxRow = { hash: string; block: string; txIndex: string; ioType: string; ioIndex: string };
const txRow = (row: any): TxRow => ({
  hash: row.tx_hash || row.transaction?.hash,
  block: row.block_number, txIndex: row.tx_index, ioType: row.io_type, ioIndex: row.io_index,
});

describe(ID, function () {
  this.timeout(1_800_000);
  it("原生存储的双向分页、容量和未分组交易历史与全节点一致", async () => {
    // 1. 启动一个隔离 dev 全节点及只连接它的轻客户端，记录本轮脚本和后端。
    // 2. 在不同主链块依次创建 A-E，再花费 B，取全节点已确认交易作为独立依据。
    // 3. 等双方索引目标脚本与花费交易，取得全节点活集、容量和未分组历史。
    // 4. 轻客户端双向逐页读取活 cell，并逐项对照全节点的完整有序列表。
    // 5. 轻客户端读取容量与未分组交易历史，逐项对照全节点结果。
    await withNodeWorkspace(ID, async run => {
      // 1. 启动一个隔离 dev 全节点及只连接它的轻客户端，记录本轮脚本和后端。
      const ckb = run.startCkbNode();
      await until("CKB RPC", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      const { node_id: nodeId } = await ckb.local_node_info();
      const light = run.startLightClient({ bootnodeId: nodeId });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      const { funder, watched, report } = run;
      report.genesis = genesis.header.hash;
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[1] 轻客户端：应连接本轮全节点的 dev 创世链");
      const peers = await until("light connected to CKB", 90_000, async () => {
        const ids = (await light.get_peers()).map(p => p.node_id);
        return ids.includes(nodeId) && ids;
      });
      assert.deepEqual(peers, [nodeId], "[1] 轻客户端：唯一 peer 应为本轮 CKB");

      // 2. 在不同主链块依次创建 A-E，再花费 B，取全节点已确认交易作为独立依据。
      report.stage = "create_and_spend";
      const { chainConfig, genesisCell } = devFunding(genesis, funder);
      let funding = genesisCell;
      const created: any[] = [];
      for (const label of ["A", "B", "C", "D", "E"]) {
        const tx = await buildCreation(funding, funder, watched, chainConfig);
        const hash = await ckb.send_transaction(tx.raw);
        assert.equal(hash, tx.hash, `[2] CKB：${label} 创建交易应按签名哈希提交`);
        const confirmed = await untilCommitted(label, async () => {
          await ckb.generate_block();
          return ckb.get_transaction(tx.hash);
        });
        const block = await ckb.get_block(confirmed.tx_status.block_hash);
        const canonical = await ckb.get_block_hash(block.header.number);
        assert.equal(canonical, confirmed.tx_status.block_hash, `[2] CKB：${label} 应在主链确认`);
        const index = block.transactions.findIndex(t => t.hash === tx.hash);
        assert.ok(index > 0, `[2] CKB：${label} 应在非 cellbase 交易中，实际索引 ${index}`);
        created.push({ label, out_point: { tx_hash: hash, index: "0x0" },
          block_number: block.header.number, tx_index: hex(BigInt(index)), block_hash: canonical });
        recordConfirmation(report, label, hash, block);
        funding = tx.change;
      }
      report.created = created;
      const heights = created.map(x => BigInt(x.block_number));
      assert.ok(heights.slice(1).every((h, i) => h > heights[i]),
        `[2] CKB：A-E 应在递增的不同主链块，实际高度 ${heights.join(",")}`);
      const [A, B, C, D, E] = outPoints(created);
      const search = { script: watched.script, script_type: "lock" };
      // 全节点 indexer 必须先追到 E 才能把 B 作为可花费 cell 使用。
      await until("CKB indexer through E", 300_000, async () => {
        const tip = await ckb.get_indexer_tip();
        return tip?.block_hash === created[4].block_hash && coversHeight(tip.block_number, created[4].block_number);
      });
      const confirmedBefore = await ckb.get_cells(search, "asc", ALL);
      assert.deepEqual(outPoints(confirmedBefore.objects), [A, B, C, D, E], "[2] CKB：花费前活集应恰好是 A-E");
      const spend = await buildSpend(confirmedBefore.objects[1], watched, funder, chainConfig);
      assert.deepEqual(spend.raw.inputs.map(i => i.previous_output), [B], "[2] 签名交易：唯一输入应为 B");
      const spendHash = await ckb.send_transaction(spend.raw);
      assert.equal(spendHash, spend.hash, "[2] CKB：花费 B 应按签名哈希提交");
      const committed = await untilCommitted("spend B", async () => {
        await ckb.generate_block();
        return ckb.get_transaction(spend.hash);
      });
      assert.deepEqual(committed.transaction.inputs.map(i => i.previous_output), [B], "[2] CKB：已确认花费交易的输入应恰好是 B");
      const spendBlock = await ckb.get_block(committed.tx_status.block_hash);
      const spendCanonical = await ckb.get_block_hash(spendBlock.header.number);
      assert.equal(spendCanonical, committed.tx_status.block_hash, "[2] CKB：花费 B 应在主链确认");
      recordConfirmation(report, "spend B", spend.hash, spendBlock, B);
      const spentState = await ckb.get_live_cell(B, false);
      assert.ok(["dead", "unknown"].includes(spentState.status),
        `[2] CKB：花费后 B 应不再 live，实际 ${spentState.status}`);

      // 3. 等双方索引目标脚本与花费交易，取得全节点活集、容量和未分组历史。
      report.stage = "sync_and_oracle";
      await light.set_scripts([{ ...search, block_number: "0x0" }]);
      const tip = await ckb.get_tip_header();
      await until("CKB indexer through spend", 300_000, async () => {
        const indexer = await ckb.get_indexer_tip();
        report.sync_progress = { side: "CKB", indexer };
        return indexer?.block_hash === tip.hash && coversHeight(indexer.block_number, tip.number);
      });
      const fullAsc = await ckb.get_cells(search, "asc", ALL);
      const fullDesc = await ckb.get_cells(search, "desc", ALL);
      assert.deepEqual(outPoints(fullAsc.objects), [A, C, D, E], "[3] CKB：花费后升序活集应恰好是 A、C、D、E");
      assert.deepEqual(outPoints(fullDesc.objects), [E, D, C, A], "[3] CKB：花费后降序活集应恰好是 E、D、C、A");
      const fullCapacity = await ckb.get_cells_capacity(search);
      const fullHistory = await ckb.get_transactions({ ...search, group_by_transaction: false }, "asc", ALL);
      const expectedHistory = fullHistory.objects.map(txRow);
      assert.deepEqual(expectedHistory.map(x => x.hash),
        [A.tx_hash, B.tx_hash, C.tx_hash, D.tx_hash, E.tx_hash, spend.hash],
        "[3] CKB：未分组历史应包括五笔创建和一笔花费");
      await until("light indexed spend and watched script", 600_000, async () => {
        const height = scriptHeight(await light.get_scripts(), watched.script);
        const lt = await light.get_tip_header();
        const st = await light.get_transaction(spend.hash);
        report.sync_progress = { side: "light", height, tip: lt.hash, spend: st?.tx_status?.status };
        return lt.hash === tip.hash && coversHeight(height, spendBlock.header.number)
          && committedIn(st, spend.hash, spendCanonical);
      }, Error);

      // 4. 轻客户端双向逐页读取活 cell，并逐项对照全节点的完整有序列表。
      report.stage = "cell_pages";
      report.pages = [];
      for (const [order, expected] of [["asc", outPoints(fullAsc.objects)], ["desc", outPoints(fullDesc.objects)]] as const) {
        const actual: any[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        const deadline = Date.now() + 120_000;
        for (;;) {
          const page = cursor ? await light.get_cells(search, order, LIMIT, cursor)
            : await light.get_cells(search, order, LIMIT);
          report.pages.push({ order, after: cursor, rows: outPoints(page.objects), cursor: page.last_cursor });
          assert.ok(Date.now() <= deadline, `[4] 轻客户端：${order} 翻页应在 120 秒内结束`);
          assert.ok(page.objects.length <= 2, `[4] 轻客户端：${order} 单页最多 2 项，实际 ${page.objects.length}`);
          if (!page.objects.length) break;
          actual.push(...outPoints(page.objects));
          assert.ok(actual.length <= expected.length, `[4] 轻客户端：${order} 续页累计不应超过 ${expected.length} 项，实际 ${actual.length}`);
          cursor = page.last_cursor;
          assert.ok(typeof cursor === "string" && cursor.length > 2, `[4] 轻客户端：${order} 非空页应返回游标`);
          assert.ok(!seen.has(cursor), `[4] 轻客户端：${order} 游标应推进`);
          seen.add(cursor);
        }
        assert.deepEqual(actual, expected, `[4] 轻客户端：${order} 全部活 cell 应与 CKB 完整有序列表一致`);
      }

      // 5. 轻客户端读取容量与未分组交易历史，逐项对照全节点结果。
      report.stage = "capacity_and_history";
      const lightCapacity = await light.get_cells_capacity(search);
      assert.equal(lightCapacity.capacity, fullCapacity.capacity, "[5] 轻客户端：同一 lock 的活容量应等于 CKB indexer");
      const historySearch = { ...search, group_by_transaction: false };
      const actualHistory: TxRow[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      const deadline = Date.now() + 120_000;
      for (;;) {
        const page = cursor ? await light.get_transactions(historySearch, "asc", LIMIT, cursor)
          : await light.get_transactions(historySearch, "asc", LIMIT);
        report.history_pages = (report.history_pages || []).concat({ after: cursor, rows: page.objects.map(txRow), cursor: page.last_cursor });
        assert.ok(Date.now() <= deadline, "[5] 轻客户端：历史翻页应在 120 秒内结束");
        if (!page.objects.length) break;
        actualHistory.push(...page.objects.map(txRow));
        assert.ok(actualHistory.length <= expectedHistory.length,
          `[5] 轻客户端：历史累计不应超过 ${expectedHistory.length} 行，实际 ${actualHistory.length}`);
        cursor = page.last_cursor;
        assert.ok(typeof cursor === "string" && cursor.length > 2, "[5] 轻客户端：非空历史页应返回游标");
        assert.ok(!seen.has(cursor), "[5] 轻客户端：历史游标应推进");
        seen.add(cursor);
      }
      assert.deepEqual(actualHistory, expectedHistory, "[5] 轻客户端：未分组交易历史应与 CKB 完整有序列表一致");
    });
  });
});
