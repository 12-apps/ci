import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setupPlaywright } from '../setup-playwright.mjs';

for (const cacheHit of [true, false]) {
  test(`working exact browser avoids apt, cache hit=${cacheHit}`, async () => {
    await setupPlaywright({ browser: 'chromium', cacheHit }, {
      validate: async () => ({ ok: true }),
      configureApt: () => assert.fail('apt must not run'),
      install: () => assert.fail('install must not run'), log: () => {},
    });
  });
  for (const result of [{ ok: false }, { ok: false, timedOut: true }, undefined, 'throw']) {
    test(`inconclusive probe preserves installation, cache hit=${cacheHit}, result=${JSON.stringify(result)}`, async () => {
      const calls = [];
      await setupPlaywright({ browser: 'firefox', cacheHit, attempts: 3, timeoutMs: 360_000 }, {
        validate: async () => { calls.push('probe'); if (result === 'throw') throw Error('missing API'); return result; },
        configureApt: () => calls.push('apt'),
        install: async (options) => { calls.push(options); return 2; }, log: () => {},
      });
      assert.deepEqual(calls, ['probe', 'apt', {
        args: cacheHit ? ['install-deps', 'firefox'] : ['install', '--with-deps', 'firefox'],
        attempts: 3, timeoutMs: 360_000,
      }]);
    });
  }
}
test('fallback failure remains a setup failure', async () => {
  await assert.rejects(setupPlaywright({ browser: 'chromium', cacheHit: true }, {
    validate: async () => ({ ok: false }), configureApt: () => {},
    install: async () => { throw Error('all installation attempts failed'); }, log: () => {},
  }), /all installation attempts failed/);
});

const probe = fileURLToPath(new URL('../validate-browser.mjs', import.meta.url));
for (const requested of ['chromium', 'firefox', 'webkit']) {
  for (const scenario of ['working', 'missing-library', 'corrupt-cache', 'version-change', 'missing-version', 'wrong-browser']) {
    test(`consumer probe ${requested}: ${scenario}`, () => {
      const cwd = mkdtempSync(join(tmpdir(), 'pw-probe-'));
      try {
        const pkg = join(cwd, 'node_modules', '@playwright', 'test');
        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '1.56.0', main: 'index.cjs' }));
        writeFileSync(join(pkg, 'index.cjs'), `
const fs = require('node:fs');
const api = {};
for (const name of ['chromium','firefox','webkit']) api[name] = { launch: async options => {
  if (name !== ${JSON.stringify(requested)}) throw Error('wrong engine');
  if (options.headless !== true || options.timeout !== 20000) throw Error('unsafe launch options');
  if (${JSON.stringify(scenario)} === 'missing-library') throw Error('libnss3.so missing');
  if (${JSON.stringify(scenario)} === 'corrupt-cache') throw Error('Executable does not exist');
  return { newPage: async () => ({ evaluate: async fn => fn() }),
    close: async () => fs.writeFileSync('closed', name) };
}};
module.exports = api;`);
        const res = spawnSync(process.execPath, [probe], { cwd, encoding: 'utf8', env: {
          ...process.env, PW_BROWSER: scenario === 'wrong-browser' ? 'chrome' : requested,
          PW_VERSION: scenario === 'version-change' ? '1.55.0' : scenario === 'missing-version' ? '' : '1.56.0',
        } });
        if (scenario === 'working') {
          assert.equal(res.status, 0, res.stderr);
          assert.equal(readFileSync(join(cwd, 'closed'), 'utf8'), requested);
          assert.match(res.stdout, /launch, page and evaluation passed/);
        } else assert.notEqual(res.status, 0);
      } finally { rmSync(cwd, { recursive: true, force: true }); }
    });
  }
}
test('action passes its resolved cache-key version into validation', () => {
  const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  assert.match(action, /PW_VERSION: \$\{\{ steps\.playwright-version\.outputs\.version \}\}/);
});
