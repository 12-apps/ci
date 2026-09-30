// Execute the production workflow shell, not a second implementation of its keys.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = readFileSync(new URL('../monorepo-tests.yml', import.meta.url), 'utf8');
const root = mkdtempSync(join(tmpdir(), 'workflow-verdict-safety-'));
after(() => rmSync(root, { recursive: true, force: true }));
function job(name) {
  const start = source.indexOf(`\n  ${name}:`);
  assert.notEqual(start, -1);
  return source.slice(start).split(/\n  [a-z][a-z-]*:/)[1];
}
function step(body, name) {
  const start = body.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, name);
  const rest = body.slice(start);
  const next = rest.indexOf('\n      - ', 1);
  return next < 0 ? rest : rest.slice(0, next);
}
function shell(block) {
  const run = block.split('        run: |\n')[1];
  assert.ok(run, block);
  return run.split('\n').filter((line) => line.startsWith('          ')).map((line) => line.slice(10)).join('\n');
}
let invocation = 0;
function execute(block, extra = {}, cwd = root) {
  const out = join(root, `outputs-${invocation++}`);
  writeFileSync(out, '');
  const env = { ...process.env, GITHUB_OUTPUT: out, LANE_NODE: '24.19.0', EXECUTION_ID: 'a'.repeat(64),
    LANE_VARS: '{}', LANE_PRE: 'true', LANE_CMD: 'node tests.mjs', BASE_SHA: 'b'.repeat(40), MERGE_BASE: 'b'.repeat(40),
    STACK_BASE_SHA: '', PLAN_CMD: '', PLAN_CONFIG: '', PR_NUMBER: '9', FP_CMD: `printf '${'c'.repeat(64)}'`, ...extra };
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', shell(block)], { cwd, encoding: 'utf8', env });
  const outputs = Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  return { ...result, outputs };
}
for (const lane of ['unit', 'integration']) {
  const plan = job(`${lane}-plan`);
  const fp = step(plan, 'Fingerprint the test-relevant tree');
  const green = step(plan, 'Key the green manifest to how this lane runs');
  test(`${lane}: identical execution preserves reuse; base, runtime, commands, vars and config invalidate`, () => {
    const baseline = execute(fp);
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.ok(baseline.outputs.value);
    assert.equal(execute(fp).outputs.value, baseline.outputs.value);
    for (const change of [{ BASE_SHA: 'd'.repeat(40) }, { MERGE_BASE: 'd'.repeat(40) }, { STACK_BASE_SHA: 'd'.repeat(40) },
      { EXECUTION_ID: 'd'.repeat(64) }, { LANE_PRE: 'exit 97' }, { LANE_CMD: 'node other.mjs' },
      { LANE_VARS: '{"FEATURE":"new"}' }, { PLAN_CMD: 'node different-plan.mjs' }]) {
      const changed = execute(fp, change);
      assert.equal(changed.status, 0, changed.stderr);
      assert.notEqual(changed.outputs.value, baseline.outputs.value, JSON.stringify(change));
    }
    const path = join(root, `${lane}.json`);
    writeFileSync(path, '{"roots":["src"]}');
    const first = execute(fp, { PLAN_CONFIG: path }).outputs.value;
    writeFileSync(path, '{"roots":["src","helpers"]}');
    assert.notEqual(execute(fp, { PLAN_CONFIG: path }).outputs.value, first);
  });
  test(`${lane}: missing provenance/base/config and a failed fingerprint pipeline cannot hit`, () => {
    for (const change of [{ EXECUTION_ID: '' }, { LANE_NODE: '' }, { BASE_SHA: '' }, { MERGE_BASE: '' },
      { PLAN_CONFIG: join(root, 'missing.json') }, { FP_CMD: 'false | sha256sum | cut -c1-64' }]) {
      const result = execute(fp, change);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.outputs.value, '', JSON.stringify(change));
    }
  });
  test(`${lane}: green manifest identity stays reusable on another push with the same inputs`, () => {
    const baseline = execute(green).outputs.value;
    assert.ok(baseline);
    assert.equal(execute(green, { GITHUB_SHA: 'e'.repeat(40), BASE_SHA: 'f'.repeat(40) }).outputs.value, baseline);
    assert.notEqual(execute(green, { EXECUTION_ID: 'e'.repeat(64) }).outputs.value, baseline);
    assert.equal(execute(green, { EXECUTION_ID: '' }).outputs.value, '');
  });
  test(`${lane}: cache identity resolves actual Node and the correct pre-command, then pins shard execution`, () => {
    const pre = lane === 'unit' ? 'pre-test-command' : 'pre-integration-command';
    assert.match(fp, new RegExp(`LANE_PRE: \\$\\{\\{ inputs\\.${pre} \\}\\}`));
    assert.match(fp, /MERGE_BASE: \$\{\{ steps\.base\.outputs\.merge-base \}\}/);
    assert.match(plan, /node-version: \$\{\{ steps\.verdict-node\.outputs\.node-version \}\}/);
    const tests = job(`${lane}-tests`);
    assert.ok(tests.includes(`needs.${lane}-plan.outputs.node-version || inputs.node-version`));
    assert.ok(tests.includes(`needs.${lane}-plan.outputs.base-sha ||`));
    const upload = step(plan, 'Upload the filtered plan');
    assert.match(upload, /inputs\.skip-green != ''/);
    assert.doesNotMatch(upload, /if:.*skip-green-key/);
  });
  test(`${lane}: an input command pipeline failure reaches the actual test step`, () => {
    const run = step(job(`${lane}-tests`), `Run ${lane} tests`);
    const command = 'node -e "process.exit(17)" | cat';
    const result = execute(run, { GITHUB_EVENT_NAME: 'pull_request', SHARD_TOTAL: '1', SHARD_INDEX: '1',
      UNIT_CMD: command, UNIT_FULL_CMD: command, INT_CMD: command, INT_FULL_CMD: command });
    assert.equal(result.status, 17, result.stdout + result.stderr);
  });
}
test('unit shards cannot consult or record legacy partial-result verdicts', () => {
  const unit = job('unit-tests');
  assert.doesNotMatch(unit, /unit-verdict-|steps\.verdict\.|id: fingerprint|id: record/);
});

