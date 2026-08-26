/**
 * The hop-two narrowing, and — with more coverage — every route that must WIDEN.
 *
 * This is the only NARROWING analysis in the action, so its failure mode is the
 * asymmetric one: a wrong answer here is a green lane that ran nothing, and a
 * green check on untested code is indistinguishable from a green check on tested
 * code. Every case below that ends in `"*"` is one of the fail-safes; they exist
 * because a narrowing produced by a parse failure reads exactly like one that is
 * earned.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { declarationsOf, reachableExports } from "../lib/exports-dataflow.mjs";

const reach = (src, tainted) => {
  const out = reachableExports(src, tainted);
  return out === "*" ? "*" : [...out].sort();
};

// --- the narrowing itself ---------------------------------------------------

test("only the exports that reference the tainted name come back", () => {
  const src = [
    'import { markOrderPaid } from "./order-confirm";',
    "export async function closeSessionIfSettled(id) {",
    "  await settle(id);",
    "}",
    "export async function confirmWaiterPayment(id) {",
    "  return markOrderPaid({ id });",
    "}",
  ].join("\n");
  assert.deepEqual(reach(src, ["markOrderPaid"]), ["confirmWaiterPayment"]);
});

test("taint reaches an export through a local helper", () => {
  const src = [
    'import { moved } from "./dep";',
    "const helper = () => moved() + 1;",
    "export const uses = () => helper();",
    "export const clean = () => 0;",
  ].join("\n");
  assert.deepEqual(reach(src, ["moved"]), ["uses"]);
});

test("an unrelated import taints nothing", () => {
  const src = 'import { other } from "./dep";\nexport const a = () => other();\n';
  assert.deepEqual(reach(src, ["moved"]), []);
});

test("`export { X } from` is a reference to that module's X and nothing else", () => {
  // The barrel case: a re-export line forwards ONE name, so a change to `b`
  // must not arrive through the line that forwards `a`.
  const src = 'export { a } from "./left";\nexport { b } from "./right";\n';
  assert.deepEqual(reach(src, ["./right#b"]), ["b"]);
  assert.deepEqual(reach(src, ["./left#a"]), ["a"]);
});

test("a local `export { … }` list marks the declarations above it exported", () => {
  const src = [
    'import { moved } from "./dep";',
    "const wraps = () => moved();",
    "const clean = () => 0;",
    "export { wraps, clean };",
  ].join("\n");
  assert.deepEqual(reach(src, ["moved"]), ["wraps"]);
});

// --- everything that must widen --------------------------------------------

test("`export * from` widens — the names are not here to bracket", () => {
  assert.equal(reach('export * from "./a";\nexport const b = 1;\n', ["x"]), "*");
});

test("a top-level side effect widens — it can touch anything", () => {
  const src = 'import { moved } from "./dep";\nregisterEverything();\nexport const a = () => 1;\n';
  assert.equal(reach(src, ["moved"]), "*");
});

test("a file whose exports cannot be found widens, never reports 'clean'", () => {
  // The load-bearing fail-safe. The walk reaches a module BY NAME, so it exports
  // something; finding none means the bracketing failed. An empty answer would
  // read as "nothing here can see the change" and silently cut a real chain —
  // green at every step, wrong at the end.
  assert.equal(reach("const onlyLocal = 1;\n", ["moved"]), "*");
});

// --- the bracketing must not invent side effects -----------------------------
// Each of these WAS a false narrowing during development: a parse slip that
// reported a real chain as unreachable.

test("a multi-line import clause is not read as a side effect", () => {
  const src = [
    "import {",
    "  moved,",
    "  other,",
    '} from "./dep";',
    "export const uses = () => moved();",
    "export const clean = () => other();",
  ].join("\n");
  assert.deepEqual(reach(src, ["moved"]), ["uses"]);
});

test("a multi-line union type is not read as a side effect", () => {
  const src = [
    'import { moved } from "./dep";',
    "export type Mode =",
    '  | "a"',
    '  | "b"',
    '  | "c";',
    "export const uses = () => moved();",
  ].join("\n");
  assert.deepEqual(reach(src, ["moved"]), ["uses"]);
});

test("a comment cannot introduce a declaration or a side effect", () => {
  const src = [
    'import { moved } from "./dep";',
    "// registerEverything();",
    "/* export const ghost = moved; */",
    "export const uses = () => moved();",
    "export const clean = () => 0;",
  ].join("\n");
  assert.deepEqual(reach(src, ["moved"]), ["uses"]);
});

// --- the bracketer, directly ------------------------------------------------

test("declarationsOf reports null for what it cannot bracket", () => {
  assert.equal(declarationsOf('export * from "./a";\n'), null);
  assert.equal(declarationsOf("sideEffect();\n"), null);
  assert.notEqual(declarationsOf("export const a = 1;\n"), null);
});

test("declarationsOf keeps exported-ness and the identifiers a body uses", () => {
  const decls = declarationsOf("const hidden = 1;\nexport function shown() {\n  return hidden;\n}\n");
  assert.deepEqual(decls.map((d) => [d.name, d.exported]), [["hidden", false], ["shown", true]]);
  assert.ok(decls[1].refs.has("hidden"));
});
