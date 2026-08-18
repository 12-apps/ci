#!/usr/bin/env node
/**
 * Self-tests for the setup-playwright action's bound-and-retry ladder. Run:
 *   node --test .github/actions/setup-playwright/__tests__/install-playwright.test.mjs
 *
 * The centerpiece is the case a bare `pnpm exec playwright install-deps` gets
 * wrong: a child that never exits. `runBounded` is driven against a REAL
 * process that ignores SIGTERM, because that is what apt does — a timeout that
 * only sends SIGTERM would report a kill and leave the process running, which
 * looks identical to working from the outside.
 *
 * Node builtins only — this runs before any install.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { APT_CONF, installWithRetry, runBounded } from '../install-playwright.mjs';

/** A runner that fails the first `failures` attempts, then succeeds. */
const flaky = (failures, { timedOut = false } = {}) => {
  let seen = 0;
  return async () => {
    seen += 1;
    return seen <= failures ? { ok: false, timedOut, code: timedOut ? null : 1 } : { ok: true, timedOut: false, code: 0 };
  };
};

const noSleep = async () => {};

test('a clean install runs once and warns about nothing', async () => {
  const warnings = [];
  const used = await installWithRetry({
    args: ['install-deps', 'chromium'],
    run: flaky(0),
    log: (m) => warnings.push(m),
    sleep: noSleep,
  });
  assert.equal(used, 1);
  assert.deepEqual(warnings, []);
});

test('a transient stall is retried rather than failing the lane', async () => {
  const warnings = [];
  const used = await installWithRetry({
    args: ['install-deps', 'chromium'],
    run: flaky(2, { timedOut: true }),
    log: (m) => warnings.push(m),
    sleep: noSleep,
  });
  assert.equal(used, 3);
  assert.equal(warnings.length, 2);
  // The log has to say STALLED, not just "failed" — the whole point of the
  // change is that the two have different causes and different remedies.
  assert.match(warnings[0], /stalled past \d+s and was killed \(attempt 1\/3\)/);
});

test('an install that is broken rather than stalled still fails the lane', async () => {
  await assert.rejects(
    installWithRetry({ args: ['install-deps', 'chromium'], run: flaky(99), log: () => {}, sleep: noSleep }),
    /failed 3 times/,
  );
});

test('a non-zero exit is reported as an exit, not as a stall', async () => {
  const warnings = [];
  await installWithRetry({
    args: ['install', '--with-deps', 'chromium'],
    run: flaky(1),
    log: (m) => warnings.push(m),
    sleep: noSleep,
  });
  assert.match(warnings[0], /exited 1 \(attempt 1\/3\)/);
});

test('runBounded kills a child that ignores SIGTERM, and reports the timeout', async () => {
  // apt does not always go quietly, so SIGTERM alone is not a bound. This is
  // the assertion that would fail if the SIGKILL escalation were dropped.
  const started = Date.now();
  const result = await runBounded(
    'node',
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { timeoutMs: 300, graceMs: 300 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5000, 'the bound must actually end the process');
});

test('runBounded lets a fast command through untouched', async () => {
  const result = await runBounded('node', ['-e', 'process.exit(0)'], { timeoutMs: 10_000 });
  assert.deepEqual({ ok: result.ok, timedOut: result.timedOut, code: result.code }, { ok: true, timedOut: false, code: 0 });
});

test('the apt config declares the bounds apt lacks by default', () => {
  // Asserted as CONTENT, not as a call: this file is what turns a hang into an
  // error, and everything else here depends on that having happened.
  for (const directive of ['Acquire::Retries "3";', 'Acquire::http::Timeout "30";', 'Acquire::https::Timeout "30";']) {
    assert.ok(APT_CONF.includes(directive), `missing ${directive}`);
  }
});
