/**
 * A type-only edit seeds no runtime work (FUT-3586).
 *
 * `interface` and `type` declarations are erased before any runtime lane
 * loads a module, so an edit confined to them cannot change what a test
 * executes. Following their type references to the exports that annotate
 * with them used to widen the file to `*`: one added union member in a
 * consumer's `PhoneOrderState` selected 92 integration files.
 *
 * The narrowing is pinned beside every shape that must stay wide, because
 * the dangerous direction is the quiet one: a runtime change read as a type
 * change selects nothing and reports green.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { selectAffected } from "../lib/select.mjs";
import { affectedExports, typeOnlyChange } from "../lib/symbols.mjs";

const CONSUMER = 'import { open } from "./basket";\nexport const use = () => open();\n';
const TEST = 'import { use } from "./consumer";\nuse();\n';

/** `src/basket.ts` changes from `base` to `head`; a test reaches it through `open`. */
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
};
const wide = (result, why) => {
  assert.deepEqual(result.tests, ["src/consumer.test.ts"], why);
  assert.equal(result.typeOnly, undefined, why);
};

const STATE = (members) =>
  `export interface PhoneOrderState {\n  kind: ${members};\n  items: string[];\n}\n` +
  "export const EMPTY: PhoneOrderState = { kind: \"delivery\", items: [] };\n" +
  "export function open(state: PhoneOrderState = EMPTY): PhoneOrderState {\n  return { ...state };\n}\n";

test("an interface-only edit seeds nothing, though runtime exports annotate with it", () => {
  const result = select(STATE('"delivery" | "pickup"'), STATE('"delivery" | "pickup" | "take-away"'));
  narrow(result);
  assert.deepEqual(result.symbols["src/basket.ts"], []);
});

test("a type-alias-only edit seeds nothing", () => {
  const file = (members) => `export type Kind = ${members};\nexport function open(kind: Kind = "a"): Kind {\n  return kind;\n}\n`;
  narrow(select(file('"a" | "b"'), file('"a" | "b" | "c"')));
});

test("a multi-line union and an interface edited together still seed nothing", () => {
  const file = (extra) =>
    `export type Kind =\n  | "a"\n  | "b"${extra};\n` +
    `export interface Order {\n  kind: Kind;${extra ? "\n  note?: string;" : ""}\n}\n` +
    "export function open(order?: Order) {\n  return order ?? null;\n}\n";
  narrow(select(file(""), file('\n  | "c"')));
});

test("a mixed edit: the function's change still seeds its importers", () => {
  const file = (members, body) =>
    `export interface S {\n  kind: ${members};\n}\nexport function open(s?: S) {\n  return ${body};\n}\n`;
  wide(select(file('"a"', "s ?? 1"), file('"a" | "b"', "s ?? 2")), "interface + function body");
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
  const file = (imports, members) => `${imports}export interface S {\n  kind: ${members};\n}\nexport function open(s?: S) {\n  return s;\n}\n`;
  const result = select(file("", '"a"'), file('import "./polyfill";\n', '"a" | "b"'));
  wide(result, "a new side-effect import");
  assert.deepEqual(result.symbols["src/basket.ts"], ["*"]);
});

test("a value sharing its name with an unchanged type is a runtime change", () => {
  const file = (value) =>
    `export const Status = { open: ${value} } as const;\n` +
    "export type Status = (typeof Status)[keyof typeof Status];\n" +
    "export function open(): Status {\n  return Status.open;\n}\n";
  wide(select(file(1), file(2)), "const Status beside type Status");
  assert.deepEqual([...affectedExports(file(1), file(2))], ["Status"]);
  // The type half alone is still a type-and-value name: never narrowed.
  const typed = (extra) => `export const Status = { open: 1 } as const;\nexport type Status = (typeof Status)[keyof typeof Status]${extra};\n`;
  assert.equal(typeOnlyChange(typed(""), typed(" | 3"), affectedExports(typed(""), typed(" | 3"))), false);
});

test("a runtime statement after a semicolon-less type is not mistaken for the type", () => {
  const file = (members, value) =>
    `export type Kind =\n  | "a"\n  | "b"${members}\nexport const seed = make(${value})\nexport function open() {\n  return seed\n}\n`;
  wide(select(file("", 1), file('\n  | "c"', 2)), "the type span would swallow `seed`");
  // The value alone: it used to be reported as `Kind`, and selected nothing.
  assert.deepEqual([...affectedExports(file("", 1), file("", 2))], ["seed"]);
  wide(select(file("", 1), file("", 2)), "a value edit after a semicolon-less type");
});

test("a new or deleted file is never type-only", () => {
  const names = new Set(["S"]);
  assert.equal(typeOnlyChange(null, "export interface S {}\n", names), false);
  assert.equal(typeOnlyChange("export interface S {}\n", null, names), false);
  assert.equal(typeOnlyChange("export interface S {}\n", "export interface S { a: 1 }\n", new Set(["*"])), false);
});
