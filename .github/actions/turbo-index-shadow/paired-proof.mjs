// Isolated correctness probe; never called by normal Build or production keys.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPrivateJson } from './bounded-output.mjs';
import { decideRestore, makeIndex } from './index.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const measured = async fn => { const start = performance.now(); const value = await fn(); return { value, wallMs: performance.now() - start }; };
function manifest(root) {
  const rows = []; let total = 0;
  const visit = dir => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      assert.ok(!name.isSymbolicLink(), 'isolated payload must be regular');
      if (name.isDirectory()) visit(path);
      else {
        assert.ok(name.isFile()); total += statSync(path).size;
        assert.ok(total <= 4_000_000, 'isolated payload cap before reading');
        const bytes = readFileSync(path);
        rows.push({ path: path.slice(root.length + 1), bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  };
  visit(join(root, '.turbo')); rows.sort((a, b) => a.path.localeCompare(b.path));
  assert.ok(rows.reduce((n, row) => n + row.bytes, 0) <= 4_000_000, 'isolated payload cap');
  return rows;
}

export async function savePaired({ root, key, cache, emit = () => {} }) {
  assert.match(key, /^index-pair-[0-9]+-[0-9]+-[0-9]+-payload$/);
  const paths = [join(root, '.turbo')], indexPath = join(root, '_index', 'index.json');
  const before = manifest(root);
  const saved = await measured(() => cache.saveCache(paths, key));
  assert.ok(Number.isSafeInteger(saved.value) && saved.value >= 0, 'payload save not confirmed');
  const lookup = await measured(() => cache.restoreCache(paths, key, [], { lookupOnly: true }));
  assert.equal(lookup.value, key, 'saved payload lookup must match exact key');
  assert.deepEqual(manifest(root), before, 'payload changed while saving');
  const serialized = await measured(async () => {
    const index = makeIndex(root, key, '2.7.5');
    const bytes = Buffer.from(JSON.stringify(index) + '\n');
    assert.ok(bytes.length <= 4_096, 'three-task probe index bound');
    mkdirSync(join(root, '_index'), { mode: 0o700 }); writeFileSync(indexPath, bytes, { mode: 0o600 });
    return { index, bytes };
  });
  const indexSave = await measured(() => cache.saveCache([indexPath], `${key}-index`));
  assert.ok(Number.isSafeInteger(indexSave.value) && indexSave.value >= 0, 'index save not confirmed');
  const receipt = { phase: 'paired-producer', key, payloadCacheId: saved.value, indexCacheId: indexSave.value,
    payloadSaveMs: saved.wallMs, payloadLookupMs: lookup.wallMs, serializationMs: serialized.wallMs,
    indexSaveMs: indexSave.wallMs, indexRawBytes: serialized.value.bytes.length,
    indexSha256: sha(serialized.value.bytes), archiveHashes: serialized.value.index.hashes,
    payloadFiles: before, payloadFileBytes: before.reduce((n, row) => n + row.bytes, 0),
    scope: 'isolated successfully saved exact-key payload; no production cache or billing claim' };
  emit(receipt); return receipt;
}

function fixture(root, changes = []) {
  if (existsSync(root)) {
    assert.equal(readFileSync(join(root, '.owned-paired-proof'), 'utf8'), 'isolated-v1');
    rmSync(root, { recursive: true });
  }
  mkdirSync(root, { mode: 0o700 }); writeFileSync(join(root, '.owned-paired-proof'), 'isolated-v1');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'isolated-paired-proof', private: true, packageManager: 'pnpm@10.34.5' }));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n  packages/a: {}\n  packages/b: {}\n  packages/c: {}\n");
  writeFileSync(join(root, 'turbo.json'), JSON.stringify({ $schema: 'https://turbo.build/schema.json', tasks: { build: { inputs: ['input.txt', 'package.json', '../../build.mjs'], outputs: ['dist/**'] } } }));
  writeFileSync(join(root, 'build.mjs'), `import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';\nimport { createHash } from 'node:crypto';\nmkdirSync('dist',{recursive:true});\nwriteFileSync('dist/out.json',JSON.stringify({name:JSON.parse(readFileSync('package.json')).name,inputSha256:createHash('sha256').update(readFileSync('input.txt')).digest('hex')}));\n`);
  for (const name of ['a', 'b', 'c']) {
    const dir = join(root, 'packages', name); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `proof-${name}`, private: true, scripts: { build: 'node ../../build.mjs' } }));
    writeFileSync(join(dir, 'input.txt'), changes.includes(name) ? 'changed\n' : 'original\n');
  }
}

