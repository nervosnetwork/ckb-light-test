require("ts-node").register({
  project: require("node:path").join(__dirname, "tsconfig.integration.json"),
  transpileOnly: true
});
