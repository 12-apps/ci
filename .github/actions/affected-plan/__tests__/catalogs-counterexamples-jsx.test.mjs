// A JSX `{a}/{b}` is read by scan() as a regex literal, which masks the code
// between the slashes — hiding the pack being passed to a function.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const LIB = new URL("../lib", import.meta.url).href;
const { selectAffected } = await import(`${LIB}/select.mjs`);
const { keyedUse } = await import(`${LIB}/catalogs.mjs`);
const { parseImports } = await import(`${LIB}/modules.mjs`);

const RATIO = 'import { EN } from "./copy/en";\nexport function Ratio({ a }) {\n  return <p>{a}/{fmt(EN)}</p>;\n}\n';

test("CX10 keyedUse: a pack passed to fmt() inside JSX `{a}/{…}` is read as 'no key read'", () => {
  const record = parseImports(RATIO).find((r) => r.spec === "./copy/en");
  const out = keyedUse(RATIO, record, new Set(["a"]));
  // Sound answers: null (widen), or a result naming Ratio as a reader.
  const decls = out === null ? null : out.decls ?? out;
  assert.ok(decls === null || decls === "*" || decls.has("Ratio"), `keyedUse answered ${JSON.stringify(decls && [...decls])}`);
});

test("CX10b end to end", () => {
  const isCatalog = (f) => /^src\/copy\//.test(f);
  const root = mkdtempSync(join(tmpdir(), "keyed-jsx-"));
  const pack = (s) => `export const EN = {\n  a: "${s}",\n  b: "y",\n};\n`;
  const head = {
    "src/copy/en.ts": pack("new"),
    "src/ratio.tsx": RATIO,
    "src/ratio.test.ts": 'import { Ratio } from "./ratio";\nRatio({ a: 1 });\n',
  };
  for (const [p, b] of Object.entries(head)) { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), b); }
  const r = selectAffected({
    repoRoot: root, roots: ["src"], workspaceDirs: [], changed: ["src/copy/en.ts"],
    readBase: (f) => (f === "src/copy/en.ts" ? pack("old") : head[f]),
    isTest: (f) => /\.test\.ts$/.test(f), isCatalog,
  });
  assert.ok(r.tests.includes("src/ratio.test.ts"), `selected: ${JSON.stringify(r.tests)}`);
});