async function plan(root, turbo) {
  const privateDir = join(root, '_private'); mkdirSync(privateDir, { mode: 0o700 });
  try { return await readPrivateJson(privateDir, turbo, ['run', 'build', '--dry=json', '--no-daemon'], {
    spawnFn: (command, args, options) => spawn(command, args, { ...options, cwd: root }),
  }); } finally { rmSync(privateDir, { recursive: true, force: true }); }
}
// Only this detached process group belongs to the probe. Never signal a
// runner-wide process name or PID list; descendants inherit this group.
async function runBuild(root, turbo, timeoutMs, graceMs) {
  await new Promise((resolve, reject) => {
    let child, deadline, hardKill, settled = false, failure;
    const signal = kind => {
      if (!child?.pid) return;
      try { process.kill(-child.pid, kind); }
      catch (error) { if (error.code !== 'ESRCH') failure = 'termination-unproved'; }
    };
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(hardKill);
      signal('SIGKILL');
      if (failure || code !== 0) reject(new Error(`isolated build failed: ${failure ?? 'child-failed'}`));
      else resolve();
    };
    try {
      // No child output or environment-bearing summary reaches public logs.
      child = spawn(turbo, ['run', 'build', '--no-daemon', '--summarize'], {
        cwd: root, detached: true, stdio: 'ignore',
      });
    } catch { finish(null); return; }
    child.once('error', () => { failure = 'spawn-failed'; finish(null); });
    child.once('close', finish);
    deadline = setTimeout(() => {
      failure = 'timeout'; signal('SIGTERM');
      hardKill = setTimeout(() => signal('SIGKILL'), graceMs);
    }, timeoutMs);
  });
}

export async function build(root, turbo, { timeoutMs = 30_000, graceMs = 5_000 } = {}) {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0 && Number.isFinite(graceMs) && graceMs >= 0);
  assert.equal(readFileSync(join(root, '.owned-paired-proof'), 'utf8'), 'isolated-v1');
  const started = performance.now(), runs = join(root, '.turbo', 'runs');
  mkdirSync(join(root, '.turbo'), { recursive: true });
  // Refuse an existing summary directory: finally owns only what we created.
  mkdirSync(runs, { mode: 0o700 });
  try {
    await runBuild(root, turbo, timeoutMs, graceMs);
    const files = readdirSync(runs).filter(name => name.endsWith('.json'));
    assert.equal(files.length, 1, 'exactly one summary from this build');
    const path = join(runs, files[0]);
    assert.ok(statSync(path).size <= 512_000, 'isolated summary byte bound');
    let summary;
    try { summary = JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new Error('isolated build summary unavailable'); }
    const tasks = summary.tasks.map(task => ({ taskId: task.taskId, hash: task.hash, cacheStatus: task.cache.status, exitCode: task.execution?.exitCode ?? null }));
    assert.equal(tasks.length, 3);
    for (const name of ['a', 'b', 'c']) {
      const dir = join(root, 'packages', name), output = JSON.parse(readFileSync(join(dir, 'dist', 'out.json')));
      assert.deepEqual(output, { name: `proof-${name}`, inputSha256: sha(readFileSync(join(dir, 'input.txt'))) });
    }
    return { wallMs: performance.now() - started, tasks, hits: tasks.filter(task => task.cacheStatus === 'HIT').length, outputsVerified: 3 };
  } finally {
    // Includes nonzero exit, timeout, spawn, read, parse and output assertions.
    rmSync(runs, { recursive: true, force: true });
  }
}

