// One entry for both deployment surfaces, without maintaining a list of case IDs.
const path = require("node:path");
const args = process.argv.slice(2);
const browser = args.includes("--browser");
const config = browser ? ".mocharc.integration.browser.jsonc" : ".mocharc.integration.jsonc";
process.env.CKB_INTEGRATION_SURFACE = browser ? "browser" : "native";
const cli = require.resolve("mocha/bin/mocha");
const forwarded = args.filter(arg => arg !== "--browser");
// Mocha 9 applies fail-zero separately to each worker/file in parallel mode.
// For a filtered run, fail only if the selection is empty across the whole suite.
const filtered = forwarded.some(arg => /^(?:--(?:f?grep)(?:=|$)|-[fg])/.test(arg));
process.argv = [process.execPath, cli, "--config", path.join(__dirname, config), ...forwarded,
  ...(filtered && !browser ? ["--no-parallel", "--jobs", "1"] : [])];
require(cli);
