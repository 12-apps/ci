/**
 * Executable false-negative counterexamples. For each case the unchanged test
 * passes before the edit and fails after it; selection must include that test.
 * This checks runtime semantics as well as the selector's reported names.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { buildGraph, parseImports } from "../lib/modules.mjs";
import { selectAffected } from "../lib/select.mjs";

const subject = "src/subject.test.mjs";
const testSource = (imports, expression, expected = "1") => [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  imports,
  `test('observable behavior', async () => { assert.equal(${expression}, ${expected}); });`,
  "",
].join("\n");

const cases = [
  {
    name: "a static import target changes under an unchanged exported function",
    files: {
      "src/good.mjs": "export const value = 1;\n",
      "src/bad.mjs": "export const value = 2;\n",
      "src/index.mjs": "import { value } from './good.mjs';\nexport function answer() { return value; }\n",
      [subject]: testSource("import { answer } from './index.mjs';", "answer()"),
    },
    changes: { "src/index.mjs": "import { value } from './bad.mjs';\nexport function answer() { return value; }\n" },
  },
  {
    name: "rewiring a reexport changes what its callers receive",
    files: {
      "src/good.mjs": "export const value = 1;\n",
      "src/bad.mjs": "export const value = 2;\n",
      "src/index.mjs": "export { value } from './good.mjs';\n",
      [subject]: testSource("import { value } from './index.mjs';", "value"),
    },
    changes: { "src/index.mjs": "export { value } from './bad.mjs';\n" },
  },
  ...[
    ["a string literal", "'a  b'", "'a b'", "value", "'a  b'"],
    ["a template literal", "`a  b`", "`a b`", "value", "'a  b'"],
    ["a regular expression", "/a  b/", "/a b/", "value.test('a  b')", "true"],
  ].map(([name, before, after, expression, expected]) => ({
    name: `whitespace inside ${name} is observable`,
    files: {
      "src/value.mjs": `export const value = ${before};\n`,
      [subject]: testSource("import { value } from './value.mjs';", expression, expected),
    },
    changes: { "src/value.mjs": `export const value = ${after};\n` },
  })),
  {
    name: "an eager exported initializer can throw when only another binding is imported",
    files: {
      "src/value.mjs": "export const setup = JSON.parse('1');\nexport const value = 1;\n",
      "src/middle.mjs": "import { setup } from './value.mjs';\nexport const value = 1;\n",
      [subject]: testSource("import { value } from './middle.mjs';", "value"),
    },
    changes: { "src/value.mjs": "export const setup = JSON.parse('oops');\nexport const value = 1;\n" },
  },
  {
    name: "an eager initializer in an importer observes a changed deferred function",
    files: {
      "src/dependency.mjs": "export function answer() { return 1; }\n",
      "src/value.mjs": "import { answer } from './dependency.mjs';\nexport const setup = answer();\nexport const value = 1;\n",
      [subject]: testSource("import { value } from './value.mjs';", "value"),
    },
    changes: { "src/dependency.mjs": "export function answer() { throw new Error('regression'); }\n" },
  },
  {
    name: "eager initialization stays module-wide through a barrel's unrelated export",
    files: {
      "src/value.mjs": "export const setup = JSON.parse('1');\nexport const value = 1;\n",
      "src/clean.mjs": "export const stable = 1;\n",
      "src/barrel.mjs": "export { setup } from './value.mjs';\nexport { stable } from './clean.mjs';\n",
      [subject]: testSource("import { stable } from './barrel.mjs';", "stable"),
    },
    changes: { "src/value.mjs": "export const setup = JSON.parse('oops');\nexport const value = 1;\n" },
  },
  ...[
    ["a computed dynamic import", "const source = './value.mjs';", "(await import(source)).value", true],
    ["whitespace before an import parenthesis", "", "(await import ('./value.mjs')).value", false],
    ["a newline before an import parenthesis", "", "(await import\n('./value.mjs')).value", false],
    ["a comment before an import parenthesis", "", "(await import /* load */ ('./value.mjs')).value", false],
  ].map(([name, imports, expression, blind]) => ({
    name,
    files: {
      "src/value.mjs": "export const value = 1;\n",
      [subject]: testSource(imports, expression),
    },
    changes: { "src/value.mjs": "export const value = 2;\n" },
    blind,
  })),
  {
    name: "a resolved helper outside configured roots remains in the graph",
    files: {
      "src/value.mjs": "export const value = 1;\n",
      "helpers/answer.mjs": "import { value } from '../src/value.mjs';\nexport function answer() { return value; }\n",
      [subject]: testSource("import { answer } from '../helpers/answer.mjs';", "answer()"),
    },
    changes: { "src/value.mjs": "export const value = 2;\n" },
    graphFile: "helpers/answer.mjs",
  },
  {
    name: "a relocated body can observe a different module context",
    files: {
      "src/good.mjs": "export const value = 1;\n",
      "src/bad.mjs": "export const value = 2;\n",
      "src/old.mjs": "import { value } from './good.mjs';\nexport function answer() { return value; }\n",
      [subject]: testSource("import { answer } from './old.mjs';", "answer()"),
    },
    changes: {
      "src/old.mjs": "export { answer } from './new.mjs';\n",
      "src/new.mjs": "import { value } from './bad.mjs';\nexport function answer() { return value; }\n",
    },
  },
  {
    name: "a same-named body elsewhere in the diff cannot hide a same-file regression",
    files: {
      "src/a.mjs": "export function answer() { return 1; }\n",
      "src/b.mjs": "export function answer() { return 2; }\n",
      [subject]: testSource("import { answer } from './a.mjs';", "answer()"),
    },
    changes: {
      "src/a.mjs": "export function answer() { return 2; }\n",
      "src/b.mjs": "export function answer() { return 3; }\n",
    },
  },
  {
    name: "an eager step-file prelude may fail before any step callback runs",
    files: {
      "src/data.mjs": "export const BUYERS = [1];\n",
      "src/register.mjs": "export function Given(pattern, callback) {}\n",
      "src/steps.mjs": "import { BUYERS } from './data.mjs';\nimport { Given } from './register.mjs';\nconst byName = new Map(BUYERS.map((b) => [b, b]));\nexport const stable = 1;\nGiven('a buyer', () => byName.get(1));\n",
      [subject]: testSource("import { stable } from './steps.mjs';", "stable"),
    },
    changes: { "src/data.mjs": "export const BUYERS = null;\n" },
    calls: ["Given"],
  },
  ...[
    ["a renamed import carries taint into its deferred consumer", "export function value() { return read(); }", "value()"],
    ["a renamed import carries taint into eager module evaluation", "export const setup = read();\nexport const value = 1;", "value"],
  ].map(([name, body, expression]) => ({
    name,
    files: {
      "src/dep.mjs": "export function answer() { return 1; }\n",
      "src/middle.mjs": `import { answer as read } from './dep.mjs';\n${body}\n`,
      [subject]: testSource("import { value } from './middle.mjs';", expression),
    },
    changes: { "src/dep.mjs": "export function answer() { throw new Error('regression'); }\n" },
  })),
];

