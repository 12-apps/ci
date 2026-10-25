import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { readPrivateJson } from '../bounded-output.mjs';
import { capture } from '../shadow.mjs';

async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'index-output-control-'));
  const bin = join(root, 'bin'), directory = join(root, 'private');
  mkdirSync(bin); mkdirSync(directory, { mode: 0o700 });
  try { return await fn({ root, bin, directory }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function currentPlanWithWriter({ root, bin, directory }, source) {
  const writer = join(bin, 'pnpm'), marker = join(root, 'writer-finished');
  writeFileSync(writer, `#!${process.execPath}\n${source}\n`); chmodSync(writer, 0o700);
  const script = `import { currentPlan } from ${JSON.stringify(new URL('../shadow.mjs', import.meta.url).href)};
    try { const value = await currentPlan(process.argv[1], false); console.log(JSON.stringify({ ok: true, value })); }
    catch { console.log(JSON.stringify({ ok: false })); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, directory], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OUTPUT_CONTROL_MARKER: marker },
    encoding: 'utf8', timeout: 8_000, maxBuffer: 4_096,
  });
  assert.equal(result.status, 0, 'the caller exits after cleanup, without exposing child output');
  assert.equal(existsSync(join(directory, 'private-dry-run.json')), false);
  return { report: JSON.parse(result.stdout), finished: existsSync(marker), output: result.stdout + result.stderr };
}

test('actual currentPlan accepts bounded JSON and removes its private file', () => fixture(paths => {
  const result = currentPlanWithWriter(paths, 'process.stdout.write(JSON.stringify({ tasks: [] }));');
  assert.deepEqual(result.report, { ok: true, value: { tasks: [] } });
}));

test('the exclusive private file is 0600 and its on-disk bytes never exceed the limit', () => fixture(async ({ directory }) => {
  const path = join(directory, 'private-dry-run.json'), limit = 16_384;
  let peak = 0;
  await assert.rejects(readPrivateJson(directory, process.execPath, ['-e', `
    const { writeSync } = require('node:fs');
    const data = Buffer.alloc(4096, 'x');
    for (let i = 0; i < 256; i++) writeSync(1, data);
  `], {
    maxBytes: limit,
    spawnFn: (command, args, options) => {
      const child = spawn(command, args, options);
      child.stdout.on('data', () => {
        const info = statSync(path); peak = Math.max(peak, info.size);
        assert.equal(info.mode & 0o777, 0o600);
      });
      return child;
    },
  }), error => error.reason === 'output-limit' && error.bytesWritten <= limit);
  assert.ok(peak <= limit);
  assert.equal(existsSync(path), false);
}));

test('a valid JSON document exactly at the byte cap is accepted', () => fixture(async ({ directory }) => {
  const text = JSON.stringify({ value: 'é' }), bytes = Buffer.byteLength(text);
  const actual = await readPrivateJson(directory, process.execPath, ['-e', `process.stdout.write(${JSON.stringify(text)})`], { maxBytes: bytes });
  assert.deepEqual(actual, { value: 'é' });
  assert.equal(existsSync(join(directory, 'private-dry-run.json')), false);
}));

test('invalid JSON and child failure remove private output without exposing its values', () => fixture(async ({ directory }) => {
  for (const source of ['process.stdout.write("PRIVATE_PLACEHOLDER_VALUE");', 'process.stdout.write("PRIVATE_PLACEHOLDER_VALUE"); process.exitCode = 1;']) {
    await assert.rejects(readPrivateJson(directory, process.execPath, ['-e', source]), error => !String(error).includes('PRIVATE_PLACEHOLDER_VALUE'));
    assert.equal(existsSync(join(directory, 'private-dry-run.json')), false);
  }
}));

test('spawn failure cleans up and a pre-existing file is preserved', () => fixture(async ({ directory }) => {
  const path = join(directory, 'private-dry-run.json');
  await assert.rejects(readPrivateJson(directory, join(directory, 'absent-command'), []), error => error.reason === 'spawn-failed');
  assert.equal(existsSync(path), false);
  writeFileSync(path, 'existing owner');
  await assert.rejects(readPrivateJson(directory, process.execPath, []), { code: 'EEXIST' });
  assert.equal(readFileSync(path, 'utf8'), 'existing owner');
}));

function runnable(pid) {
  try { return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function assertTerminated(pids) {
  // SIGKILL is delivered asynchronously by the kernel. Bound that delivery
  // interval, then inspect state; a fixed delay alone is not the assertion.
  const deadline = performance.now() + 250;
  while (pids.some(runnable) && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  for (const pid of pids) assert.equal(runnable(pid), false);
}

function treeSource(pidPath, mode) {
  const child = `process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`;
  return `const { spawn } = require('node:child_process');
    const { writeFileSync, writeSync } = require('node:fs');
    process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.once('message', () => {
      writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify([process.pid, child.pid]));
      ${mode === 'overflow' ? `const bytes = Buffer.alloc(4096, 'x'); for (let i = 0; i < 1024; i++) writeSync(1, bytes);` : mode === 'success' ? `process.stdout.write('{}', () => process.exit(0));` : `setInterval(() => {}, 1000);`}
    });`;
}

for (const mode of ['overflow', 'timeout', 'success']) test(`${mode} terminates an ignoring descendant and removes private output`, { timeout: 8_000 }, () => fixture(async ({ root, directory }) => {
  const pidPath = join(root, 'pids.json'), signals = [];
  const options = { maxBytes: 16_384, timeoutMs: 1_000, graceMs: 25,
    killFn: (pid, signal) => { signals.push(signal); process.kill(pid, signal); } };
  try {
    const attempt = readPrivateJson(directory, process.execPath, ['-e', treeSource(pidPath, mode)], options);
    if (mode === 'success') assert.deepEqual(await attempt, {});
    else await assert.rejects(attempt, error => error.reason === (mode === 'overflow' ? 'output-limit' : 'timeout'));
    const pids = JSON.parse(readFileSync(pidPath, 'utf8'));
    // Kernel state, rather than a wait or completion marker, proves that a
    // zombie may await its reaper but neither process can continue executing.
    await assertTerminated(pids);
    assert.ok(signals.includes('SIGKILL'));
    if (mode !== 'success') assert.ok(signals.includes('SIGTERM'));
    assert.equal(existsSync(join(directory, 'private-dry-run.json')), false);
  } finally {
    if (existsSync(pidPath)) for (const pid of JSON.parse(readFileSync(pidPath, 'utf8'))) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}));

test('an inconclusive capture cleans its owned temporary directory and retains restore', () => fixture(async ({ root, directory }) => {
  mkdirSync(join(root, '.turbo'));
  const result = await capture({ root, temp: directory, matchedKey: 'probe-payload', cleanBeforeRestore: true, version: '2.7.5', runPlan: async () => { throw new Error('unavailable'); } });
  assert.equal(result.ready, false); assert.equal(result.report.decision.restore, true);
  assert.deepEqual(readdirSync(directory), []);
}));

test('actual currentPlan stops a writer during overflow before its completion marker', () => fixture(paths => {
  const result = currentPlanWithWriter(paths, `
    const { writeSync, writeFileSync } = require('node:fs');
    const chunk = Buffer.alloc(64 * 1024, 'x');
    for (let i = 0; i < 544; i++) writeSync(1, chunk);
    writeFileSync(process.env.OUTPUT_CONTROL_MARKER, 'completed the over-limit write');
  `);
  assert.equal(result.report.ok, false);
  assert.equal(result.finished, false, 'the previous post-exit check allowed all 35,651,584 bytes');
  assert.doesNotMatch(result.output, /xxxx/);
}));
