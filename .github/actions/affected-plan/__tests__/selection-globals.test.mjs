// Regression proofs for omitted runtime inputs and false zero-shard fallbacks.
// Exercise the real planner and green-manifest decision across multiple pushes.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { decide } from "../../skip-green/filter.mjs";
import { nextManifest } from "../../skip-green/record.mjs";

const CLI = process.env.SAFETY_INPUTS_CLI ?? fileURLToPath(new URL("../plan.mjs", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "affected-safe-inputs-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let sequence = 0;
const CONFIG = {
  workspaces: [], ignore: String.raw`\.md$`, sourceRoots: ["src"],
  lanes: { unit: { roots: ["src"], test: String.raw`\.test\.mjs$`, skipGreen: { globals: [] } } },
};
const TESTS = {
  "src/a.test.mjs": "console.log(globalThis.setupValue);\n",
  "src/b.test.mjs": "console.log('b');\n",
};
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function commit(root, files) {
  for (const [file, body] of Object.entries(files)) {
    if (body === null) { git(root, "rm", "-q", "--", file); continue; }
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), body);
    git(root, "add", "--", file);
  }
  git(root, "commit", "-qm", "fixture");
  return git(root, "rev-parse", "HEAD");
}
function repo(files = TESTS, config = CONFIG) {
  const root = join(TMP, String(++sequence));
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "commit.gpgsign", "false");
  const base = commit(root, { ".affected-plan.json": JSON.stringify(config), ...files });
  return { root, base };
}
function plan(root, base, args = [], expectedStatus = 0) {
  const output = join(root, "outputs.txt");
  writeFileSync(output, "");
  const result = spawnSync(process.execPath, [CLI, "--base", base, "--out", "plan.json", "--explain", "false", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "" },
  });
  const doc = JSON.parse(readFileSync(join(root, "plan.json"), "utf8"));
  const outputs = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => {
    const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
  }));
  assert.equal(result.status, expectedStatus, result.stderr);
  return { doc, outputs };
}
const record = (doc, root) => nextManifest({ lane: "unit", plan: doc, laneResult: "success", headSha: git(root, "rev-parse", "HEAD"), runId: "1" }).manifest;
const filter = (doc, manifest) => decide({ plan: doc, manifest, always: new Set(), policy: "enforce", maxShards: 4, perShard: 40 });
const selectAll = (root, files) => commit(root, Object.fromEntries(Object.entries(files).filter(([file]) => file.endsWith(".test.mjs")).map(([file, body]) => [file, `${body}console.log('first push');\n`])));

