/** CLI controls for runtime import context versus erased types/formatting. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../plan.mjs", import.meta.url));
const body = "export function answer() { return 1; }\n";
const cases = [
  ["an erased type-only import target", "import type { Value } from './old';", "import type { Value } from './new';", "none"],
  ["an erased multiline type-only import", "import type {\n  Value,\n} from './old';", "import type {\n  Other\n} from './new';", "none"],
  ["an inline-only type import retaining module evaluation", "import { type Value } from './old';", "import { type Other } from './new';", "narrowed"],
  ["an erased type-only reexport", "export type { Value } from './old';", "export type { Other } from './new';", "none"],
  ["an erased inline type in a mixed import", "import { a, type Value } from './old';", "import { a, type Other } from './old';", "none"],
  ["a value import's whitespace and trailing comma", "import {a as local} from './old';", "import {\n  a as local,\n} from './old';", "none"],
  ["a namespace import's whitespace", "import * as old from './old';", "import   *   as old   from './old';", "none"],
  ["a reexport's whitespace", "export {a as renamed} from './old';", "export {\n a as renamed,\n} from './old';", "none"],
  ["a runtime import target", "import { a } from './old';", "import { a } from './new';", "narrowed"],
  ["a runtime imported binding", "import { a as local } from './old';", "import { b as local } from './old';", "narrowed"],
  ["a runtime namespace binding", "import * as old from './old';", "import * as renamed from './old';", "narrowed"],
  ["a runtime reexport target", "export { a } from './old';", "export { a } from './new';", "narrowed"],
  ["a runtime reexport alias", "export { a as renamed } from './old';", "export { a as other } from './old';", "narrowed"],
  ["a value import becoming erased", "import { a } from './old';", "import type { a } from './old';", "narrowed"],
  ["dependency evaluation order", "import { a } from './old';\nimport './new';", "import './new';\nimport { a } from './old';", "narrowed"],
  ["a same-line effect after an import", "import { a } from './old'; globalThis.count = 1;", "import { a } from './old'; globalThis.count = 2;", "narrowed"],
];

for (const [name, before, after, mode] of cases) test(`CLI: ${name} selects ${mode}`, (t) => {
  const root = mkdtempSync(join(tmpdir(), "selection-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Selector test");
  git("config", "user.email", "selector@example.test");
  put(".affected-plan.json", JSON.stringify({
    workspaces: [],
    sourceRoots: ["src"],
    lanes: { unit: { roots: ["src"], test: String.raw`\.test\.ts$` } },
  }));
  put("src/old.ts", "export const a = 1;\nexport const b = 2;\nexport type Value = number;\n");
  put("src/new.ts", "export const a = 2;\nexport type Other = string;\n");
  put("src/entry.ts", `${before}\n${body}`);
  put("src/entry.test.ts", "import { answer } from './entry';\nanswer();\n");
  git("add", "-A");
  git("commit", "-qm", "test: establish baseline");
  const base = git("rev-parse", "HEAD");
  put("src/entry.ts", `${after}\n${body}`);
  git("add", "-A");
  git("commit", "-qm", "test: change import context");
  const result = spawnSync(process.execPath, [CLI, "--repo-root", root, "--lane", "unit", "--base", base, "--out", "plan.json"], {
    cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const plan = JSON.parse(readFileSync(join(root, "plan.json"), "utf8"));
  assert.equal(plan.mode, mode, plan.why);
  assert.deepEqual(plan.tests, mode === "none" ? [] : ["src/entry.test.ts"]);
  assert.equal(plan.counts.shardTotal, mode === "none" ? 0 : 1);
});

// Node 24 strips inline type bindings but preserves their module evaluation.
// Execute the actual TypeScript rather than assuming both spellings erase.
for (const example of [
  { name: "inline import target rewiring", statement: (target) => `import { type Foo } from '${target}';`, rewire: true, fails: true },
  { name: "inline reexport target rewiring", statement: (target) => `export { type Foo } from '${target}';`, rewire: true, fails: true },
  { name: "inline import target content", statement: (target) => `import { type Foo } from '${target}';`, rewire: false, fails: true },
  { name: "a runtime value named type changes its local alias", statement: (target) => `import { type as Foo } from '${target}';`, alias: true, rewire: true, fails: true },
  { name: "whole-statement import type erasure", statement: (target) => `import type { Foo } from '${target}';`, rewire: true, fails: false },
  { name: "whole-statement export type erasure", statement: (target) => `export type { Foo } from '${target}';`, rewire: true, fails: false },
]) test(`Node TypeScript + CLI: ${example.name}`, (t) => {
  const root = mkdtempSync(join(tmpdir(), "selection-types-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Selector test");
  git("config", "user.email", "selector@example.test");
  put(".affected-plan.json", JSON.stringify({
    workspaces: [], sourceRoots: ["src"],
    lanes: { unit: { roots: ["src"], test: String.raw`\.test\.mjs$` } },
  }));
  const good = "export type Foo = number;\nexport const type = 1;\n";
  const bad = "export type Foo = number;\nthrow new Error('module initialization regression');\n";
  const entry = (target) => `${example.statement(target)}\nexport const value = ${example.alias ? "Foo" : "1"};\n`;
  put("src/good.ts", good);
  put("src/bad.ts", bad);
  put("src/entry.ts", entry("./good.ts"));
  put("src/entry.test.mjs", "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './entry.ts';\ntest('loads safely', () => assert.equal(value, 1));\n");
  git("add", "-A");
  git("commit", "-qm", "test: establish passing TypeScript baseline");
  const base = git("rev-parse", "HEAD");
  const env = { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" };
  delete env.NODE_TEST_CONTEXT;
  const execute = () => spawnSync(process.execPath, ["--test", "src/entry.test.mjs"], { cwd: root, encoding: "utf8", env });
  const baseline = execute();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  if (example.alias) put("src/entry.ts", entry("./good.ts").replace("type as Foo", "type as Renamed"));
  else if (example.rewire) put("src/entry.ts", entry("./bad.ts"));
  else put("src/good.ts", bad);
  git("add", "-A");
  git("commit", "-qm", "test: introduce throwing dependency");
  const after = execute();
  assert.equal(after.status, example.fails ? 1 : 0, after.stdout + after.stderr);
  const planned = spawnSync(process.execPath, [CLI, "--repo-root", root, "--lane", "unit", "--base", base, "--out", "plan.json"], {
    cwd: root, encoding: "utf8", env,
  });
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  const plan = JSON.parse(readFileSync(join(root, "plan.json"), "utf8"));
  assert.equal(plan.mode, example.fails ? "narrowed" : "none", plan.why);
  assert.deepEqual(plan.tests, example.fails ? ["src/entry.test.mjs"] : []);
});
