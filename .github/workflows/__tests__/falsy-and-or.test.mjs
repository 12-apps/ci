import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// `cond && X || Y` is GitHub's only ternary, and it breaks when X is falsy:
// `0`, `''`, `false` and `null` make the whole expression Y whatever cond is.
// Two workflows here carry a comment warning about exactly that, and it was
// still written three times: `cache: cond && '' || 'pnpm'` (always pnpm), and
// package-gates' `fetch-depth: cond && 0 || 1` (always a shallow clone, which
// failed the MCP ratchet's merge-base on its first real run). Quote the value
// (`'0'` is truthy) or invert the condition so the falsy operand comes last.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const files = [
  ...readdirSync(path.join(root, "workflows")).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(root, "workflows", f)),
  ...readdirSync(path.join(root, "actions")).map((d) => path.join(root, "actions", d, "action.yml")).filter((f) => {
    try { readFileSync(f); return true; } catch { return false; }
  }),
];
const FALSY_BRANCH = /&&\s*(0|''|""|false|null)\s*\|\|/;

/** Every `${{ … }}` outside comments, with its file and line. */
function expressions(file) {
  const out = [];
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    for (const m of line.matchAll(/\$\{\{(.*?)\}\}/g)) out.push({ at: `${path.relative(root, file)}:${i + 1}`, expr: m[1] });
  });
  return out;
}

test("the sweep reads the workflows and actions", () => {
  const all = files.flatMap(expressions);
  assert.ok(files.length > 20 && all.length > 100, `saw ${files.length} files, ${all.length} expressions`);
});

test("no expression's && branch is a falsy literal", () => {
  const bad = files.flatMap(expressions).filter(({ expr }) => FALSY_BRANCH.test(expr));
  assert.deepEqual(bad.map((b) => `${b.at}: \${{${b.expr}}}`), []);
});

test("the pattern is caught in each of its spellings", () => {
  for (const e of ["c && 0 || 1", "c && '' || 'pnpm'", "c&&false||true", 'c && "" || x', "c && null || x"]) {
    assert.ok(FALSY_BRANCH.test(e), e);
  }
  for (const e of ["c && '0' || '1'", "!c && 'pnpm' || ''", "c && 'x' || ''"]) assert.ok(!FALSY_BRANCH.test(e), e);
});
