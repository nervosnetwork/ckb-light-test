// TEST-MAP: LC-FILTER-01
// TEST-MAP: LC-FILTER-02
// TEST-MAP: LC-FILTER-03
// TEST-MAP: LC-FILTER-04
import assert from "node:assert/strict";
import { CKB, FEE, coversHeight, devFunding, hex, output, scriptHeight, signTransaction,
  until, untilCommitted, withNodeWorkspace, buildCreation } from "../lc_store_support";
import { capacityOf, freshAccount, hasFinalizedCheckpoint, normalizedCells, normalizedOutPoints } from "./filter_index_support";

const LIMIT = "0x40";
const INDEX_WAIT = 600_000;
const CHECKPOINT = 2_000n; // 上游 CHECK_POINT_INTERVAL；不是某次运行产生的块高。

describe("区块过滤、检查点与脚本索引", function () {
  this.timeout(2_400_000);

  it("LC-FILTER-01 命中与不命中交错，空脚本扫完后仍无 cell", async () => {
    // 1. 启动本轮 CKB 和仅连接它的轻客户端，确认创世与 peer 身份。
    // 2. 订阅 A/C，依次确认 A、B、A 输出和不命中空块，链上逐项记录独立预期。
    // 3. 等全节点 indexer 与轻客户端 A/C 脚本都追平末块，完整核对 cell 与容量。
    await withNodeWorkspace("LC-FILTER-01", async run => {
      // 1. 启动本轮 CKB 和仅连接它的轻客户端，确认创世与 peer 身份。
      const ckb = run.startCkbNode();
      await until("LC-FILTER-01 CKB RPC", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      const { node_id: nodeId } = await ckb.local_node_info();
      const light = run.startLightClient({ bootnodeId: nodeId, maxOutboundPeers: 1 });
      const lightGenesis = await until("LC-FILTER-01 light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[1] 轻客户端：创世哈希应与本轮 CKB 相同");
      const peers = await until("LC-FILTER-01 peer", 90_000, async () => {
        const rows = await light.get_peers();
        return rows.some(p => p.node_id === nodeId) && rows;
      });
      assert.deepEqual(peers.map(p => p.node_id), [nodeId], "[1] 轻客户端：应仅连接本轮 CKB");

      // 2. 订阅 A/C，依次确认 A、B、A 输出和不命中空块，链上逐项记录独立预期。
      const { funder, watched: A, report } = run;
      const { chainConfig, genesisCell } = devFunding(genesis, funder);
      const template = chainConfig.SCRIPTS.SECP256K1_BLAKE160;
      const B = freshAccount(template), C = freshAccount(template);
      const searchA = { script: A.script, script_type: "lock" };
      const searchC = { script: C.script, script_type: "lock" };
      await light.set_scripts([{ ...searchA, block_number: "0x0" }, { ...searchC, block_number: "0x0" }]);
      let funding = genesisCell;
      const expected: any[] = [];
      for (const [label, recipient] of [["A1", A], ["B1", B], ["A2", A]] as const) {
        report.stage = `create_${label}`;
        const tx = await buildCreation(funding, funder, recipient, chainConfig);
        const submitted = await ckb.send_transaction(tx.raw);
        assert.equal(submitted, tx.hash, `[2] CKB：${label} 提交哈希应与签名交易一致`);
        const confirmed = await untilCommitted(label, async () => {
          await ckb.generate_block();
          return ckb.get_transaction(tx.hash);
        });
        const block = await ckb.get_block(confirmed.tx_status.block_hash);
        const canonical = await ckb.get_block_hash(block.header.number);
        assert.equal(confirmed.tx_status.block_hash, canonical, `[2] CKB：${label} 应在主链块确认`);
        assert.ok(block.transactions.some(t => t.hash === tx.hash), `[2] CKB：${label} 块体应包含创建交易`);
        assert.deepEqual(confirmed.transaction.outputs[0].lock, recipient.script, `[2] CKB：${label} 第一个输出应为目标脚本`);
        if (recipient === A) expected.push({ out_point: { tx_hash: tx.hash, index: "0x0" },
          block_number: block.header.number, capacity: confirmed.transaction.outputs[0].capacity });
        report.transactions.push({ label, tx_hash: tx.hash, block_hash: canonical, block_number: block.header.number });
        funding = tx.change;
        await ckb.generate_block(); // 每次命中之间显式插入无 A 的正常块。
      }
      const empty1 = await ckb.generate_block();
      const empty2 = await ckb.generate_block();
      const last = await ckb.get_tip_header();
      report.stage = "interleaved_index";
      report.expected = expected;
      report.empty_blocks = [empty1, empty2];
      assert.ok(BigInt(last.number) > BigInt(expected[1].block_number), `[2] CKB：最后空块应在 A2 后，实测 ${last.number}`);

      // 3. 等全节点 indexer 与轻客户端 A/C 脚本都追平末块，完整核对 cell 与容量。
      await until("LC-FILTER-01 full indexer", INDEX_WAIT, async () => {
        const tip = await ckb.get_indexer_tip();
        report.full_indexer_tip = tip;
        return tip?.block_hash === last.hash && coversHeight(tip.block_number, last.number);
      });
      const fullA = await ckb.get_cells(searchA, "asc", LIMIT);
      const fullC = await ckb.get_cells(searchC, "asc", LIMIT);
      assert.deepEqual(normalizedCells(fullA.objects), normalizedCells(expected.map(e => ({ ...e, output: { capacity: e.capacity } }))),
        "[3] CKB：A 的全部未花费输出应恰好是两个本轮创建输出");
      assert.deepEqual(fullC.objects, [], "[3] CKB：无输出脚本 C 在全节点应为空");
      const fullCapA = await ckb.get_cells_capacity(searchA);
      const fullCapC = await ckb.get_cells_capacity(searchC);
      assert.equal(BigInt(fullCapA.capacity), expected.reduce((n, e) => n + BigInt(e.capacity), 0n),
        "[3] CKB：A 的容量应等于两笔确认输出之和");
      assert.equal(BigInt(fullCapC.capacity), 0n, "[3] CKB：C 的容量应为零");
      await until("LC-FILTER-01 A/C scripts indexed", INDEX_WAIT, async () => {
        const rows = await light.get_scripts();
        const aHeight = scriptHeight(rows, A.script), cHeight = scriptHeight(rows, C.script);
        report.script_progress = { aHeight, cHeight, target: last.number };
        return coversHeight(aHeight, last.number) && coversHeight(cHeight, last.number);
      }, Error);
      const lightA = await light.get_cells(searchA, "asc", LIMIT);
      const lightC = await light.get_cells(searchC, "asc", LIMIT);
      assert.deepEqual(normalizedCells(lightA.objects), normalizedCells(fullA.objects),
        "[3] 轻客户端：A 的精确 outpoint、块高和容量应与全节点一致");
      assert.deepEqual(lightC.objects, [], "[3] 轻客户端：C 扫完后仍应没有 cell");
      const lightCapA = await light.get_cells_capacity(searchA);
      const lightCapC = await light.get_cells_capacity(searchC);
      assert.equal(BigInt(lightCapA.capacity), BigInt(fullCapA.capacity), "[3] 轻客户端：A 容量应与全节点一致");
      assert.equal(BigInt(lightCapC.capacity), 0n, "[3] 轻客户端：C 扫完后容量应为零");
      report.actual = normalizedCells(lightA.objects);
    });
  });

  it("LC-FILTER-03 同一命中块的两个精确输出位置都入索引", async () => {
    // 1. 启动本轮 CKB 和仅连接它的轻客户端，确认创世与 peer 身份。
    // 2. 创建同笔交易中的 A0、A1、B2，确认真实块体和三个精确输出位置。
    // 3. 等两端索引追平，核对 A 的完整输出列表与容量，不把 B2 混入。
    await withNodeWorkspace("LC-FILTER-03", async run => {
      // 1. 启动本轮 CKB 和仅连接它的轻客户端，确认创世与 peer 身份。
      const ckb = run.startCkbNode();
      await until("LC-FILTER-03 CKB RPC", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      const { node_id: nodeId } = await ckb.local_node_info();
      const light = run.startLightClient({ bootnodeId: nodeId, maxOutboundPeers: 1 });
      const lightGenesis = await until("LC-FILTER-03 light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[1] 轻客户端：创世哈希应与本轮 CKB 相同");
      const peers = await until("LC-FILTER-03 peer", 90_000, async () => {
        const rows = await light.get_peers();
        return rows.some(p => p.node_id === nodeId) && rows;
      });
      assert.deepEqual(peers.map(p => p.node_id), [nodeId], "[1] 轻客户端：应仅连接本轮 CKB");

      // 2. 创建同笔交易中的 A0、A1、B2，确认真实块体和三个精确输出位置。
      const { funder, watched: A, report } = run;
      const { chainConfig, genesisCell } = devFunding(genesis, funder);
      const B = freshAccount(chainConfig.SCRIPTS.SECP256K1_BLAKE160);
      const searchA = { script: A.script, script_type: "lock" };
      await light.set_scripts([{ ...searchA, block_number: "0x0" }]);
      const amount0 = 100n * CKB, amount1 = 110n * CKB, amountB = 120n * CKB;
      const change = BigInt(genesisCell.cellOutput.capacity) - amount0 - amount1 - amountB - FEE;
      const tx = await signTransaction(genesisCell, funder,
        [output(A, amount0), output(A, amount1), output(B, amountB), output(funder, change)], chainConfig);
      const submitted = await ckb.send_transaction(tx.raw);
      assert.equal(submitted, tx.hash, "[2] CKB：提交的创建交易哈希应与签名交易一致");
      const confirmed = await untilCommitted("A0/A1/B2", async () => {
        await ckb.generate_block();
        return ckb.get_transaction(tx.hash);
      });
      const block = await ckb.get_block(confirmed.tx_status.block_hash);
      const canonical = await ckb.get_block_hash(block.header.number);
      assert.equal(confirmed.tx_status.block_hash, canonical, "[2] CKB：交易应在主链块确认");
      assert.ok(block.transactions.some(t => t.hash === tx.hash), "[2] CKB：命中块体应包含该交易");
      assert.deepEqual(confirmed.transaction.outputs.slice(0, 2).map(o => o.lock), [A.script, A.script],
        "[2] CKB：第 0、1 输出都应属于 A");
      assert.deepEqual(confirmed.transaction.outputs[2].lock, B.script, "[2] CKB：第 2 输出应属于 B");
      const expected = [{ out_point: { tx_hash: tx.hash, index: "0x0" }, block_number: block.header.number,
        output: { capacity: confirmed.transaction.outputs[0].capacity } },
      { out_point: { tx_hash: tx.hash, index: "0x1" }, block_number: block.header.number,
        output: { capacity: confirmed.transaction.outputs[1].capacity } }];
      report.expected = normalizedCells(expected);
      report.transactions.push({ tx_hash: tx.hash, block_hash: canonical, block_number: block.header.number });

      // 3. 等两端索引追平，核对 A 的完整输出列表与容量，不把 B2 混入。
      const tip = await ckb.get_tip_header();
      await until("LC-FILTER-03 full indexer", INDEX_WAIT, async () => {
        const indexerTip = await ckb.get_indexer_tip();
        report.full_indexer_tip = indexerTip;
        return indexerTip?.block_hash === tip.hash && coversHeight(indexerTip.block_number, tip.number);
      });
      const fullA = await ckb.get_cells(searchA, "asc", LIMIT);
      assert.deepEqual(normalizedCells(fullA.objects), normalizedCells(expected),
        "[3] CKB：A 应恰好具有该交易第 0、1 两个输出");
      const fullCap = await ckb.get_cells_capacity(searchA);
      assert.equal(BigInt(fullCap.capacity), amount0 + amount1, "[3] CKB：A 容量应为两个不同输出之和");
      await until("LC-FILTER-03 script indexed", INDEX_WAIT, async () => {
        const height = scriptHeight(await light.get_scripts(), A.script);
        report.script_progress = { height, target: block.header.number };
        return coversHeight(height, block.header.number);
      }, Error);
      const lightA = await light.get_cells(searchA, "asc", LIMIT);
      assert.deepEqual(normalizedOutPoints(lightA.objects), normalizedOutPoints(expected),
        "[3] 轻客户端：两个不同 index 的 outpoint 应完整返回，不混入 B2");
      assert.deepEqual(normalizedCells(lightA.objects), normalizedCells(expected),
        "[3] 轻客户端：两个输出的块高与容量应逐项对应全节点块体");
      const lightCap = await light.get_cells_capacity(searchA);
      assert.equal(BigInt(lightCap.capacity), BigInt(fullCap.capacity), "[3] 轻客户端：容量应等于全节点两输出之和");
      report.actual = normalizedCells(lightA.objects);
    });
  });

  it("LC-FILTER-02 检查点前、当块、后均索引命中输出", async () => {
    // 1. 启动本轮 CKB，确认本轮创世与初始高度。
    // 2. 正常挖到检查点前，在 1999、2000、2001 依次确认 A 输出及相邻不命中块。
    // 3. 在较低链高启动轻客户端并订阅 A，再由真实节点继续挖到证明高度。
    // 4. 等全节点 indexer 和轻客户端脚本追平，核对三个边界输出的完整列表与容量。
    await withNodeWorkspace("LC-FILTER-02", async run => {
      // 1. 启动本轮 CKB，确认本轮创世与初始高度。
      const ckb = run.startCkbNode();
      await until("LC-FILTER-02 CKB RPC", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      const { node_id: nodeId } = await ckb.local_node_info();
      const initial = await ckb.get_tip_header();
      assert.equal(BigInt(initial.number), 0n, "[1] CKB：本轮隔离链应从创世高度开始");
      const { funder, watched: A, report } = run;
      const { chainConfig, genesisCell } = devFunding(genesis, funder);
      const searchA = { script: A.script, script_type: "lock" };

      // 2. 正常挖到检查点前，在 1999、2000、2001 依次确认 A 输出及相邻不命中块。
      report.stage = "mine_checkpoint_fixture";
      const mineDeadline = Date.now() + 1_800_000;
      // 先在真实链上拆出三个独立 funding cell，避免相邻目标块的交易互相等待前一笔找零。
      const splitAmount = 200n * CKB;
      const splitChange = BigInt(genesisCell.cellOutput.capacity) - splitAmount * 3n - FEE;
      const split = await signTransaction(genesisCell, funder,
        [output(funder, splitAmount), output(funder, splitAmount), output(funder, splitAmount), output(funder, splitChange)], chainConfig);
      const splitSubmitted = await ckb.send_transaction(split.raw);
      assert.equal(splitSubmitted, split.hash, "[2] CKB：拆分 funding 的提交哈希应正确");
      const splitConfirmed = await untilCommitted("three independent funding cells", async () => {
        await ckb.generate_block();
        return ckb.get_transaction(split.hash);
      });
      assert.equal(splitConfirmed.tx_status.status, "committed", "[2] CKB：三个独立 funding cell 应先上链");
      const funding = [0n, 1n, 2n].map(index => ({ ...output(funder, splitAmount),
        outPoint: { txHash: split.hash, index: hex(index) } }));
      const splitTip = await ckb.get_tip_header();
      for (let n = BigInt(splitTip.number) + 1n; n <= CHECKPOINT - 5n; n++) {
        assert.ok(Date.now() < mineDeadline, `[2] CKB：正常挖到边界前应在 30 分钟内完成，当前目标 ${n}`);
        await until(`LC-FILTER-02 accepted height ${n}`, 60_000, async () => {
          await ckb.generate_block();
          const tip = await ckb.get_tip_header();
          return coversHeight(tip.number, hex(n)) && tip;
        });
      }
      const beforeBoundary = await ckb.get_tip_header();
      assert.equal(BigInt(beforeBoundary.number), CHECKPOINT - 5n, "[2] CKB：三笔边界交易提交前应位于 1995");
      const expected: any[] = [];
      const scheduled: Array<{label: string; height: bigint; tx: any}> = [];
      for (const [index, label, height] of [[0, "A-1", CHECKPOINT - 1n],
        [1, "A0", CHECKPOINT], [2, "A+1", CHECKPOINT + 1n]] as const) {
        const tx = await buildCreation(funding[index], funder, A, chainConfig);
        const submitted = await ckb.send_transaction(tx.raw);
        assert.equal(submitted, tx.hash, `[2] CKB：${label} 提交哈希应与签名交易一致`);
        scheduled.push({ label, height, tx });
        await until(`LC-FILTER-02 proposal height ${height - 3n}`, 60_000, async () => {
          await ckb.generate_block();
          const tip = await ckb.get_tip_header();
          return coversHeight(tip.number, hex(height - 3n)) && tip;
        });
      }
      const preCommit = await ckb.get_tip_header();
      assert.equal(BigInt(preCommit.number), CHECKPOINT - 2n, "[2] CKB：边界前的不命中块应到 1998");
      for (const { label, height, tx } of scheduled) {
        await until(`LC-FILTER-02 committed height ${height}`, 60_000, async () => {
          await ckb.generate_block();
          const tip = await ckb.get_tip_header();
          return coversHeight(tip.number, hex(height)) && tip;
        });
        const confirmed = await ckb.get_transaction(tx.hash);
        assert.equal(confirmed.tx_status.status, "committed", `[2] CKB：${label} 应在预定边界块确认`);
        const block = await ckb.get_block_by_number(hex(height));
        assert.equal(BigInt(block.header.number), height, `[2] CKB：${label} 应在预定边界高度确认`);
        const canonical = await ckb.get_block_hash(block.header.number);
        assert.equal(confirmed.tx_status.block_hash, canonical, `[2] CKB：${label} 应位于该高度的主链块`);
        assert.ok(block.transactions.some(t => t.hash === tx.hash), `[2] CKB：${label} 的块体应包含该创建交易`);
        assert.deepEqual(confirmed.transaction.outputs[0].lock, A.script, `[2] CKB：${label} 第一个输出应属于 A`);
        expected.push({ out_point: { tx_hash: tx.hash, index: "0x0" }, block_number: block.header.number,
          output: { capacity: confirmed.transaction.outputs[0].capacity } });
        report.transactions.push({ label, tx_hash: tx.hash, block_hash: canonical, block_number: block.header.number });
      }
      await until("LC-FILTER-02 accepted height 2002", 60_000, async () => {
        await ckb.generate_block(); // 2002 为边界后的不命中块。
        const tip = await ckb.get_tip_header();
        return coversHeight(tip.number, hex(CHECKPOINT + 2n)) && tip;
      });
      const afterBoundary = await ckb.get_tip_header();
      assert.equal(BigInt(afterBoundary.number), CHECKPOINT + 2n, "[2] CKB：边界后相邻块应不含 A 输出");

      // 3. 在较低链高启动轻客户端并订阅 A，再由真实节点继续挖到证明高度。
      const previousRustLog = process.env.RUST_LOG;
      process.env.RUST_LOG = "info";
      let light: ReturnType<typeof run.startLightClient>;
      try {
        light = run.startLightClient({ bootnodeId: nodeId, maxOutboundPeers: 1 });
      } finally {
        if (previousRustLog === undefined) delete process.env.RUST_LOG;
        else process.env.RUST_LOG = previousRustLog;
      }
      const lightGenesis = await until("LC-FILTER-02 light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[3] 轻客户端：创世哈希应与本轮 CKB 相同");
      const peers = await until("LC-FILTER-02 peer", 90_000, async () => {
        const rows = await light.get_peers();
        return rows.some(p => p.node_id === nodeId) && rows;
      });
      assert.deepEqual(peers.map(p => p.node_id), [nodeId], "[3] 轻客户端：应仅连接本轮 CKB");
      await light.set_scripts([{ ...searchA, block_number: hex(CHECKPOINT - 2n) }]);
      for (const height of [CHECKPOINT - 1n, CHECKPOINT, CHECKPOINT + 1n]) {
        const block = await ckb.get_block_by_number(hex(height));
        await until(`LC-FILTER-02 filter ${height}`, 90_000, () => ckb.get_block_filter(block.header.hash));
      }
      await until("LC-FILTER-02 peer proved first boundary", INDEX_WAIT, async () => {
        const rows = await light.get_peers();
        report.peer_progress = rows.map(p => p.sync_state?.proved_best_known_header?.number);
        return rows.some(p => p.node_id === nodeId &&
          coversHeight(p.sync_state?.proved_best_known_header?.number, afterBoundary.number));
      }, Error);
      for (let n = CHECKPOINT + 3n; n <= CHECKPOINT * 3n + 1n; n++) {
        assert.ok(Date.now() < mineDeadline, `[3] CKB：继续正常挖到检查点请求高度应在 30 分钟内完成，当前目标 ${n}`);
        await until(`LC-FILTER-02 accepted height ${n}`, 60_000, async () => {
          await ckb.generate_block();
          const tip = await ckb.get_tip_header();
          return coversHeight(tip.number, hex(n)) && tip;
        });
      }
      const target = await ckb.get_tip_header();
      assert.ok(BigInt(target.number) >= CHECKPOINT * 3n, `[3] CKB：已证明链高应足够请求 4000 检查点并扫描 2001，实测 ${target.number}`);
      report.expected = normalizedCells(expected);
      report.target = target;
      const finalBlock = await ckb.get_block_by_number(target.number);
      await until("LC-FILTER-02 final filter ready", 90_000, () => ckb.get_block_filter(finalBlock.header.hash));

      // 4. 等全节点 indexer 和轻客户端脚本追平，核对三个边界输出的完整列表与容量。
      report.stage = "compare_checkpoint_index";
      await until("LC-FILTER-02 full indexer", INDEX_WAIT, async () => {
        const tip = await ckb.get_indexer_tip();
        report.full_indexer_tip = tip;
        return tip?.block_hash === target.hash && coversHeight(tip.block_number, target.number);
      });
      const fullA = await ckb.get_cells(searchA, "asc", LIMIT);
      assert.deepEqual(normalizedCells(fullA.objects), normalizedCells(expected),
        "[4] CKB：边界前、当块、后应恰好各有一个 A 输出");
      const fullCap = await ckb.get_cells_capacity(searchA);
      assert.equal(BigInt(fullCap.capacity), capacityOf(expected), "[4] CKB：容量应等于三个边界输出之和");
      await until("LC-FILTER-02 A indexed through boundary", INDEX_WAIT, async () => {
        const height = scriptHeight(await light.get_scripts(), A.script);
        const lightTip = await light.get_tip_header();
        report.script_progress = { height, light_tip: lightTip.number, target: hex(CHECKPOINT + 2n) };
        return coversHeight(height, hex(CHECKPOINT + 2n)) && lightTip.hash === target.hash;
      }, Error);
      const lightA = await light.get_cells(searchA, "asc", LIMIT);
      assert.deepEqual(normalizedCells(lightA.objects), normalizedCells(expected),
        "[4] 轻客户端：检查点两侧的三个精确 outpoint、块高、容量应完整一致");
      const lightCap = await light.get_cells_capacity(searchA);
      assert.equal(BigInt(lightCap.capacity), BigInt(fullCap.capacity), "[4] 轻客户端：A 总容量应与全节点一致");
      report.actual = normalizedCells(lightA.objects);
    });
  });

  it("LC-FILTER-04 双真实 peer 跨检查点、单 peer 回扫已最终化区间、恢复后续扫新区间", async () => {
    // 1. 启动本轮 CKB A，正常创建检查点前 B/A 输出并挖过检查点请求高度。
    // 2. 启动同创世的 CKB B，显式接入 A，启动连接 A/B 的轻客户端并确认双 peer 身份和已证明高度。
    // 3. 双 peer 下订阅 A，确认跨检查点扫描结果、两端 indexer 与最终化前置日志。
    // 4. 优雅停止 B，确认只剩 A；部分添加历史 B 脚本，只要求已最终化区间内的输出可见。
    // 5. 重启 B 并恢复双 peer，在新区间创建 A 输出，确认两端新结果完整一致。
    await withNodeWorkspace("LC-FILTER-04", async run => {
      // 1. 启动本轮 CKB A，正常创建检查点前 B/A 输出并挖过检查点请求高度。
      const ckbA = run.startCkbNode("A");
      await until("LC-FILTER-04 CKB A RPC", 90_000, () => ckbA.get_tip_header());
      const genesisA = await ckbA.get_block_by_number("0x0");
      const { node_id: nodeIdA } = await ckbA.local_node_info();
      const { funder, watched: A, report } = run;
      const { chainConfig, genesisCell } = devFunding(genesisA, funder);
      const B = freshAccount(chainConfig.SCRIPTS.SECP256K1_BLAKE160);
      const searchA = { script: A.script, script_type: "lock" };
      const searchB = { script: B.script, script_type: "lock" };
      const mineDeadline = Date.now() + 1_800_000;
      report.stage = "prepare_two_peer_checkpoint";
      const splitAmount = 200n * CKB;
      const repeatedAAmount = 400n * CKB;
      const splitChange = BigInt(genesisCell.cellOutput.capacity) - splitAmount - repeatedAAmount - FEE;
      const split = await signTransaction(genesisCell, funder,
        [output(funder, splitAmount), output(funder, repeatedAAmount), output(funder, splitChange)], chainConfig);
      const splitSubmitted = await ckbA.send_transaction(split.raw);
      assert.equal(splitSubmitted, split.hash, "[1] CKB A：拆分 B/A 独立 funding 的交易哈希应正确");
      const splitConfirmed = await untilCommitted("B/A independent funding", async () => {
        await ckbA.generate_block();
        return ckbA.get_transaction(split.hash);
      });
      assert.equal(splitConfirmed.tx_status.status, "committed", "[1] CKB A：B/A 独立 funding 应先上链");
      const fundingB = { ...output(funder, splitAmount), outPoint: { txHash: split.hash, index: "0x0" } };
      const fundingA = { ...output(funder, repeatedAAmount), outPoint: { txHash: split.hash, index: "0x1" } };
      const splitTip = await ckbA.get_tip_header();
      for (let n = BigInt(splitTip.number) + 1n; n <= CHECKPOINT - 6n; n++) {
        assert.ok(Date.now() < mineDeadline, `[1] CKB A：准备真实检查点链应在 30 分钟内完成，当前目标 ${n}`);
        await until(`LC-FILTER-04 A accepted height ${n}`, 60_000, async () => {
          await ckbA.generate_block();
          const tip = await ckbA.get_tip_header();
          return coversHeight(tip.number, hex(n)) && tip;
        });
      }
      const beforeB = await ckbA.get_tip_header();
      assert.equal(BigInt(beforeB.number), CHECKPOINT - 6n, "[1] CKB A：B 提交前应处于 1994");
      const txB = await buildCreation(fundingB, funder, B, chainConfig);
      const submittedB = await ckbA.send_transaction(txB.raw);
      assert.equal(submittedB, txB.hash, "[1] CKB A：历史 B 创建交易哈希应正确");
      await until("LC-FILTER-04 accepted height 1995", 60_000, async () => {
        await ckbA.generate_block();
        const tip = await ckbA.get_tip_header();
        return coversHeight(tip.number, hex(CHECKPOINT - 5n)) && tip;
      });
      const txA1 = await buildCreation(fundingA, funder, A, chainConfig);
      const submittedA1 = await ckbA.send_transaction(txA1.raw);
      assert.equal(submittedA1, txA1.hash, "[1] CKB A：检查点前 A 创建交易哈希应正确");
      await until("LC-FILTER-04 accepted height 1996", 60_000, async () => {
        await ckbA.generate_block();
        const tip = await ckbA.get_tip_header();
        return coversHeight(tip.number, hex(CHECKPOINT - 4n)) && tip;
      });
      await until("LC-FILTER-04 accepted height 1997", 60_000, async () => {
        await ckbA.generate_block(); // 1997 为无监控脚本的相邻块。
        const tip = await ckbA.get_tip_header();
        return coversHeight(tip.number, hex(CHECKPOINT - 3n)) && tip;
      });
      const preBoundary = await ckbA.get_tip_header();
      assert.equal(BigInt(preBoundary.number), CHECKPOINT - 3n, "[1] CKB A：已挖到 1997 相邻空块");
      await until("LC-FILTER-04 accepted height 1998", 60_000, async () => {
        await ckbA.generate_block();
        const tip = await ckbA.get_tip_header();
        return coversHeight(tip.number, hex(CHECKPOINT - 2n)) && tip;
      });
      const confirmedB = await ckbA.get_transaction(txB.hash);
      assert.equal(confirmedB.tx_status.status, "committed", "[1] CKB A：B 应在 1998 确认");
      const blockB = await ckbA.get_block_by_number(hex(CHECKPOINT - 2n));
      assert.equal(confirmedB.tx_status.block_hash, blockB.header.hash, "[1] CKB A：B 应在 1998 主链块确认");
      assert.ok(blockB.transactions.some(t => t.hash === txB.hash), "[1] CKB A：历史块体应包含 B 交易");
      assert.deepEqual(confirmedB.transaction.outputs[0].lock, B.script, "[1] CKB A：历史输出脚本应属于 B");
      await until("LC-FILTER-04 accepted height 1999", 60_000, async () => {
        await ckbA.generate_block();
        const tip = await ckbA.get_tip_header();
        return coversHeight(tip.number, hex(CHECKPOINT - 1n)) && tip;
      });
      const confirmedA1 = await ckbA.get_transaction(txA1.hash);
      assert.equal(confirmedA1.tx_status.status, "committed", "[1] CKB A：A1 应在 1999 确认");
      const blockA1 = await ckbA.get_block_by_number(hex(CHECKPOINT - 1n));
      assert.equal(confirmedA1.tx_status.block_hash, blockA1.header.hash, "[1] CKB A：A1 应在 1999 主链块确认");
      assert.ok(blockA1.transactions.some(t => t.hash === txA1.hash), "[1] CKB A：检查点前块体应包含 A1 交易");
      for (let n = CHECKPOINT; n <= CHECKPOINT * 2n + 1n; n++) {
        assert.ok(Date.now() < mineDeadline, `[1] CKB A：继续挖到已证明检查点应在 30 分钟内完成，当前目标 ${n}`);
        await until(`LC-FILTER-04 A accepted height ${n}`, 60_000, async () => {
          await ckbA.generate_block();
          const tip = await ckbA.get_tip_header();
          return coversHeight(tip.number, hex(n)) && tip;
        });
      }
      const checkpointTip = await ckbA.get_tip_header();
      assert.ok(BigInt(checkpointTip.number) >= CHECKPOINT * 2n, `[1] CKB A：tip 应足够请求检查点，实测 ${checkpointTip.number}`);
      const expectedA1 = [{ out_point: { tx_hash: txA1.hash, index: "0x0" }, block_number: blockA1.header.number,
        output: { capacity: confirmedA1.transaction.outputs[0].capacity } }];
      const expectedB = [{ out_point: { tx_hash: txB.hash, index: "0x0" }, block_number: blockB.header.number,
        output: { capacity: confirmedB.transaction.outputs[0].capacity } }];
      report.transactions.push({ label: "B", tx_hash: txB.hash, block_hash: blockB.header.hash, block_number: blockB.header.number },
        { label: "A1", tx_hash: txA1.hash, block_hash: blockA1.header.hash, block_number: blockA1.header.number });

      // 2. 启动同创世的 CKB B，显式接入 A，启动连接 A/B 的轻客户端并确认双 peer 身份和已证明高度。
      const ckbB = run.startCkbNode("B");
      await until("LC-FILTER-04 CKB B RPC", 90_000, () => ckbB.get_tip_header());
      const genesisB = await ckbB.get_block_by_number("0x0");
      assert.equal(genesisB.header.hash, genesisA.header.hash, "[2] CKB B：创世哈希应与 A 相同");
      const { node_id: nodeIdB } = await ckbB.local_node_info();
      assert.notEqual(nodeIdB, nodeIdA, "[2] CKB：A/B 应是两个不同的真实 peer ID");
      await ckbB.add_node(nodeIdA, run.p2pAddress("A"));
      await until("LC-FILTER-04 B synced", INDEX_WAIT, async () => {
        const tip = await ckbB.get_tip_header();
        report.ckb_b_tip = tip;
        return tip.hash === checkpointTip.hash;
      });
      const previousRustLog = process.env.RUST_LOG;
      process.env.RUST_LOG = "info"; // 仅给本轮轻客户端的已最终化检查点前置证据启用常规日志。
      let light: ReturnType<typeof run.startLightClient>;
      try {
        light = run.startLightClient({ bootnodes: [{ node: "A", nodeId: nodeIdA },
          { node: "B", nodeId: nodeIdB }], maxOutboundPeers: 3 });
      } finally {
        if (previousRustLog === undefined) delete process.env.RUST_LOG;
        else process.env.RUST_LOG = previousRustLog;
      }
      const lightGenesis = await until("LC-FILTER-04 light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesisA.header.hash, "[2] 轻客户端：创世哈希应与 A/B 相同");
      const provedPeers = await until("LC-FILTER-04 two proved peers", INDEX_WAIT, async () => {
        const peers = await light.get_peers();
        report.peer_progress = peers.map(p => ({ node_id: p.node_id,
          proved: p.sync_state?.proved_best_known_header?.number }));
        return peers.some(p => p.node_id === nodeIdA && coversHeight(p.sync_state?.proved_best_known_header?.number, checkpointTip.number))
          && peers.some(p => p.node_id === nodeIdB && coversHeight(p.sync_state?.proved_best_known_header?.number, checkpointTip.number)) && peers;
      }, Error);
      assert.deepEqual(provedPeers.map(p => p.node_id).sort(), [nodeIdA, nodeIdB].sort(),
        "[2] 轻客户端：两个已证明 peer 应恰为 A、B");

      // 3. 双 peer 下订阅 A，确认跨检查点扫描结果、两端 indexer 与最终化前置日志。
      report.stage = "two_peer_index";
      await light.set_scripts([{ ...searchA, block_number: hex(CHECKPOINT - 2n) }]);
      await until("LC-FILTER-04 full A indexer", INDEX_WAIT, async () => {
        const tip = await ckbA.get_indexer_tip();
        report.full_indexer_tip = tip;
        return tip?.block_hash === checkpointTip.hash && coversHeight(tip.block_number, checkpointTip.number);
      });
      const fullA1 = await ckbA.get_cells(searchA, "asc", LIMIT);
      assert.deepEqual(normalizedCells(fullA1.objects), normalizedCells(expectedA1),
        "[3] CKB A：检查点前的 A1 应是完整的 A 集合");
      await until("LC-FILTER-04 A indexed", INDEX_WAIT, async () => {
        const height = scriptHeight(await light.get_scripts(), A.script);
        const tip = await light.get_tip_header();
        report.script_progress = { stage: "two_peers", height, tip: tip.number, target: hex(CHECKPOINT) };
        return coversHeight(height, hex(CHECKPOINT)) && tip.hash === checkpointTip.hash;
      }, Error);
      const lightA1 = await light.get_cells(searchA, "asc", LIMIT);
      assert.deepEqual(normalizedCells(lightA1.objects), normalizedCells(expectedA1),
        "[3] 轻客户端：双 peer 扫描后的 A1 应与全节点块体一致");
      const fullA1Cap = await ckbA.get_cells_capacity(searchA);
      const lightA1Cap = await light.get_cells_capacity(searchA);
      assert.equal(BigInt(lightA1Cap.capacity), BigInt(fullA1Cap.capacity), "[3] 轻客户端：双 peer 时 A 容量应与全节点一致");
      const lightCommand = report.commands.find(c => c.argv?.[0]?.endsWith("ckb-light-client") && c.argv.includes("run"));
      const logFile = lightCommand?.log;
      await until("LC-FILTER-04 checkpoint finalized", INDEX_WAIT, async () => hasFinalizedCheckpoint(logFile), Error);
      report.finalized_checkpoint_log = logFile;

      // 4. 优雅停止 B，确认只剩 A；部分添加历史 B 脚本，只要求已最终化区间内的输出可见。
      report.stage = "one_peer_backscan";
      await run.stopCkbNode("B");
      const remaining = await until("LC-FILTER-04 one peer remaining", 90_000, async () => {
        const peers = await light.get_peers();
        return peers.length === 1 && peers[0].node_id === nodeIdA && peers;
      }, Error);
      assert.deepEqual(remaining.map(p => p.node_id), [nodeIdA], "[4] 轻客户端：B 停止后应只剩真实 peer A");
      await light.set_scripts([{ ...searchB, block_number: hex(CHECKPOINT - 3n) }], "partial");
      const fullB = await ckbA.get_cells(searchB, "asc", LIMIT);
      assert.deepEqual(normalizedCells(fullB.objects), normalizedCells(expectedB),
        "[4] CKB A：历史 B 输出应仍是主链活 cell");
      await until("LC-FILTER-04 B backscan finalized interval", INDEX_WAIT, async () => {
        const height = scriptHeight(await light.get_scripts(), B.script);
        report.script_progress = { stage: "one_peer_backscan", height, target: hex(CHECKPOINT) };
        return coversHeight(height, hex(CHECKPOINT));
      }, Error);
      const lightB = await light.get_cells(searchB, "asc", LIMIT);
      assert.deepEqual(normalizedCells(lightB.objects), normalizedCells(expectedB),
        "[4] 轻客户端：低于 quorum 时已最终化区间的 B 输出仍应完整可见");
      const fullBCap = await ckbA.get_cells_capacity(searchB);
      const lightBCap = await light.get_cells_capacity(searchB);
      assert.equal(BigInt(lightBCap.capacity), BigInt(fullBCap.capacity), "[4] 轻客户端：B 历史容量应与全节点一致");

      // 5. 重启 B 并恢复双 peer，在新区间创建 A 输出，确认两端新结果完整一致。
      report.stage = "restore_two_peers";
      const restartedB = run.startCkbNode("B");
      await until("LC-FILTER-04 restarted B RPC", 90_000, () => restartedB.get_tip_header());
      const restartedInfo = await restartedB.local_node_info();
      assert.equal(restartedInfo.node_id, nodeIdB, "[5] CKB B：优雅重启后应沿用同一节点身份");
      await restartedB.add_node(nodeIdA, run.p2pAddress("A"));
      await until("LC-FILTER-04 two peers restored", INDEX_WAIT, async () => {
        const peers = await light.get_peers();
        report.peer_progress = peers.map(p => p.node_id);
        return peers.some(p => p.node_id === nodeIdA) && peers.some(p => p.node_id === nodeIdB) && peers;
      }, Error);
      const txA2 = await buildCreation(txA1.change, funder, A, chainConfig);
      const submittedA2 = await ckbA.send_transaction(txA2.raw);
      assert.equal(submittedA2, txA2.hash, "[5] CKB A：恢复后 A2 创建交易哈希应正确");
      const confirmedA2 = await untilCommitted("A2 after quorum restored", async () => {
        await ckbA.generate_block();
        return ckbA.get_transaction(txA2.hash);
      });
      const blockA2 = await ckbA.get_block(confirmedA2.tx_status.block_hash);
      const canonicalA2 = await ckbA.get_block_hash(blockA2.header.number);
      assert.equal(confirmedA2.tx_status.block_hash, canonicalA2, "[5] CKB A：A2 应在新区间主链块确认");
      assert.ok(blockA2.transactions.some(t => t.hash === txA2.hash), "[5] CKB A：新区间块体应包含 A2");
      const expectedA2 = { out_point: { tx_hash: txA2.hash, index: "0x0" }, block_number: blockA2.header.number,
        output: { capacity: confirmedA2.transaction.outputs[0].capacity } };
      const restoreDeadline = Date.now() + 1_800_000;
      for (let n = BigInt(blockA2.header.number) + 1n; n <= CHECKPOINT * 4n + 1n; n++) {
        assert.ok(Date.now() < restoreDeadline, `[5] CKB A：恢复后正常挖至新区间所需的证明高度应在 30 分钟内完成，目标 ${n}`);
        await until(`LC-FILTER-04 restored accepted height ${n}`, 60_000, async () => {
          await ckbA.generate_block();
          const tip = await ckbA.get_tip_header();
          return coversHeight(tip.number, hex(n)) && tip;
        });
        if (n % 250n === 0n || n === CHECKPOINT * 4n + 1n) {
          const chunkTip = await ckbA.get_tip_header();
          await until(`LC-FILTER-04 B through ${n}`, INDEX_WAIT, async () => {
            const tip = await restartedB.get_tip_header();
            report.ckb_b_tip = tip;
            return tip.hash === chunkTip.hash;
          });
          await until(`LC-FILTER-04 two peers online and light advancing ${n}`, INDEX_WAIT, async () => {
            const peers = await light.get_peers();
            const lightTip = await light.get_tip_header();
            report.peer_progress = peers.map(p => ({ node_id: p.node_id,
              proved: p.sync_state?.proved_best_known_header?.number }));
            report.light_tip = lightTip;
            return peers.some(p => p.node_id === nodeIdA) && peers.some(p => p.node_id === nodeIdB)
              && coversHeight(lightTip.number, hex(n - 250n));
          }, Error);
        }
      }
      const finalTip = await ckbA.get_tip_header();
      await until("LC-FILTER-04 B re-synced", INDEX_WAIT, async () => {
        const tip = await restartedB.get_tip_header();
        report.ckb_b_tip = tip;
        return tip.hash === finalTip.hash;
      });
      const finalPeers = await until("LC-FILTER-04 two peers online after restore", INDEX_WAIT, async () => {
        const peers = await light.get_peers();
        report.peer_progress = peers.map(p => ({ node_id: p.node_id,
          proved: p.sync_state?.proved_best_known_header?.number }));
        return peers.some(p => p.node_id === nodeIdA) && peers.some(p => p.node_id === nodeIdB) && peers;
      }, Error);
      assert.deepEqual(finalPeers.map(p => p.node_id).sort(), [nodeIdA, nodeIdB].sort(),
        "[5] 轻客户端：恢复后 A/B 两个真实 peer 应同时在线");
      const finalLightTip = await light.get_tip_header();
      assert.ok(BigInt(finalLightTip.number) > BigInt(checkpointTip.number),
        `[5] 轻客户端：恢复双 peer 后公开 tip 应向新区间推进，实测 ${finalLightTip.number}`);
      const canonicalLightTip = await ckbA.get_block_hash(finalLightTip.number);
      assert.equal(finalLightTip.hash, canonicalLightTip,
        "[5] 轻客户端：恢复后的公开 tip 应位于 A/B 的主链");
      await until("LC-FILTER-04 full indexer after restore", INDEX_WAIT, async () => {
        const tip = await ckbA.get_indexer_tip();
        report.full_indexer_tip = tip;
        return tip?.block_hash === finalTip.hash && coversHeight(tip.block_number, finalTip.number);
      });
      const fullA2 = await ckbA.get_cells(searchA, "asc", LIMIT);
      assert.deepEqual(normalizedCells(fullA2.objects), normalizedCells([...expectedA1, expectedA2]),
        "[5] CKB A：恢复后 A 应恰好有旧 A1 和新 A2");
      await until("LC-FILTER-04 A indexed after restore", INDEX_WAIT, async () => {
        const height = scriptHeight(await light.get_scripts(), A.script);
        const tip = await light.get_tip_header();
        report.script_progress = { stage: "restored", height, tip: tip.number, target: blockA2.header.number };
        return coversHeight(height, blockA2.header.number) && coversHeight(tip.number, hex(CHECKPOINT * 3n));
      }, Error);
      const lightA2 = await light.get_cells(searchA, "asc", LIMIT);
      assert.deepEqual(normalizedCells(lightA2.objects), normalizedCells([...expectedA1, expectedA2]),
        "[5] 轻客户端：恢复双 peer 后旧/新区间的 A 输出应完整一致");
      const fullFinalCap = await ckbA.get_cells_capacity(searchA);
      const lightFinalCap = await light.get_cells_capacity(searchA);
      assert.equal(BigInt(lightFinalCap.capacity), BigInt(fullFinalCap.capacity), "[5] 轻客户端：恢复后 A 总容量应与全节点一致");
      report.actual = normalizedCells(lightA2.objects);
    });
  });
});
