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

test("a symbol MOVED with an identical body is unchanged", () => {
  // The single most common refactor. Treating a relocation as "everything
  // changed" makes the selector useless exactly when the diff is largest.
  const base = "export function wireQuery() {\n  return 1;\n}\n";
  const movedInto = "export function wireQuery() {\n  return 1;\n}\n";
  const seenElsewhere = exportedSymbols(base).symbols; // hashes from the file it left
  const affected = affectedExports(null, movedInto, seenElsewhere);
  assert.equal(affected.size, 0, "same name, same body, different file — nothing to re-run");
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

test("a module-level IMPORT line alone does not widen", () => {
  // Relocating a helper rewrites the import line of the file it left behind.
  // Widening on that would undo the move-awareness above.
  const base = "import { helper } from './old';\nexport const a = 1;\n";
  const head = "import { helper } from './new';\nexport const a = 1;\n";
  assert.equal(affectedExports(base, head).size, 0);
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
