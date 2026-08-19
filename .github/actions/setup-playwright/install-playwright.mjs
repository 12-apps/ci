/* global process */
/**
 * Install Playwright's browser and its apt system dependencies WITHOUT the
 * stall that hangs a lane for hours.
 *
 * ── The bug this exists to prevent ──────────────────────────────────────────
 * `playwright install-deps` shells out to `apt-get update`. apt has NO timeout
 * for a mirror that accepts the connection and then stops sending: the socket
 * stays open, apt keeps waiting, and the step never ends. Observed five times
 * in one afternoon in a consumer, 54 to 131 minutes each, every one ending
 * mid-fetch with the same shape:
 *
 *     Ign:14 http://azure.archive.ubuntu.com/ubuntu noble-updates/main amd64 Packages
 *     Get:5  https://archive.ubuntu.com/ubuntu noble-security InRelease [126 kB]
 *     <silence until the job was cancelled>
 *
 * The Azure mirror was being ignored and the archive.ubuntu.com fallback went
 * quiet. Nothing was wrong with the lane; there was simply no clock on the
 * network.
 *
 * A hang is the worst shape this failure can take. It is indistinguishable
 * from work — the check never resolves, auto-merge waits on it, and nothing
 * says which — and, decisively, it CANNOT BE RETRIED. Only a failure can.
 *
 * ── What this does instead ──────────────────────────────────────────────────
 * 1. Give apt the network bounds it lacks (`Acquire::Retries`, http/https/ftp
 *    timeouts). This is the load-bearing step: it turns a hang into an error.
 * 2. Bound each attempt with a hard wall clock anyway, because (1) only covers
 *    apt's own sockets — a stall anywhere else in the install would still hang.
 *    SIGTERM first, SIGKILL after a grace period, because apt does not always
 *    go quietly.
 * 3. Retry. A stalled mirror is transient; one bad fetch is not a lane failure.
 *
 * The bound lives HERE rather than as `timeout-minutes:` on the step because
 * GitHub does not support that key on a composite action's steps — a caller
 * would have to remember to bound the whole job, which is both coarser and
 * exactly the kind of thing that gets forgotten.
 */
import { spawn, spawnSync } from 'node:child_process';

/** apt's missing network bounds. Written before any install runs. */
export const APT_CONF = [
  'Acquire::Retries "3";',
  'Acquire::http::Timeout "30";',
  'Acquire::https::Timeout "30";',
  'Acquire::ftp::Timeout "30";',
  '',
].join('\n');

export const APT_CONF_PATH = '/etc/apt/apt.conf.d/99-ci-network-timeouts';

/**
 * Run one command under a hard deadline.
 *
 * Resolves `{ ok, timedOut, code }` rather than throwing: the caller's retry
 * loop needs to tell "failed" from "timed out" to say which in the log, and an
 * exception would flatten the two.
 */
export function runBounded(
  command,
  args,
  {
    timeoutMs,
    graceMs = 30_000,
    spawnFn = spawn,
    killFn = (pid, signal) => process.kill(pid, signal),
    escalateFn = (pid, signal) =>
      spawnSync('sudo', ['-n', 'kill', '-s', signal.replace(/^SIG/, ''), '--', String(pid)], {
        stdio: ['ignore', 'ignore', 'inherit'],
      }),
    log = console.log,
  } = {},
) {
  return new Promise((resolve) => {
    // `detached` puts the child in its OWN process group, which is what lets a
    // single signal reach its descendants.
    //
    // Signalling the child alone is not enough: `pnpm exec playwright
    // install-deps` is three processes deep, and the one that matters is the
    // `apt-get` at the bottom. Killing the wrapper leaves that apt-get running
    // and HOLDING /var/lib/apt/lists/lock, so every retry after it dies on
    // `E: Could not get lock` — a retry loop spinning against a lock its own
    // previous attempt still holds.
    const child = spawnFn(command, args, { stdio: 'inherit', detached: true });
    let timedOut = false;

    /**
     * Signal the whole process group, escalating to `sudo` when it holds
     * root-owned processes.
     *
     * The escalation is the load-bearing part, and it was missing. Playwright
     * announces `Switching to root user to install dependencies...` and runs
     * apt under sudo, so the process actually holding the apt lock is owned by
     * ROOT while this runs as the unprivileged runner user. `process.kill`
     * answers EPERM, not ESRCH — the orphan is alive and simply out of reach.
     *
     * The first version of this swallowed every error as "already reaped",
     * which is why the bug survived a fix that looked correct: the log showed a
     * clean kill, the lock stayed held, and the two facts never met. Nothing is
     * swallowed here now — an unreachable process gets SAID.
     */
    const killGroup = (signal) => {
      try {
        killFn(-child.pid, signal);
        return;
      } catch (error) {
        // Already gone is the ordinary answer, and not worth a line of log.
        if (error?.code === 'ESRCH') return;
        if (error?.code !== 'EPERM') {
          log(`could not ${signal} the install process group: ${error?.message ?? error}`);
          return;
        }
      }
      // EPERM: something in the group is root's (apt, via playwright's sudo).
      const escalated = escalateFn(-child.pid, signal);
      if (escalated?.status !== 0) {
        log(
          `could not ${signal} the root-owned install process group even with sudo ` +
            `(exit ${escalated?.status ?? 'n/a'}) — a stale apt lock may fail the retries below`,
        );
      }
    };

    const hardKill = setTimeout(() => killGroup('SIGKILL'), timeoutMs + graceMs);
    const softKill = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(softKill);
      clearTimeout(hardKill);
      resolve({ ok: false, timedOut: false, code: null });
    });
    child.on('close', (code) => {
      clearTimeout(softKill);
      clearTimeout(hardKill);
      // The spawned process closing does NOT mean the tree is gone. The wrapper
      // dies on SIGTERM while the `apt-get` beneath it ignores it and keeps the
      // lock — and cancelling the pending SIGKILL here is what used to let that
      // orphan survive, because `close` arrives before the hard kill was due.
      // Sweep the group once more on the way out; ESRCH is the normal answer.
      if (timedOut) killGroup('SIGKILL');
      resolve({ ok: code === 0 && !timedOut, timedOut, code });
    });
  });
}

