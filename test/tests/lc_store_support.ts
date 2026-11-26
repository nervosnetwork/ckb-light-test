import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import { isDeepStrictEqual } from "node:util";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { commons, config, hd, helpers, utils } from "@ckb-lumos/lumos";
import { blockchain } from "@ckb-lumos/base";
import { ParamsFormatter, ResultFormatter } from "@ckb-lumos/rpc";
import { CKB_DEV_PATH, CKB_DEV_LIGHT_CLIENT_PATH } from "../../config/dev_paths";

export type Backend = "rocksdb" | "sqlite";
export interface Options { workdir: string; expectedBackend?: Backend }
export interface Report { case_id: string; backend: Backend | "indexeddb" | "undetected"; status: string; command: string[];
  started_at: string; finished_at?: string; stage: string; commands: any[]; transactions: any[];
  output_ready: boolean; rpc_trace?: string; error?: any; [key: string]: any }
export class PrerequisiteError extends Error {}
export const FUNDING_KEY = "0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc";
export const CKB = 100_000_000n;
export const FEE = 100_000n;
export const hex = (n: bigint) => "0x" + n.toString(16);
// CKB compact target uses an unsigned 24-bit mantissa. A branch's work is
// the sum of these per-header difficulties after its common ancestor.
export function blockWork(compactTarget: string): bigint {
  const compact = BigInt(compactTarget);
  const exponent = compact >> 24n;
  const mantissa = compact & 0xff_ffffn;
  if (exponent > 32n || mantissa === 0n) return 0n;
  const target = exponent <= 3n
    ? mantissa >> (8n * (3n - exponent))
    : mantissa << (8n * (exponent - 3n));
  if (target === 0n) return 0n;
  const hashSpace = 1n << 256n;
  return target === 1n ? hashSpace - 1n : hashSpace / target;
}
export interface OutPoint { tx_hash: string; index: string }
export const outPoints = (rows: Array<{ out_point: OutPoint }>) => rows.map(row => row.out_point);
export const serial = (x: OutPoint) => `${x.tx_hash}:${BigInt(x.index)}`;
export const position = (cell: any) => [BigInt(cell.block_number), BigInt(cell.tx_index), BigInt(cell.out_point.index)];
export const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// Hold the port reservations together so two roles in one test can never receive the same port.
async function freePorts(count: number): Promise<number[]> {
  const reservations: net.Server[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
      reservations.push(server);
    }
    return reservations.map(s => (s.address() as net.AddressInfo).port);
  } finally {
    await Promise.all(reservations.map(s => new Promise(resolve => s.close(resolve))));
  }
}
export async function freePort(): Promise<number> { return (await freePorts(1))[0]; }

export async function until(label: string, timeoutMs: number, read: () => Promise<any>,
  ErrorType: any = PrerequisiteError): Promise<any> {
  const end = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < end) {
    try { const value = await read(); if (value) return value; last = "not ready"; }
    catch (error) { last = error.message; }
    await sleep(1000);
  }
  throw new ErrorType(`${label} timed out after ${timeoutMs}ms; last=${last}`);
}
export function start(binary: string, argv: string[], logFile: string, commands: any[]): any {
  const fd = fs.openSync(logFile, "w");
  const child = spawn(binary, argv, { stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  commands.push({ argv: [binary, ...argv], pid: child.pid, log: logFile });
  return child;
}
export async function stop(child: ReturnType<typeof spawn> | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = (ms: number) => new Promise<boolean>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const exited = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.removeListener("exit", exited); resolve(false); }, ms);
    child.once("exit", exited);
  });
  child.kill("SIGINT");
  if (await waitForExit(20_000)) return;
  child.kill("SIGTERM");
  if (await waitForExit(8_000)) return;
  child.kill("SIGKILL");
  await waitForExit(5_000);
  throw new Error(`node ${child.pid} did not stop gracefully; kept its data and logs`);
}
export function account(key: string, scriptTemplate: any): any {
  const args = hd.key.publicKeyToBlake160(hd.key.privateToPublic(key));
  const lock = { codeHash: scriptTemplate.CODE_HASH, hashType: scriptTemplate.HASH_TYPE, args };
  const address = helpers.encodeToAddress(lock, { config: config.predefined.AGGRON4 });
  return { key, lock, address, script: ParamsFormatter.toScript(lock) };
}
export function output(owner: any, amount: bigint): any {
  return { cellOutput: { lock: owner.lock, capacity: hex(amount) }, data: "0x" };
}
export function fromRpcCell(cell: any): any {
  return { cellOutput: ResultFormatter.toOutput(cell.output), data: cell.output_data,
    outPoint: ResultFormatter.toOutPoint(cell.out_point) };
}
export async function signTransaction(input: any, owner: any, outputs: any[], chainConfig: any): Promise<any> {
  let skeleton = helpers.TransactionSkeleton();
  skeleton = await commons.secp256k1Blake160.setupInputCell(skeleton, input, owner.address, { config: chainConfig });
  skeleton = skeleton.update("outputs", (current: any) => current.clear().push(...outputs));
  skeleton = commons.secp256k1Blake160.prepareSigningEntries(skeleton);
  const entries = skeleton.get("signingEntries");
  assert.equal(entries.size, 1, "one signing group");
  const signed = helpers.sealTransaction(skeleton, [hd.key.signRecoverable(entries.first().message, owner.key)]);
  const hash = utils.ckbHash(blockchain.RawTransaction.pack(signed));
  return { hash, signed, raw: ParamsFormatter.toRawTransaction(signed) };
}

