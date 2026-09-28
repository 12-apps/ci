#!/usr/bin/env node
/**
 * The scheduled-CD gate (scripts/deploy/cd-gate.mjs): the decision rules, and
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
import { attempted, decide, main } from '../cd-gate.mjs';

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

async function runMain(api, extra = {}) {
  const out = join(mkdtempSync(join(tmpdir(), 'cd-gate-')), 'out');
  const result = await main({
    GITHUB_API_URL: api.url, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't', GITHUB_REF_NAME: 'main',
    GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/cd.yml@refs/heads/main', GITHUB_RUN_ID: '9',
    GITHUB_EVENT_NAME: 'schedule', GITHUB_SHA: 'ccc', GITHUB_OUTPUT: out, ...extra,
  });
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