export function controlledDecision(name, index, current, key, now = Date.now()) {
  let candidate = index, candidatePlan = current, expectedKey = key;
  if (name === 'missing' || name === 'corrupt') candidate = null;
  if (name === 'stale') now += 8 * 86400000;
  if (name === 'wrong-key') expectedKey += '-other';
  if (name === 'inconclusive') candidatePlan = { ...current, tasks: [{ ...current.tasks[0], hash: null }] };
  return decideRestore(candidate, candidatePlan, expectedKey, now);
}

export async function runPairedProof({ phase, root, tools, key, expectedSha, emit = row => console.log(`PAIRED_PROOF ${JSON.stringify(row)}`) }) {
  const cache = createRequire(join(tools, 'package.json'))('@actions/cache');
  const turbo = join(tools, 'node_modules', '.bin', 'turbo'), started = performance.now();
  if (phase === 'producer') {
    fixture(root); const built = await build(root, turbo);
    assert.equal(built.hits, 0); emit({ phase: 'producer-build', ...built });
    const receipt = await savePaired({ root, key, cache, emit });
    emit({ phase: 'producer-total', wallMs: performance.now() - started }); return receipt;
  }
  assert.equal(phase, 'consumer'); assert.match(expectedSha, /^[0-9a-f]{64}$/);
  for (const name of ['zero', 'useful', 'partial', 'missing', 'corrupt', 'stale', 'wrong-key', 'inconclusive']) {
    const caseStart = performance.now(); fixture(root, name === 'zero' ? ['a', 'b', 'c'] : name === 'partial' ? ['b'] : []);
    const current = await measured(() => plan(root, turbo));
    const indexPath = join(root, '_index', 'index.json');
    const indexTransport = await measured(() => cache.restoreCache([indexPath], `${key}-${name === 'missing' ? 'absent-index' : 'index'}`));
    let index = null, transportVerified = false, rawBytes = 0;
    if (name !== 'missing') {
      assert.equal(indexTransport.value, `${key}-index`);
      const bytes = readFileSync(indexPath); rawBytes = bytes.length;
      assert.ok(bytes.length <= 4_096); assert.equal(sha(bytes), expectedSha);
      transportVerified = true;
      if (name === 'corrupt') { writeFileSync(indexPath, 'corrupt'); assert.notEqual(sha(readFileSync(indexPath)), expectedSha); }
      else index = JSON.parse(bytes);
    } else assert.equal(indexTransport.value, undefined);
    const decisionStart = performance.now(), decision = controlledDecision(name, index, current.value, key);
    const decisionMs = performance.now() - decisionStart;
    assert.equal(decision.restore, name !== 'zero', `${name} must retain conservative behavior`);
    // Turbo dry-run can create an empty cache directory. Archive absence,
    // rather than directory absence, is the fresh-cache invariant.
    const baselineHashes = existsSync(join(root, '.turbo')) ? makeIndex(root, key, '2.7.5').hashes : [];
    assert.deepEqual(baselineHashes, [], 'fresh payload archive baseline');
    const payload = decision.restore ? await measured(() => cache.restoreCache([join(root, '.turbo')], key)) : { value: null, wallMs: 0 };
    if (decision.restore) assert.equal(payload.value, key);
    else assert.deepEqual(makeIndex(root, key, '2.7.5').hashes, [], 'zero case omitted actual payload transport');
    const built = await build(root, turbo);
    assert.equal(built.hits, name === 'zero' ? 0 : name === 'partial' ? 2 : 3);
    emit({ phase: 'consumer-case', name, key, indexMatchedKey: indexTransport.value ?? null, indexRawBytes: rawBytes,
      originalTransportDigestVerified: transportVerified, corruptionScope: name === 'corrupt' ? 'owned received-file tamper; backend corruption not exercised' : null,
      dryRunMs: current.wallMs, indexTransportMs: indexTransport.wallMs, decisionMs, decision,
      baselineArchiveHashes: baselineHashes, payloadRestored: decision.restore, payloadMatchedKey: payload.value, payloadRestoreMs: payload.wallMs,
      build: built, wholeCaseMs: performance.now() - caseStart });
  }
  emit({ phase: 'consumer-total', cases: 8, wallMs: performance.now() - started,
    scope: 'one isolated cross-job correctness proof; not a representative performance or billing comparison' });
}