for (const example of cases) test(example.name, (t) => {
  const root = mkdtempSync(join(tmpdir(), "selection-safety-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  };
  write({
    ...example.files,
    "src/unrelated.test.mjs": testSource("", "1"),
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // the fixture runs in its own test harness
  const execute = () => spawnSync(process.execPath, ["--test", subject], { cwd: root, encoding: "utf8", env });
  const baseline = execute();
  assert.equal(baseline.status, 0, `passing baseline required:\n${baseline.stdout}${baseline.stderr}`);
  write(example.changes);
  const regressed = execute();
  assert.equal(regressed.status, 1, `the unchanged test must catch the edit:\n${regressed.stdout}${regressed.stderr}`);
  const selected = selectAffected({
    repoRoot: root,
    changed: Object.keys(example.changes),
    readBase: (file) => example.files[file] ?? null,
    roots: ["src"],
    calls: example.calls ?? [],
    isTest: (file) => file.endsWith(".test.mjs"),
  });
  assert.deepEqual(selected.tests, [subject], selected.why);
  if (example.blind !== undefined) assert.equal(selected.stats.blindFiles, example.blind ? 1 : 0);
  if (example.graphFile) assert.ok(selected.graph.edges.has(example.graphFile));
});

test("computed require calls are explicitly blind too", () => {
  const [record] = parseImports("const mod = require (source);\n");
  assert.equal(record.unbounded, true);
  assert.equal(record.spec, "<computed require>");
});

test("following roots to a fixed point terminates on cycles and leaves data terminal", (t) => {
  const root = mkdtempSync(join(tmpdir(), "selection-graph-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "a.mjs"), "import './b.mjs';\nimport './data.json';\n");
  writeFileSync(join(root, "b.mjs"), "import './a.mjs';\n");
  writeFileSync(join(root, "data.json"), JSON.stringify({ text: "import('./absent.mjs')" }));
  const result = buildGraph(root, ["a.mjs"]);
  assert.deepEqual([...result.edges.keys()], ["a.mjs", "b.mjs"]);
  assert.equal(result.edges.get("a.mjs")[1].target, "data.json");
  assert.deepEqual(result.unresolved, []);
});
