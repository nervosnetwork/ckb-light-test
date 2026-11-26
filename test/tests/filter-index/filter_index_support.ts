import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { account, OutPoint } from "../lc_store_support";

// 仅做本地数据变换；不发 RPC，也不决定用例何时算同步完成。
export function freshAccount(template: any) {
  return account("0x" + randomBytes(32).toString("hex"), template);
}

export function normalizedOutPoints(rows: Array<{ out_point: OutPoint }>): OutPoint[] {
  return rows.map(row => row.out_point).sort((a, b) =>
    a.tx_hash.localeCompare(b.tx_hash) || Number(BigInt(a.index) - BigInt(b.index)));
}

export function normalizedCells(rows: any[]) {
  return rows.map(row => ({
    out_point: row.out_point,
    block_number: row.block_number,
    capacity: row.output.capacity,
  })).sort((a, b) =>
    BigInt(a.block_number) < BigInt(b.block_number) ? -1 :
    BigInt(a.block_number) > BigInt(b.block_number) ? 1 :
    a.out_point.tx_hash.localeCompare(b.out_point.tx_hash) ||
    Number(BigInt(a.out_point.index) - BigInt(b.out_point.index)));
}

export function capacityOf(rows: any[]): bigint {
  return rows.reduce((sum, row) => sum + BigInt(row.output.capacity), 0n);
}

export function hasFinalizedCheckpoint(logFile: string): boolean {
  if (!logFile || !fs.existsSync(logFile)) return false;
  return /finalize\s+\d+\s+new check points, stop at index\s+[1-9]\d*/.test(fs.readFileSync(logFile, "utf8"));
}
