/**
 * Symbol-layer guards.
 *
 * This layer decides whether a changed file changed anything OBSERVABLE. Get it
 * wrong in one direction and the suite runs for a comment; wrong in the other
 * and a real behaviour change reaches main untested. The asymmetry is the
 * point: `affectedExports` returns `"*"` — every export, widen — for anything
 * it cannot analyse confidently, and the tests below pin both the narrowing it
 * is allowed to do and the widening it must not skip.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { affectedExports, exportedSymbols } from "../lib/symbols.mjs";

const has = (set, name) => set.has(name);

test("an untouched export is not affected", () => {
  const source = "export function a() {\n  return 1;\n}\n";
  assert.equal(affectedExports(source, source).size, 0);
});

test("a changed body affects only that export", () => {
  const base = "export function a() {\n  return 1;\n}\nexport function b() {\n  return 2;\n}\n";
  const head = "export function a() {\n  return 99;\n}\nexport function b() {\n  return 2;\n}\n";
  const affected = affectedExports(base, head);
  assert.ok(has(affected, "a"));
  assert.ok(!has(affected, "b"), "b is byte-identical and must not be selected through");
});

test("a comment is not a behaviour change", () => {
  const base = "export function a() {\n  return 1;\n}\n";
  const head = "/** Now with an explanation. */\nexport function a() {\n  // why\n  return 1;\n}\n";
  assert.equal(affectedExports(base, head).size, 0, "documenting a boundary must be free");
});

test("a matching symbol in another file does not prove a safe relocation", () => {
  // The name/body do not capture the new file's imports or lexical context.
  const base = "export function wireQuery() {\n  return 1;\n}\n";
  const movedInto = "export function wireQuery() {\n  return 1;\n}\n";
  const seenElsewhere = exportedSymbols(base).symbols; // hashes from the file it left
  const affected = affectedExports(null, movedInto, seenElsewhere);
  assert.ok(affected.has("wireQuery"), "a new module context must reach its callers");
});

test("a removed export is affected", () => {
  const base = "export const a = 1;\nexport const b = 2;\n";
  const head = "export const a = 1;\n";
  assert.ok(has(affectedExports(base, head), "b"));
});

test("module-level code widens to the whole file", () => {
  // A side-effecting call or a config object is owned by no export, so it can
  // alter any of them.
  const base = "export const a = 1;\nregisterThing({ mode: 'x' });\n";
  const head = "export const a = 1;\nregisterThing({ mode: 'y' });\n";
  assert.ok(has(affectedExports(base, head), "*"));
});

test("a changed import target widens even when exported bodies are identical", () => {
  // Binding the same name from a different module can change its value or
  // throw during initialization; unchanged callers are not a proof of safety.
  const base = "import { helper } from './old';\nexport const a = 1;\n";
  const head = "import { helper } from './new';\nexport const a = 1;\n";
  assert.ok(affectedExports(base, head).has("*"));
});

test("same-named body equality cannot prove import rewiring harmless", () => {
  // Module context and initialization are observable even when a same-named
  // export elsewhere in the diff has identical body bytes.
  const base = "import { helper } from './old';\nexport const a = 1;\n";
  const head = "import { helper } from './new';\nexport const a = 1;\n";
  const same = new Map([["helper", "h1"]]);
  assert.ok(affectedExports(base, head, same, same).has("*"));
});

test("E3: an import rewired to a module the diff does not vouch for widens", () => {
  // `export function answer() { return value; }` is byte-identical; only the
  // import moved from './good' (value = 1) to './bad' (value = 2). Neither
  // module is in the diff, so nothing proves `value` unchanged — and it is not.
  const base = "import { value } from './good';\nexport function answer() {\n  return value;\n}\n";
  const head = "import { value } from './bad';\nexport function answer() {\n  return value;\n}\n";
  assert.ok(has(affectedExports(base, head), "*"), "the body did not change; the binding did");
  // A body that DID change across the diff is no move either.
  const moved = new Map([["value", "v1"]]);
  const changed = new Map([["value", "v2"]]);
  assert.ok(has(affectedExports(base, head, moved, changed), "*"));
});

test("E3: a default, namespace or side-effect import change always widens", () => {
  for (const [base, head] of [
    ["import x from './a';\nexport const k = 1;\n", "import x from './b';\nexport const k = 1;\n"],
    ["import * as ns from './a';\nexport const k = 1;\n", "import * as ns from './b';\nexport const k = 1;\n"],
    ["export const k = 1;\n", "import './polyfill';\nexport const k = 1;\n"],
  ]) {
    assert.ok(has(affectedExports(base, head, new Map([["x", "1"]]), new Map([["x", "1"]])), "*"), head);
  }
});

