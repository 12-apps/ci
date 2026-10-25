import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { controlledDecision, savePaired } from '../paired-proof.mjs';

const key = 'index-pair-1-2-1-payload';
const env = { specified: { env: [] }, configured: [], inferred: [] };
const index = { version: 1, cacheKey: key, turboVersion: '2.7.5', createdAt: new Date().toISOString(), hashes: ['1111111111111111'] };
const plan = { turboVersion: '2.7.5', globalCacheInputs: { environmentVariables: env }, tasks: [{ taskId: 'a#build', hash: '2222222222222222', environmentVariables: env }] };
test('only the complete disjoint control omits payload; unsafe controls retain it', () => {
  assert.equal(controlledDecision('zero', index, plan, key).restore, false);
  for (const name of ['missing', 'corrupt', 'stale', 'wrong-key', 'inconclusive']) assert.equal(controlledDecision(name, index, plan, key).restore, true, name);
  const useful = { ...plan, tasks: [{ ...plan.tasks[0], hash: index.hashes[0] }] };
  assert.equal(controlledDecision('useful', index, useful, key).restore, true);
  assert.equal(controlledDecision('partial', index, { ...plan, tasks: [...plan.tasks, ...useful.tasks] }, key).restore, true);
});
for (const failure of ['save-error', 'negative-id', 'wrong-lookup', 'payload-mutation']) test(`never publishes an index after ${failure}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'paired-save-control-')), calls = [];
  mkdirSync(join(root, '.turbo')); const archive = join(root, '.turbo', '1111111111111111.tar.zst'); writeFileSync(archive, 'payload');
  const cache = {
    saveCache: async (paths, savedKey) => { calls.push(savedKey); if (failure === 'save-error') throw new Error('save failed'); if (failure === 'payload-mutation') writeFileSync(archive, 'changed'); return failure === 'negative-id' ? -1 : 12; },
    restoreCache: async () => failure === 'wrong-lookup' ? `${key}-other` : key,
  };
  try {
    await assert.rejects(savePaired({ root, key, cache }));
    assert.deepEqual(calls, [key]); assert.equal(existsSync(join(root, '_index')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('publishes exact-key index only after confirmed stable payload save', async () => {
  const root = mkdtempSync(join(tmpdir(), 'paired-save-control-')), calls = [];
  mkdirSync(join(root, '.turbo')); writeFileSync(join(root, '.turbo', '1111111111111111.tar.zst'), 'payload');
  const cache = { saveCache: async (paths, savedKey) => { calls.push(savedKey); return 12; }, restoreCache: async () => key };
  try { const receipt = await savePaired({ root, key, cache }); assert.deepEqual(calls, [key, `${key}-index`]); assert.equal(receipt.key, key); assert.match(receipt.indexSha256, /^[0-9a-f]{64}$/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