export function initFullNode(fullBin: string, fullDir: string, fullRpc: number, fullP2p: number,
  funderArgs: string, commands: any[], genesisMessage: string, minerTag: string, websocketPort?: number): string[] {
  const initArgs = ["init", "-C", fullDir, "--chain", "dev", "--rpc-port", String(fullRpc),
    "--p2p-port", String(fullP2p), "--ba-arg", funderArgs,
    "--genesis-message", genesisMessage, "--ba-message", minerTag, "--log-to", "file"];
  commands.push({ argv: [fullBin, ...initArgs] });
  execFileSync(fullBin, initArgs, { encoding: "utf8", timeout: 30_000 });
  const ckbConfig = path.join(fullDir, "ckb.toml");
  let cfg = fs.readFileSync(ckbConfig, "utf8");
  cfg = cfg.replace(/^modules\s*=.*$/m, 'modules = ["Net", "Pool", "Miner", "Chain", "Stats", "Experiment", "Debug", "IntegrationTest", "Indexer"]');
  const listen = [`/ip4/127.0.0.1/tcp/${fullP2p}`];
  if (websocketPort) listen.push(`/ip4/127.0.0.1/tcp/${websocketPort}/ws`);
  const addresses = "listen_addresses = " + JSON.stringify(listen);
  cfg = cfg.replace(/^listen_addresses\s*=.*$/m, addresses)
    .replace(/^bootnodes\s*=.*$/m, "bootnodes = []")
    .replace(/^discovery_local_address\s*=.*$/m, "discovery_local_address = false");
  if (!cfg.includes('"IntegrationTest"') || !cfg.includes('"Indexer"')) throw new PrerequisiteError("CKB modules not configured");
  if (!cfg.includes(addresses)) throw new PrerequisiteError("CKB P2P is not loopback-only");
  fs.writeFileSync(ckbConfig, cfg);
  return initArgs;
}
export function configureLightNode(lightDir: string, fullDir: string, lightRpc: number,
  lightP2p: number, bootnodes: string[], maxOutboundPeers: number): {storePath: string; lightConfigPath: string} {
  const chainSpec = path.join(fullDir, "specs", "dev.toml");
  const storePath = path.join(lightDir, "store");
  fs.mkdirSync(storePath, { recursive: true });
  const lightConfig = `chain = ${JSON.stringify(chainSpec)}\n[store]\npath = ${JSON.stringify(storePath)}\n` +
    `[network]\npath = ${JSON.stringify(path.join(lightDir, "network"))}\n` +
    `listen_addresses = ["/ip4/127.0.0.1/tcp/${lightP2p}"]\n` +
    `bootnodes = ${JSON.stringify(bootnodes)}\n` +
    `max_peers = ${Math.max(4, maxOutboundPeers + 1)}\nmax_outbound_peers = ${maxOutboundPeers}\nping_interval_secs = 120\n` +
    `ping_timeout_secs = 1200\nconnect_outbound_interval_secs = 2\n` +
    `upnp = false\ndiscovery_local_address = false\nbootnode_mode = false\n` +
    `[rpc]\nlisten_address = "127.0.0.1:${lightRpc}"\n`;
  const lightConfigPath = path.join(lightDir, "config.toml");
  fs.writeFileSync(lightConfigPath, lightConfig);
  return { storePath, lightConfigPath };
}