const FILES = {
  "src/reader.test.mjs": "import { value } from './reader.mjs'; console.log(value());\n",
  "src/reader.mjs": "export function value() { return 1; }\n",
  "src/other.test.mjs": "console.log('unrelated');\n",
  "data/seed.json": '{"value":1}\n',
  "runner/setup.mjs": "import { setup } from '../shared/setup.mjs'; setup();\n",
  "shared/setup.mjs": "export function setup() {}\n",
};
const config = (selectionGlobals) => ({
  ...CONFIG,
  routes: [{ match: '^data/', entry: ['src/reader.mjs'] }],
  lanes: { unit: {
    ...CONFIG.lanes.unit,
    skipGreen: { globals: ['^data/', '^runner/setup\\.mjs$'] },
    ...(selectionGlobals === undefined ? {} : { selectionGlobals }),
  } },
});
for (const [label, globals, expected] of [
  ['legacy absent', undefined, ['src/other.test.mjs', 'src/reader.test.mjs']],
  ['explicit empty', [], ['src/reader.test.mjs']],
  ['runner only', ['^runner/setup\\.mjs$'], ['src/reader.test.mjs']],
]) test(`selection globals: ${label}`, () => {
  const { root, base } = repo(FILES, config(globals));
  commit(root, { 'data/seed.json': '{"value":2}\n' });
  const { doc } = plan(root, base);
  assert.deepEqual(doc.tests, expected);
  assert.ok(doc.globalFiles.includes('data/seed.json'), 'hash globals remain complete');
  assert.ok(doc.reasons['src/reader.test.mjs'].length);
});
for (const change of ['edit', 'delete', 'rename']) test(`routed seed ${change} retains consumer without unrelated suite`, () => {
  const { root, base } = repo(FILES, config([]));
  const files = change === 'edit' ? { 'data/seed.json': '{"value":2}\n' }
    : { 'data/seed.json': null, ...(change === 'rename' ? { 'data/moved.json': FILES['data/seed.json'] } : {}) };
  commit(root, files);
  assert.deepEqual(plan(root, base).doc.tests, ['src/reader.test.mjs']);
});
test('mixed source and routed data changes union both consumers', () => {
  const { root, base } = repo(FILES, config([]));
  commit(root, { 'data/seed.json': '{}\n', 'src/other.test.mjs': "console.log('changed');\n" });
  assert.deepEqual(plan(root, base).doc.tests, ['src/other.test.mjs', 'src/reader.test.mjs']);
});
test('selection narrowing does not weaken cache invalidation or unchanged reuse', () => {
  const { root, base } = repo(FILES, config([]));
  selectAll(root, FILES);
  const first = plan(root, base).doc;
  commit(root, { 'data/seed.json': '{}\n' });
  const second = plan(root, base).doc;
  for (const file of second.tests) assert.notEqual(second.inputs[file], first.inputs[file]);
  assert.deepEqual(filter(second, record(first, root)).kept, second.tests);
  commit(root, { 'README.md': 'unrelated\n' });
  assert.deepEqual(plan(root, base).doc.inputs, second.inputs);
});
test('blind hash global forbids reuse without overriding explicit safe selection', () => {
  const files = { ...FILES, 'runner/setup.mjs': "import './missing.mjs';\n" };
  const { root, base } = repo(files, config([]));
  commit(root, { 'data/seed.json': '{}\n' });
  const { doc } = plan(root, base);
  assert.deepEqual(doc.tests, ['src/reader.test.mjs']);
  assert.equal(doc.inputs['src/reader.test.mjs'], null);
});
for (const blind of [false, true]) test(`runner transitive selection remains conservative (blind=${blind})`, () => {
  const files = { ...FILES, ...(blind ? { 'shared/setup.mjs': "import './missing.mjs';\n" } : {}) };
  const { root, base } = repo(files, config(['^runner/setup\\.mjs$']));
  commit(root, blind ? { 'data/seed.json': '{}\n' } : { 'shared/setup.mjs': 'export function setup() { console.log(1); }\n' });
  assert.deepEqual(plan(root, base).doc.tests, ['src/other.test.mjs', 'src/reader.test.mjs']);
});
for (const invalid of [null, {}, 'bad', [5], ['[']]) test(`invalid selection globals fail full: ${JSON.stringify(invalid)}`, () => {
  const { root, base } = repo(FILES, config(invalid));
  commit(root, { 'data/seed.json': '{}\n' });
  const { doc, outputs } = plan(root, base);
  assert.equal(doc.mode, 'full');
  assert.ok(Number(outputs['shard-total']) > 0);
});

test('selection globals work without skip-green configured', () => {
  const options = config(['^runner/setup\\.mjs$']);
  delete options.lanes.unit.skipGreen;
  const { root, base } = repo(FILES, options);
  commit(root, { 'shared/setup.mjs': 'export function setup() { console.log(2); }\n' });
  const { doc } = plan(root, base);
  assert.deepEqual(doc.tests, ['src/other.test.mjs', 'src/reader.test.mjs']);
  assert.equal(Object.hasOwn(doc, 'inputs'), false);
});

for (const change of ['direct', 'transitive', 'inconclusive']) test(`selection-only ${change} inputs invalidate reusable proof`, () => {
  const options = config(['^runner/setup\\.mjs$']);
  options.lanes.unit.skipGreen.globals = [];
  const { root, base } = repo(FILES, options);
  selectAll(root, FILES);
  const first = plan(root, base).doc;
  const previous = record(first, root);
  commit(root, change === 'direct'
    ? { 'runner/setup.mjs': "globalThis.setupValue = 2;\n" }
    : { 'shared/setup.mjs': change === 'transitive'
      ? 'export function setup() { console.log(3); }\n'
      : "import './missing.mjs';\n" });
  const second = plan(root, base).doc;
  assert.deepEqual(second.tests, ['src/other.test.mjs', 'src/reader.test.mjs']);
  if (change === 'transitive') assert.ok(second.globalFiles.includes('shared/setup.mjs'));
  for (const file of second.tests) {
    assert.notEqual(second.inputs[file], first.inputs[file]);
    if (change === 'inconclusive') assert.equal(second.inputs[file], null);
  }
  assert.deepEqual(filter(second, previous).kept, second.tests);
});
