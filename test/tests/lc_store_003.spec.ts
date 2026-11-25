// TEST-MAP: LC-STORE-003
import assert from "node:assert/strict";
import {
  buildCreation, buildSpend, committedIn, comparePosition, coversHeight, devFunding,
  hex, outPoints, OutPoint, position, recordConfirmation, recordFirstPage, recordSuffixPage, scriptHeight,
  serial, until, untilCommitted, withNodeWorkspace,
} from "./lc_store_support";

const CASE_ID = "LC-STORE-003";
const ALL_CELLS = "0x40";
const PAGE_OF_TWO = "0x2";

describe(CASE_ID, function () {
  this.timeout(1_800_000);

  it("花费第一页末项 B 后，旧游标的下一项是 C，续页恰好是 C、D、E", async () => {
    // 1. 本轮启动 1 个 CKB 全节点和 1 个轻客户端，确认轻客户端只连接这个全节点。
    // 2. 在全节点依次创建 A、B、C、D、E，确认它们在不同区块且均未花费。
    // 3. 等轻客户端同步到 E，升序取第一页 [A, B]，保存旧游标。
    // 4. 只花费 B，确认两端查询同一 lock 都只返回 [A, C, D, E]。
    // 5. 用旧游标翻到空页，确认下一项是 C，全部续页恰好是 [C, D, E]。

    await withNodeWorkspace(CASE_ID, async (run) => {
      // 1. 本轮启动 1 个 CKB 全节点和 1 个轻客户端，确认轻客户端只连接这个全节点。
      const ckb = run.startCkbNode();
      await until("CKB RPC", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      const { node_id: ckbNodeId } = await ckb.local_node_info();
      const light = run.startLightClient({ bootnodeId: ckbNodeId });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      const { funder, watched, report } = run;
      report.genesis = genesis.header.hash;
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[1] 轻客户端：创世块哈希应与本轮 CKB 相同");
      const connectedPeerIds = await until("light connected to this CKB", 90_000, async () => {
        const ids = (await light.get_peers()).map(peer => peer.node_id);
        return ids.includes(ckbNodeId) && ids;
      });
      assert.deepEqual(connectedPeerIds, [ckbNodeId], "[1] 轻客户端：唯一的 peer 应为本轮启动的 CKB");

      // 2. 在全节点依次创建 A、B、C、D、E，确认它们在不同区块且均未花费。
      report.stage = "create_A_to_E";
      const { chainConfig, genesisCell } = devFunding(genesis, funder);
      let funding = genesisCell;
      const created = [];
      report.created = created;
      for (const label of ["A", "B", "C", "D", "E"]) {
        const tx = await buildCreation(funding, funder, watched, chainConfig);
        const submittedHash = await ckb.send_transaction(tx.raw);
        assert.equal(submittedHash, tx.hash, `[2] CKB：提交 ${label} 的创建交易应返回本地计算的哈希`);
        const confirmed = await untilCommitted(label, async () => {
          await ckb.generate_block();
          return ckb.get_transaction(tx.hash);
        });
        const block = await ckb.get_block(confirmed.tx_status.block_hash);
        const canonical = await ckb.get_block_hash(block.header.number);
        assert.equal(confirmed.tx_status.block_hash, canonical, `[2] CKB：${label} 的创建交易应在该高度的主链块中`);
        const txIndex = block.transactions.findIndex(t => t.hash === tx.hash);
        assert.ok(txIndex > 0, `[2] CKB：${label} 的创建交易应位于 cellbase 之后，实际索引为 ${txIndex}`);
        created.push({
          label, out_point: { tx_hash: tx.hash, index: "0x0" },
          block_hash: canonical, block_number: block.header.number, tx_index: hex(BigInt(txIndex)),
        });
        recordConfirmation(report, label, tx.hash, block);
        funding = tx.change;
      }
      const [A, B, C, D, E] = outPoints(created);
      const eBlock = created[4];
      const heights = created.map(c => BigInt(c.block_number));
      const strictlyIncreasing = heights.slice(1).every((height, i) => height > heights[i]);
      assert.ok(strictlyIncreasing, `[2] CKB：A 到 E 的确认高度应严格递增，实际为 ${heights.join(", ")}`);
      for (const [label, cell] of Object.entries({ A, B, C, D, E })) {
        const { status } = await ckb.get_live_cell(cell, false);
        assert.equal(status, "live", `[2] CKB：花费前 ${label} 应为活 cell`);
      }

      // 3. 等轻客户端同步到 E，升序取第一页 [A, B]，保存旧游标。
      report.stage = "sync_to_E";
      const search = { script: watched.script, script_type: "lock" };
      await light.set_scripts([{ ...search, block_number: "0x0" }]);
      const before = await ckb.get_tip_header();
      report.before_tip = { number: before.number, hash: before.hash };
      await until("CKB indexer through E", 300_000, async () => {
        const tip = await ckb.get_indexer_tip();
        report.sync_progress = { stage: "full_before", indexer: tip };
        return tip?.block_hash === before.hash && coversHeight(tip.block_number, before.number);
      });
      const fullBefore = await ckb.get_cells(search, "asc", ALL_CELLS);
      assert.deepEqual(outPoints(fullBefore.objects), [A, B, C, D, E], "[3] CKB：花费前按 lock 升序应返回 A 到 E");
      assert.deepEqual(fullBefore.objects.map(position), created.map(position), "[3] CKB：索引位置应与创建位置一致");
      await until("light indexed E for the watched lock", 300_000, async () => {
        const height = scriptHeight(await light.get_scripts(), watched.script);
        const tip = await light.get_tip_header();
        const tx = await light.get_transaction(E.tx_hash);
        report.sync_progress = { stage: "light_before", script_block: height, tip_hash: tip.hash, e_status: tx?.tx_status?.status };
        return tip.hash === before.hash && coversHeight(height, eBlock.block_number)
          && committedIn(tx, E.tx_hash, eBlock.block_hash);
      }, Error);
      const lightBefore = await light.get_cells(search, "asc", ALL_CELLS);
      assert.deepEqual(outPoints(lightBefore.objects), [A, B, C, D, E], "[3] 轻客户端：同步到 E 后应升序返回 A 到 E");

      report.stage = "save_first_page";
      const firstPage = await light.get_cells(search, "asc", PAGE_OF_TWO);
      assert.deepEqual(outPoints(firstPage.objects), [A, B], "[3] 轻客户端：升序取两项，第一页应恰好是 A、B");
      const oldCursor = firstPage.last_cursor;
      assert.ok(typeof oldCursor === "string" && oldCursor.length > 2, "[3] 轻客户端：非空第一页应返回非空游标");
      const fullB = fullBefore.objects[1];
      assert.deepEqual(position(firstPage.objects[1]), position(fullB), "[3] 轻客户端：页末位置应与 CKB 记录的 B 一致");
      recordFirstPage(report, firstPage);

      // 4. 只花费 B，确认两端查询同一 lock 都只返回 [A, C, D, E]。
      report.stage = "spend_B";
      const spend = await buildSpend(fullB, watched, funder, chainConfig);
      const signedInputs = spend.raw.inputs.map(input => input.previous_output);
      assert.deepEqual(signedInputs, [B], "[4] 签名交易：唯一的输入应为 B");
      const submittedSpendHash = await ckb.send_transaction(spend.raw);
      assert.equal(submittedSpendHash, spend.hash, "[4] CKB：提交花费 B 的交易应返回本地计算的哈希");
      const confirmedSpend = await untilCommitted("spend B", async () => {
        await ckb.generate_block();
        return ckb.get_transaction(spend.hash);
      });
      const committedInputs = confirmedSpend.transaction.inputs.map(input => input.previous_output);
      assert.deepEqual(committedInputs, [B], "[4] CKB：链上花费交易的唯一输入应为 B");
      const spendBlock = await ckb.get_block(confirmedSpend.tx_status.block_hash);
      assert.ok(spendBlock.transactions.some(t => t.hash === spend.hash), "[4] CKB：确认块的块体应包含花费 B 的交易");
      const spendBlockHash = await ckb.get_block_hash(spendBlock.header.number);
      assert.equal(confirmedSpend.tx_status.block_hash, spendBlockHash, "[4] CKB：花费 B 的交易应在该高度的主链块中");
      recordConfirmation(report, "spend B", spend.hash, spendBlock, B);
      const { status: spentStatus } = await ckb.get_live_cell(B, false);
      assert.ok(["dead", "unknown"].includes(spentStatus),
        `[4] CKB：花费后 B 应为 dead 或 unknown，实际为 ${spentStatus}`);
      for (const [label, cell] of Object.entries({ A, C, D, E })) {
        const { status } = await ckb.get_live_cell(cell, false);
        assert.equal(status, "live", `[4] CKB：花费 B 后 ${label} 仍应为活 cell`);
      }
      report.stage = "sync_spend_B";
      const after = await ckb.get_tip_header();
      await until("CKB indexer through spend B", 300_000, async () => {
        const tip = await ckb.get_indexer_tip();
        report.sync_progress = { stage: "full_after", indexer: tip };
        return tip?.block_hash === after.hash && coversHeight(tip.block_number, after.number);
      });
      const fullAfter = await ckb.get_cells(search, "asc", ALL_CELLS);
      assert.deepEqual(outPoints(fullAfter.objects), [A, C, D, E], "[4] CKB：花费 B 后按 lock 查询应只剩 A、C、D、E");
      const strictlyAfterB = fullAfter.objects.filter(c => comparePosition(position(c), position(fullB)) > 0);
      const strictSuffix = outPoints(strictlyAfterB);
      assert.deepEqual(strictSuffix, [C, D, E], "[4] CKB：严格位于 B 原位置之后的活 cell 应依次是 C、D、E");
      await until("light indexed spend B for the watched lock", 300_000, async () => {
        const height = scriptHeight(await light.get_scripts(), watched.script);
        const tip = await light.get_tip_header();
        const tx = await light.get_transaction(spend.hash);
        report.sync_progress = { stage: "light_after", script_block: height, tip_hash: tip.hash, spend_status: tx?.tx_status?.status };
        return tip.hash === after.hash && coversHeight(height, spendBlock.header.number)
          && committedIn(tx, spend.hash, spendBlockHash);
      }, Error);
      const lightAfter = await light.get_cells(search, "asc", ALL_CELLS);
      assert.deepEqual(outPoints(lightAfter.objects), [A, C, D, E], "[4] 轻客户端：不带游标查询应只剩 A、C、D、E");

      // 5. 用旧游标翻到空页，确认下一项是 C，全部续页恰好是 [C, D, E]。
      report.stage = "old_cursor_after_deleted_B";
      const resumed: OutPoint[] = [];
      let cursor = oldCursor;
      const seen = new Set([oldCursor]);
      const deadline = Date.now() + 120_000;
      report.suffix_pages = [];
      report.suffix_expected = strictSuffix.map(serial);
      report.next_expected = serial(C);
      for (;;) {
        const page = await light.get_cells(search, "asc", PAGE_OF_TWO, cursor);
        recordSuffixPage(report, cursor, page);
        assert.ok(Date.now() <= deadline, "[5] 轻客户端：旧游标的全部续页应在 120 秒内读完");
        assert.ok(page.objects.length <= 2, `[5] 轻客户端：每页最多 2 项，本页返回 ${page.objects.length} 项`);
        if (page.objects.length === 0) break;
        resumed.push(...outPoints(page.objects));
        assert.ok(resumed.length <= strictSuffix.length,
          `[5] 轻客户端：续页累计应不超过 CKB 确认的 ${strictSuffix.length} 项，已读 ${resumed.length} 项`);
        cursor = page.last_cursor;
        assert.ok(typeof cursor === "string" && cursor.length > 2, "[5] 轻客户端：非空续页应返回非空游标");
        assert.ok(!seen.has(cursor), "[5] 轻客户端：续页游标应向前推进，不应重复已用的游标");
        seen.add(cursor);
      }
      assert.deepEqual(resumed[0], C, "[5] 轻客户端：花费 B 后，旧游标的下一项应为 C");
      assert.deepEqual(resumed, [C, D, E], "[5] 轻客户端：合并所有续页应恰好按 C、D、E 返回");
    });
  });
});
