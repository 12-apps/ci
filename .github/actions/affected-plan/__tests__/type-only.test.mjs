/**
 * A type-only edit seeds no runtime work (FUT-3586), re-landed after the
 * revert of 12-apps/ci#179.
 *
 * `interface` and `type` declarations are erased before any runtime lane
 * loads a module. Following their names to the exports that annotate with
 * them, then widening on those exports' initializers, made one added union
 * member in a consumer's `PhoneOrderState` select 92 integration files.
 *
 * The narrowing is pinned beside every shape that must stay wide, and beside
 * new attempts to smuggle a runtime edit through a type span, because the
 * dangerous direction is the quiet one: a runtime change read as a type
 * change selects nothing and reports green. The five counterexamples that
 * reverted #179 live, unchanged, in type-only-counterexamples.test.mjs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { typeOnlyEdit } from "../lib/module-context.mjs";
import { selectAffected } from "../lib/select.mjs";
import { affectedExports } from "../lib/symbols.mjs";

const CONSUMER = 'import { open } from "./basket";\nexport const use = () => open();\n';
const TEST = 'import { use } from "./consumer";\nuse();\n';

/** `src/basket.ts` changes from `base` to `head`; a test reaches it through the consumer. */
function select(base, head, consumer = CONSUMER) {
  const root = mkdtempSync(join(tmpdir(), "affected-type-only-"));
  const files = { "src/basket.ts": head, "src/consumer.ts": consumer, "src/consumer.test.ts": TEST };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return selectAffected({
    repoRoot: root,
    changed: ["src/basket.ts"],
    readBase: (file) => (file === "src/basket.ts" ? base : null),
    roots: ["src"],
    workspaceDirs: [],
    isTest: (f) => /\.test\.ts$/.test(f),
  });
}

const narrow = (result) => {
  assert.equal(result.mode, "none");
  assert.deepEqual(result.tests, []);
  assert.deepEqual(result.typeOnly, ["src/basket.ts"]);
  assert.deepEqual(result.symbols["src/basket.ts"], []);
};
const wide = (result, why) => {
  assert.deepEqual(result.tests, ["src/consumer.test.ts"], `${why}; typeOnly=${JSON.stringify(result.typeOnly)}`);
  assert.equal(result.typeOnly, undefined, why);
};

const STATE = (members) =>
  `export interface PhoneOrderState {\n  kind: ${members};\n  items: string[];\n}\n` +
  'export const EMPTY: PhoneOrderState = { kind: "delivery", items: [] };\n' +
  "export function open(state: PhoneOrderState = EMPTY): PhoneOrderState {\n  return { ...state };\n}\n";

// ── narrowed ───────────────────────────────────────────────────────────────

test("an interface-only edit seeds nothing, though runtime exports annotate with it", () => {
  narrow(select(STATE('"delivery" | "pickup"'), STATE('"delivery" | "pickup" | "take-away"')));
});

test("a semicolon-less multi-line union and an interface edited together seed nothing", () => {
  const file = (extra) =>
    `export type Kind =\n  | "a"\n  | "b"${extra}\n` +
    `export interface Order {\n  kind: Kind${extra ? "\n  note?: string" : ""}\n}\n` +
    "export const DEFAULT: Order = { kind: \"a\" }\nexport function open(order: Order = DEFAULT) {\n  return order\n}\n";
  narrow(select(file(""), file('\n  | "c"')));
});

test("a template literal type and a comment holding `}` inside an interface seed nothing", () => {
  const file = (extra) =>
    "export type Route<P extends string = `/${string}`> = `${P}?${string}`;\n" +
    `export interface Link {\n  // closes with } on purpose\n  to: Route${extra};\n}\n` +
    "export const HOME: Link = { to: \"/?\" };\nexport function open(link: Link = HOME) {\n  return link;\n}\n";
  narrow(select(file(""), file(" | null")));
});

// ── still wide ─────────────────────────────────────────────────────────────

test("a mixed edit: the function's change still seeds its importers", () => {
  const file = (members, body) =>
    `export interface S {\n  kind: ${members};\n}\nexport function open(s?: S) {\n  return ${body};\n}\n`;
  const result = select(file('"a"', "s ?? 1"), file('"a" | "b"', "s ?? 2"));
  wide(result, "interface + function body");
  assert.ok(result.symbols["src/basket.ts"].includes("open") || result.symbols["src/basket.ts"][0] === "*");
});

