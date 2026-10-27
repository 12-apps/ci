// `export default copy.key` is read by reexportsOf as handing the PACK on as
// `default`; a named import of `default` then reads string methods as keys.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const LIB = new URL("../lib", import.meta.url).href;
const { selectAffected } = await import(`${LIB}/select.mjs`);

test("CX11 export default EN.key + import { default as msg }", () => {
  const isCatalog = (f) => /^src\/copy\//.test(f);
  const root = mkdtempSync(join(tmpdir(), "keyed-default-"));
  const pack = (s) => `export const EN = {\n  a: "${s}",\n  b: "y",\n};\n`;
  const head = {
    "src/copy/en.ts": pack("new"),
    "src/msg.ts": 'import { EN } from "./copy/en";\nexport default EN.a;\n',
    "src/shout.ts": 'import { default as msg } from "./msg";\nexport const shout = () => msg.toUpperCase();\n',
    "src/shout.test.ts": 'import { shout } from "./shout";\nexpect(shout()).toBe("OLD");\n',
  };
  for (const [p, b] of Object.entries(head)) { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), b); }
  const r = selectAffected({
    repoRoot: root, roots: ["src"], workspaceDirs: [], changed: ["src/copy/en.ts"],
    readBase: (f) => (f === "src/copy/en.ts" ? pack("old") : head[f]),
    isTest: (f) => /\.test\.ts$/.test(f), isCatalog,
  });
  assert.ok(r.tests.includes("src/shout.test.ts"), `selected: ${JSON.stringify(r.tests)}`);
});