/**
 * The locks an interrupted apt run leaves behind.
 *
 * All four, not just the one the log names: which is held depends on how far
 * the run got, and a retry blocked on any of them fails the same way.
 */
export const APT_LOCKS = [
  '/var/lib/apt/lists/lock',
  '/var/lib/dpkg/lock',
  '/var/lib/dpkg/lock-frontend',
  '/var/cache/apt/archives/lock',
];

/**
 * Kill whatever still holds apt's locks, by FILE rather than by process tree.
 *
 * This is the third shape of this fix and the first that does not depend on
 * process topology, because the previous two both did and both were wrong.
 *
 * `sudo` on Ubuntu runs with `Defaults use_pty` (the default since sudo 1.9),
 * which gives the command its own pty and therefore its own SESSION. Playwright
 * announces `Switching to root user...` and sudos apt, so the `apt-get` holding
 * the lock is in a session of its own — not in the process group we spawned,
 * and not reachable by signalling that group however carefully.
 *
 * The evidence, from a consumer run where the group kill was already in place:
 * attempt 1 was killed, no escalation path ran (so `process.kill` had
 * SUCCEEDED — it killed the wrapper), and attempts 2 and 3 still reported
 * `held by process 2460 (apt-get)`. A kill that lands on the wrong group looks
 * exactly like a kill that worked.
 *
 * So: ask the kernel who has the lock FILE open and kill that, which is true
 * regardless of who is whose parent. `fuser` is the direct question; `pkill` is
 * the fallback for an image without psmisc. Both are best-effort by design —
 * this runs between retries, and a cleanup that throws would fail a lane that
 * still had attempts left.
 */
export function releaseAptLocks({ runFn = spawnSync, log = console.log } = {}) {
  const attempts = [
    { what: 'fuser', argv: ['-n', 'fuser', '-k', '-KILL', ...APT_LOCKS] },
    { what: 'pkill', argv: ['-n', 'pkill', '-KILL', '-x', 'apt-get|apt|dpkg'] },
  ];
  for (const { what, argv } of attempts) {
    const result = runFn('sudo', argv, { stdio: ['ignore', 'ignore', 'ignore'] });
    // 0 = killed something, 1 = nothing was holding it (both fine and quiet).
    // Anything else means the tool is missing or refused, so try the next one.
    if (result?.status === 0) {
      log(`released a stale apt lock with ${what} before retrying`);
      return true;
    }
    if (result?.status === 1) return false;
  }
  log('could not release apt locks with either fuser or pkill — a retry may hit a stale lock');
  return false;
}

/**
 * Install, retrying a stall or a failure up to `attempts` times.
 *
 * Returns the number of attempts used; throws only when every one is spent, so
 * a genuinely broken install still fails the lane rather than being swallowed.
 */
export async function installWithRetry({
  args,
  attempts = 3,
  timeoutMs = 6 * 60_000,
  run = runBounded,
  log = console.log,
  releaseLocks = releaseAptLocks,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await run('pnpm', ['exec', 'playwright', ...args], { timeoutMs });
    if (result.ok) return attempt;

    const why = result.timedOut
      ? `stalled past ${Math.round(timeoutMs / 1000)}s and was killed`
      : `exited ${result.code}`;
    log(`::warning::playwright ${args.join(' ')} ${why} (attempt ${attempt}/${attempts})`);
    if (attempt < attempts) {
      // BEFORE the next attempt, not after the last: a retry that starts while
      // the previous one's apt is still holding the lock is not a retry at all.
      // It fails in about ten seconds, and the lane then reports three
      // failures having genuinely tried once.
      releaseLocks({ log });
      await sleep(10_000);
    }
  }
  throw new Error(`playwright ${args.join(' ')} failed ${attempts} times`);
}