test("enum and const enum edits are runtime changes", () => {
  const enums = (keyword, value) =>
    `export ${keyword} Kind {\n  A = ${value},\n}\nexport function open() {\n  return Kind.A;\n}\n`;
  wide(select(enums("enum", 1), enums("enum", 2)), "enum");
  wide(select(enums("const enum", 1), enums("const enum", 2)), "const enum");
});

test("declare values, classes and namespaces are runtime changes", () => {
  const declared = (type) => `export declare const limit: ${type};\nexport function open() {\n  return limit;\n}\n`;
  wide(select(declared("number"), declared("1 | 2")), "declare const");
  const klass = (type) => `export class Basket {\n  items: ${type} = [];\n}\nexport function open() {\n  return new Basket();\n}\n`;
  wide(select(klass("string[]"), klass("number[]")), "class");
  const space = (type) =>
    `export namespace Shapes {\n  export type Kind = ${type};\n}\nexport function open(k?: Shapes.Kind) {\n  return k;\n}\n`;
  wide(select(space('"a"'), space('"a" | "b"')), "namespace");
});

test("an import change beside an interface edit is a runtime change", () => {
  const file = (imports, members) =>
    `${imports}export interface S {\n  kind: ${members};\n}\nexport const EMPTY: S = { kind: "a" };\nexport function open(s: S = EMPTY) {\n  return s;\n}\n`;
  wide(select(file("", '"a"'), file('import "./polyfill";\n', '"a" | "b"')), "a new side-effect import");
  wide(select(file("", '"a"'), file('import type { Extra } from "./extra";\n', '"a" | Extra')), "a new type import");
});

test("a type sharing its name with a value is not narrowed", () => {
  const file = (extra) =>
    "export const Status = { open: 1 } as const;\n" +
    `export type Status = (typeof Status)[keyof typeof Status]${extra};\n` +
    "export function open(): Status {\n  return Status.open;\n}\n";
  wide(select(file(""), file(" | 3")), "type Status beside const Status");
});

test("a changed test file still runs as itself", () => {
  const root = mkdtempSync(join(tmpdir(), "affected-type-only-test-"));
  const body = (members) => `interface Row {\n  kind: ${members};\n}\nconst row: Row = { kind: "a" };\nconsole.log(row);\n`;
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/row.test.ts"), body('"a" | "b"'));
  const result = selectAffected({
    repoRoot: root,
    changed: ["src/row.test.ts"],
    readBase: () => body('"a"'),
    roots: ["src"],
    workspaceDirs: [],
    isTest: (f) => /\.test\.ts$/.test(f),
  });
  assert.deepEqual(result.tests, ["src/row.test.ts"]);
});

test("typeOnlyEdit never trusts the names it is handed alone", () => {
  // `affectedExports` blamed only `Kind`; the units and the emitted JS disagree.
  const file = (v) => `export type Kind = "a" | "b"; init(${v})\nexport function open(k: Kind) {\n  return k\n}\nfunction init(n: number) {\n  return n\n}\n`;
  assert.deepEqual([...affectedExports(file(1), file(2))], ["Kind"]);
  assert.equal(typeOnlyEdit(file(1), file(2), new Set(["Kind"])), false);
  // A runtime unit that differs, whatever names it is handed.
  const forged = (v) => `export type Kind = "a";\nexport function open() {\n  return ${v};\n}\n`;
  assert.equal(typeOnlyEdit(forged(1), forged(2), new Set(["Kind"])), false);
  // `*`, a new file and a deleted file are never type-only.
  const ok = (m) => `export interface S { a: ${m} }\n`;
  assert.equal(typeOnlyEdit(ok("1"), ok("2"), new Set(["*"])), false);
  assert.equal(typeOnlyEdit(null, ok("2"), new Set(["S"])), false);
  assert.equal(typeOnlyEdit(ok("1"), null, new Set(["S"])), false);
  assert.equal(typeOnlyEdit(ok("1"), ok("2"), new Set(["S"])), true);
});

// ── new counterexamples: a runtime edit smuggled through a type span ───────
//
// Each edit changes what a test can observe at load. Where noted, the
// exports bracketer (`affectedExports`) blames only the type, so a rule that
// trusted it would select nothing.

const INIT = "function init(n: number) {\n  return n\n}\n";
const OPEN_CONSUMER = 'import { open } from "./basket";\nexport const use = () => open("a");\n';

test("counterexample: an indented IIFE after a semicolon-less union, no `;` of its own", () => {
  const file = (v) => `export type Kind =\n  | "a"\n  | "b"\n  ;(() => { globalThis.mode = ${v} })()\nexport function open(k: Kind) {\n  return k\n}\n`;
  assert.deepEqual([...affectedExports(file(1), file(2))], ["Kind"], "the bracketer blames the type alone");
  wide(select(file(1), file(2), OPEN_CONSUMER), "IIFE swallowed by the union");
});

