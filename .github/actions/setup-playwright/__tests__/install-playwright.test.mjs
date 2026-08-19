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
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  APT_CONF,
  APT_LOCKS,
  installWithRetry,
  releaseAptLocks,
  runBounded,
} from '../install-playwright.mjs';

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

test('runBounded kills the whole TREE, not just the process it spawned', async () => {
  // The case the first version of this action got wrong, and the one its tests
  // could not see: `pnpm exec playwright install-deps` is three processes deep,
  // and the one holding /var/lib/apt/lists/lock is the `apt-get` at the bottom.
  // Signalling only the direct child leaves that apt-get alive, so every retry
  // after a timeout dies instantly on `E: Could not get lock` — a retry loop
  // spinning against a lock its own previous attempt still holds.
  //
  // So this spawns a PARENT that spawns a GRANDCHILD which ignores SIGTERM, and
  // asserts the grandchild is gone afterwards. With `child.kill()` in place of
  // the group kill, the grandchild survives and this fails.
  const pidFile = join(mkdtempSync(join(tmpdir(), 'pw-tree-')), 'grandchild.pid');
  const grandchild = `
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {}, 1000);
  `;
  const parent = `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  `;

  const result = await runBounded(process.execPath, ['-e', parent], { timeoutMs: 1500, graceMs: 500 });
  assert.equal(result.timedOut, true);

  const pid = Number(readFileSync(pidFile, 'utf-8'));
  assert.ok(Number.isInteger(pid) && pid > 0, 'the grandchild never recorded its pid');

  // `kill(pid, 0)` throws ESRCH once the process is gone. Poll briefly: the
  // group signal and the OS reaping it are not the same instant.
  const gone = async () => {
    for (let i = 0; i < 40; i += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  assert.ok(await gone(), `the grandchild (pid ${pid}) outlived the bound — the kill did not reach the tree`);
});

test('the apt config declares the bounds apt lacks by default', () => {
  // Asserted as CONTENT, not as a call: this file is what turns a hang into an
  // error, and everything else here depends on that having happened.
  for (const directive of ['Acquire::Retries "3";', 'Acquire::http::Timeout "30";', 'Acquire::https::Timeout "30";']) {
    assert.ok(APT_CONF.includes(directive), `missing ${directive}`);
  }
});

/**
 * A `runBounded` whose signalling is entirely injected, so the EPERM path can
 * be driven without a root-owned process to kill.
 *
 * The real bug lived exactly here and the suite above could not see it: those
 * tests spawn a grandchild owned by the SAME user, which is always killable.
 * Playwright's apt runs under sudo, so the process holding the lock is root's
 * and answers EPERM — a case no same-user test can reach.
 */
function killProbe({ killCode, escalateStatus = 0 }) {
  const escalations = [];
  const logged = [];
  const child = {
    pid: 4242,
    kill: () => {},
    on(event, handler) {
      // Close immediately after the bound fires, the way a wrapper dies on
      // SIGTERM while the root-owned process beneath it lives on.
      if (event === 'close') setTimeout(() => handler(0), 60);
    },
  };
  return {
    escalations,
    logged,
    run: () =>
      runBounded('irrelevant', [], {
        timeoutMs: 10,
        graceMs: 5,
        spawnFn: () => child,
        killFn: () => {
          const error = new Error(killCode);
          error.code = killCode;
          throw error;
        },
        escalateFn: (pid, signal) => {
          escalations.push({ pid, signal });
          return { status: escalateStatus };
        },
        log: (line) => logged.push(line),
      }),
  };
}

test('an unkillable root-owned group is escalated to sudo, by process GROUP', async () => {
  const probe = killProbe({ killCode: 'EPERM' });
  await probe.run();
  // Negative pid: the whole group, not just the wrapper — the apt-get is two
  // levels below the process we spawned.
  assert.deepEqual(
    probe.escalations.map((e) => e.pid),
    probe.escalations.map(() => -4242),
  );
  assert.ok(probe.escalations.length > 0, 'EPERM did not escalate to sudo at all');
  assert.ok(
    probe.escalations.some((e) => e.signal === 'SIGKILL'),
    'the group was never SIGKILLed with sudo',
  );
});

test('a sudo escalation that fails SAYS so instead of looking clean', async () => {
  const probe = killProbe({ killCode: 'EPERM', escalateStatus: 1 });
  await probe.run();
  assert.ok(
    probe.logged.some((line) => line.includes('sudo') && line.includes('apt lock')),
    `an unreachable process was not reported; logged: ${JSON.stringify(probe.logged)}`,
  );
});

test('a process that is simply already gone is not reported as a problem', async () => {
  const probe = killProbe({ killCode: 'ESRCH' });
  await probe.run();
  assert.deepEqual(probe.escalations, [], 'ESRCH should not reach for sudo');
  assert.deepEqual(probe.logged, [], 'ESRCH is the ordinary answer and should be silent');
});

test('a stale apt lock is released BEFORE the retry, not after the last attempt', async () => {
  // The ordering is the whole point. Attempt 2 starting while attempt 1's apt
  // still holds the lock dies in ~10s on `E: Could not get lock`, so the lane
  // reports three failures having really tried once. Observed exactly that in
  // a consumer, twice, with two different (wrong) fixes in place.
  const order = [];
  await assert.rejects(() =>
    installWithRetry({
      args: ['install-deps', 'chromium'],
      attempts: 3,
      run: async () => {
        order.push('attempt');
        return { ok: false, timedOut: true, code: null };
      },
      releaseLocks: () => order.push('release'),
      log: () => {},
      sleep: async () => {},
    }),
  );
  assert.deepEqual(order, ['attempt', 'release', 'attempt', 'release', 'attempt']);
});

test('the lock sweep asks the kernel who holds the FILE, not who is whose child', () => {
  // `sudo use_pty` puts the sudo'd apt in its own SESSION, so no amount of
  // process-group signalling reaches it. Naming the lock files is what makes
  // this independent of the tree.
  const calls = [];
  const released = releaseAptLocks({
    runFn: (cmd, argv) => {
      calls.push({ cmd, argv });
      return { status: 0 };
    },
    log: () => {},
  });
  assert.equal(released, true);
  assert.equal(calls[0].cmd, 'sudo');
  for (const lock of APT_LOCKS) {
    assert.ok(calls[0].argv.includes(lock), `the sweep never mentioned ${lock}`);
  }
});

test('the lock sweep falls back to pkill when fuser is not on the image', () => {
  const tried = [];
  releaseAptLocks({
    runFn: (_cmd, argv) => {
      const tool = argv[1];
      tried.push(tool);
      // 127 is what a missing binary answers.
      return { status: tool === 'fuser' ? 127 : 0 };
    },
    log: () => {},
  });
  assert.deepEqual(tried, ['fuser', 'pkill']);
});

test('nothing holding the lock is a quiet, ordinary answer', () => {
  const logged = [];
  const released = releaseAptLocks({
    runFn: () => ({ status: 1 }),
    log: (line) => logged.push(line),
  });
  assert.equal(released, false);
  assert.deepEqual(logged, [], 'an unheld lock should not warn about anything');
});

test('a sweep that cannot run at all SAYS so rather than looking clean', () => {
  const logged = [];
  releaseAptLocks({ runFn: () => ({ status: 127 }), log: (line) => logged.push(line) });
  assert.ok(
    logged.some((line) => line.includes('stale lock')),
    `an unusable sweep was not reported; logged: ${JSON.stringify(logged)}`,
  );
});
