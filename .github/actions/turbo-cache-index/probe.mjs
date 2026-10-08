// Bounded real Turbo 2.7.5 fixture; never an application/full-suite substitute.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [mode, rootArg, scenario = 'useful-hit'] = process.argv.slice(2);
const root = resolve(rootArg);
const binary = process.env.TURBO_BINARY;
const json = (path, value) => writeFileSync(join(root, path), JSON.stringify(value));
if (mode === 'prepare') {
  rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
  json('package.json', { name: 'cache-index-probe', private: true, packageManager: 'pnpm@10.34.5' });
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - packages/*\n");
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/a: {}\n  packages/b:\n    dependencies:\n      a:\n        specifier: workspace:*\n        version: link:../a\n  packages/c:\n    dependencies:\n      b:\n        specifier: workspace:*\n        version: link:../b\n");
  json('turbo.json', { globalDependencies: ['build.mjs', 'pnpm-lock.yaml'], tasks: { build: { dependsOn: ['^build'], outputs: ['dist/**'] } } });
  writeFileSync(join(root, 'build.mjs'), `import fs from 'node:fs';\nconst name=process.argv[2];\nfs.mkdirSync('dist',{recursive:true});\nfs.writeFileSync('dist/result.json',JSON.stringify({name,source:fs.readFileSync('source.txt','utf8')}));\nfs.appendFileSync('../../executions.log',name+'\\n');\n`);
  for (const [name, dependency] of [['a',null],['b','a'],['c','b']]) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    json(`packages/${name}/package.json`, { name, version: '1.0.0', scripts: { build: `node ../../build.mjs ${name}` }, ...(dependency ? { dependencies: { [dependency]: 'workspace:*' } } : {}) });
    writeFileSync(join(root, 'packages', name, 'source.txt'), 'baseline');
  }
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync(resolve(process.env.TURBO_PACKAGE), join(root, 'node_modules/turbo'));
  symlinkSync(resolve(binary), join(root, 'node_modules/.bin/turbo'));
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n.turbo/\npackages/*/dist/\nexecutions.log\n');
  for (const args of [['init','-q'],['add','.'],['-c','user.name=CI fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture baseline']]) execFileSync('git', args, { cwd: root });
} else if (mode === 'change') {
  assert.ok(['no-hit','useful-hit','lockfile-change'].includes(scenario));
  if (scenario === 'no-hit') writeFileSync(join(root, 'packages/a/source.txt'), 'changed upstream source');
  if (scenario === 'lockfile-change') writeFileSync(join(root, 'pnpm-lock.yaml'), readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8') + '# changed lockfile global input\n');
} else if (mode === 'build') {
  const started = performance.now();
  const before = existsSync(join(root, 'executions.log')) ? readFileSync(join(root, 'executions.log'), 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const log = execFileSync(binary, ['run','build','--no-daemon'], { cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, CI: '1' } });
  console.log(log);
  assert.match(log, /3 successful, 3 total/);
  const count = existsSync(join(root, 'executions.log')) ? readFileSync(join(root, 'executions.log'), 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const expected = scenario === 'useful-hit' ? 0 : 3;
  assert.equal(count - before, expected, `actual build executions for ${scenario}`);
  assert.match(log, new RegExp(`Cached:\\s+${scenario === 'useful-hit' ? 3 : 0} cached, 3 total`));
  console.log(`PROBE_BUILD ${JSON.stringify({scenario, elapsedMs: Math.round(performance.now()-started), executions: count - before})}`);
} else throw new Error('usage: probe.mjs prepare|change|build ROOT [no-hit|useful-hit|lockfile-change]');
