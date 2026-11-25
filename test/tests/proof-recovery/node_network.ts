import * as fs from "node:fs";
import * as path from "node:path";

/** Temporarily mine with a real node whose P2P listener and outbound slots are disabled. */
export function isolateNodeNetwork(rpcTrace: string, node: "A" | "B"): () => void {
  const file = path.join(path.dirname(rpcTrace), node === "A" ? "full-node" : "full-node-B", "ckb.toml");
  const original = fs.readFileSync(file, "utf8");
  const listen = /^listen_addresses\s*=\s*\[[^\n]*\]$/m;
  const outbound = /^max_outbound_peers\s*=\s*\d+$/m;
  if (!listen.test(original) || !outbound.test(original)) {
    throw new Error(`${node} network configuration not recognized: ${file}`);
  }
  const isolated = original.replace(listen, "listen_addresses = []")
    .replace(outbound, "max_outbound_peers = 0");
  fs.writeFileSync(file, isolated);
  return () => fs.writeFileSync(file, original);
}