test("E3: runtime import reordering can change module evaluation", () => {
  const base = "import { a } from './a';\nimport { b } from './b';\nexport const k = 1;\n";
  const head = "import { b } from './b';\nimport { a } from './a';\nexport const k = 1;\n";
  assert.ok(affectedExports(base, head).has("*"));
});

test("E3: a re-export target change is not excused by name/body equality", () => {
  const base = "export { x } from './a';\n";
  const head = "export { x } from './b';\n";
  assert.ok(has(affectedExports(base, head), "*"), "nothing vouches for './b'.x");
  const same = new Map([["x", "x1"]]);
  assert.ok(affectedExports(base, head, same, same).has("*"), "same body does not prove equal module context");
  assert.ok(has(affectedExports("export * from './a';\n", "export * from './b';\n"), "*"), "a star re-export is never provable");
});

test("E4: whitespace INSIDE a string literal is a change", () => {
  const base = "export const value = 'a  b';\n";
  const head = "export const value = 'a b';\n";
  assert.ok(has(affectedExports(base, head), "value"), "'a  b' !== 'a b'");
  // …and outside one it still is not.
  const spaced = "export   const   value   =   'a  b';\n";
  assert.equal(affectedExports(base, spaced).size, 0);
  const tpl = "export const t = `a  b`;\n";
  assert.ok(has(affectedExports(tpl, "export const t = `a b`;\n"), "t"));
});

test("E5: changed eager initializers remain tainted for module-effect propagation", () => {
  // Symbol taint is propagated as a module effect by select.mjs. Executable
  // transitive/barrel/alias counterexamples live in selection-safety.test.mjs.
  const base = "export const setup = JSON.parse('1');\nexport const value = 1;\n";
  const head = "export const setup = JSON.parse('oops');\nexport const value = 1;\n";
  assert.ok(has(affectedExports(base, head), "setup"));
  // Adding or removing such an export is the same load-time change.
  assert.ok(has(affectedExports("export const value = 1;\n", head), "setup"));
  assert.ok(has(affectedExports(head, "export const value = 1;\n"), "setup"));
  for (const init of ["new Map()", "await load()", "`${env.X}`", "[1, 2].map((x) => x)"]) {
    assert.ok(has(affectedExports("export const s = 1;\nexport const value = 1;\n", `export const s = ${init};\nexport const value = 1;\n`), "s"), init);
  }
});

test("E5: an inert initializer keeps symbol granularity", () => {
  for (const [before, after] of [
    ["export const s = 1;", "export const s = 2;"],
    ["export const s = 'a';", "export const s = 'b';"],
    ["export const s = { a: 1 };", "export const s = { a: 2 };"],
    ["export const s = () => run();", "export const s = () => run(2);"],
    ["export const s = async (x) => x;", "export const s = async (x) => x + 1;"],
    ["export const s = function () { return 1; };", "export const s = function () { return 2; };"],
    ["export function s() { return f(); }", "export function s() { return g(); }"],
    ["export const s: Record<string, () => void> = {};", "export const s: Record<string, () => void> = { a: b };"],
  ]) {
    const affected = affectedExports(`${before}\nexport const value = 1;\n`, `${after}\nexport const value = 1;\n`);
    assert.ok(has(affected, "s") && !has(affected, "*") && !has(affected, "value"), after);
  }
});

test("a new file affects every export it declares", () => {
  const head = "export const a = 1;\nexport const b = 2;\n";
  const affected = affectedExports(null, head);
  assert.ok(has(affected, "a") && has(affected, "b"));
});

test("an unparseable declaration widens rather than guessing", () => {
  const base = "export const a = 1;\n";
  const head = "export function a() {\n  return {;\n"; // never balances
  assert.ok(has(affectedExports(base, head), "*"), "fail safe, not silent");
});

test("exportedSymbols separates declarations from module-level lines", () => {
  const parsed = exportedSymbols("import x from './x';\nexport const a = 1;\nsideEffect();\n");
  assert.ok(parsed.ok);
  assert.ok(parsed.symbols.has("a"));
  assert.deepEqual(parsed.moduleLevel, ["import x from './x';", "sideEffect();"]);
});

test("a re-export is keyed by the name it forwards", () => {
  // So moving a symbol behind a re-export is not read as a change.
  const parsed = exportedSymbols('export { a, b } from "./other";\n');
  assert.ok(parsed.symbols.has("a") && parsed.symbols.has("b"));
  assert.equal(parsed.reexports[0].spec, "./other");
});
