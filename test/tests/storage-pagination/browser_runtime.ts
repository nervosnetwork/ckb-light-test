// Browser process, origin, CDP transport and plain-value projection only; no CKB or light-client RPC is chosen here.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PrerequisiteError } from "../lc_store_support";

const page = `<!doctype html><meta charset="utf-8"><title>LC-STORE-005</title><script type="module" src="/harness.mjs"></script>`;
const harness = `import { LightClient } from '/runtime.js';
let client;
const plain = value => value === undefined ? null : JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v));
globalThis.__store005 = {
  generation: crypto.randomUUID(),
  async invoke(name, args) {
    if (name === 'environment') return { crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer, indexedDB: typeof indexedDB };
    if (name === 'start') {
      client = new LightClient();
      await client.start(args[0], args[1], 'error', 'ws');
      return true;
    }
    if (name === 'stop') { await client.stop(); client = undefined; return true; }
    const value = await client[name](...args);
    if (name === 'getGenesisBlock') return { hash: value.header.hash };
    if (name === 'getTipHeader') return { number: String(value.number), hash: value.hash };
    if (name === 'getPeers') return value.map(p => p.nodeId);
    if (name === 'getScripts') return value.map(s => ({ script: plain(s.script), scriptType: s.scriptType, blockNumber: String(s.blockNumber) }));
    if (name === 'getCells') return { lastCursor: value.lastCursor,
      cells: value.cells.map(c => ({ outPoint: { tx_hash: c.outPoint.txHash, index: '0x' + BigInt(c.outPoint.index).toString(16) },
        capacity: String(c.cellOutput.capacity), blockNumber: String(c.blockNumber), txIndex: String(c.txIndex) })) };
    if (name === 'getCellsCapacity') return String(value);
    if (name === 'getTransactions') return { lastCursor: value.lastCursor,
      rows: value.transactions.map(t => ({ hash: t.transaction.hash(), block: String(t.blockNumber),
        txIndex: String(t.txIndex), ioType: t.ioType, ioIndex: String(t.ioIndex) })) };
    return plain(value);
  }
};`;