test('identical base and HEAD trees with different ancestry cannot reuse narrower coverage', () => {
  const cwd = join(root, 'ancestry');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (name, body) => writeFileSync(join(cwd, name), body);
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  write('.affected-plan.json', JSON.stringify({ workspaces: [], sourceRoots: ['src'], lanes: { unit: { roots: ['src'], test: '\\.test\\.mjs$' } } }));
  for (const name of ['a', 'b']) {
    write(`src/${name}.mjs`, `export function ${name}() { return 1; }\n`);
    write(`src/${name}.test.mjs`, `import { ${name} } from './${name}.mjs';\nconsole.log(${name}());\n`);
  }
  const common = commit();
  write('src/a.mjs', 'export function a() { return 2; }\n');
  const base = commit();
  git('checkout', '--detach', '-q', common);
  write('src/b.mjs', 'export function b() { return 1 + 0; }\n');
  const first = commit();
  const tree = git('rev-parse', 'HEAD^{tree}');
  const second = git('commit-tree', tree, '-p', base, '-m', 'same tree with a different parent');
  const results = [];
  const cli = fileURLToPath(new URL('../../actions/affected-plan/plan.mjs', import.meta.url));
  for (const head of [first, second]) {
    git('checkout', '--detach', '-q', head);
    const mergeBase = git('merge-base', base, 'HEAD');
    const fp = step(job('unit-plan'), 'Fingerprint the test-relevant tree');
    const key = execute(fp, { BASE_SHA: base, MERGE_BASE: mergeBase, FP_CMD: 'git rev-parse HEAD^{tree}', PLAN_CONFIG: '.affected-plan.json' }, cwd);
    assert.equal(key.status, 0, key.stderr);
    assert.ok(key.outputs.value);
    execFileSync(process.execPath, [cli, '--base', base, '--out', 'plan.json'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    results.push({ tree: git('rev-parse', 'HEAD^{tree}'), mergeBase, key: key.outputs.value, tests: JSON.parse(readFileSync(join(cwd, 'plan.json'))).tests });
  }
  assert.equal(results[0].tree, results[1].tree);
  assert.notEqual(results[0].mergeBase, results[1].mergeBase);
  assert.deepEqual(results[0].tests, ['src/b.test.mjs']);
  assert.deepEqual(results[1].tests, ['src/a.test.mjs', 'src/b.test.mjs']);
  assert.notEqual(results[0].key, results[1].key);
});
