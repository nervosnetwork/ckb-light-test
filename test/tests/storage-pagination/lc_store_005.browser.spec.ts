// TEST-MAP: LC-STORE-005
// Browser-only: collected by the dedicated --browser integration entry, never by native CI.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CKB_DEV_BROWSER_BUNDLE } from "../../../config/dev_paths";
import {
  buildCreation, CKB, coversHeight, devFunding, FEE, output, signTransaction,
  PrerequisiteError, until, withNodeWorkspace,
} from "../lc_store_support";
import { withBrowserRuntime } from "./browser_runtime";

const ID = "LC-STORE-005";
const ALL = 64;
const bundle = path.resolve(process.cwd(), CKB_DEV_BROWSER_BUNDLE);
const fullTxRow = (x: any) => ({ hash: x.tx_hash, block: String(BigInt(x.block_number)),
  txIndex: String(BigInt(x.tx_index)), ioType: x.io_type, ioIndex: String(BigInt(x.io_index)) });
const point = (x: any) => ({ tx_hash: x.tx_hash, index: x.index });
function browserConfig(database: string, bootnode: string | null) {
  return `chain = "dev"\n[store]\npath = "${database}"\n[network]\npath = "${database}-network"\n` +
    `listen_addresses = []\nbootnodes = ${JSON.stringify(bootnode ? [bootnode] : [])}\n` +
    `max_peers = 4\nmax_outbound_peers = 1\nping_interval_secs = 120\n` +
    `ping_timeout_secs = 1200\nconnect_outbound_interval_secs = 2\n` +
    `upnp = false\ndiscovery_local_address = false\nbootnode_mode = false\n` +
    `[rpc]\nlisten_address = "127.0.0.1:0"\n`;
}