export function comparePosition(a: bigint[], b: bigint[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

// JSON-RPC transport only. It deliberately does not choose a method or perform any business step.
export async function rpc(port: number, method: string, params: unknown[], report: Report, side: string): Promise<any> {
  const entry: any = { at: new Date().toISOString(), stage: report.stage, side, method, params };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result: any = await response.json();
    if (result.error) throw new Error(`${result.error.code} ${result.error.message}`);
    if (!("result" in result)) throw new Error("missing result");
    entry.result = result.result;
    return result.result;
  } catch (error) {
    entry.error = error.message;
    throw new Error(`${side}.${method}: ${error.message}`);
  } finally {
    if (report.rpc_trace) fs.appendFileSync(report.rpc_trace, JSON.stringify(entry) + "\n");
  }
}

// Pure projection. Matching the actual script is independent of the order returned by get_scripts.
export function scriptHeight(rows: any[], lock: any): string | undefined {
  return rows.find(r => r.script_type === "lock" && isDeepStrictEqual(r.script, lock))?.block_number;
}

// 与仓库中的 dev 服务共享构建目录，但不加载其网络配置，也不使用其链数据。
function preparedBinary(directory: string, binary: string): string {
  const file = path.resolve(__dirname, "../..", directory, binary);
  try {
    fs.accessSync(file, fs.constants.X_OK);
    if (fs.statSync(file).isFile()) return file;
  } catch { /* report the expected build location below */ }
  throw new PrerequisiteError(`Missing executable from dev preparation: ${file}`);
}

export function readStoreBackend(storePath: string): { backend: Backend; marker: string } {
  const rocks = path.join(storePath, "CURRENT"), sqlite = path.join(storePath, "db.sqlite");
  const hasRocks = fs.existsSync(rocks), hasSqlite = fs.existsSync(sqlite);
  if (hasRocks === hasSqlite) {
    throw new PrerequisiteError(`Expected exactly one backend at ${storePath}: CURRENT=${hasRocks}, db.sqlite=${hasSqlite}`);
  }
  return hasRocks ? { backend: "rocksdb", marker: rocks } : { backend: "sqlite", marker: sqlite };
}

export async function prepareRun(options: Options, report: Report) {
  const base = options.workdir;
  fs.mkdirSync(base, { recursive: true });
  if (fs.readdirSync(base).length) throw new PrerequisiteError("workdir must start empty");
  report.output_ready = true;
  report.rpc_trace = path.join(base, "rpc.jsonl");
  const fullBin = preparedBinary(CKB_DEV_PATH, "ckb");
  const lightBin = preparedBinary(CKB_DEV_LIGHT_CLIENT_PATH, "ckb-light-client");
  const fullVersion = execFileSync(fullBin, ["--version"], { encoding: "utf8" }).trim();
  const lightVersion = execFileSync(lightBin, ["--version"], { encoding: "utf8" }).trim();
  report.binaries = { full: { path: fullBin, version: fullVersion, sha256: sha256(fullBin) },
    light: { path: lightBin, version: lightVersion, sha256: sha256(lightBin) } };
  const [fullRpc, fullP2p, lightRpc, lightP2p, bRpc, bP2p, aWs, bWs] = await freePorts(8);
  report.ports = { fullRpc, fullP2p, lightRpc, lightP2p, bRpc, bP2p, aWs, bWs };
  const fullDir = path.join(base, "full-node"), lightDir = path.join(base, "light-client");
  fs.mkdirSync(lightDir);
  return { base, fullBin, lightBin, fullDir, lightDir, fullRpc, fullP2p, lightRpc, lightP2p, bRpc, bP2p, aWs, bWs };
}

export async function withRunDirectory(id: string,
  body: (options: Options, report: Report) => Promise<void>): Promise<void> {
  const browser = process.env.CKB_INTEGRATION_SURFACE === "browser";
  const root = path.join(process.env.RUNNER_TEMP || os.tmpdir(),
    browser ? "ckb-light-integration-browser" : "ckb-light-integration", id.toLowerCase());
  fs.mkdirSync(root, { recursive: true });
  const workdir = fs.mkdtempSync(path.join(root, "run-"));
  // prepare_dev.sh 的原有矩阵选择：非空构建 SQLite，空串构建 RocksDB。本地未指定就读取实际存储。
  const choice = browser ? undefined : process.env.RUSQLITE;
  const expectedBackend = choice === undefined ? undefined : choice ? "sqlite" : "rocksdb";
  const options: Options = { workdir, expectedBackend };
  const report: Report = { case_id: id, backend: "undetected", expected_backend: browser ? "indexeddb" : expectedBackend, status: "not_run",
    command: [process.execPath, ...process.argv.slice(1)], started_at: new Date().toISOString(),
    stage: "preflight", commands: [], transactions: [], output_ready: false };
  try {
    await body(options, report);
    report.exit_code = 0;
  } catch (error) {
    report.status = error instanceof PrerequisiteError ? "prerequisite_failed" : "failed";
    report.exit_code = error instanceof PrerequisiteError ? 2 : 1;
    report.error = { name: error.name, message: error.message, stack: error.stack };
    if (error.name === "AssertionError") {
      Object.assign(report.error, { actual: error.actual, expected: error.expected, operator: error.operator });
    }
    throw error;
  } finally {
    report.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(workdir, "result.json"), JSON.stringify(report, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
    console.log(JSON.stringify({ case_id: report.case_id, backend: report.backend, status: report.status,
      result: path.join(workdir, "result.json") }));
  }
}

// 本地构造与签名；这些函数不发 RPC，也不从轻客户端生成预期。
export function devFunding(genesis: any, funder: any) {
  const defaults = config.predefined.AGGRON4;
  const groupHash = genesis.transactions[1]?.hash;
  if (!groupHash) throw new PrerequisiteError("dev genesis lacks secp dep-group transaction");
  const chainConfig = { ...defaults, SCRIPTS: { ...defaults.SCRIPTS,
    SECP256K1_BLAKE160: { ...defaults.SCRIPTS.SECP256K1_BLAKE160, TX_HASH: groupHash, INDEX: "0x0" } } };
  for (const tx of genesis.transactions) {
    const i = tx.outputs.findIndex(out => isDeepStrictEqual(out.lock, funder.script));
    if (i !== -1) {
      const genesisCell = fromRpcCell({ output: tx.outputs[i], output_data: tx.outputs_data[i],
        out_point: { tx_hash: tx.hash, index: hex(BigInt(i)) } });
      return { chainConfig, genesisCell };
    }
  }
  throw new PrerequisiteError("funded dev genesis cell for documented fixture key not found");
}

export async function buildCreation(funding: any, funder: any, watched: any, chainConfig: any) {
  const capacity = BigInt(funding.cellOutput.capacity), amount = 100n * CKB;
  if (capacity < amount + FEE + 61n * CKB) throw new PrerequisiteError("funding capacity exhausted");
  const outputs = [output(watched, amount), output(funder, capacity - amount - FEE)];
  const tx = await signTransaction(funding, funder, outputs, chainConfig);
  return { ...tx, change: { ...outputs[1], outPoint: { txHash: tx.hash, index: "0x1" } } };
}

export async function buildSpend(row: any, owner: any, recipient: any, chainConfig: any) {
  const input = fromRpcCell(row);
  return signTransaction(input, owner, [output(recipient, BigInt(input.cellOutput.capacity) - FEE)], chainConfig);
}

export async function untilCommitted(label: string, readAfterBlock: () => Promise<any>) {
  for (let block = 0; block < 20; block++) {
    const tx = await readAfterBlock();
    if (tx?.tx_status?.status === "committed") return tx;
  }
  throw new PrerequisiteError(`${label} not committed after 20 normal blocks`);
}
export const coversHeight = (height: string | undefined, target: string) =>
  height != null && BigInt(height) >= BigInt(target);
export const committedIn = (tx: any, txHash: string, blockHash: string) =>
  tx?.tx_status?.status === "committed" && tx.tx_status.block_hash === blockHash && tx.transaction?.hash === txHash;

export function recordConfirmation(report: Report, label: string, hash: string, block: any, input?: OutPoint) {
  const receipt = { hash, block_hash: block.header.hash, block_number: block.header.number };
  if (input) report.spend = { ...receipt, input: serial(input) };
  report.transactions.push({ label, ...(input ? report.spend : receipt) });
}
export function recordFirstPage(report: Report, page: any) {
  const boundary = page.objects[page.objects.length - 1];
  report.first_page = outPoints(page.objects).map(serial);
  report.boundary = { out_point: serial(boundary.out_point), position: position(boundary).map(String), cursor: page.last_cursor };
}
export function recordSuffixPage(report: Report, cursor: string, page: any) {
  const ids = outPoints(page.objects).map(serial);
  report.suffix_pages.push({ after_cursor: cursor, out_points: ids, last_cursor: page.last_cursor });
  report.suffix_actual = (report.suffix_actual || []).concat(ids);
  report.next_actual = report.suffix_actual[0] || null;
}

// 只绑定同名 JSON-RPC 方法；连接对象创建时不发送请求。
function rpcMethods<M extends string>(port: number, report: Report, side: string, names: readonly M[]) {
  const client = {} as Record<M, (...params: unknown[]) => Promise<any>>;
  for (const method of names) client[method] = (...params) => rpc(port, method, params, report, side);
  return client;
}
const fullMethods = ["get_tip_header", "get_tip_block_number", "get_block_by_number", "get_header_by_number",
  "get_header", "local_node_info", "get_peers", "add_node", "remove_node", "send_transaction", "generate_block",
  "get_transaction", "get_block", "get_block_hash", "get_live_cell", "get_indexer_tip", "get_cells",
  "get_cells_capacity", "get_transactions", "get_raw_tx_pool", "tx_pool_info", "get_blockchain_info",
  "get_block_template", "get_consensus", "get_block_filter", "get_current_epoch"] as const;
const lightMethods = ["get_genesis_block", "local_node_info", "get_peers", "set_scripts", "get_scripts", "get_tip_header",
  "get_transaction", "get_cells", "get_cells_capacity", "get_transactions", "get_header", "fetch_header",
  "fetch_transaction", "send_transaction"] as const;

type NodeName = "A" | "B";
type Bootnode = { node: NodeName; nodeId: string };
type LightOptions = { bootnodeId?: string; bootnodes?: Bootnode[]; maxOutboundPeers?: number };
type Child = ReturnType<typeof spawn>;
interface FullNodeSlot {
  dir: string; rpc: number; p2p: number; ws: number; launches: number; child?: Child;
}
async function prepareNodeWorkspace(options: Options, report: Report) {
  const { base, fullBin, lightBin, fullDir, lightDir, fullRpc, fullP2p, lightRpc, lightP2p, bRpc, bP2p, aWs, bWs } =
    await prepareRun(options, report);
  const template = config.predefined.AGGRON4.SCRIPTS.SECP256K1_BLAKE160;
  const funder = account(FUNDING_KEY, template);
  const newAccount = () => account("0x" + randomBytes(32).toString("hex"), template);
  const watched = newAccount();
  report.watch_script = watched.script;
  const genesisMessage = "ckb-light-integration-" + randomBytes(12).toString("hex");
  const nodes: Record<NodeName, FullNodeSlot> = {
    A: { dir: fullDir, rpc: fullRpc, p2p: fullP2p, ws: aWs, launches: 0 },
    B: { dir: path.join(base, "full-node-B"), rpc: bRpc, p2p: bP2p, ws: bWs, launches: 0 },
  };
  let firstChainDir: string | undefined;
  let lightProcess: Child | undefined, storePath: string | undefined, lightLaunches = 0;
  const address = (port: number) => `/ip4/127.0.0.1/tcp/${port}`;
  const log = (name: string, launch: number) => path.join(base, launch === 1 ? name + ".log" : `${name}-${launch}.log`);
  const stopCkbNode = async (name: NodeName = "A") => {
    const n = nodes[name];
    await stop(n.child);
    n.child = undefined;
  };
  const stopLightClient = async () => {
    await stop(lightProcess);
    lightProcess = undefined;
  };
  const checkBackend = () => {
    if (!storePath) throw new PrerequisiteError("start the light client before checking its backend");
    const { backend, marker } = readStoreBackend(storePath);
    report.backend = report.binaries.light.backend = backend;
    report.binaries.light.backend_marker = marker;
    if (options.expectedBackend && backend !== options.expectedBackend) {
      throw new PrerequisiteError(`Expected ${options.expectedBackend} build; the light client opened ${backend}`);
    }
  };
  return {
    funder, watched, report, newAccount, stopCkbNode, stopLightClient, checkBackend,
    readChainSpec() {
      if (!firstChainDir) throw new PrerequisiteError("start CKB before reading the dev chain specification");
      return fs.readFileSync(path.join(firstChainDir, "specs", "dev.toml"), "utf8");
    },
    p2pAddress(name: NodeName | "light") { return address(name === "light" ? lightP2p : nodes[name].p2p); },
    wsAddress(name: NodeName = "A") { return address(nodes[name].ws) + "/ws"; },
    startCkbNode(name: NodeName = "A", { websocket = false }: { websocket?: boolean } = {}) {
      const n = nodes[name];
      if (n.child) throw new PrerequisiteError(`CKB ${name} already started; stop it before restarting`);
      if (report.stage === "preflight") report.stage = "start_nodes";
      if (!n.launches) {
        // Share only the chain specification. Node identities, database and mining messages are distinct.
        initFullNode(fullBin, n.dir, n.rpc, n.p2p, funder.lock.args, report.commands, genesisMessage,
          name === "A" ? "0x41" : "0x42", websocket ? n.ws : undefined);
        const devSpec = path.join(n.dir, "specs", "dev.toml");
        if (firstChainDir) {
          fs.copyFileSync(path.join(firstChainDir, "specs", "dev.toml"), devSpec);
        } else {
          // A zero-time dev genesis makes two fresh nodes both advertise initial block download
          // and promptly disconnect. Start this private chain one minute ago, before either process starts.
          const source = fs.readFileSync(devSpec, "utf8");
          const stamp = /^(timestamp[ \t]*=[ \t]*)[0-9]+[ \t]*$/m;
          if (!stamp.test(source)) throw new PrerequisiteError("missing genesis timestamp in dev chain spec");
          fs.writeFileSync(devSpec, source.replace(stamp, (_, key) => key + (Date.now() - 60_000)));
          firstChainDir = n.dir;
        }
      }
      n.child = start(fullBin, ["run", "-C", n.dir, "--indexer"], log(name === "A" ? "full-node" : "full-node-B", ++n.launches), report.commands);
      return rpcMethods(n.rpc, report, name === "A" ? "full" : "full-B", fullMethods);
    },
    startLightClient({ bootnodeId, bootnodes, maxOutboundPeers = 1 }: LightOptions = {}) {
      if (!firstChainDir) throw new PrerequisiteError("initialize at least one full node to create the dev chain spec");
      if (lightProcess) throw new PrerequisiteError("light client already started; stop it before restarting");
      if (bootnodeId && bootnodes) throw new Error("use bootnodeId or bootnodes, not both");
      const peers: Bootnode[] = bootnodes || (bootnodeId ? [{node: "A", nodeId: bootnodeId}] : []);
      if (!Number.isInteger(maxOutboundPeers) || maxOutboundPeers < 1) {
        throw new Error("invalid light client peer limit");
      }
      const bootAddresses = peers.map(p => address(nodes[p.node].p2p) + "/p2p/" + p.nodeId);
      const cfg = configureLightNode(lightDir, firstChainDir, lightRpc, lightP2p, bootAddresses, maxOutboundPeers);
      storePath = cfg.storePath;
      lightProcess = start(lightBin, ["run", "--config-file", cfg.lightConfigPath], log("light-client", ++lightLaunches), report.commands);
      return rpcMethods(lightRpc, report, "light", lightMethods);
    },
    async close() {
      const shutdown = await Promise.allSettled([stopLightClient(), stopCkbNode("A"), stopCkbNode("B")]);
      for (const name of ["A", "B"] as NodeName[]) {
        const logfile = path.join(nodes[name].dir, "data", "logs", "run.log");
        if (fs.existsSync(logfile)) fs.copyFileSync(logfile, path.join(base, name === "A" ? "full-run.log" : "full-run-B.log"));
      }
      for (const result of shutdown) if (result.status === "rejected") throw result.reason;
      if (storePath && report.backend === "undetected") {
        try { checkBackend(); } catch (err) {
          if (report.status === "passed") throw err;
          report.backend_check_error = err.message; // preserve the original test failure
        }
      }
      if (report.status === "passed") {
        for (const dir of [path.join(nodes.A.dir, "data"), path.join(nodes.B.dir, "data"), path.join(lightDir, "store"), path.join(lightDir, "network")]) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        report.cleaned_runtime_data = true;
      }
    },
  };
}
type NodeWorkspace = ReturnType<typeof prepareNodeWorkspace> extends Promise<infer T> ? T : never;
export async function withNodeWorkspace(id: string, body: (run: NodeWorkspace) => Promise<void>) {
  await withRunDirectory(id, async (options, report) => {
    const run = await prepareNodeWorkspace(options, report);
    try {
      await body(run);
      report.status = "passed";
    } finally {
      await run.close();
    }
  });
}
