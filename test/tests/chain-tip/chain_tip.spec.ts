import assert from "node:assert/strict";
import { blockWork, until, withNodeWorkspace } from "../lc_store_support";

const n = (value: string) => BigInt(value);
const hex = (value: bigint) => `0x${value.toString(16)}`;
const headerFields = (h: any) => ({ epoch: h.epoch, compact_target: h.compact_target,
  transactions_root: h.transactions_root, parent_hash: h.parent_hash });


describe("LC-TIP 正常链尖通信", function () {
  this.timeout(1_800_000);

  // TEST-MAP: LC-TIP-001
  it("LC-TIP-001 未连接时为创世，连接后采用 20 块主链头", async () => {
    // 1. 启动一个隔离 CKB 并正常挖 20 块，固定其规范链尖及父块。
    // 2. 启动未连接的轻客户端，确认同创世且链尖仍为创世。
    // 3. 优雅重启轻客户端并只连接本轮 CKB，确认 180 秒内采用规范链尖。
    await withNodeWorkspace("LC-TIP-001", async (run: any) => {
      const { report } = run;
      // 1. 启动一个隔离 CKB 并正常挖 20 块，固定其规范链尖及父块。
      report.stage = "full_20";
      const ckb = run.startCkbNode();
      await until("CKB ready", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      for (let i = 0; i < 20; i++) await ckb.generate_block();
      const expected = await ckb.get_tip_header();
      const canonical = await ckb.get_block_hash(expected.number);
      const parent = await ckb.get_block_hash(hex(n(expected.number) - 1n));
      const fullHeader = await ckb.get_header(canonical);
      const { node_id: nodeId } = await ckb.local_node_info();
      assert.equal(n(expected.number), 20n, "[1] CKB：本轮正常挖块后链高应为 20");
      assert.equal(expected.hash, canonical, "[1] CKB：固定链尖应为该高度的规范块");
      assert.equal(expected.parent_hash, parent, "[1] CKB：固定链尖应连接规范父块");
      assert.deepEqual(headerFields(expected), headerFields(fullHeader), "[1] CKB：链尖块头应与按哈希查询一致");
      report.expected = { tip: expected, canonical, parent };

      // 2. 启动未连接的轻客户端，确认同创世且链尖仍为创世。
      report.stage = "light_disconnected";
      const disconnected = run.startLightClient({ bootnodes: [] });
      const lightGenesis = await until("light RPC ready", 90_000, () => disconnected.get_genesis_block());
      run.checkBackend();
      const noPeers = await disconnected.get_peers();
      const initial = await disconnected.get_tip_header();
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[2] 轻客户端：应使用本轮全节点的创世块");
      assert.deepEqual(noPeers, [], "[2] 轻客户端：连接前不应有 peer");
      assert.equal(initial.hash, genesis.header.hash, "[2] 轻客户端：未连接时链尖应为创世块");

      // 3. 优雅重启轻客户端并只连接本轮 CKB，确认 180 秒内采用规范链尖。
      report.stage = "connect_and_prove";
      await run.stopLightClient();
      const light = run.startLightClient({ bootnodeId: nodeId });
      const peers = await until("light connected", 90_000, async () => {
        const rows = await light.get_peers();
        return rows.some((p: any) => p.node_id === nodeId) && rows;
      });
      assert.deepEqual(peers.map((p: any) => p.node_id), [nodeId], "[3] 轻客户端：唯一 peer 应为本轮 CKB");
      const actual = await until("light tip at canonical 20", 180_000, async () => {
        const tip = await light.get_tip_header();
        report.last_light_tip = tip;
        return tip.hash === canonical && tip;
      }, Error);
      assert.equal(actual.number, expected.number, "[3] 轻客户端：链高应等于全节点固定链高");
      assert.equal(actual.hash, canonical, "[3] 轻客户端：链尖应为全节点规范哈希");
      assert.equal(actual.parent_hash, parent, "[3] 轻客户端：父哈希应为全节点规范父块");
      assert.deepEqual(headerFields(actual), headerFields(fullHeader), "[3] 轻客户端：块头字段应与全节点规范块一致");
      const canonicalAfterCheck = await ckb.get_block_hash(expected.number);
      assert.equal(canonicalAfterCheck, canonical, "[3] CKB：判定期间规范链尖不应改变");
    });
  });

  // TEST-MAP: LC-TIP-002
  it("LC-TIP-002 已连接后逐块订阅推进三次", async () => {
    // 1. 启动一个 CKB 和只连接它的轻客户端，先同步至非创世链尖。
    // 2. 连续三次各挖一块即停，逐步固定全节点规范哈希和父块。
    // 3. 每一步都确认轻端链尖及同一 peer 的已证明头，再进入下一步。
    await withNodeWorkspace("LC-TIP-002", async (run: any) => {
      const { report } = run;
      // 1. 启动一个 CKB 和只连接它的轻客户端，先同步至非创世链尖。
      report.stage = "connected_baseline";
      const ckb = run.startCkbNode();
      await until("CKB ready", 90_000, () => ckb.get_tip_header());
      await ckb.generate_block();
      const baseline = await ckb.get_tip_header();
      const baselineHash = await ckb.get_block_hash(baseline.number);
      const { node_id: nodeId } = await ckb.local_node_info();
      const light = run.startLightClient({ bootnodeId: nodeId });
      await until("light RPC ready", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      const connected = await until("connected to CKB", 90_000, async () => {
        const rows = await light.get_peers();
        return rows.some((p: any) => p.node_id === nodeId) && rows;
      });
      assert.deepEqual(connected.map((p: any) => p.node_id), [nodeId], "[1] 轻客户端：唯一 peer 应为本轮 CKB");
      const initial = await until("light baseline", 120_000, async () => {
        const tip = await light.get_tip_header(); return tip.hash === baselineHash && tip;
      }, Error);
      assert.equal(initial.hash, baselineHash, "[1] 轻客户端：初始链尖应为全节点规范块");
      let previousHash = baselineHash;

      for (let step = 1; step <= 3; step++) {
        // 2. 连续三次各挖一块即停，逐步固定全节点规范哈希和父块。
        report.stage = `block_${step}`;
        await ckb.generate_block();
        const expected = await ckb.get_tip_header();
        const canonical = await ckb.get_block_hash(expected.number);
        const parent = await ckb.get_block_hash(hex(n(expected.number) - 1n));
        const fullHeader = await ckb.get_header(canonical);
        assert.equal(expected.hash, canonical, `[2] CKB：第 ${step} 步链尖应为该高度规范块`);
        assert.equal(parent, previousHash, `[2] CKB：第 ${step} 步应紧接上一步规范块`);
        report[`expected_${step}`] = { tip: expected, canonical, parent };

        // 3. 每一步都确认轻端链尖及同一 peer 的已证明头，再进入下一步。
        const actual = await until(`light subscribed block ${step}`, 120_000, async () => {
          const tip = await light.get_tip_header();
          const peers = await light.get_peers();
          report[`last_${step}`] = { tip, peers };
          const proved = peers.find((p: any) => p.node_id === nodeId)?.sync_state?.proved_best_known_header;
          return tip.hash === canonical && proved?.hash === canonical && tip;
        }, Error);
        assert.equal(actual.number, expected.number, `[3] 轻客户端：第 ${step} 步链高应等于全节点`);
        assert.equal(actual.hash, canonical, `[3] 轻客户端：第 ${step} 步应采用规范哈希`);
        assert.equal(actual.parent_hash, parent, `[3] 轻客户端：第 ${step} 步应连接上一步规范块`);
        assert.deepEqual(headerFields(actual), headerFields(fullHeader), `[3] 轻客户端：第 ${step} 步块头应与规范块相同`);
        const canonicalAfterStep = await ckb.get_block_hash(expected.number);
        assert.equal(canonicalAfterStep, canonical, `[3] CKB：第 ${step} 步判定时规范哈希应未变化`);
        previousHash = canonical;
      }
    });
  });

  // TEST-MAP: LC-TIP-003
  it("LC-TIP-003 从创世落后 240 块后追上", async () => {
    // 1. 启动一个 CKB，正常挖到 240 后固定规范链尖及父块。
    // 2. 启动未连接的轻客户端，确认同创世且初始高度落后。
    // 3. 优雅重启并只连接该 CKB，确认 900 秒内追上固定链尖。
    await withNodeWorkspace("LC-TIP-003", async (run: any) => {
      const { report } = run;
      // 1. 启动一个 CKB，正常挖到 240 后固定规范链尖及父块。
      report.stage = "mine_240";
      const ckb = run.startCkbNode();
      await until("CKB ready", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      for (let i = 0; i < 300; i++) {
        const current = await ckb.get_tip_header();
        if (n(current.number) >= 240n) break;
        await ckb.generate_block();
      }
      const expected = await ckb.get_tip_header();
      const canonical = await ckb.get_block_hash(expected.number);
      const parent = await ckb.get_block_hash(hex(n(expected.number) - 1n));
      const fullHeader = await ckb.get_header(canonical);
      const { node_id: nodeId } = await ckb.local_node_info();
      assert.equal(n(expected.number), 240n, "[1] CKB：本轮链高应为 240");
      assert.equal(expected.hash, canonical, "[1] CKB：链尖应为该高度规范块");
      report.expected = { tip: expected, canonical, parent };

      // 2. 启动未连接的轻客户端，确认同创世且初始高度落后。
      report.stage = "lagged_light";
      const disconnected = run.startLightClient({ bootnodes: [] });
      const lightGenesis = await until("light RPC ready", 90_000, () => disconnected.get_genesis_block());
      run.checkBackend();
      const noPeers = await disconnected.get_peers();
      const initial = await disconnected.get_tip_header();
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[2] 轻客户端：创世块应与本轮 CKB 相同");
      assert.deepEqual(noPeers, [], "[2] 轻客户端：连接前应没有 peer");
      assert.equal(initial.hash, genesis.header.hash, "[2] 轻客户端：追赶起点应为创世块");
      assert.ok(n(initial.number) < n(expected.number), `[2] 轻客户端：起点 ${initial.number} 应落后于 ${expected.number}`);

      // 3. 优雅重启并只连接该 CKB，确认 900 秒内追上固定链尖。
      report.stage = "catch_up";
      await run.stopLightClient();
      const light = run.startLightClient({ bootnodeId: nodeId });
      const connected = await until("light connected", 90_000, async () => {
        const rows = await light.get_peers(); return rows.some((p: any) => p.node_id === nodeId) && rows;
      });
      assert.deepEqual(connected.map((p: any) => p.node_id), [nodeId], "[3] 轻客户端：唯一 peer 应为本轮 CKB");
      const actual = await until("light caught up to 240", 900_000, async () => {
        const tip = await light.get_tip_header();
        report.last_light_tip = tip;
        assert.ok(n(tip.number) <= n(expected.number), `[3] 轻客户端：追赶高度 ${tip.number} 不应超过固定全节点高度 ${expected.number}`);
        return tip.hash === canonical && tip;
      }, Error);
      assert.equal(actual.number, expected.number, "[3] 轻客户端：最终链高应等于全节点");
      assert.equal(actual.hash, canonical, "[3] 轻客户端：最终哈希应为规范哈希");
      assert.equal(actual.parent_hash, parent, "[3] 轻客户端：最终父哈希应为规范父块");
      assert.deepEqual(headerFields(actual), headerFields(fullHeader), "[3] 轻客户端：最终块头字段应等于规范块");
      const canonicalAfterCatchUp = await ckb.get_block_hash(expected.number);
      assert.equal(canonicalAfterCatchUp, canonical, "[3] CKB：判定期间规范链尖应未变化");
    });
  });

  // TEST-MAP: LC-TIP-004
  it("LC-TIP-004 两条有效短分叉收敛后选择较高累计难度链", async () => {
    // 1. 启动 A、B 两个同创世 CKB，使其共享至少 120 块祖先，并启动只连接 A 的轻客户端。
    // 2. 公开断开 A/B，A 挖两块且轻客户端确实采用 A-tip，B 独立挖四块。
    // 3. 验证两条有效分叉及 B 的累计难度更高，再公开重连 A/B。
    // 4. 等 A/B 规范链收敛，确认轻客户端采用 B-tip 与其规范父块。
    await withNodeWorkspace("LC-TIP-004", async (run: any) => {
      const { report } = run;
      // 1. 启动 A、B 两个同创世 CKB，使其共享至少 120 块祖先，并启动只连接 A 的轻客户端。
      report.stage = "shared_ancestor";
      const A = run.startCkbNode("A");
      const B = run.startCkbNode("B");
      await until("A ready", 90_000, () => A.get_tip_header());
      await until("B ready", 90_000, () => B.get_tip_header());
      const ga = await A.get_block_by_number("0x0");
      const gb = await B.get_block_by_number("0x0");
      assert.equal(gb.header.hash, ga.header.hash, "[1] CKB B：创世块应与 A 相同");
      const { node_id: idA } = await A.local_node_info();
      const { node_id: idB } = await B.local_node_info();
      await A.add_node(idB, run.p2pAddress("B"));
      await until("A/B connected", 90_000, async () => {
        const pa = await A.get_peers(), pb = await B.get_peers();
        return pa.some((p: any) => p.node_id === idB) && pb.some((p: any) => p.node_id === idA);
      });
      for (let i = 0; i < 150; i++) {
        const current = await A.get_tip_header();
        if (n(current.number) >= 120n) break;
        await A.generate_block();
      }
      const fork = await A.get_tip_header();
      await until("B synced shared ancestor", 300_000, async () => {
        const hash = await B.get_block_hash(fork.number); return hash === fork.hash;
      }, Error);
      const light = run.startLightClient({ bootnodeId: idA });
      await until("light RPC ready", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      const baseline = await until("light at ancestor", 300_000, async () => {
        const tip = await light.get_tip_header(); return tip.hash === fork.hash && tip;
      }, Error);
      assert.equal(baseline.hash, fork.hash, "[1] 轻客户端：分叉前应采用共同祖先");
      const lightPeers = await light.get_peers();
      assert.deepEqual(lightPeers.map((p: any) => p.node_id), [idA], "[1] 轻客户端：只应连接 A");

      // 2. 公开断开 A/B，A 挖两块且轻客户端确实采用 A-tip，B 独立挖四块。
      report.stage = "two_valid_branches";
      await A.remove_node(idB);
      await B.remove_node(idA);
      await until("A/B disconnected", 90_000, async () => {
        const pa = await A.get_peers(), pb = await B.get_peers();
        return !pa.some((p: any) => p.node_id === idB) && !pb.some((p: any) => p.node_id === idA);
      }, Error);
      for (let i = 0; i < 2; i++) await A.generate_block();
      const oldTip = await A.get_tip_header();
      const oldHash = await A.get_block_hash(oldTip.number);
      const adoptedA = await until("light at A tip", 120_000, async () => {
        const tip = await light.get_tip_header(); return tip.hash === oldHash && tip;
      }, Error);
      assert.equal(adoptedA.hash, oldHash, "[2] 轻客户端：重组前应确实采用 A 的规范链尖");
      for (let i = 0; i < 4; i++) await B.generate_block();
      const newTip = await B.get_tip_header();
      const newHash = await B.get_block_hash(newTip.number);
      const newParent = await B.get_block_hash(hex(n(newTip.number) - 1n));
      const newHeader = await B.get_header(newHash);
      report.branches = { fork, oldTip, newTip };

      // 3. 验证两条有效分叉及 B 的累计难度更高，再公开重连 A/B。
      report.stage = "branch_preconditions";
      const forkNumber = n(fork.number);
      assert.ok(forkNumber >= 120n, `[3] CKB：共同祖先高度 ${fork.number} 应至少为 120`);
      const bForkHash = await B.get_block_hash(fork.number);
      assert.equal(bForkHash, fork.hash, "[3] CKB B：分叉点应与 A 相同");
      const aFirst = await A.get_block_hash(hex(forkNumber + 1n));
      const bFirst = await B.get_block_hash(hex(forkNumber + 1n));
      assert.notEqual(bFirst, aFirst, "[3] CKB：两条有效分叉在 F+1 应有不同哈希");
      let tdA = 0n, tdB = 0n;
      for (let i = 1n; i <= 2n; i++) {
        const hash = await A.get_block_hash(hex(forkNumber + i));
        const head = await A.get_header(hash);
        tdA += blockWork(head.compact_target);
      }
      for (let i = 1n; i <= 4n; i++) {
        const hash = await B.get_block_hash(hex(forkNumber + i));
        const head = await B.get_header(hash);
        tdB += blockWork(head.compact_target);
      }
      assert.ok(tdB > tdA, `[3] CKB：B 分支累计难度 ${tdB} 应高于 A 的 ${tdA}`);
      await A.add_node(idB, run.p2pAddress("B"));

      // 4. 等 A/B 规范链收敛，确认轻客户端采用 B-tip 与其规范父块。
      report.stage = "reorg_to_B";
      await until("A/B canonical B tip", 300_000, async () => {
        const ta = await A.get_tip_header(), tb = await B.get_tip_header();
        const ha = await A.get_block_hash(newTip.number), hb = await B.get_block_hash(newTip.number);
        report.last_full_tips = { ta, tb, ha, hb };
        return ta.hash === newHash && tb.hash === newHash && ha === newHash && hb === newHash;
      }, Error);
      const aForkHash = await A.get_block_hash(hex(forkNumber + 1n));
      assert.equal(aForkHash, bFirst, "[4] CKB A：F+1 规范哈希应切换到 B 分支");
      assert.notEqual(aForkHash, aFirst, "[4] CKB A：旧 A 分支 F+1 不应仍是规范块");
      const actual = await until("light canonical B tip", 300_000, async () => {
        const tip = await light.get_tip_header(); report.last_light_tip = tip;
        return tip.hash === newHash && tip;
      }, Error);
      assert.equal(actual.number, newTip.number, "[4] 轻客户端：应达到 B 分支链高");
      assert.equal(actual.hash, newHash, "[4] 轻客户端：应采用 B 分支规范链尖");
      assert.equal(actual.parent_hash, newParent, "[4] 轻客户端：父哈希应为 B 分支规范父块");
      assert.deepEqual(headerFields(actual), headerFields(newHeader), "[4] 轻客户端：块头字段应与 B 规范块一致");
      const finalPeers = await light.get_peers();
      assert.deepEqual(finalPeers.map((p: any) => p.node_id), [idA], "[4] 轻客户端：换链后仍只应连接 A");
      const aCanonicalAfterCheck = await A.get_block_hash(newTip.number);
      assert.equal(aCanonicalAfterCheck, newHash, "[4] CKB A：判定期间规范链尖不应改变");
    });
  });
});
