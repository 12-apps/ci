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
import { spawn } from 'node:child_process';

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
export function runBounded(command, args, { timeoutMs, graceMs = 30_000, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnFn(command, args, { stdio: 'inherit' });
    let timedOut = false;

    const hardKill = setTimeout(() => child.kill('SIGKILL'), timeoutMs + graceMs);
    const softKill = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(softKill);
      clearTimeout(hardKill);
      resolve({ ok: false, timedOut: false, code: null });
    });
    child.on('close', (code) => {
      clearTimeout(softKill);
      clearTimeout(hardKill);
      resolve({ ok: code === 0 && !timedOut, timedOut, code });
    });
  });
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
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await run('pnpm', ['exec', 'playwright', ...args], { timeoutMs });
    if (result.ok) return attempt;

    const why = result.timedOut
      ? `stalled past ${Math.round(timeoutMs / 1000)}s and was killed`
      : `exited ${result.code}`;
    log(`::warning::playwright ${args.join(' ')} ${why} (attempt ${attempt}/${attempts})`);
    if (attempt < attempts) await sleep(10_000);
  }
  throw new Error(`playwright ${args.join(' ')} failed ${attempts} times`);
}
