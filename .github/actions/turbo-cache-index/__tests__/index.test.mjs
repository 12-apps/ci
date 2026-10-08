import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decideRestore, makeIndex } from '../index.mjs';

const now = Date.parse('2026-10-08T07:00:00Z');
const key = 'turbo-build-abc-123-1';
const a = '1234567890abcdef';
const b = 'fedcba0987654321';
const index = () => ({ version: 1, cacheKey: key, turboVersion: '2.7.5', createdAt: new Date(now).toISOString(), hashes: [a] });
const plan = () => ({ turboVersion: '2.7.5', tasks: [{ taskId: 'web#build', hash: b }] });

test('only a complete paired index and proved zero intersection skips restore', () => {
  assert.equal(decideRestore(index(), plan(), key, now).restore, false);
  assert.equal(decideRestore(index(), { ...plan(), tasks: [{ taskId: 'web#build', hash: a }] }, key, now).restore, true);
});

for (const [name, mutate] of [
  ['missing index', () => null],
  ['wrong payload key', i => ({ ...i, cacheKey: 'turbo-build-other' })],
  ['old schema', i => ({ ...i, version: 0 })],
  ['unknown Turbo version', i => ({ ...i, turboVersion: '2.7.6' })],
  ['stale index', i => ({ ...i, createdAt: new Date(now - 8 * 86400000).toISOString() })],
  ['future index', i => ({ ...i, createdAt: new Date(now + 120000).toISOString() })],
  ['malformed date', i => ({ ...i, createdAt: 'oops' })],
  ['missing hashes', i => ({ ...i, hashes: undefined })],
  ['malformed hash', i => ({ ...i, hashes: ['oops'] })],
  ['duplicate inventory', i => ({ ...i, hashes: [a, a] })],
]) test(`${name} preserves restore`, () => assert.equal(decideRestore(mutate(index()), plan(), key, now).restore, true));

for (const [name, mutate] of [
  ['missing plan', () => null],
  ['unknown version', p => ({ ...p, turboVersion: '3.0.0' })],
  ['empty task set', p => ({ ...p, tasks: [] })],
  ['missing task hashes', p => ({ ...p, tasks: [{ taskId: 'web#build' }] })],
  ['one incomplete dependency', p => ({ ...p, tasks: [...p.tasks, { taskId: 'upstream#build' }] })],
  ['missing task identity', p => ({ ...p, tasks: [{ hash: b }] })],
]) test(`${name} preserves restore`, () => assert.equal(decideRestore(index(), mutate(plan()), key, now).restore, true));

test('an upstream dependency intersection still restores', () => {
  assert.equal(decideRestore(index(), { ...plan(), tasks: [...plan().tasks, { taskId: 'upstream#build', hash: a }] }, key, now).restore, true);
});

test('empty matched cache key never authorizes skipping', () => assert.equal(decideRestore(index(), plan(), '', now).restore, true));

test('inventory uses actual regular archive files, including older useful tasks', () => {
  const root = mkdtempSync(join(tmpdir(), 'turbo-index-'));
  try {
    const dir = join(root, '.turbo/cache'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${a}.tar.zst`), 'archive');
    writeFileSync(join(dir, `${a}-meta.json`), '{}');
    const i = makeIndex(root, key, '2.7.5', now);
    assert.deepEqual(i.hashes, [a]);
    assert.equal(i.cacheKey, key);
    assert.equal(decideRestore(i, plan(), key, now).restore, false);
    symlinkSync(join(dir, `${a}.tar.zst`), join(dir, `${b}.tar.zst`));
    assert.throws(() => makeIndex(root, key, '2.7.5', now), /regular/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unknown archive naming cannot silently disappear from inventory', () => {
  const root = mkdtempSync(join(tmpdir(), 'turbo-index-'));
  try {
    mkdirSync(join(root, '.turbo/cache'), { recursive: true });
    writeFileSync(join(root, '.turbo/cache/unknown.tar.zst'), 'archive');
    assert.throws(() => makeIndex(root, key, '2.7.5', now), /unknown/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
