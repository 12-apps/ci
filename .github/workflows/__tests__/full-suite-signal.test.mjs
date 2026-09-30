// Evaluate the CONDITIONS SHIPPED by the workflow, then run the real guard
// against JUnit emitted by an actual test runner. A green test-command exit
// is not evidence of execution: node:test and Vitest both accept all-skipped
// suites. This covers event/shard wiring, not GitHub's scheduler itself.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { jobBlocks, jobIf } from './matrix-zero-guard.test.mjs';

const workflow = process.env.SIGNAL_TEST_WORKFLOW ?? fileURLToPath(new URL('../monorepo-tests.yml', import.meta.url));
const source = readFileSync(workflow, 'utf8');
const jobs = Object.fromEntries(jobBlocks(source).map(({ name, body }) => [name, body]));
const cli = fileURLToPath(new URL('../../actions/vitest-signal-guard/check-test-signal.mjs', import.meta.url));
const events = ['pull_request', 'push', 'workflow_dispatch', 'schedule'];

function step(lane, name) {
  const body = jobs[`${lane}-tests`];
  const start = body.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, name);
  const end = body.indexOf('\n      - ', start + 1);
  return body.slice(start, end < 0 ? undefined : end);
}

function condition(block) {
  const match = block.match(/\bif:\s*>-\s*\$\{\{([\s\S]*?)\}\}/);
  assert.ok(match, 'the step must declare its folded condition');
  return match[1];
}

function enabled(expression, lane, event, count, { reports = 'reports', bypass = false, outcome = 'success' } = {}) {
  // These comparisons have GitHub's same scalar semantics. Missing labels are
  // an empty array. Implicit success() is modelled by the outcome argument.
  const values = {
    'github.event_name': event,
    [`inputs.${lane}-junit-reports`]: reports,
    [`needs.${lane}-plan.outputs.count`]: count,
    [`steps.${lane}.outcome`]: outcome,
  };
  let js = expression.replace(/^\s*\$\{\{|\}\}\s*$/g, '')
    .replace(/contains\(github\.event\.pull_request\.labels\.\*\.name, inputs\.allow-zero-tests-label\)/g, String(bypass));
  for (const [name, value] of Object.entries(values)) js = js.replaceAll(name, JSON.stringify(value));
  assert.doesNotMatch(js, /\b(?:github|inputs|needs|steps)\./, 'unmodelled workflow condition');
  return outcome === 'success' && Boolean(Function(`"use strict"; return (${js});`)());
}

function signal(lane, event, count, options) {
  const one = condition(step(lane, `Verify the ${lane} lane executed at least one test`));
  const staging = condition(step(lane, 'Stage JUnit reports for the signal job'));
  const aggregate = jobIf(jobs[`${lane}-signal`]);
  assert.ok(aggregate);
  if (count === 1) return enabled(one, lane, event, count, options);
  return enabled(staging, lane, event, count, options) && enabled(aggregate, lane, event, count, options);
}

function runnerReport(root, label, executes) {
  const file = join(root, `${label}.test.mjs`);
  writeFileSync(file, `import { test } from 'node:test';\ntest.skip('skipped case', () => {});\n${executes ? "test('executed case', () => {});\n" : ''}`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // This is a separate runner, not the parent test's worker.
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=junit', file], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  const report = join(root, `${label}.xml`);
  writeFileSync(report, result.stdout);
  return report;
}

for (const lane of ['unit', 'integration']) {
  for (const event of events) {
    for (const shards of [1, 3]) {
      test(`${lane} ${event}, ${shards} shard(s): zero execution fails; one executed case passes`, (t) => {
        const root = mkdtempSync(join(tmpdir(), 'full-signal-'));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const reports = Array.from({ length: shards }, (_, i) => runnerReport(root, `shard-${i}`, false));
        const run = () => signal(lane, event, shards)
          ? spawnSync(process.execPath, [cli, ...reports], { encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: event, LANE_LABEL: lane } })
          : { status: 0, stderr: 'Workflow silently skipped the signal guard' };
        const skipped = run();
        assert.equal(skipped.status, 1, skipped.stderr);
        assert.match(skipped.stderr, /zero tests/);
        runnerReport(root, 'shard-0', true);
        const executed = run();
        assert.equal(executed.status, 0, executed.stderr);
        assert.match(executed.stdout, /executed 1 test case/);
      });
    }
  }

  test(`${lane}: no selection or successful-verdict reuse needs no fresh report`, () => {
    assert.match(jobs[`${lane}-tests`], new RegExp(`needs\\.${lane}-plan\\.outputs\\.count != '0'`));
    for (const event of events) assert.equal(signal(lane, event, 0), false);
  });

  test(`${lane}: opt-out and unsuccessful execution do not create another guard failure`, () => {
    for (const event of events) for (const count of [1, 3]) {
      assert.equal(signal(lane, event, count, { reports: '' }), false);
      for (const outcome of ['failure', 'cancelled', 'skipped']) assert.equal(signal(lane, event, count, { outcome }), false);
    }
  });

  test(`${lane}: the label bypass is exclusively a pull-request choice`, () => {
    for (const count of [1, 3]) {
      assert.equal(signal(lane, 'pull_request', count, { bypass: true }), false);
      for (const event of events.slice(1)) assert.equal(signal(lane, event, count, { bypass: true }), true);
    }
  });

  test(`${lane}: missing/malformed reports fail through the same central parser`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'full-signal-bad-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.equal(signal(lane, 'workflow_dispatch', 1), true);
    for (const contents of [null, '<testsuites tests="1"><testcase name="truncated">']) {
      const report = join(root, 'report.xml');
      if (contents !== null) writeFileSync(report, contents);
      const result = spawnSync(process.execPath, [cli, report], { encoding: 'utf8' });
      assert.equal(result.status, 1, result.stderr);
    }
    for (const block of [step(lane, `Verify the ${lane} lane executed at least one test`), jobs[`${lane}-signal`]]) {
      assert.match(block, /uses: 12-apps\/ci\/\.github\/actions\/vitest-signal-guard@v2/);
      assert.doesNotMatch(block, /continue-on-error/);
    }
    assert.match(step(lane, 'Upload JUnit reports for the signal job'), /if-no-files-found: error/);
  });
}