describe(ID, function () {
  this.timeout(1_800_000);
  it("真实 dev WebSocket 与 IndexedDB：同块父子交易、浏览器重建和续扫", async () => {
    // 1. 启动 1 个带回环 WebSocket 的隔离 dev 全节点，浏览器以 DevNet 和同源 IndexedDB 连接它。
    // 2. 向全节点正常提交父交易 P 与子交易 Q，验证同一主链块里 P 在 Q 前，Q 花费 P 的受监控输出。
    // 3. 等全节点索引器和浏览器轻端追平 Q，公开活集、容量及历史与全节点独立预期一致。
    // 4. 正常 stop 浏览器客户端和全节点，重建同源页面/worker；无 peer 时原索引与 tip 不丢。
    // 5. 同库重启全节点，浏览器客户端回连并索引新交易 R；结果再次逐项等于全节点。
    await withNodeWorkspace(ID, async run => {
      // 1. 启动 1 个带回环 WebSocket 的隔离 dev 全节点，浏览器以 DevNet 和同源 IndexedDB 连接它。
      const { report, funder, watched } = run;
      report.stage = "browser_preflight";
      if (!fs.existsSync(bundle)) throw new PrerequisiteError(`browser bundle not built: ${bundle}`);
      let ckb = run.startCkbNode("A", { websocket: true });
      await until("CKB RPC", 90_000, () => ckb.get_tip_header());
      const genesis = await ckb.get_block_by_number("0x0");
      const { node_id: idA } = await ckb.local_node_info();
      const spec = run.readChainSpec();
      const bootnode = `${run.wsAddress("A")}/p2p/${idA}`;
      const database = `lc-store-005-${randomBytes(12).toString("hex")}`;
      const secret = "0x" + randomBytes(32).toString("hex");
      report.browser_fixture = { database, bootnode, genesis: genesis.header.hash };
      await withBrowserRuntime(bundle, report, async browser => {
        const environment = await browser.call("environment");
        assert.deepEqual(environment, { crossOriginIsolated: true, sharedArrayBuffer: "function", indexedDB: "object" },
          "[1] 浏览器：应具备跨源隔离、SharedArrayBuffer 和真实 IndexedDB");
        await browser.call("start", { type: "DevNet", spec, config: browserConfig(database, bootnode) }, secret);
        report.backend = "indexeddb";
        const browserGenesis = await browser.call("getGenesisBlock");
        assert.equal(browserGenesis.hash, genesis.header.hash, "[1] 浏览器轻端：DevNet 创世哈希应与本轮 CKB 相同");
        const connected = await until("browser connected to CKB WebSocket", 90_000, async () => {
          const ids = await browser.call("getPeers");
          return ids.includes(idA) && ids;
        });
        assert.deepEqual(connected, [idA], "[1] 浏览器轻端：唯一 peer 应为本轮 CKB 的 WebSocket 节点");
        const search = { script: watched.lock, scriptType: "lock", withData: false };
        const fullSearch = { script: watched.script, script_type: "lock" };
        await browser.call("setScripts", [{ script: watched.lock, scriptType: "lock", blockNumber: "0x0" }]);

        // 2. 向全节点正常提交父交易 P 与子交易 Q，验证同一主链块里 P 在 Q 前，Q 花费 P 的受监控输出。
        report.stage = "same_block_P_Q";
        const { chainConfig, genesisCell } = devFunding(genesis, funder);
        const P = await buildCreation(genesisCell, funder, watched, chainConfig);
        const pOut = { tx_hash: P.hash, index: "0x0" };
        const pCell = { cellOutput: P.signed.outputs[0], data: "0x", outPoint: { txHash: P.hash, index: "0x0" } };
        const Q = await signTransaction(pCell, watched, [output(watched, 100n * CKB - FEE)], chainConfig);
        const qOut = { tx_hash: Q.hash, index: "0x0" };
        assert.deepEqual(Q.raw.inputs.map(i => i.previous_output), [pOut], "[2] 签名交易：Q 唯一输入应为 P 的受监控输出");
        const submittedP = await ckb.send_transaction(P.raw);
        assert.equal(submittedP, P.hash, "[2] CKB：P 应按签名哈希提交");
        const submittedQ = await ckb.send_transaction(Q.raw);
        assert.equal(submittedQ, Q.hash, "[2] CKB：Q 应按签名哈希提交");
        let pReceipt: any, qReceipt: any;
        for (let i = 0; i < 20; i++) {
          await ckb.generate_block();
          pReceipt = await ckb.get_transaction(P.hash);
          qReceipt = await ckb.get_transaction(Q.hash);
          if (pReceipt?.tx_status?.status === "committed" && qReceipt?.tx_status?.status === "committed") break;
        }
        assert.equal(pReceipt?.tx_status?.status, "committed", "[2] CKB：P 应在正常挖块后确认");
        assert.equal(qReceipt?.tx_status?.status, "committed", "[2] CKB：Q 应在正常挖块后确认");
        assert.equal(qReceipt.tx_status.block_hash, pReceipt.tx_status.block_hash,
          "[2] CKB：P 和 Q 应在同一非创世块确认");
        const pqBlock = await ckb.get_block(qReceipt.tx_status.block_hash);
        assert.ok(BigInt(pqBlock.header.number) > 0n, "[2] CKB：P/Q 所在块应非创世块");
        const indices = [P.hash, Q.hash].map(hash => pqBlock.transactions.findIndex(t => t.hash === hash));
        assert.ok(indices[0] > 0 && indices[1] > indices[0],
          `[2] CKB：块体应先 P 后 Q，实际交易序号 ${indices.join(",")}`);
        assert.deepEqual(qReceipt.transaction.inputs.map(i => i.previous_output), [pOut],
          "[2] CKB：链上 Q 唯一输入应确切花费 P 输出");
        const pqCanonical = await ckb.get_block_hash(pqBlock.header.number);
        assert.equal(pqCanonical, qReceipt.tx_status.block_hash, "[2] CKB：P/Q 所在块应为主链块");
        report.transactions.push({ label: "P", hash: P.hash, block: pqCanonical },
          { label: "Q", hash: Q.hash, block: pqCanonical, input: pOut });

        // 3. 等全节点索引器和浏览器轻端追平 Q，公开活集、容量及历史与全节点独立预期一致。
        report.stage = "browser_indexed_Q";
        const H = await ckb.get_tip_header();
        await until("CKB indexer through P/Q", 300_000, async () => {
          const tip = await ckb.get_indexer_tip();
          return tip?.block_hash === H.hash && coversHeight(tip.block_number, H.number);
        });
        const fullCells = await ckb.get_cells(fullSearch, "asc", "0x40");
        const fullCapacity = await ckb.get_cells_capacity(fullSearch);
        const fullHistory = await ckb.get_transactions({ ...fullSearch, group_by_transaction: false }, "asc", "0x40");
        assert.deepEqual(fullCells.objects.map(c => point(c.out_point)), [qOut],
          "[3] CKB：P 输出已花费，当前活集应只有 Q 输出");
        assert.equal(BigInt(fullCapacity.capacity), 100n * CKB - FEE, "[3] CKB：活容量应为 Q 输出容量");
        assert.deepEqual(fullHistory.objects.map(fullTxRow).map(r => r.hash), [P.hash, Q.hash, Q.hash],
          "[3] CKB：历史应依次为 P 输出、Q 输入、Q 输出");
        await until("browser indexed Q", 600_000, async () => {
          const scripts = await browser.call("getScripts");
          const height = scripts.find(s => s.script.args === watched.lock.args)?.blockNumber;
          const tip = await browser.call("getTipHeader");
          const cells = await browser.call("getCells", search, "asc", ALL);
          report.sync_progress = { stage: "Q", height, tip: tip.hash, cells: cells.cells };
          return tip.hash === H.hash && coversHeight(height, pqBlock.header.number)
            && cells.cells.length === 1 && cells.cells[0].outPoint.tx_hash === Q.hash;
        }, Error);
        const browserCells = await browser.call("getCells", search, "asc", ALL);
        assert.deepEqual(browserCells.cells.map(c => c.outPoint), [qOut], "[3] 浏览器轻端：活集应恰好只有 Q 输出");
        const browserCapacity = await browser.call("getCellsCapacity", search);
        assert.equal(BigInt(browserCapacity), BigInt(fullCapacity.capacity), "[3] 浏览器轻端：活容量应等于 CKB indexer");
        const browserHistory = await browser.call("getTransactions", { ...search, groupByTransaction: false }, "asc", ALL);
        assert.deepEqual(browserHistory.rows, fullHistory.objects.map(fullTxRow),
          "[3] 浏览器轻端：未分组历史应与 CKB 完整有序列表相同");

        // 4. 正常 stop 浏览器客户端和全节点，重建同源页面/worker；无 peer 时原索引与 tip 不丢。
        report.stage = "browser_offline_restart";
        await browser.call("stop");
        await run.stopCkbNode("A");
        await browser.reload();
        await browser.call("start", { type: "DevNet", spec, config: browserConfig(database, null) }, secret);
        const offlinePeers = await browser.call("getPeers");
        assert.deepEqual(offlinePeers, [], "[4] 浏览器轻端：CKB 离线时应无 peer");
        const offlineTip = await browser.call("getTipHeader");
        assert.deepEqual(offlineTip, { number: String(BigInt(H.number)), hash: H.hash },
          "[4] 浏览器轻端：同源 IndexedDB 重建后应保留已接受 tip");
        const offlineCells = await browser.call("getCells", search, "asc", ALL);
        assert.deepEqual(offlineCells.cells.map(c => c.outPoint), [qOut], "[4] 浏览器轻端：离线重建后仍应只有 Q 活输出");
        const offlineCapacity = await browser.call("getCellsCapacity", search);
        assert.equal(BigInt(offlineCapacity), BigInt(fullCapacity.capacity), "[4] 浏览器轻端：离线重建后容量应不变");
        const offlineHistory = await browser.call("getTransactions", { ...search, groupByTransaction: false }, "asc", ALL);
        assert.deepEqual(offlineHistory.rows, fullHistory.objects.map(fullTxRow),
          "[4] 浏览器轻端：离线重建后历史应逐项不变");

        // 5. 同库重启全节点，浏览器客户端回连并索引新交易 R；结果再次逐项等于全节点。
        report.stage = "browser_resume_R";
        await browser.call("stop");
        ckb = run.startCkbNode("A", { websocket: true });
        await until("restarted CKB RPC", 90_000, () => ckb.get_tip_header());
        await browser.call("start", { type: "DevNet", spec, config: browserConfig(database, bootnode) }, secret);
        const peers = await until("browser reconnects to CKB", 90_000, async () => {
          const ids = await browser.call("getPeers");
          return ids.includes(idA) && ids;
        });
        assert.deepEqual(peers, [idA], "[5] 浏览器轻端：重连后唯一 peer 应仍是本轮 CKB");
        const R = await buildCreation(P.change, funder, watched, chainConfig);
        const submittedR = await ckb.send_transaction(R.raw);
        assert.equal(submittedR, R.hash, "[5] CKB：R 应按签名哈希提交");
        let rReceipt: any;
        for (let i = 0; i < 20; i++) {
          await ckb.generate_block();
          rReceipt = await ckb.get_transaction(R.hash);
          if (rReceipt?.tx_status?.status === "committed") break;
        }
        assert.equal(rReceipt?.tx_status?.status, "committed", "[5] CKB：R 应在正常挖块后确认");
        const rBlock = await ckb.get_block(rReceipt.tx_status.block_hash);
        const rHash = await ckb.get_block_hash(rBlock.header.number);
        assert.equal(rHash, rReceipt.tx_status.block_hash, "[5] CKB：R 应在主链确认");
        const ROut = { tx_hash: R.hash, index: "0x0" };
        const finalTip = await ckb.get_tip_header();
        await until("CKB indexer through R", 300_000, async () => {
          const tip = await ckb.get_indexer_tip();
          return tip?.block_hash === finalTip.hash && coversHeight(tip.block_number, finalTip.number);
        });
        const finalFullCells = await ckb.get_cells(fullSearch, "asc", "0x40");
        const finalFullHistory = await ckb.get_transactions({ ...fullSearch, group_by_transaction: false }, "asc", "0x40");
        assert.deepEqual(finalFullCells.objects.map(c => point(c.out_point)), [qOut, ROut],
          "[5] CKB：续链后应只有 Q、R 两个监控活输出");
        await until("browser indexed R", 600_000, async () => {
          const scripts = await browser.call("getScripts");
          const height = scripts.find(s => s.script.args === watched.lock.args)?.blockNumber;
          const tip = await browser.call("getTipHeader");
          const cells = await browser.call("getCells", search, "asc", ALL);
          report.sync_progress = { stage: "R", height, tip: tip.hash, cells: cells.cells };
          return tip.hash === finalTip.hash && coversHeight(height, rBlock.header.number)
            && cells.cells.some(c => c.outPoint.tx_hash === R.hash);
        }, Error);
        const finalBrowserCells = await browser.call("getCells", search, "asc", ALL);
        assert.deepEqual(finalBrowserCells.cells.map(c => c.outPoint), finalFullCells.objects.map(c => point(c.out_point)),
          "[5] 浏览器轻端：续扫活集应与 CKB 完整有序列表一致");
        const finalFullCapacity = await ckb.get_cells_capacity(fullSearch);
        const finalBrowserCapacity = await browser.call("getCellsCapacity", search);
        assert.equal(BigInt(finalBrowserCapacity), BigInt(finalFullCapacity.capacity),
          "[5] 浏览器轻端：续扫容量应与 CKB indexer 一致");
        const finalBrowserHistory = await browser.call("getTransactions", { ...search, groupByTransaction: false }, "asc", ALL);
        assert.deepEqual(finalBrowserHistory.rows, finalFullHistory.objects.map(fullTxRow),
          "[5] 浏览器轻端：续扫历史应与 CKB 完整有序列表一致");
        await browser.call("stop");
      });
    });
  });
});