test("counterexample: a column-0 IIFE after a semicolon-less type", () => {
  const file = (v) => `export type Kind = "a" | "b"\n;(() => { globalThis.mode = ${v} })()\nexport function open(k: Kind) {\n  return k\n}\n`;
  wide(select(file(1), file(2), OPEN_CONSUMER), "IIFE after the type");
});

test("counterexample: a generic default holding a template literal with `${` and a call after it", () => {
  const file = (v) => "export type Wrap<T extends string = `${\"}\"}`> = { v: T }; init(" + v + ")\nexport function open(w: Wrap<string>) {\n  return w\n}\n" + INIT;
  wide(select(file(1), file(2), OPEN_CONSUMER), "call after a template-literal generic default");
  const lines = (v) => "export type Wrap<T extends string = `${string}{`> = { v: T }\n  init(" + v + ")\nexport function open(w: Wrap<string>) {\n  return w\n}\n" + INIT;
  wide(select(lines(1), lines(2), OPEN_CONSUMER), "an indented call after an unbalanced-looking template");
});

test("counterexample: a comment holding `}` inside an interface, then a call after its real close", () => {
  const file = (v) => `export interface A {\n  // } init(0)\n  a: string\n} init(${v})\nexport function open(a: A) {\n  return a\n}\n` + INIT;
  assert.deepEqual([...affectedExports(file(1), file(2))], ["A"], "the bracketer blames the interface alone");
  wide(select(file(1), file(2), 'import { open } from "./basket";\nexport const use = () => open({ a: "" });\n'), "call after the interface");
});

test("counterexample: a comment holding `{` inside an interface, then a changed const", () => {
  const file = (v) => `export interface A {\n  a: string // {\n}\nexport const seed = make(${v})\nexport function open(a: A) {\n  return seed\n}\nfunction make(n: number) {\n  return n\n}\n`;
  wide(select(file(1), file(2), 'import { open } from "./basket";\nexport const use = () => open({ a: "" });\n'), "const after the interface");
});

test("counterexample: an interface and an exported const on one line", () => {
  const file = (v) => `export interface A { a: string } export const seed = make(${v})\nexport function open(a: A) {\n  return seed\n}\nfunction make(n: number) {\n  return n\n}\n`;
  assert.deepEqual([...affectedExports(file(1), file(2))], ["A"], "the bracketer blames the interface alone");
  wide(select(file(1), file(2), 'import { open } from "./basket";\nexport const use = () => open({ a: "" });\n'), "const on the interface's line");
});

test("counterexample: a `;`-terminated type and a call on one line", () => {
  const file = (v) => `export type K = "a" | "b"; init(${v})\nexport function open(k: K) {\n  return k\n}\n` + INIT;
  wide(select(file(1), file(2), OPEN_CONSUMER), "call after the type's `;`");
});

test("counterexample: a string-literal type holding a backtick, then a changed const", () => {
  const file = (v) => "export type Tick = \"`\"\nexport const seed = make(" + v + ")\nexport function open(t: Tick) {\n  return seed\n}\nfunction make(n: number) {\n  return n\n}\n";
  wide(select(file(1), file(2), 'import { open } from "./basket";\nexport const use = () => open("`");\n'), "a backtick that opens no template");
});

// ── the plan document ──────────────────────────────────────────────────────

test("the plan document names the type-only files and runs nothing for them", () => {
  const root = mkdtempSync(join(tmpdir(), "affected-type-only-cli-"));
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const put = (path, body) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  put(".affected-plan.json", JSON.stringify({ workspaces: [], sourceRoots: ["src"], lanes: { unit: { roots: ["src"], test: String.raw`\.test\.ts$` } } }));
  put("src/basket.ts", STATE('"delivery"'));
  put("src/consumer.ts", CONSUMER);
  put("src/consumer.test.ts", TEST);
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").stdout.trim();
  put("src/basket.ts", STATE('"delivery" | "take-away"'));
  git("commit", "-qam", "head");
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "plan.mjs");
  const run = spawnSync("node", [cli, "--lane", "unit", "--base", base, "--out", "plan.json", "--explain", "false"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" },
  });
  assert.equal(run.status, 0, run.stderr);
  const document = JSON.parse(readFileSync(join(root, "plan.json"), "utf8"));
  assert.equal(document.mode, "none");
  assert.deepEqual(document.tests, []);
  assert.deepEqual(document.typeOnly, ["src/basket.ts"]);
});
