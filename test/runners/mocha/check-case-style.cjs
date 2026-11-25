// The review contract lives in AGENTS.md. Verify the parts inspectable without starting any nodes.
const fs = require("node:fs");
const assert = require("node:assert/strict");
const ts = require("typescript");

module.exports = function checkCaseStyle(file) {
  const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const lineOf = node => src.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  function visit(n, fn) { fn(n); ts.forEachChild(n, child => visit(child, fn)); }
  visit(src, test => {
    if (!ts.isCallExpression(test) || !["it", "it.skip"].includes(test.expression.getText())) return;
    const lines = test.getText().split("\n");
    const headings = [];
    lines.forEach((text, i) => {
      const m = /^\s*\/\/\s*(\d+)\.\s+(.+?)\s*$/.exec(text);
      if (m) headings.push({ id: Number(m[1]), title: m[2], line: lineOf(test) + i });
    });
    const count = headings.length / 2;
    const where = `${file}:${lineOf(test)}`;
    assert(count > 0 && Number.isInteger(count), `${where}: expected a numbered outline and matching code blocks`);
    const sections = headings.slice(count);
    sections.forEach((h, i) => {
      assert(h.id === i+1 && headings[i].id === h.id && headings[i].title === h.title, `${where}: outline/section ${i+1} differs`);
    });
    visit(test, n => {
      if (!ts.isCallExpression(n) || !/^assert(?:\.|$)/.test(n.expression.getText())) return;
      const line = lineOf(n);
      const step = sections.filter(h => h.line < line).at(-1);
      const message = n.arguments[n.arguments.length-1];
      const prefix = message && (ts.isTemplateExpression(message) ? message.head.text : message.text);
      assert(step && typeof prefix === "string" && prefix.startsWith(`[${step.id}] `),
        `${file}:${line}: assertion message must identify its numbered step`);
      // Permit a dynamic subject, e.g. `[2] CKB ${name}：…`.
      assert(message.getText().includes("："), `${file}:${line}: include the subject and expected behavior`);
      visit(n, inner => assert(!ts.isAwaitExpression(inner), `${file}:${line}: read RPC results before asserting on them`));
    });
  });
};
