// Registration only: run once in CI so a glob change cannot silently drop a reviewed case.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const Mocha = require("mocha");
const checkCaseStyle = require("./check-case-style.cjs");
const { allowedPending, caseIds } = require("./native-pending.cjs");
const root = path.resolve(__dirname, "../../..");
process.chdir(root);
require("./init.integration.js");

const implemented = new Map();
for (const file of fs.globSync("reviews/normal-communication/**/*.md")) {
  const source = fs.readFileSync(file, "utf8");
  const tables = source.matchAll(/<!-- TEST-CASES-BEGIN -->([\s\S]*?)<!-- TEST-CASES-END -->/g);
  for (const [, table] of tables) {
    for (const row of table.split("\n")) {
      const match = /^\|\s*`(LC-[A-Z0-9-]+-\d+)`\s*\|\s*-\s*\[x\]/i.exec(row);
      if (!match) continue;
      assert(!implemented.has(match[1]), `${match[1]} marked in two review rows`);
      implemented.set(match[1], file);
    }
  }
}
const seen = new Map();
for (const [surface, name] of [["native", ".mocharc.integration.jsonc"], ["browser", ".mocharc.integration.browser.jsonc"]]) {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, name), "utf8"));
  const files = new Set(cfg.spec.flatMap(pattern => fs.globSync(pattern)));
  for (const pattern of cfg.ignore || []) for (const file of fs.globSync(pattern)) files.delete(file);
  const mocha = new Mocha();
  for (const file of files) mocha.addFile(path.resolve(file));
  mocha.loadFiles();
  let count = 0;
  const pending = [];
  const registered = new Map();
  mocha.suite.eachTest(test => {
    const ids = caseIds(test);
    assert.equal(ids.length, 1, `expected one stable ID in ${test.fullTitle()}`);
    const [id] = ids;
    assert(!seen.has(id), `${id} registered more than once (${seen.get(id)} and ${surface})`);
    if (test.isPending()) pending.push(id);
    seen.set(id, surface);
    const key = path.relative(root, test.file);
    if (!registered.has(key)) registered.set(key, []);
    registered.get(key).push(id);
    count++;
  });
  for (const file of files) {
    checkCaseStyle(file);
    const tags = [...fs.readFileSync(file, "utf8").matchAll(/^\s*\/\/\s*TEST-MAP:\s*(LC-[A-Z0-9-]+-\d+)\s*$/gm)].map(m=>m[1]);
    assert(tags.length, `no mapped test in ${file}; keep helpers outside the spec glob`);
    assert.deepEqual(tags.sort(), (registered.get(file) || []).sort(), `${file}: mapping and registered IDs differ`);
  }
  assert(count > 0, `${surface} has no registered tests`);
  assert.deepEqual(pending.sort(), surface === "native" ? [...allowedPending].sort() : [],
    `${surface}: pending cases differ from the approved skips`);
  console.log(`${surface}: ${count} registered, ${count - pending.length} active, ${pending.length} pending` +
    (pending.length ? ` (${pending.join(", ")})` : ""));
}
assert.deepEqual([...seen.keys()].sort(), [...implemented.keys()].sort(), "registered IDs differ from implemented review rows");
console.log(`${seen.size} unique mapped cases; registration only, no test bodies executed`);
