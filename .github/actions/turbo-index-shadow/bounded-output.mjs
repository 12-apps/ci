import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_PLAN_BYTES = 32_000_000;

/** A private file never grows beyond the cap; child output never enters logs. */
export async function readPrivateJson(directory, command, args, {
  maxBytes = MAX_PLAN_BYTES, timeoutMs = 30_000, graceMs = 5_000,
  spawnFn = spawn, killFn = (pid, signal) => process.kill(pid, signal),
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isFinite(timeoutMs) || timeoutMs < 1 ||
      !Number.isFinite(graceMs) || graceMs < 0) throw new Error('invalid private-output bounds');
  const path = join(directory, 'private-dry-run.json');
  // Exclusive creation means cleanup can never delete a pre-existing file.
  const fd = openSync(path, 'wx', 0o600);
  try {
    const result = await new Promise(resolve => {
      let child, bytes = 0, failure = null, settled = false, deadline, hardKill;
      const signal = kind => {
        if (!child?.pid) return;
        try { killFn(-child.pid, kind); }
        catch (error) { if (error?.code !== 'ESRCH') failure = 'termination-unproved'; }
      };
      const finish = code => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline); clearTimeout(hardKill);
        // A closing wrapper does not prove its descendants exited. Sweep the
        // detached group on success too; no unrelated process is in this group.
        signal('SIGKILL');
        resolve({ ok: code === 0 && failure === null, reason: failure ?? 'child-failed', bytes });
      };
      const abort = reason => {
        if (failure !== null || settled) return;
        failure = reason;
        signal('SIGTERM');
        // Stop reading immediately, so neither disk nor buffered output can
        // keep growing during the termination grace period.
        child.stdout.destroy();
        hardKill = setTimeout(() => signal('SIGKILL'), graceMs);
      };
      try { child = spawnFn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch { finish(null); return; }
      child.on('error', () => { failure ??= 'spawn-failed'; finish(null); });
      child.on('close', finish);
      child.stdout.on('error', () => abort('output-unavailable'));
      child.stdout.on('data', chunk => {
        if (failure !== null || settled) return;
        if (bytes + chunk.length > maxBytes) { abort('output-limit'); return; }
        try {
          let offset = 0;
          while (offset < chunk.length) {
            const count = writeSync(fd, chunk, offset, chunk.length - offset);
            if (count < 1) throw new Error('short write');
            offset += count; bytes += count;
          }
        } catch { abort('output-unavailable'); }
      });
      deadline = setTimeout(() => abort('timeout'), timeoutMs);
    });
    if (!result.ok) {
      const error = new Error('bounded private JSON unavailable');
      error.reason = result.reason; error.bytesWritten = result.bytes;
      throw error;
    }
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new Error('bounded private JSON invalid'); }
  } finally {
    try { closeSync(fd); } finally { unlinkSync(path); }
  }
}
