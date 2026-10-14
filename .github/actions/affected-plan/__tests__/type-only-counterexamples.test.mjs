// False negatives 12-apps/ci#179 introduced: each edit below changes what a test can observe at
// runtime, so the consumer's test must stay selected (FUT-3586 review). Kept after the revert so a
// re-landed type-only rule cannot reopen them.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { selectAffected } from "../lib/select.mjs";

function select(base, head, consumer) {
  const root = mkdtempSync(join(tmpdir(), "review-179-"));
  const files = { "src/basket.ts": head, "src/consumer.ts": consumer, "src/consumer.test.ts": 'import { use } from "./consumer";\nuse();\n' };
  for (const [p, b] of Object.entries(files)) { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), b); }
  return selectAffected({ repoRoot: root, changed: ["src/basket.ts"], readBase: (f) => (f === "src/basket.ts" ? base : null), roots: ["src"], workspaceDirs: [], isTest: (f) => /\.test\.ts$/.test(f) });
}

test("a semicolon'd string-literal type holding an unbalanced bracket swallows the next const", () => {
  const file = (extra) =>
    'export type Opener = "(" | "[";\n' +
    `export const closes = (c: string) => c === ")" || c === "]"${extra};\n` +
    "export const DEFAULT: Opener = pick();\nfunction pick(): Opener {\n  return \"(\";\n}\n";
  const r = select(file(""), file(' || c === "x"'), 'import { closes } from "./basket";\nexport const use = () => closes(")");\n');
  assert.deepEqual(r.tests, ["src/consumer.test.ts"], `closes() changed at runtime; typeOnly=${JSON.stringify(r.typeOnly)}`);
});

test("a semicolon-less multi-line union followed by a top-level call", () => {
  const file = (arg) =>
    `export type Kind =\n  | "a"\n  | "b"\nregister("${arg}")\nexport function open(kind: Kind) {\n  return kind\n}\n` +
    "function register(k: string) {\n  globalThis.kinds = [k]\n}\n";
  const r = select(file("a"), file("b"), 'import { open } from "./basket";\nexport const use = () => open("a");\n');
  assert.deepEqual(r.tests, ["src/consumer.test.ts"], `module side effect changed; typeOnly=${JSON.stringify(r.typeOnly)}`);
});

test("a semicolon-less multi-line union followed by an ADDED top-level statement", () => {
  const file = (extra) => `export type Kind =\n  | "a"\n  | "b"\n${extra}export function open(kind: Kind) {\n  return kind\n}\n`;
  const r = select(file(""), file("Object.freeze(Object.prototype)\n"), 'import { open } from "./basket";\nexport const use = () => open("a");\n');
  assert.deepEqual(r.tests, ["src/consumer.test.ts"], `new module side effect; typeOnly=${JSON.stringify(r.typeOnly)}`);
});

test("an interface and a call on one line", () => {
  const file = (n) => `export interface A { a: string } init(${n})\nexport function open(a: A) {\n  return a;\n}\nfunction init(n: number) {\n  return n;\n}\n`;
  const r = select(file(1), file(2), 'import { open } from "./basket";\nexport const use = () => open({ a: "" });\n');
  assert.deepEqual(r.tests, ["src/consumer.test.ts"], `typeOnly=${JSON.stringify(r.typeOnly)}`);
});

test("declarationEnd's early return: a template opened on its own line, holding `export const` lines", () => {
  const file = (v) => "export const HEADER =\n  `\nexport const VERSION = " + v + ";\nexport const GENERATED = true;`\nexport function render() {\n  return HEADER;\n}\n";
  const r = select(file(1), file(2), 'import { HEADER } from "./basket";\nexport const use = () => HEADER;\n');
  assert.deepEqual(r.tests, ["src/consumer.test.ts"], `HEADER's string changed; symbols=${JSON.stringify(r.symbols["src/basket.ts"])}`);
});
