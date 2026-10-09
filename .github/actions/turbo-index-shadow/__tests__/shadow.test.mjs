import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { capture, producer, clearTransport, verifyTransport } from '../shadow.mjs';

const a = '1234567890abcdef', b = 'fedcba0987654321';
const environment = () => ({ specified: { env: [] }, configured: [], inferred: [] });
const plan = (hash = b) => ({ turboVersion: '2.7.5', globalCacheInputs: { environmentVariables: environment() }, tasks: [{ taskId: 'example#build', hash, command: 'node build.mjs', environmentVariables: environment() }] });

async function fixture(fn) {
  const parent = mkdtempSync(join(tmpdir(), 'index-shadow-test-'));
  const root = join(parent, 'repo'), temp = join(parent, 'temp');
  mkdirSync(join(root, '.turbo/custom'), { recursive: true }); mkdirSync(temp);
  writeFileSync(join(root, '.turbo/custom', `${a}.tar.zst`), 'archive bytes');
  try { return await fn({ root, temp }); } finally { rmSync(parent, { recursive: true, force: true }); }
}

test('complete current inventory is advisory, measures bytes, and never skips actual work', async () => fixture(async ({ root, temp }) => {
  const before = readFileSync(join(root, '.turbo/custom', `${a}.tar.zst`));
  const result = await capture({ root, temp, matchedKey: 'turbo-build-example', cleanBeforeRestore: true, runPlan: async () => plan(), version: '2.7.5' });
  assert.equal(result.report.decision.restore, false);
  assert.equal(result.report.actualRestoreRetained, true);
  assert.equal(result.report.payload.archiveBytes, 13);
  assert.equal(result.report.productionPairedIndex, false);
  assert.deepEqual(readFileSync(join(root, '.turbo/custom', `${a}.tar.zst`)), before);
  const prepared = producer({ root, saveKey: 'turbo-build-new', version: '2.7.5', payloadSaveAllowed: false });
  assert.equal(prepared.actualPayloadIndexPublished, false);
  assert.equal(prepared.normalPayloadSaveAllowed, false);
}));

for (const [name, options] of [
  ['useful hit', { runPlan: async () => plan(a) }],
  ['partial including dependency hit', { runPlan: async () => ({ ...plan(), tasks: [...plan().tasks, { ...plan(a).tasks[0], taskId: 'dependency#build', command: '<NONEXISTENT>' }] }) }],
  ['empty graph', { runPlan: async () => ({ ...plan(), tasks: [] }) }],
  ['unknown baseline', { cleanBeforeRestore: false }],
  ['no matched key', { matchedKey: '' }],
  ['transient observer environment', { runPlan: async () => ({ ...plan(), globalCacheInputs: { environmentVariables: { ...environment(), specified: { env: ['SHADOW_MATCHED_KEY'] } } } }) }],
  ['failed or timed out dry-run', { runPlan: async () => { throw new Error('bounded dry-run unavailable'); } }],
]) test(`${name} keeps fallback`, async () => fixture(async ({ root, temp }) => {
  const result = await capture({ root, temp, matchedKey: 'turbo-build-example', cleanBeforeRestore: true, runPlan: async () => plan(), version: '2.7.5', ...options });
  assert.equal(result.report.decision.restore, true);
  assert.equal(result.report.actualRestoreRetained, true);
}));

test('private owned transport is digest checked and corruption cannot become evidence', async () => fixture(async ({ root, temp }) => {
  const result = await capture({ root, temp, matchedKey: 'turbo-build-example', cleanBeforeRestore: true, runPlan: async () => plan(), version: '2.7.5' });
  const original = readFileSync(result.indexPath);
  clearTransport(result.statePath);
  assert.throws(() => verifyTransport(result.statePath), /unavailable/);
  writeFileSync(result.indexPath, 'corrupt');
  assert.throws(() => verifyTransport(result.statePath), /digest/);
  writeFileSync(result.indexPath, original);
  assert.equal(verifyTransport(result.statePath).sameBytes, true);
  assert.equal(verifyTransport(result.statePath).deployedPairingProven, false);
}));

test('symlinked custom archives are rejected without following them', async () => fixture(async ({ root, temp }) => {
  symlinkSync(join(root, '.turbo/custom', `${a}.tar.zst`), join(root, '.turbo/custom', `${b}.tar.zst`));
  const result = await capture({ root, temp, matchedKey: 'turbo-build-example', cleanBeforeRestore: true, runPlan: async () => plan(), version: '2.7.5' });
  assert.equal(result.report.decision.restore, true);
  assert.equal(result.ready, false);
}));

test('a symlinked payload root is not an inventory', async () => fixture(async ({ root, temp }) => {
  renameSync(join(root, '.turbo'), join(root, 'outside'));
  symlinkSync(join(root, 'outside'), join(root, '.turbo'));
  const result = await capture({ root, temp, matchedKey: 'turbo-build-example', cleanBeforeRestore: true, runPlan: async () => plan(), version: '2.7.5' });
  assert.equal(result.report.decision.restore, true);
  assert.equal(result.ready, false);
}));

test('clear refuses an unowned path and preserves the original file', () => fixture(({ root }) => {
  const statePath = join(root, 'state.json'); writeFileSync(statePath, '{}');
  assert.throws(() => clearTransport(statePath), /unowned/);
  assert.equal(readFileSync(statePath, 'utf8'), '{}');
}));

test('advisory CLI failure exits zero, warns, and emits no secret error value', () => {
  const result = spawnSync(process.execPath, [new URL('../main.mjs', import.meta.url).pathname, 'before'], {
    encoding: 'utf8', env: { ...process.env, SHADOW_MATCHED_KEY: 'secret\nvalue', RUNNER_TEMP: '/nonexistent-shadow-parent' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /warning/);
  assert.doesNotMatch(result.stdout + result.stderr, /secret\nvalue/);
});
