import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { buildCreation, devFunding, hex, until, untilCommitted, withNodeWorkspace } from "../lc_store_support";

const missingHash = () => "0x" + randomBytes(32).toString("hex");
const historicalHeight = (tip: any, offset = 150n) => {
  const height = BigInt(tip.number) - offset;
  assert.ok(height > 0n, "need a non-genesis block outside the recent-header window");
  return hex(height);
};
const terminal = (status: any) => (status?.status === "fetched" || status?.status === "not_found") && status;

describe("02 区块头与交易按需取证", function () {
  this.timeout(900_000);

  // TEST-MAP: LC-FETCH-01
  it("LC-FETCH-01 未缓存历史头的内容与全节点一致", async () => {
    // 1. 启动 1 个 CKB 全节点和连接它的 1 个轻客户端，核实创世块及唯一连接。
    // 2. 正常挖块后由全节点确定非创世历史主链头，确认轻客户端尚未缓存。
    // 3. 调用轻客户端 fetch_header，180 秒内取得与全节点一致的头并核实后置读取。
    await withNodeWorkspace("LC-FETCH-01", async run => {
      const { report } = run;
      // 1. 启动 1 个 CKB 全节点和连接它的 1 个轻客户端，核实创世块及唯一连接。
      const ckb = run.startCkbNode();
      await until("CKB RPC", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      const { node_id: nodeId } = await ckb.local_node_info();
      const light = run.startLightClient({ bootnodeId: nodeId });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[1] 轻客户端：创世块应与本轮全节点一致");
      const peers = await until("light connected", 90_000, async () => {
        const ids = (await light.get_peers()).map((p: any) => p.node_id);
        return ids.includes(nodeId) && ids;
      });
      assert.deepEqual(peers, [nodeId], "[1] 轻客户端：唯一 peer 应为本轮全节点");

      // 2. 正常挖块后由全节点确定非创世历史主链头，确认轻客户端尚未缓存。
      report.stage = "select_uncached_history";
      for (let i = 0; i < 220; i++) await ckb.generate_block();
      const tip = await ckb.get_tip_header();
      await until("light tip follows CKB", 300_000, async () => {
        const current = await light.get_tip_header();
        report.sync_progress = { full: tip.number, light: current.number };
        return current.hash === tip.hash;
      });
      const block = await ckb.get_block_by_number(historicalHeight(tip));
      const expected = await ckb.get_header(block.header.hash);
      const canonical = await ckb.get_block_hash(block.header.number);
      assert.equal(expected.hash, canonical, "[2] CKB：历史头应属于当前主链");
      assert.ok(BigInt(expected.number) > 0n, "[2] CKB：头目标应为非创世块");
      const before = await light.get_header(expected.hash);
      assert.equal(before, null, "[2] 轻客户端：请求前历史头应尚未缓存");
      report.target = { header: expected.hash, height: expected.number, extension: block.extension ?? null };
      report.extension_variant = block.extension && block.extension !== "0x" ? "sample_available" : "not_executed_no_sample";

      // 3. 调用轻客户端 fetch_header，180 秒内取得与全节点一致的头并核实后置读取。
      report.stage = "fetch_header";
      const fetched = await until("fetch historical header", 180_000,
        async () => terminal(await light.fetch_header(expected.hash)), Error);
      assert.equal(fetched.status, "fetched", "[3] 轻客户端：存在的历史头应在截止前取得");
      assert.equal(fetched.data.hash, expected.hash, "[3] 轻客户端：返回头哈希应等于请求哈希");
      assert.equal(fetched.data.number, expected.number, "[3] 轻客户端：返回头高度应等于全节点记录");
      assert.equal(fetched.data.parent_hash, expected.parent_hash, "[3] 轻客户端：返回头父哈希应等于全节点记录");
      assert.deepEqual(fetched.data, expected, "[3] 轻客户端：全部头字段应与全节点一致");
      const after = await light.get_header(expected.hash);
      assert.deepEqual(after, expected, "[3] 轻客户端：取证后公开读取应返回同一历史头");
    });
  });

  // TEST-MAP: LC-FETCH-02
  it("LC-FETCH-02 同一历史头并发与重复请求稳定", async () => {
    // 1. 启动 1 个 CKB 全节点和连接它的 1 个轻客户端，核实创世块及唯一连接。
    // 2. 正常挖块并用全节点确定一个未缓存的历史主链头。
    // 3. 并发登记同一头，逐一确认最终内容，再重复请求核实稳定性。
    await withNodeWorkspace("LC-FETCH-02", async run => {
      const { report } = run;
      // 1. 启动 1 个 CKB 全节点和连接它的 1 个轻客户端，核实创世块及唯一连接。
      const ckb = run.startCkbNode();
      await until("CKB RPC", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      const { node_id: nodeId } = await ckb.local_node_info();
      const light = run.startLightClient({ bootnodeId: nodeId });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[1] 轻客户端：创世块应与本轮全节点一致");
      const peers = await until("light connected", 90_000, async () => {
        const ids = (await light.get_peers()).map((p: any) => p.node_id);
        return ids.includes(nodeId) && ids;
      });
      assert.deepEqual(peers, [nodeId], "[1] 轻客户端：唯一 peer 应为本轮全节点");

      // 2. 正常挖块并用全节点确定一个未缓存的历史主链头。
      report.stage = "select_uncached_history";
      for (let i = 0; i < 220; i++) await ckb.generate_block();
      const tip = await ckb.get_tip_header();
      await until("light tip follows CKB", 300_000, async () => {
        const current = await light.get_tip_header();
        report.sync_progress = { full: tip.number, light: current.number };
        return current.hash === tip.hash;
      });
      const block = await ckb.get_block_by_number(historicalHeight(tip, 151n));
      const expected = await ckb.get_header(block.header.hash);
      const canonical = await ckb.get_block_hash(block.header.number);
      assert.equal(expected.hash, canonical, "[2] CKB：目标应为当前主链历史头");
      assert.ok(BigInt(expected.number) > 0n, "[2] CKB：目标应为非创世块");
      const before = await light.get_header(expected.hash);
      assert.equal(before, null, "[2] 轻客户端：并发前历史头应尚未缓存");
      report.target = { header: expected.hash, height: expected.number };

      // 3. 并发登记同一头，逐一确认最终内容，再重复请求核实稳定性。
      report.stage = "concurrent_and_repeat_header";
      const initial = await Promise.all([
        light.fetch_header(expected.hash), light.fetch_header(expected.hash), light.fetch_header(expected.hash),
      ]);
      report.initial_statuses = initial.map((r: any) => r.status);
      for (let i = 0; i < initial.length; i++) {
        assert.ok(["added", "fetching", "fetched"].includes(initial[i].status),
          `[3] 轻客户端：第 ${i + 1} 个并发调用应正常登记或取回，实际 ${initial[i].status}`);
      }
      const results = await Promise.all(initial.map(async (_: any, i: number) => {
        const result = await until(`concurrent header ${i + 1}`, 180_000,
          async () => terminal(await light.fetch_header(expected.hash)), Error);
        return result;
      }));
      for (let i = 0; i < results.length; i++) {
        assert.equal(results[i].status, "fetched", `[3] 轻客户端：第 ${i + 1} 个并发头请求应最终取得`);
        assert.deepEqual(results[i].data, expected, `[3] 轻客户端：第 ${i + 1} 个并发头应与全节点全部字段相同`);
      }
      const repeat = await light.fetch_header(expected.hash);
      assert.equal(repeat.status, "fetched", "[3] 轻客户端：重复取同一头应直接返回已取得状态");
      assert.deepEqual(repeat.data, expected, "[3] 轻客户端：重复取同一头应保持全节点内容");
    });
  });

  // TEST-MAP: LC-FETCH-03
  it("LC-FETCH-03 合法未知头返回缺失且不产生本地头", async () => {
    // 1. 启动 1 个 CKB 全节点和连接它的 1 个轻客户端，核实创世块及唯一连接。
    // 2. 正常挖块并确认一个格式合法的未知哈希在全节点和轻客户端均无头。
    // 3. 调用 fetch_header 观察缺失终态，复核两端始终没有该头。
    await withNodeWorkspace("LC-FETCH-03", async run => {
      const { report } = run;
      // 1. 启动 1 个 CKB 全节点和连接它的 1 个轻客户端，核实创世块及唯一连接。
      const ckb = run.startCkbNode();
      await until("CKB RPC", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      const { node_id: nodeId } = await ckb.local_node_info();
      const light = run.startLightClient({ bootnodeId: nodeId });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[1] 轻客户端：创世块应与本轮全节点一致");
      const peers = await until("light connected", 90_000, async () => {
        const ids = (await light.get_peers()).map((p: any) => p.node_id);
        return ids.includes(nodeId) && ids;
      });
      assert.deepEqual(peers, [nodeId], "[1] 轻客户端：唯一 peer 应为本轮全节点");

      // 2. 正常挖块并确认一个格式合法的未知哈希在全节点和轻客户端均无头。
      report.stage = "select_missing_header";
      for (let i = 0; i < 220; i++) await ckb.generate_block();
      const tip = await ckb.get_tip_header();
      await until("light tip follows CKB", 300_000, async () => {
        const current = await light.get_tip_header();
        report.sync_progress = { full: tip.number, light: current.number };
        return current.hash === tip.hash;
      });
      const hash = missingHash();
      const fullBefore = await ckb.get_header(hash);
      assert.equal(fullBefore, null, "[2] CKB：随机合法哈希不应对应链上头");
      const lightBefore = await light.get_header(hash);
      assert.equal(lightBefore, null, "[2] 轻客户端：请求前不应有该头");
      report.target = { missing_header: hash };

      // 3. 调用 fetch_header 观察缺失终态，复核两端始终没有该头。
      report.stage = "fetch_missing_header";
      const fetched = await until("missing header terminal", 180_000,
        async () => terminal(await light.fetch_header(hash)), Error);
      assert.equal(fetched.status, "not_found", "[3] 轻客户端：未知头应在截止前返回缺失终态");
      const lightAfter = await light.get_header(hash);
      assert.equal(lightAfter, null, "[3] 轻客户端：缺失终态后仍不应有该头");
      const fullAfter = await ckb.get_header(hash);
      assert.equal(fullAfter, null, "[3] CKB：结束时该头仍不在全节点主链");
    });
  });

  // TEST-MAP: LC-FETCH-04
  it("LC-FETCH-04 未缓存已确认交易的内容与归属一致", async () => {
    // 1. 启动 1 个 CKB 全节点和连接它的 1 个轻客户端，核实创世块及唯一连接。
    // 2. 在全节点正常提交并确认非 cellbase 交易，续挖历史深度并核实轻客户端尚未缓存。
    // 3. 调用 fetch_transaction，180 秒内核对完整交易、已确认状态和主链区块归属。
    await withNodeWorkspace("LC-FETCH-04", async run => {
      const { report, funder, watched } = run;
      // 1. 启动 1 个 CKB 全节点和连接它的 1 个轻客户端，核实创世块及唯一连接。
      const ckb = run.startCkbNode();
      await until("CKB RPC", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      const { node_id: nodeId } = await ckb.local_node_info();
      const light = run.startLightClient({ bootnodeId: nodeId });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[1] 轻客户端：创世块应与本轮全节点一致");
      const peers = await until("light connected", 90_000, async () => {
        const ids = (await light.get_peers()).map((p: any) => p.node_id);
        return ids.includes(nodeId) && ids;
      });
      assert.deepEqual(peers, [nodeId], "[1] 轻客户端：唯一 peer 应为本轮全节点");

      // 2. 在全节点正常提交并确认非 cellbase 交易，续挖历史深度并核实轻客户端尚未缓存。
      report.stage = "confirm_uncached_transaction";
      const { chainConfig, genesisCell } = devFunding(genesis, funder);
      const built = await buildCreation(genesisCell, funder, watched, chainConfig);
      const submitted = await ckb.send_transaction(built.raw);
      assert.equal(submitted, built.hash, "[2] CKB：提交交易应返回本地签名交易哈希");
      const confirmed = await untilCommitted("transaction", async () => {
        await ckb.generate_block();
        return ckb.get_transaction(built.hash);
      });
      assert.equal(confirmed.tx_status.status, "committed", "[2] CKB：交易应已确认");
      const block = await ckb.get_block(confirmed.tx_status.block_hash);
      const canonical = await ckb.get_block_hash(block.header.number);
      assert.equal(confirmed.tx_status.block_hash, canonical, "[2] CKB：交易所属块应为该高度主链块");
      const index = block.transactions.findIndex((t: any) => t.hash === built.hash);
      assert.ok(index > 0, `[2] CKB：交易应位于 cellbase 之后，实际索引 ${index}`);
      for (let i = 0; i < 220; i++) await ckb.generate_block();
      const tip = await ckb.get_tip_header();
      await until("light tip follows CKB", 300_000, async () => {
        const current = await light.get_tip_header();
        report.sync_progress = { full: tip.number, light: current.number };
        return current.hash === tip.hash;
      });
      const expected = await ckb.get_transaction(built.hash);
      assert.equal(expected.tx_status.block_hash, canonical, "[2] CKB：历史交易归属块应保持不变");
      const before = await light.get_transaction(built.hash);
      assert.equal(before.transaction, null, "[2] 轻客户端：取证前交易内容应尚未缓存");
      assert.equal(before.tx_status.status, "unknown", "[2] 轻客户端：取证前交易状态应未知");
      report.target = { transaction: built.hash, block_hash: canonical, block_number: block.header.number };
      report.extension_variant = block.extension && block.extension !== "0x" ? "sample_available" : "not_executed_no_sample";

      // 3. 调用 fetch_transaction，180 秒内核对完整交易、已确认状态和主链区块归属。
      report.stage = "fetch_transaction";
      const fetched = await until("fetch committed transaction", 180_000,
        async () => terminal(await light.fetch_transaction(built.hash)), Error);
      assert.equal(fetched.status, "fetched", "[3] 轻客户端：已确认交易应在截止前取得");
      assert.equal(fetched.data.transaction.hash, built.hash, "[3] 轻客户端：交易哈希应等于请求哈希");
      assert.deepEqual(fetched.data.transaction, expected.transaction, "[3] 轻客户端：完整交易内容应与全节点一致");
      assert.equal(fetched.data.tx_status.status, "committed", "[3] 轻客户端：交易应标记为已确认");
      assert.equal(fetched.data.tx_status.block_hash, canonical, "[3] 轻客户端：交易应归属于全节点确认块");
      const after = await light.get_transaction(built.hash);
      assert.deepEqual(after.transaction, expected.transaction, "[3] 轻客户端：后置公开读取应保留完整交易内容");
      assert.equal(after.tx_status.block_hash, canonical, "[3] 轻客户端：后置公开读取应保留主链区块归属");
    });
  });

  // TEST-MAP: LC-FETCH-05
  it("LC-FETCH-05 同一已确认交易并发与重复请求稳定", async () => {
    // 1. 启动 1 个 CKB 全节点和连接它的 1 个轻客户端，核实创世块及唯一连接。
    // 2. 全节点确认交易并续挖成历史交易，固定内容与区块归属，确认轻客户端未缓存。
    // 3. 并发登记同一交易，逐一确认完整内容与归属，再重复请求核实稳定性。
    await withNodeWorkspace("LC-FETCH-05", async run => {
      const { report, funder, watched } = run;
      // 1. 启动 1 个 CKB 全节点和连接它的 1 个轻客户端，核实创世块及唯一连接。
      const ckb = run.startCkbNode();
      await until("CKB RPC", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      const { node_id: nodeId } = await ckb.local_node_info();
      const light = run.startLightClient({ bootnodeId: nodeId });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[1] 轻客户端：创世块应与本轮全节点一致");
      const peers = await until("light connected", 90_000, async () => {
        const ids = (await light.get_peers()).map((p: any) => p.node_id);
        return ids.includes(nodeId) && ids;
      });
      assert.deepEqual(peers, [nodeId], "[1] 轻客户端：唯一 peer 应为本轮全节点");

      // 2. 全节点确认交易并续挖成历史交易，固定内容与区块归属，确认轻客户端未缓存。
      report.stage = "confirm_uncached_transaction";
      const { chainConfig, genesisCell } = devFunding(genesis, funder);
      const built = await buildCreation(genesisCell, funder, watched, chainConfig);
      const submitted = await ckb.send_transaction(built.raw);
      assert.equal(submitted, built.hash, "[2] CKB：提交交易应返回本地签名交易哈希");
      const confirmed = await untilCommitted("transaction", async () => {
        await ckb.generate_block();
        return ckb.get_transaction(built.hash);
      });
      assert.equal(confirmed.tx_status.status, "committed", "[2] CKB：交易应已确认");
      const block = await ckb.get_block(confirmed.tx_status.block_hash);
      const canonical = await ckb.get_block_hash(block.header.number);
      assert.equal(confirmed.tx_status.block_hash, canonical, "[2] CKB：交易应在当前主链块中");
      const index = block.transactions.findIndex((t: any) => t.hash === built.hash);
      assert.ok(index > 0, `[2] CKB：交易应位于 cellbase 之后，实际索引 ${index}`);
      for (let i = 0; i < 220; i++) await ckb.generate_block();
      const tip = await ckb.get_tip_header();
      await until("light tip follows CKB", 300_000, async () => {
        const current = await light.get_tip_header();
        report.sync_progress = { full: tip.number, light: current.number };
        return current.hash === tip.hash;
      });
      const expected = await ckb.get_transaction(built.hash);
      assert.equal(expected.tx_status.block_hash, canonical, "[2] CKB：历史交易归属块应保持不变");
      const before = await light.get_transaction(built.hash);
      assert.equal(before.transaction, null, "[2] 轻客户端：并发前交易内容应尚未缓存");
      assert.equal(before.tx_status.status, "unknown", "[2] 轻客户端：并发前交易状态应未知");
      report.target = { transaction: built.hash, block_hash: canonical, block_number: block.header.number };

      // 3. 并发登记同一交易，逐一确认完整内容与归属，再重复请求核实稳定性。
      report.stage = "concurrent_and_repeat_transaction";
      const initial = await Promise.all([
        light.fetch_transaction(built.hash), light.fetch_transaction(built.hash), light.fetch_transaction(built.hash),
      ]);
      report.initial_statuses = initial.map((r: any) => r.status);
      for (let i = 0; i < initial.length; i++) {
        assert.ok(["added", "fetching", "fetched"].includes(initial[i].status),
          `[3] 轻客户端：第 ${i + 1} 个并发调用应正常登记或取回，实际 ${initial[i].status}`);
      }
      const results = await Promise.all(initial.map(async (_: any, i: number) =>
        until(`concurrent transaction ${i + 1}`, 180_000,
          async () => terminal(await light.fetch_transaction(built.hash)), Error)));
      for (let i = 0; i < results.length; i++) {
        assert.equal(results[i].status, "fetched", `[3] 轻客户端：第 ${i + 1} 个并发交易请求应最终取得`);
        assert.deepEqual(results[i].data.transaction, expected.transaction,
          `[3] 轻客户端：第 ${i + 1} 个并发交易的完整内容应与全节点一致`);
        assert.equal(results[i].data.tx_status.status, "committed",
          `[3] 轻客户端：第 ${i + 1} 个并发交易应为已确认`);
        assert.equal(results[i].data.tx_status.block_hash, canonical,
          `[3] 轻客户端：第 ${i + 1} 个并发交易应归属同一主链块`);
      }
      const repeat = await light.fetch_transaction(built.hash);
      assert.equal(repeat.status, "fetched", "[3] 轻客户端：重复请求应直接返回已取得状态");
      assert.deepEqual(repeat.data.transaction, expected.transaction, "[3] 轻客户端：重复请求应保留完整交易内容");
      assert.equal(repeat.data.tx_status.block_hash, canonical, "[3] 轻客户端：重复请求应保留主链区块归属");
    });
  });

  // TEST-MAP: LC-FETCH-06
  it("LC-FETCH-06 合法未知交易返回缺失且不产生本地交易", async () => {
    // 1. 启动 1 个 CKB 全节点和连接它的 1 个轻客户端，核实创世块及唯一连接。
    // 2. 正常挖块并确认一个格式合法的未知交易哈希在两端均未知。
    // 3. 调用 fetch_transaction 观察缺失终态，复核两端仍无交易内容。
    await withNodeWorkspace("LC-FETCH-06", async run => {
      const { report } = run;
      // 1. 启动 1 个 CKB 全节点和连接它的 1 个轻客户端，核实创世块及唯一连接。
      const ckb = run.startCkbNode();
      await until("CKB RPC", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      const { node_id: nodeId } = await ckb.local_node_info();
      const light = run.startLightClient({ bootnodeId: nodeId });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[1] 轻客户端：创世块应与本轮全节点一致");
      const peers = await until("light connected", 90_000, async () => {
        const ids = (await light.get_peers()).map((p: any) => p.node_id);
        return ids.includes(nodeId) && ids;
      });
      assert.deepEqual(peers, [nodeId], "[1] 轻客户端：唯一 peer 应为本轮全节点");

      // 2. 正常挖块并确认一个格式合法的未知交易哈希在两端均未知。
      report.stage = "select_missing_transaction";
      for (let i = 0; i < 220; i++) await ckb.generate_block();
      const tip = await ckb.get_tip_header();
      await until("light tip follows CKB", 300_000, async () => {
        const current = await light.get_tip_header();
        report.sync_progress = { full: tip.number, light: current.number };
        return current.hash === tip.hash;
      });
      const hash = missingHash();
      const fullBefore = await ckb.get_transaction(hash);
      assert.equal(fullBefore.transaction, null, "[2] CKB：随机合法哈希不应对应交易内容");
      assert.equal(fullBefore.tx_status.status, "unknown", "[2] CKB：随机合法哈希的交易状态应未知");
      const lightBefore = await light.get_transaction(hash);
      assert.equal(lightBefore.transaction, null, "[2] 轻客户端：请求前不应有该交易内容");
      assert.equal(lightBefore.tx_status.status, "unknown", "[2] 轻客户端：请求前交易状态应未知");
      report.target = { missing_transaction: hash };

      // 3. 调用 fetch_transaction 观察缺失终态，复核两端仍无交易内容。
      report.stage = "fetch_missing_transaction";
      const fetched = await until("missing transaction terminal", 180_000,
        async () => terminal(await light.fetch_transaction(hash)), Error);
      assert.equal(fetched.status, "not_found", "[3] 轻客户端：未知交易应在截止前返回缺失终态");
      const lightAfter = await light.get_transaction(hash);
      assert.equal(lightAfter.transaction, null, "[3] 轻客户端：缺失终态后仍不应有该交易内容");
      assert.equal(lightAfter.tx_status.status, "unknown", "[3] 轻客户端：缺失终态后交易状态仍应未知");
      const fullAfter = await ckb.get_transaction(hash);
      assert.equal(fullAfter.transaction, null, "[3] CKB：结束时该交易仍不在全节点");
      assert.equal(fullAfter.tx_status.status, "unknown", "[3] CKB：结束时该交易状态仍应未知");
    });
  });

  // TEST-MAP: LC-FETCH-07
  it("LC-FETCH-07 已知与未知头及交易混合登记互不污染", async () => {
    // 1. 启动 1 个 CKB 全节点和连接它的 1 个轻客户端，核实创世块及唯一连接。
    // 2. 全节点确认交易并形成历史链，同时确定已知头与两个合法未知哈希。
    // 3. 并发登记已知与未知头，确认已知内容和未知缺失互不串号。
    // 4. 并发登记已知与未知交易，确认完整交易归属和未知缺失互不串号。
    await withNodeWorkspace("LC-FETCH-07", async run => {
      const { report, funder, watched } = run;
      // 1. 启动 1 个 CKB 全节点和连接它的 1 个轻客户端，核实创世块及唯一连接。
      const ckb = run.startCkbNode();
      await until("CKB RPC", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      const { node_id: nodeId } = await ckb.local_node_info();
      const light = run.startLightClient({ bootnodeId: nodeId });
      const lightGenesis = await until("light RPC", 90_000, () => light.get_genesis_block());
      run.checkBackend();
      assert.equal(lightGenesis.header.hash, genesis.header.hash, "[1] 轻客户端：创世块应与本轮全节点一致");
      const peers = await until("light connected", 90_000, async () => {
        const ids = (await light.get_peers()).map((p: any) => p.node_id);
        return ids.includes(nodeId) && ids;
      });
      assert.deepEqual(peers, [nodeId], "[1] 轻客户端：唯一 peer 应为本轮全节点");

      // 2. 全节点确认交易并形成历史链，同时确定已知头与两个合法未知哈希。
      report.stage = "select_mixed_targets";
      const { chainConfig, genesisCell } = devFunding(genesis, funder);
      const built = await buildCreation(genesisCell, funder, watched, chainConfig);
      const submitted = await ckb.send_transaction(built.raw);
      assert.equal(submitted, built.hash, "[2] CKB：提交交易应返回本地签名交易哈希");
      const confirmed = await untilCommitted("mixed transaction", async () => {
        await ckb.generate_block();
        return ckb.get_transaction(built.hash);
      });
      assert.equal(confirmed.tx_status.status, "committed", "[2] CKB：已知交易应确认");
      const txBlock = await ckb.get_block(confirmed.tx_status.block_hash);
      const canonicalTxBlock = await ckb.get_block_hash(txBlock.header.number);
      assert.equal(confirmed.tx_status.block_hash, canonicalTxBlock, "[2] CKB：已知交易应位于主链块");
      const txIndex = txBlock.transactions.findIndex((t: any) => t.hash === built.hash);
      assert.ok(txIndex > 0, `[2] CKB：已知交易应在 cellbase 之后，实际索引 ${txIndex}`);
      for (let i = 0; i < 220; i++) await ckb.generate_block();
      const tip = await ckb.get_tip_header();
      await until("light tip follows CKB", 300_000, async () => {
        const current = await light.get_tip_header();
        report.sync_progress = { full: tip.number, light: current.number };
        return current.hash === tip.hash;
      });
      const historical = await ckb.get_block_by_number(historicalHeight(tip));
      const expectedHeader = await ckb.get_header(historical.header.hash);
      const canonicalHeader = await ckb.get_block_hash(historical.header.number);
      assert.equal(expectedHeader.hash, canonicalHeader, "[2] CKB：已知头应为主链历史头");
      const expectedTx = await ckb.get_transaction(built.hash);
      assert.equal(expectedTx.tx_status.block_hash, canonicalTxBlock, "[2] CKB：已知交易归属应保持不变");
      const unknownHeader = missingHash();
      const unknownTx = missingHash();
      const fullMissingHeader = await ckb.get_header(unknownHeader);
      assert.equal(fullMissingHeader, null, "[2] CKB：未知头哈希不应对应主链头");
      const fullMissingTx = await ckb.get_transaction(unknownTx);
      assert.equal(fullMissingTx.transaction, null, "[2] CKB：未知交易哈希不应有交易内容");
      assert.equal(fullMissingTx.tx_status.status, "unknown", "[2] CKB：未知交易哈希状态应未知");
      const knownHeaderBefore = await light.get_header(expectedHeader.hash);
      assert.equal(knownHeaderBefore, null, "[2] 轻客户端：已知历史头请求前应未缓存");
      const missingHeaderBefore = await light.get_header(unknownHeader);
      assert.equal(missingHeaderBefore, null, "[2] 轻客户端：未知头请求前应未缓存");
      const knownTxBefore = await light.get_transaction(built.hash);
      assert.equal(knownTxBefore.transaction, null, "[2] 轻客户端：已知交易请求前应未缓存");
      const missingTxBefore = await light.get_transaction(unknownTx);
      assert.equal(missingTxBefore.transaction, null, "[2] 轻客户端：未知交易请求前应未缓存");
      report.target = { known_header: expectedHeader.hash, unknown_header: unknownHeader,
        known_transaction: built.hash, unknown_transaction: unknownTx, transaction_block: canonicalTxBlock };

      // 3. 并发登记已知与未知头，确认已知内容和未知缺失互不串号。
      report.stage = "mixed_headers";
      const [knownHeaderInitial, missingHeaderInitial] = await Promise.all([
        light.fetch_header(expectedHeader.hash), light.fetch_header(unknownHeader),
      ]);
      report.header_initial = [knownHeaderInitial.status, missingHeaderInitial.status];
      const [knownHeader, missingHeader] = await Promise.all([
        until("mixed known header", 180_000, async () => terminal(await light.fetch_header(expectedHeader.hash)), Error),
        until("mixed unknown header", 180_000, async () => terminal(await light.fetch_header(unknownHeader)), Error),
      ]);
      assert.equal(knownHeader.status, "fetched", "[3] 轻客户端：混合登记的已知头应取得");
      assert.deepEqual(knownHeader.data, expectedHeader, "[3] 轻客户端：已知头全部字段应与全节点一致");
      assert.equal(missingHeader.status, "not_found", "[3] 轻客户端：混合登记的未知头应返回缺失");
      const knownHeaderAfter = await light.get_header(expectedHeader.hash);
      assert.deepEqual(knownHeaderAfter, expectedHeader, "[3] 轻客户端：已知头后置读取应为全节点头");
      const missingHeaderAfter = await light.get_header(unknownHeader);
      assert.equal(missingHeaderAfter, null, "[3] 轻客户端：未知头仍不应有本地内容");
      const fullMissingHeaderAfter = await ckb.get_header(unknownHeader);
      assert.equal(fullMissingHeaderAfter, null, "[3] CKB：未知头结束时仍不存在");

      // 4. 并发登记已知与未知交易，确认完整交易归属和未知缺失互不串号。
      report.stage = "mixed_transactions";
      const [knownTxInitial, missingTxInitial] = await Promise.all([
        light.fetch_transaction(built.hash), light.fetch_transaction(unknownTx),
      ]);
      report.transaction_initial = [knownTxInitial.status, missingTxInitial.status];
      const [knownTx, missingTx] = await Promise.all([
        until("mixed known transaction", 180_000, async () => terminal(await light.fetch_transaction(built.hash)), Error),
        until("mixed unknown transaction", 180_000, async () => terminal(await light.fetch_transaction(unknownTx)), Error),
      ]);
      assert.equal(knownTx.status, "fetched", "[4] 轻客户端：混合登记的已知交易应取得");
      assert.deepEqual(knownTx.data.transaction, expectedTx.transaction, "[4] 轻客户端：已知交易完整内容应与全节点一致");
      assert.equal(knownTx.data.tx_status.status, "committed", "[4] 轻客户端：已知交易应已确认");
      assert.equal(knownTx.data.tx_status.block_hash, canonicalTxBlock, "[4] 轻客户端：已知交易应归属全节点主链块");
      assert.equal(missingTx.status, "not_found", "[4] 轻客户端：混合登记的未知交易应返回缺失");
      const knownTxAfter = await light.get_transaction(built.hash);
      assert.deepEqual(knownTxAfter.transaction, expectedTx.transaction, "[4] 轻客户端：已知交易后置读取应与全节点一致");
      const missingTxAfter = await light.get_transaction(unknownTx);
      assert.equal(missingTxAfter.transaction, null, "[4] 轻客户端：未知交易仍不应有本地内容");
      const fullMissingTxAfter = await ckb.get_transaction(unknownTx);
      assert.equal(fullMissingTxAfter.transaction, null, "[4] CKB：未知交易结束时仍不存在");
    });
  });
});
