/**
 * A module-context edit that evaluates nothing new narrows (module-context.mjs).
 *
 * future-pay#3351 added one import and one private helper to an e2e session
 * file. Both widened it to `*`, the `*` reached a runner root through an
 * import of an untouched constant, and every journey ran. The narrowing is
 * pinned beside every shape that must stay wide, and each of those is an
 * executable counterexample: the unchanged test passes before the edit, fails
 * after it, and must be selected.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { inertClass, inertDeclaration, moduleExports, narrowModuleContext, pureModule, topLevelUnits } from "../lib/module-context.mjs";
import { selectAffected } from "../lib/select.mjs";

const subject = "src/subject.test.mjs";
const testSource = (imports, expression, expected = "1") => [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  imports,
  `test('observable behavior', async () => { assert.equal(${expression}, ${expected}); });`,
  "",
].join("\n");

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "module-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (more) => {
    for (const [path, content] of Object.entries(more)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  };
  write(files);
  return { root, write };
}

const select = (root, files, changes) =>
  selectAffected({
    repoRoot: root,
    changed: Object.keys(changes),
    readBase: (file) => files[file] ?? null,
    roots: ["src"],
    isTest: (file) => file.endsWith(".test.mjs"),
  });

// ── the narrowing ────────────────────────────────────────────────────────────

test("#3351's shape: an added pure import and a private helper reach only their callers", (t) => {
  const files = {
    "src/session.mjs":
      "export const USER = { id: 1 };\n" +
      "export async function signIn(context) {\n  return context;\n}\n",
    "src/user.test.mjs": testSource("import { USER } from './session.mjs';", "USER.id"),
    "src/sign-in.test.mjs": testSource("import { signIn } from './session.mjs';", "await signIn(1)"),
  };
  const changes = {
    "src/reset.mjs": "export function forget({ key }) {\n  return key;\n}\n\nexport const KEY = 'k';\n",
    "src/session.mjs":
      "import { KEY, forget } from './reset.mjs';\n\n" +
      "export const USER = { id: 1 };\n" +
      "export async function signIn(context) {\n  await rest();\n  return context;\n}\n" +
      "async function rest() {\n  return forget({ key: KEY });\n}\n",
  };
  const { root, write } = fixture(t, files);
  write(changes);
  const selected = select(root, files, changes);
  assert.deepEqual(selected.symbols["src/session.mjs"], ["signIn"], selected.why);
  assert.deepEqual(selected.tests, ["src/sign-in.test.mjs"], selected.why);
});

test("a changed private function reaches only the exports that call it", (t) => {
  const files = {
    "src/math.mjs":
      "function twice(n) {\n  return n * 2;\n}\n" +
      "export function double(n) {\n  return twice(n);\n}\n" +
      "export function same(n) {\n  return n;\n}\n",
    "src/double.test.mjs": testSource("import { double } from './math.mjs';", "double(1)", "2"),
    "src/same.test.mjs": testSource("import { same } from './math.mjs';", "same(1)"),
  };
  const changes = { "src/math.mjs": files["src/math.mjs"].replace("n * 2", "n + n") };
  const { root, write } = fixture(t, files);
  write(changes);
  assert.deepEqual(select(root, files, changes).tests, ["src/double.test.mjs"]);
});

test("a destructured parameter does not make a function run at load", (t) => {
  // The body brace used to be the first `{`, the parameter's. The function then
  // read as eager code, and every importer of its module widened.
  const files = {
    "src/dep.mjs": "export function answer(n) {\n  return n;\n}\n",
    "src/journey.mjs":
      "import { answer } from './dep.mjs';\n" +
      "export function start({ user }) {\n  return answer(user);\n}\n" +
      "export const TABLE = { seat: 1 };\n",
    "src/table.test.mjs": testSource("import { TABLE } from './journey.mjs';", "TABLE.seat"),
    "src/start.test.mjs": testSource("import { start } from './journey.mjs';", "start({ user: 1 })"),
  };
  const changes = { "src/dep.mjs": "export function answer(n) {\n  return n * 1;\n}\n" };
  const { root, write } = fixture(t, files);
  write(changes);
  assert.deepEqual(select(root, files, changes).tests, ["src/start.test.mjs"]);
});

// ── what must stay wide: executable counterexamples ─────────────────────────

const effectful = {
  "src/effect.mjs": "globalThis.flag = 2;\nexport const x = 1;\n",
  "src/pure.mjs": "export const x = 1;\n",
};
const middleBase = "export function used() {\n  return 1;\n}\nexport const value = 1;\n";

const wide = [
  {
    name: "an added import of a module with a top-level side effect",
    files: { ...effectful, "src/middle.mjs": middleBase, [subject]: testSource("import { value } from './middle.mjs';", "globalThis.flag ?? 1") },
    changes: { "src/middle.mjs": `import { x } from './effect.mjs';\n${middleBase.replace("return 1", "return x")}` },
  },
  {
    name: "an added import binding a name its target does not export fails the link",
    files: { ...effectful, "src/middle.mjs": middleBase, [subject]: testSource("import { value } from './middle.mjs';", "value") },
    changes: { "src/middle.mjs": `import { y } from './pure.mjs';\n${middleBase.replace("return 1", "return y")}` },
  },
  {
    name: "an added import of a module that itself imports a side effect",
    files: {
      ...effectful,
      "src/relay.mjs": "import './effect.mjs';\nexport const x = 1;\n",
      "src/middle.mjs": middleBase,
      [subject]: testSource("import { value } from './middle.mjs';", "globalThis.flag ?? 1"),
    },
    changes: { "src/middle.mjs": `import { x } from './relay.mjs';\n${middleBase.replace("return 1", "return x")}` },
  },
  {
    name: "a private helper an initializer calls at load",
    files: {
      "src/middle.mjs": "function helper() {\n  return 1;\n}\nconst cached = helper();\nexport const value = 1;\nexport function get() {\n  return cached;\n}\n",
      [subject]: testSource("import { value } from './middle.mjs';", "value"),
    },
    changes: {
      "src/middle.mjs": "function helper() {\n  throw new Error('regression');\n}\nconst cached = helper();\nexport const value = 1;\nexport function get() {\n  return cached;\n}\n",
    },
  },
  {
    name: "a statement after a private function's body on the same line",
    files: {
      "src/middle.mjs": "function helper() {\n  return 1;\n} globalThis.flag = 1;\nexport const value = 1;\n",
      [subject]: testSource("import { value } from './middle.mjs';", "globalThis.flag"),
    },
    changes: { "src/middle.mjs": "function helper() {\n  return 2;\n} globalThis.flag = 2;\nexport const value = 1;\n" },
  },
  {
    name: "a column-0 function that is an operand of the line above",
    files: {
      "src/middle.mjs": "export const pick = false ||\nfunction chosen() {\n  return 1;\n};\nexport const value = 1;\n",
      [subject]: testSource("import { pick } from './middle.mjs';", "pick()"),
    },
    changes: { "src/middle.mjs": "export const pick = false ||\nfunction chosen() {\n  return 2;\n};\nexport const value = 1;\n" },
  },
  {
    name: "a removed import stops a side effect its importers relied on",
    files: {
      ...effectful,
      "src/middle.mjs": `import { x } from './effect.mjs';\n${middleBase.replace("return 1", "return x")}`,
      [subject]: testSource("import { value } from './middle.mjs';", "globalThis.flag", "2"),
    },
    changes: { "src/middle.mjs": middleBase },
  },
  // Findings of the adversarial review, each a new false negative before its fix.
  {
    name: "ASI ends an expression arrow and the indented next line runs at load",
    files: {
      "src/middle.mjs": "const f = () => 1\n  globalThis.flag = 1\nexport const value = 1\n",
      [subject]: testSource("import { value } from './middle.mjs';", "globalThis.flag"),
    },
    changes: { "src/middle.mjs": "const f = () => 1\n  globalThis.flag = 2\nexport const value = 1\n" },
  },
  {
    name: "an added 'pure' module whose arrow is followed by an indented statement",
    files: {
      "src/pure.mjs": "export const f = () => 1\n  globalThis.flag = 2\n",
      "src/middle.mjs": middleBase,
      [subject]: testSource("import { value } from './middle.mjs';", "globalThis.flag ?? 1"),
    },
    changes: { "src/middle.mjs": `import { f } from './pure.mjs';\n${middleBase.replace("return 1", "return f()")}` },
  },
  {
    name: "a default function's own name is not a named export",
    files: {
      "src/pure.mjs": "export default function foo() {\n  return 1\n}\n",
      "src/middle.mjs": middleBase,
      [subject]: testSource("import { value } from './middle.mjs';", "value"),
    },
    changes: { "src/middle.mjs": `import { foo } from './pure.mjs';\n${middleBase.replace("return 1", "return foo()")}` },
  },
  {
    name: "an `export const` line inside a template literal is not an export",
    files: {
      "src/pure.mjs": "function render() {\n  return `\nexport const foo = 1\n`\n}\nexport const bar = 1\n",
      "src/middle.mjs": middleBase,
      [subject]: testSource("import { value } from './middle.mjs';", "value"),
    },
    changes: { "src/middle.mjs": `import { foo } from './pure.mjs';\n${middleBase.replace("return 1", "return foo")}` },
  },
  {
    name: "a `node:` module that does not exist",
    files: { "src/middle.mjs": middleBase, [subject]: testSource("import { value } from './middle.mjs';", "value") },
    changes: { "src/middle.mjs": `import * as fsp from 'node:fs/promise';\n${middleBase.replace("return 1", "return fsp")}` },
  },
  {
    name: "a new private function redeclares an imported binding",
    files: {
      "src/dep.mjs": "export const x = 1;\n",
      "src/middle.mjs": `import { x } from './dep.mjs';\n${middleBase.replace("return 1", "return x")}`,
      [subject]: testSource("import { value } from './middle.mjs';", "value"),
    },
    changes: { "src/middle.mjs": `import { x } from './dep.mjs';\n${middleBase.replace("return 1", "return x")}function x() {\n  return 2;\n}\n` },
  },
  {
    name: "a syntax error inside a private function's body",
    files: {
      "src/middle.mjs": "function helper() {\n  return 1;\n}\nexport const value = 1;\n",
      [subject]: testSource("import { value } from './middle.mjs';", "value"),
    },
    changes: { "src/middle.mjs": "function helper() {\n  return 1 +\n}\nexport const value = 1;\n" },
  },
  {
    name: "a direct eval at load reaches a private function by its name in a string",
    files: {
      "src/middle.mjs": "function helper() {\n  return 1;\n}\nexport const value = eval('helper()');\n",
      [subject]: testSource("import { value } from './middle.mjs';", "value"),
    },
    changes: { "src/middle.mjs": "function helper() {\n  return 2;\n}\nexport const value = eval('helper()');\n" },
  },
  // Round two of the review: ASI decided by tokens that can start or end an expression.
  {
    name: "an expression arrow ending in a postfix `++` over a fresh statement",
    files: { "src/middle.mjs": "const f = () => globalThis.n++\n  globalThis.flag = 1\nexport const value = 1\n", [subject]: testSource("import { value } from './middle.mjs';", "globalThis.flag") },
    changes: { "src/middle.mjs": "const f = () => globalThis.n++\n  globalThis.flag = 2\nexport const value = 1\n" },
  },
  {
    name: "an expression arrow ending in a regex literal over a fresh statement",
    files: { "src/middle.mjs": "const f = () => /a/\n  globalThis.flag = 1\nexport const value = 1\n", [subject]: testSource("import { value } from './middle.mjs';", "globalThis.flag") },
    changes: { "src/middle.mjs": "const f = () => /a/\n  globalThis.flag = 2\nexport const value = 1\n" },
  },
  {
    name: "a fresh statement starting with `!`",
    files: { "src/middle.mjs": "const f = () => 1\n  !function () { globalThis.flag = 1 }()\nexport const value = 1\n", [subject]: testSource("import { value } from './middle.mjs';", "globalThis.flag") },
    changes: { "src/middle.mjs": "const f = () => 1\n  !function () { globalThis.flag = 2 }()\nexport const value = 1\n" },
  },
  {
    name: "a line starting with `as(`, an identifier in JavaScript",
    files: {
      "src/middle.mjs": "function as(n) {\n  globalThis.flag = n\n}\nconst f = () => 1\n  as(1)\nexport const value = 1\n",
      [subject]: testSource("import { value } from './middle.mjs';", "globalThis.flag"),
    },
    changes: { "src/middle.mjs": "function as(n) {\n  globalThis.flag = n\n}\nconst f = () => 1\n  as(2)\nexport const value = 1\n" },
  },
  {
    name: "a removed private function an unchanged export list still names",
    files: {
      "src/middle.mjs": "function helper() {\n  return 1\n}\nexport { helper as h }\nexport const value = 1\n",
      [subject]: testSource("import { value } from './middle.mjs';", "value"),
    },
    changes: { "src/middle.mjs": "export { helper as h }\nexport const value = 1\n" },
  },
  // Round three: a word above a column-0 declaration that still needs an operand.
  {
    name: "`export default` alone on its line makes the next function the default export",
    files: {
      "src/middle.mjs": "export default\nfunction helper() {\n  return 1\n}\nexport const value = 1\n",
      [subject]: testSource("import d from './middle.mjs';", "d()"),
    },
    changes: { "src/middle.mjs": "export default\nfunction helper() {\n  return 2\n}\nexport const value = 1\n" },
  },
  {
    name: "`new` at a line's end calls the next function as a constructor at load",
    files: {
      "src/middle.mjs": "globalThis.made = new\nfunction helper() {\n  this.n = 1\n}\nexport const value = 1\n",
      [subject]: testSource("import { value } from './middle.mjs';", "globalThis.made.n"),
    },
    changes: { "src/middle.mjs": "globalThis.made = new\nfunction helper() {\n  this.n = 2\n}\nexport const value = 1\n" },
  },
];

for (const example of wide) test(`stays wide: ${example.name}`, (t) => {
  const { root, write } = fixture(t, { ...example.files, "src/unrelated.test.mjs": testSource("", "1") });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // the fixture runs in its own test harness
  const execute = () => spawnSync(process.execPath, ["--test", subject], { cwd: root, encoding: "utf8", env });
  const baseline = execute();
  assert.equal(baseline.status, 0, `passing baseline required:\n${baseline.stdout}${baseline.stderr}`);
  write(example.changes);
  const regressed = execute();
  assert.equal(regressed.status, 1, `the unchanged test must catch the edit:\n${regressed.stdout}${regressed.stderr}`);
  const selected = select(root, example.files, example.changes);
  assert.deepEqual(selected.tests, [subject], selected.why);
});

// ── the pieces ───────────────────────────────────────────────────────────────

test("inertDeclaration finds a function's body past its parameters and return type", () => {
  for (const source of [
    "export function f({ a }: { a: string }): { ok: boolean } {\n  return { ok: true };\n}",
    "export async function f(c: C, o: {\n  u: U;\n}): Promise<void> {\n  await c;\n}",
    "function f(): Promise<{ a: 1 }> {\n  return x;\n}",
    "function f(): A | { b: 1 } {\n  return x;\n}",
    "function f(): () => void {\n  return g;\n}",
  ]) assert.equal(inertDeclaration(source), true, source);
  for (const source of [
    "function f() {} init()",
    "function f(): void {} if (x) {}",
    "function f<T extends { a: 1 }>(x: T) {}",
    "function f<T = () => void>(x: T) {}",
    "function f() { return 1; }; init();",
  ]) assert.equal(inertDeclaration(source), false, source);
});

test("a file that cannot be cut at column 0 is not narrowed", () => {
  for (const source of [
    "export const a = () => 1;\n(init());\n", // an operand-looking unit
    "export interface A { a: string } init(1)\n", // a statement after an erased body
    "export type Kind = 'a'; init(1)\n",
    "$init();\nexport const a = 1;\n",
    "export const a = (\n1;\n", // unbalanced
  ]) assert.equal(topLevelUnits(source), null, source);
});

test("a semicolon-less type alias over an indented runtime line is not narrowed", () => {
  // The .ts twin of the ASI arrow case: the alias ends at its line and the
  // indented statement runs at load.
  const file = (n) => `export type Kind = 'a'\n  globalThis.flag = ${n}\nexport const value = 1\n`;
  assert.equal(topLevelUnits(file(1)), null);
  assert.equal(narrowModuleContext(file(1), file(2), () => true), null);
  // Prettier's own multi-line union still narrows.
  assert.notEqual(topLevelUnits("export type Kind =\n  | 'a'\n  | 'b';\nexport const value = 1;\n"), null);
});

test("an arrow broken after `=>` or before a `.` continuation is still inert", () => {
  assert.equal(inertDeclaration("export const f = (a: number) =>\n  a + 1;"), true);
  assert.equal(inertDeclaration("export const f = () =>\n  list\n    .map((x) => x)\n    .filter(Boolean);"), true);
  assert.equal(inertDeclaration("const f = () => 1\n  globalThis.flag = 1"), false);
});

test("a type is not an export a value import can bind", () => {
  // Node's type stripping keeps `import { Kind }` and the link then fails;
  // only `import type` or an inline `type` erase it.
  assert.deepEqual([...moduleExports("export type Kind = 'a';\nexport const value = 1;\n")], ["value"]);
  assert.deepEqual([...moduleExports("const a = 1;\ntype T = 1;\nexport { a as b, type T };\n")], ["b"]);
});

test("a template literal's column-0 lines stay inside its unit", () => {
  const units = topLevelUnits("export const HEADER = `\nexport const VERSION = 1;\n`;\nexport function render() {\n  return HEADER;\n}\n");
  assert.deepEqual(units.map((u) => u.kind), ["opaque", "inert"]);
});

test("rebinding an import that stays, or reordering two, is not narrowed", () => {
  const body = "export function f() {\n  return 1;\n}\n";
  const yes = () => true;
  assert.equal(narrowModuleContext(`import { a } from './x';\n${body}`, `import { b as a } from './x';\n${body}`, yes), null);
  assert.equal(narrowModuleContext(`import * as n from './x';\n${body}`, `import * as m from './x';\n${body}`, yes), null);
  assert.equal(
    narrowModuleContext(`import { a } from './x';\nimport { b } from './y';\n${body}`, `import { b } from './y';\nimport { a } from './x';\n${body}`, yes),
    null,
  );
  assert.equal(narrowModuleContext(body, `import { a } from './x';\n${body}`, () => false), null);
});

test("an added import taints the names it binds, not the whole file", () => {
  const base = "export function f() {\n  return 1;\n}\nexport function g() {\n  return 2;\n}\n";
  const head = "import { a } from './x';\nimport * as ns from './y';\nexport function f() {\n  return a;\n}\nexport function g() {\n  return ns.b;\n}\nexport function h() {\n  return 3;\n}\n";
  assert.deepEqual([...narrowModuleContext(base, head, () => true)].sort(), ["f", "g", "h"]);
  const only = "import { a } from './x';\nexport function f() {\n  return a;\n}\nexport function g() {\n  return 2;\n}\n";
  assert.deepEqual([...narrowModuleContext(base, only, () => true)], ["f"]);
});

test("an import cycle is never pure", () => {
  const sources = { "a.mjs": "import { b } from './b.mjs';\nexport const a = 1;\n", "b.mjs": "import { a } from './a.mjs';\nexport const b = 1;\n" };
  const context = {
    resolve: (spec) => spec.slice(2),
    read: (file) => sources[file],
    exportsOf: (file) => new Set([file[0]]),
  };
  assert.equal(pureModule("a.mjs", context), false);
});

test("inertClass: a class body runs at use, its heritage and static parts at load", () => {
  const hot = new Set(["Changed"]);
  for (const source of [
    "export class A extends ApiError {\n  constructor(c: string) {\n    super(409, refusal().x(c));\n  }\n}",
    "class A {\n  x = make();\n  get y() { return 1; }\n}",
    "export abstract class A<T> extends Base.Inner<T> implements I {\n  m(): T { return run(); }\n}",
  ]) assert.equal(inertClass(source, hot), true, source);
  for (const source of [
    "export class A extends Changed {}",
    "class A extends mixin(B) {}",
    "class A {\n  static x = make();\n}",
    "class A {\n  static {\n    run();\n  }\n}",
    "class A {\n  [key] = 1;\n}",
    "@dec\nclass A {}",
    "class A {\n  @dec m() {}\n}",
    "class A {}\nrun();",
  ]) assert.equal(inertClass(source, hot), false, source);
});
