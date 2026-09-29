#!/usr/bin/env node
/**
 * The CD gate (scripts/deploy/cd-gate.mjs): the decision rules, and
 * the script end to end against a fake GitHub API, the way the action runs it.
 *
 * Usage: node --test scripts/deploy/__tests__/cd-gate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attempted, attemptStartedAt, decide, main, waitMs, whenRecent } from '../cd-gate.mjs';

const run = (head_sha, conclusion, tried = true) => ({ head_sha, conclusion, attempted: tried });

test('a schedule with nothing new since the last attempt skips', () => {
  const r = decide({ event: 'schedule', head: 'aaa', runs: [run('aaa', 'success')] });
  assert.equal(r.deploy, false);
  assert.equal(r.base, 'aaa');
});

test('a schedule with a new commit deploys, based on the last successful deploy', () => {
  const r = decide({ event: 'schedule', head: 'ccc', runs: [run('bbb', 'success'), run('aaa', 'success')] });
  assert.deepEqual([r.deploy, r.base], [true, 'bbb']);
});

test('a failed attempt is not retried by the next tick, and is never the base', () => {
  const runs = [run('bbb', 'failure'), run('aaa', 'success')];
  assert.equal(decide({ event: 'schedule', head: 'bbb', runs }).deploy, false);
  const next = decide({ event: 'schedule', head: 'ccc', runs });
  assert.deepEqual([next.deploy, next.base], [true, 'aaa']);
});

test('a run that never reached discover (skipped by the gate, cancelled) is not an attempt', () => {
  const runs = [run('bbb', 'success', false), run('bbb', 'cancelled', false), run('aaa', 'success')];
  const r = decide({ event: 'schedule', head: 'bbb', runs });
  assert.deepEqual([r.deploy, r.base], [true, 'aaa']);
});

test('no history at all deploys with an empty base (a full rebuild)', () => {
  assert.deepEqual(decide({ event: 'schedule', head: 'aaa', runs: [] }), {
    deploy: true, base: '', reason: 'no earlier deploy attempt found',
  });
});

test('any event but a schedule always deploys', () => {
  for (const event of ['workflow_dispatch', 'push']) {
    assert.equal(decide({ event, head: 'aaa', runs: [run('aaa', 'success')] }).deploy, true);
  }
});

test('attempted() reads the engine job as a called workflow names it', () => {
  assert.equal(attempted([{ name: 'cd / Discover targets', conclusion: 'success' }], 'Discover targets'), true);
  assert.equal(attempted([{ name: 'cd / Discover targets', conclusion: 'skipped' }], 'Discover targets'), false);
  assert.equal(attempted([{ name: 'Gate', conclusion: 'success' }], 'Discover targets'), false);
});

/** A fake API: the workflow's completed runs, and each run's jobs. */
async function fakeApi(runs, jobs, { fail = false } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (fail) { res.writeHead(500).end(); return; }
    const m = /\/actions\/runs\/(\d+)\/jobs/.exec(req.url);
    const body = m ? { jobs: jobs[m[1]] ?? [] } : { workflow_runs: runs };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

async function runMain(api, extra = {}, clock = {}) {
  const out = join(mkdtempSync(join(tmpdir(), 'cd-gate-')), 'out');
  const result = await main({
    GITHUB_API_URL: api.url, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't', GITHUB_REF_NAME: 'main',
    GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/cd.yml@refs/heads/main', GITHUB_RUN_ID: '9',
    GITHUB_EVENT_NAME: 'schedule', GITHUB_SHA: 'ccc', GITHUB_OUTPUT: out, ...extra,
  }, clock);
  return { result, output: readFileSync(out, 'utf8') };
}

test('end to end: reads the caller workflow, skips itself, stops at the first successful attempt', async () => {
  const api = await fakeApi(
    [{ id: 9, head_sha: 'ccc', conclusion: 'success' }, { id: 8, head_sha: 'bbb', conclusion: 'success' },
     { id: 7, head_sha: 'bbb', conclusion: 'success' }, { id: 6, head_sha: 'aaa', conclusion: 'success' }],
    { 8: [{ name: 'Gate', conclusion: 'success' }, { name: 'cd / Discover targets', conclusion: 'skipped' }],
      7: [{ name: 'cd / Discover targets', conclusion: 'success' }] },
  );
  try {
    const { result, output } = await runMain(api);
    assert.deepEqual([result.deploy, result.base], [true, 'bbb']);
    assert.match(output, /^deploy=true$/m);
    assert.match(output, /^base_sha=bbb$/m);
    assert.ok(api.seen[0].startsWith('/repos/o/r/actions/workflows/cd.yml/runs?branch=main&status=completed'));
    assert.ok(!api.seen.some((u) => u.includes('/runs/9/')), 'the current run is not read');
    assert.ok(!api.seen.some((u) => u.includes('/runs/6/')), 'stops once a successful attempt is found');
  } finally { api.close(); }
});

test('end to end: an unreadable history deploys with a full rebuild', async () => {
  const api = await fakeApi([], {}, { fail: true });
  try {
    const { result, output } = await runMain(api);
    assert.deepEqual([result.deploy, result.base], [true, '']);
    assert.match(output, /^base_sha=$/m);
  } finally { api.close(); }
});

test('cd.yml hands the base to the planner, falling back to the push', () => {
  const cd = readFileSync(new URL('../../../.github/workflows/cd.yml', import.meta.url), 'utf8');
  assert.match(cd, /^ {6}base_sha:\n {8}description:/m);
  assert.match(cd, /^ {10}base_sha: \$\{\{ inputs\.base_sha \|\| github\.event\.before \}\}$/m);
});

test('the action runs the script it ships', () => {
  const action = readFileSync(new URL('../../../.github/actions/cd-gate/action.yml', import.meta.url), 'utf8');
  assert.match(action, /node "\$GITHUB_ACTION_PATH\/\.\.\/\.\.\/\.\.\/scripts\/deploy\/cd-gate\.mjs"/);
});

// ── The interval mode: on every merge, at most once per X minutes ──────────

const MIN = 60_000;
const T0 = Date.parse('2026-09-28T20:00:00Z');

test('waitMs: none when the last attempt is X minutes old or there is none', () => {
  assert.equal(waitMs({ event: 'push', now: T0 + 30 * MIN, lastStart: T0, intervalMinutes: 30 }), 0);
  assert.equal(waitMs({ event: 'push', now: T0 + 45 * MIN, lastStart: T0, intervalMinutes: 30 }), 0);
  assert.equal(waitMs({ event: 'push', now: T0, lastStart: null, intervalMinutes: 30 }), 0);
});

test('waitMs: the rest of the interval when the last attempt is younger', () => {
  assert.equal(waitMs({ event: 'push', now: T0 + 10 * MIN, lastStart: T0, intervalMinutes: 30 }), 20 * MIN);
});

test('waitMs: a manual dispatch never waits', () => {
  assert.equal(waitMs({ event: 'workflow_dispatch', now: T0 + MIN, lastStart: T0, intervalMinutes: 30 }), 0);
});

test('attemptStartedAt counts a discover job still running, never a skipped one', () => {
  assert.equal(attemptStartedAt([{ name: 'cd / Discover targets', started_at: '2026-09-28T20:00:00Z', conclusion: null }], 'Discover targets'), T0);
  assert.equal(attemptStartedAt([{ name: 'cd / Discover targets', started_at: '2026-09-28T20:00:00Z', conclusion: 'skipped' }], 'Discover targets'), null);
  assert.equal(attemptStartedAt([{ name: 'Gate', started_at: '2026-09-28T20:00:00Z', conclusion: 'success' }], 'Discover targets'), null);
});

const intervalRuns = [
  { id: 8, head_sha: 'bbb', conclusion: null },
  { id: 7, head_sha: 'aaa', conclusion: 'success' },
];
const intervalJobs = {
  8: [{ name: 'cd / Discover targets', started_at: '2026-09-28T20:00:00Z', conclusion: null }],
  7: [{ name: 'cd / Discover targets', started_at: '2026-09-28T19:00:00Z', conclusion: 'success' }],
};

test('end to end: a merge 10 min after a deploy started waits 20 min, then deploys on the last success', async () => {
  const api = await fakeApi(intervalRuns, intervalJobs);
  const waited = [];
  try {
    const { result, output } = await runMain(api, { GITHUB_EVENT_NAME: 'push', MIN_INTERVAL_MINUTES: '30' },
      { now: () => T0 + 10 * MIN, wait: async (ms) => { waited.push(ms); } });
    assert.deepEqual(waited, [20 * MIN]);
    assert.deepEqual([result.deploy, result.base], [true, 'aaa']);
    assert.match(output, /^deploy=true$/m);
    assert.ok(api.seen[0].includes('/runs?branch=main&per_page='), 'reads runs still in progress, not only completed ones');
  } finally { api.close(); }
});

test('end to end: a merge after the interval deploys at once', async () => {
  const api = await fakeApi(intervalRuns, intervalJobs);
  const waited = [];
  try {
    const { result } = await runMain(api, { GITHUB_EVENT_NAME: 'push', MIN_INTERVAL_MINUTES: '30' },
      { now: () => T0 + 31 * MIN, wait: async (ms) => { waited.push(ms); } });
    assert.deepEqual(waited, []);
    assert.equal(result.deploy, true);
  } finally { api.close(); }
});

// ── when_recent: skip — hours between deploys without a runner waiting ──────

test('whenRecent: wait by default, skip on request, anything else is refused', () => {
  assert.equal(whenRecent(undefined), 'wait');
  assert.equal(whenRecent(''), 'wait');
  assert.equal(whenRecent('skip'), 'skip');
  assert.throws(() => whenRecent('later'), /when_recent must be wait or skip/);
});

test('end to end, skip: a merge inside the interval skips at once and never waits', async () => {
  const api = await fakeApi(intervalRuns, intervalJobs);
  const waited = [];
  try {
    const { result, output } = await runMain(
      api, { GITHUB_EVENT_NAME: 'push', MIN_INTERVAL_MINUTES: '360', WHEN_RECENT: 'skip' },
      { now: () => T0 + 90 * MIN, wait: async (ms) => { waited.push(ms); } });
    assert.deepEqual(waited, [], 'a skipping gate holds no runner');
    assert.deepEqual([result.deploy, result.base], [false, 'aaa']);
    assert.match(output, /^deploy=false$/m);
    assert.match(result.reason, /started 90 min ago, under the 360-min interval/);
  } finally { api.close(); }
});

test('end to end, skip: the first merge after the interval deploys', async () => {
  const api = await fakeApi(intervalRuns, intervalJobs);
  try {
    const { result } = await runMain(
      api, { GITHUB_EVENT_NAME: 'push', MIN_INTERVAL_MINUTES: '360', WHEN_RECENT: 'skip' },
      { now: () => T0 + 361 * MIN, wait: async () => assert.fail('must not wait') });
    assert.deepEqual([result.deploy, result.base], [true, 'aaa']);
  } finally { api.close(); }
});

test('end to end, skip: a manual dispatch inside the interval still deploys', async () => {
  const api = await fakeApi(intervalRuns, intervalJobs);
  try {
    const { result } = await runMain(
      api, { GITHUB_EVENT_NAME: 'workflow_dispatch', MIN_INTERVAL_MINUTES: '360', WHEN_RECENT: 'skip' },
      { now: () => T0 + MIN, wait: async () => assert.fail('must not wait') });
    assert.equal(result.deploy, true);
  } finally { api.close(); }
});

test('end to end, skip: an unreadable history still deploys (fail-open, as without skip)', async () => {
  const api = await fakeApi([], {}, { fail: true });
  try {
    const { result } = await runMain(api, { GITHUB_EVENT_NAME: 'push', MIN_INTERVAL_MINUTES: '360', WHEN_RECENT: 'skip' });
    assert.deepEqual([result.deploy, result.base], [true, '']);
  } finally { api.close(); }
});

test('end to end: a mistyped when_recent fails the step instead of deploying', async () => {
  const api = await fakeApi(intervalRuns, intervalJobs);
  try {
    await assert.rejects(
      runMain(api, { GITHUB_EVENT_NAME: 'push', MIN_INTERVAL_MINUTES: '360', WHEN_RECENT: 'later' }),
      /when_recent must be wait or skip/);
    assert.equal(api.seen.length, 0, 'refused before reading any history');
  } finally { api.close(); }
});

test('the action passes when_recent through, defaulting to wait', () => {
  const action = readFileSync(new URL('../../../.github/actions/cd-gate/action.yml', import.meta.url), 'utf8');
  assert.match(action, /^ {2}when_recent:\n(?: {4}.*\n)*? {4}default: wait$/m);
  assert.match(action, /^ {8}WHEN_RECENT: \$\{\{ inputs\.when_recent \}\}$/m);
});
