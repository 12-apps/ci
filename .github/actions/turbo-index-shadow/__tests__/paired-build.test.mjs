import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from '../paired-proof.mjs';

async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'paired-build-control-'));
  writeFileSync(join(root, '.owned-paired-proof'), 'isolated-v1');
  const executable = join(root, 'turbo');
  const script = source => {
    writeFileSync(executable, `#!${process.execPath}\n${source}\n`);
    chmodSync(executable, 0o700);
    return executable;
  };
  try { await fn({ root, script, runs: join(root, '.turbo', 'runs') }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

for (const mode of ['failure', 'missing', 'parse', 'read', 'shape', 'output']) {
  test(`owned summaries are removed after ${mode} failure`, () => fixture(async ({ root, script, runs }) => {
    const prefix = `const fs = require('node:fs'); const p = '.turbo/runs/summary.json';`;
    const source = {
      failure: `fs.writeFileSync(p, 'PRIVATE_PLACEHOLDER'); process.exit(1);`,
      missing: '',
      parse: `fs.writeFileSync(p, 'PRIVATE_PLACEHOLDER');`,
      read: `fs.mkdirSync(p);`,
      shape: `fs.writeFileSync(p, '{}');`,
      output: `fs.writeFileSync(p, JSON.stringify({tasks:[1,2,3].map(n=>({taskId:n,hash:'a',cache:{status:'MISS'}}))}));`,
    }[mode];
    await assert.rejects(build(root, script(prefix + source)), error => !String(error).includes('PRIVATE_PLACEHOLDER'));
    assert.equal(existsSync(runs), false);
  }));
}

test('spawn failure cleans owned summaries; pre-existing summaries are preserved', () => fixture(async ({ root, runs }) => {
  await assert.rejects(build(root, join(root, 'absent')));
  assert.equal(existsSync(runs), false);
  mkdirSync(runs); writeFileSync(join(runs, 'existing.json'), 'another owner');
  await assert.rejects(build(root, join(root, 'absent')), { code: 'EEXIST' });
  assert.equal(readFileSync(join(runs, 'existing.json'), 'utf8'), 'another owner');
}));

function runnable(pid) {
  try { return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
for (const mode of ['timeout', 'wrapper-exit']) {
  test(`${mode} kills only the owned group including a SIGTERM-resistant descendant`, { timeout: 8_000 }, () => fixture(async ({ root, script, runs }) => {
    const pidPath = join(root, 'pids.json');
    const descendant = `process.on('SIGTERM',()=>{}); process.send('ready'); setInterval(()=>{},1000);`;
    const source = `
      const {spawn}=require('node:child_process'), fs=require('node:fs');
      process.on('SIGTERM',()=>{});
      const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});
      child.once('message',()=>{
        fs.writeFileSync(${JSON.stringify(pidPath)},JSON.stringify([process.pid,child.pid]));
        fs.writeFileSync('.turbo/runs/summary.json','PRIVATE_PLACEHOLDER');
        ${mode === 'wrapper-exit' ? 'process.exit(0);' : 'setInterval(()=>{},1000);'}
      });`;
    const start = performance.now();
    try {
      await assert.rejects(build(root, script(source), { timeoutMs: 1_000, graceMs: 50 }), error => {
        assert.doesNotMatch(String(error), /PRIVATE_PLACEHOLDER/);
        if (mode === 'timeout') assert.match(String(error), /timeout/);
        return true;
      });
      assert.ok(performance.now() - start < 3_000, 'completion is bounded even when SIGTERM is ignored');
      const pids = JSON.parse(readFileSync(pidPath, 'utf8'));
      const deadline = performance.now() + 500;
      while (pids.some(runnable) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      for (const pid of pids) assert.equal(runnable(pid), false, `${pid} no longer runs`);
      assert.equal(existsSync(runs), false);
      assert.equal(runnable(process.pid), true, 'the unrelated test runner remains alive');
    } finally {
      if (existsSync(pidPath)) for (const pid of JSON.parse(readFileSync(pidPath, 'utf8'))) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  }));
}
