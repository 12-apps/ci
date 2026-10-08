import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const main = resolve(dirname(fileURLToPath(import.meta.url)), '../main.mjs');
const a = '1234567890abcdef', b = 'fedcba0987654321', key = 'paired-payload-123-1';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'turbo-index-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.turbo/index'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/pnpm'), `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));\nif(process.env.PLAN_FAILURE) process.exit(17);\nprocess.stdout.write(process.env.PLAN_JSON);\n`, { mode: 0o755 });
  const output = join(dir, 'output'); writeFileSync(output, '');
  writeFileSync(join(dir, '.turbo/index/build.json'), JSON.stringify({ version: 1, cacheKey: key, turboVersion: '2.7.5', createdAt: new Date().toISOString(), hashes: [a] }));
  const run = (extra = {}, mode = 'check') => spawnSync(process.execPath, [main, mode], {
    cwd: dir, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GITHUB_OUTPUT: output, RUNNER_TEMP: dir, TURBO_MATCHED_KEY: key,
      PLAN_JSON: JSON.stringify({ turboVersion: '2.7.5', globalCacheInputs: { environmentVariables: { specified: { env: [] }, configured: [], inferred: [] } }, tasks: [{ taskId: 'web#build', hash: b, environmentVariables: { specified: { env: [] }, configured: [], inferred: [] } }] }), ...extra },
  });
  return { dir, output, run };
}

test('real entrypoint forwards the actual immutable affected context and proves no overlap', t => {
  const f = fixture(t); const r = f.run({ GITHUB_EVENT_NAME: 'pull_request', SELECTION_BASE: 'abc' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(f.output, 'utf8'), 'restore=false\n');
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'args.json'))), ['exec','turbo','run','build','--dry=json','--no-daemon','--affected']);
});

for (const [name, env] of [['failed dry-run', { PLAN_FAILURE: '1' }], ['malformed dry-run', { PLAN_JSON: '{}' }], ['invalid JSON', { PLAN_JSON: 'oops' }], ['wrong paired key', { TURBO_MATCHED_KEY: 'other-payload' }]]) {
  test(`${name} retains restore without failing the job`, t => {
    const f = fixture(t); const r = f.run(env);
    assert.equal(r.status, 0, r.stderr); assert.equal(readFileSync(f.output, 'utf8'), 'restore=true\n');
  });
}

test('missing index retains restore without running Turbo', t => {
  const f = fixture(t); rmSync(join(f.dir, '.turbo/index/build.json'));
  assert.equal(f.run().status, 0); assert.equal(readFileSync(f.output, 'utf8'), 'restore=true\n');
  assert.throws(() => readFileSync(join(f.dir, 'args.json')));
});

test('push plans the full unchanged build, not the PR affected subset', t => {
  const f = fixture(t); assert.equal(f.run({ GITHUB_EVENT_NAME: 'push', SELECTION_BASE: 'abc' }).status, 0);
  assert.ok(!JSON.parse(readFileSync(join(f.dir, 'args.json'))).includes('--affected'));
});

test('failed inventory deletes a previously restored index and reports not ready', t => {
  const f = fixture(t); assert.equal(f.run({}, 'record').status, 0);
  assert.equal(readFileSync(f.output, 'utf8'), 'ready=false\n');
  assert.throws(() => readFileSync(join(f.dir, '.turbo/index/build.json')));
});

test('unknown mode is a usage error', t => assert.equal(fixture(t).run({}, 'unknown').status, 2));