type Browser = { call(method: string, ...args: any[]): Promise<any>; reload(): Promise<void> };
export async function withBrowserRuntime(bundlePath: string, report: any, body: (browser: Browser) => Promise<void>) {
  if (typeof WebSocket !== "function") throw new PrerequisiteError("LC-STORE-005 requires Node 22.14+ built-in WebSocket");
  if (!fs.existsSync(bundlePath)) throw new PrerequisiteError(`LC-STORE-005 browser bundle missing: ${bundlePath}`);
  const candidates = process.env.CHROME ? [process.env.CHROME] : process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const chrome = candidates.find(file => fs.existsSync(file));
  if (!chrome) throw new PrerequisiteError(`LC-STORE-005 Chrome missing; checked: ${candidates.join(", ")}`);
  const bundle = fs.readFileSync(bundlePath);
  report.browser_bundle = { path: bundlePath, sha256: createHash("sha256").update(bundle).digest("hex") };
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' ws://127.0.0.1:*; object-src 'none'",
    "Cache-Control": "no-store",
  };
  const routes: Record<string, { type: string; data: string | Buffer }> = {
    "/": { type: "text/html", data: page },
    "/harness.mjs": { type: "text/javascript", data: harness },
    "/runtime.js": { type: "text/javascript", data: bundle },
  };
  const server = createServer((request, response) => {
    const item = routes[new URL(request.url || "/", "http://localhost").pathname];
    response.writeHead(item ? 200 : 404, { ...headers, "Content-Type": item?.type || "text/plain" });
    response.end(item?.data || "not found");
  });
  const root = path.dirname(report.rpc_trace);
  const browserTrace = path.join(root, "browser.jsonl");
  report.browser_trace = browserTrace;
  const profile = fs.mkdtempSync(path.join(root, "chrome-profile-"));
  let child: ReturnType<typeof spawn> | undefined;
  let socket: WebSocket | undefined;
  let origin = "";
  let sessionId = "";
  let nextId = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(reason: any): void; timer: any }>();
  let stderr = "";
  const browserErrors: string[] = [];
  const send = (method: string, params: any = {}, session?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    socket!.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
  const evaluate = async (expression: string) => {
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  const ready = async (previous?: string) => {
    const deadline = Date.now() + 90_000;
    let last: any;
    while (Date.now() < deadline) {
      try {
        const generation = await evaluate("globalThis.__store005?.generation || null");
        if (generation && generation !== previous) return generation;
      }
      catch (error) { last = error; }
      await sleep(250);
    }
    throw new Error(`browser harness not ready: ${String(last)}`);
  };
  let success = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
    child = spawn(chrome, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
      ...(process.platform === "linux" && process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--disable-component-update", "--disable-sync", "--disable-extensions", "about:blank"],
      { stdio: ["ignore", "ignore", "pipe"] });
    report.browser = { chrome, origin, profile };
    let launchError: Error | undefined;
    child.once("error", error => { launchError = error; });
    child.stderr!.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-16384); });
    const endpointFile = path.join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 90_000;
    let endpoint: string | undefined;
    while (Date.now() < deadline && !endpoint) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Chrome exited before debugger startup (code=${child.exitCode}, signal=${child.signalCode}); stderr=${stderr}`);
      }
      if (fs.existsSync(endpointFile)) {
        const [port, browserPath] = fs.readFileSync(endpointFile, "utf8").trim().split(/\r?\n/);
        if (/^\d+$/.test(port) && /^\/devtools\/browser\//.test(browserPath || "")) {
          endpoint = `ws://127.0.0.1:${port}${browserPath}`;
        }
      }
      if (!endpoint) endpoint = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
      if (!endpoint) await sleep(100);
    }
    if (!endpoint) throw new Error(`Chrome debugger startup timeout; DevToolsActivePort=${endpointFile}; stderr=${stderr}`);
    report.browser.debugger_endpoint = endpoint;
    socket = new WebSocket(endpoint);
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") {
        browserErrors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "browser exception");
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
        browserErrors.push((message.params.args || []).map((arg: any) => arg.value || arg.description).join(" "));
      }
      if (browserErrors.length > 20) browserErrors.shift();
      const p = pending.get(message.id);
      if (p) {
        pending.delete(message.id); clearTimeout(p.timer);
        message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
      }
    };
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("CDP socket error")); });
    report.browser.version = await send("Browser.getVersion");
    const target = await send("Target.createTarget", { url: "about:blank" });
    const attachment = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    sessionId = attachment.sessionId;
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Page.navigate", { url: origin }, sessionId);
    await ready();
    const browser: Browser = {
      async call(method, ...args) {
        const entry: any = { at: new Date().toISOString(), stage: report.stage, method,
          args: method === "start" ? [args[0], "<redacted transport key>"] : args };
        try {
          const value = await evaluate(`globalThis.__store005.invoke(${JSON.stringify(method)}, ${JSON.stringify(args)})`);
          entry.result = value;
          return value;
        } catch (error) {
          entry.error = String(error);
          throw error;
        } finally {
          fs.appendFileSync(browserTrace, JSON.stringify(entry) + "\n");
        }
      },
      async reload() {
        const previous = await evaluate("globalThis.__store005.generation");
        await send("Page.navigate", { url: origin }, sessionId);
        await ready(previous);
      },
    };
    await body(browser);
    success = true;
  } finally {
    report.browser_stderr = stderr;
    report.browser_errors = browserErrors;
    if (socket?.readyState === WebSocket.OPEN) {
      try { await send("Browser.close"); } catch { /* close below */ }
    }
    socket?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(3000)]);
    }
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("browser closed")); }
    pending.clear();
    if (success) fs.rmSync(profile, { recursive: true, force: true });
  }
}
