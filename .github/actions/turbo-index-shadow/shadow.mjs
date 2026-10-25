import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readPrivateJson } from './bounded-output.mjs';
import { decideRestore, makeIndex, SUPPORTED_TURBO } from './index.mjs';

const MAX_INDEX = 4_000_000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safeKey = key => typeof key === 'string' && /^[A-Za-z0-9_.:/-]{1,512}$/.test(key);
const usage = () => ({ time: performance.now(), cpu: process.cpuUsage(), io: process.resourceUsage() });
function elapsed(before) {
  const cpu = process.cpuUsage(before.cpu), io = process.resourceUsage();
  return { wallMs: performance.now() - before.time, cpuUserUs: cpu.user, cpuSystemUs: cpu.system,
    fileReadBlocks: io.fsRead - before.io.fsRead, fileWriteBlocks: io.fsWrite - before.io.fsWrite,
    cpuIoScope: 'observer process only; excludes child dry-run and cache action processes' };
}
function inventory(root, key, version) {
  const started = usage(), payload = join(root, '.turbo');
  const type = lstatSync(payload);
  if (!type.isDirectory() || type.isSymbolicLink()) throw new Error('non-regular payload root');
  const index = makeIndex(root, key, version), archives = [];
  let count = 0;
  const visit = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++count > 100_000 || entry.isSymbolicLink()) throw new Error('unsupported inventory');
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.tar.zst')) archives.push({ hash: entry.name.slice(0, -8), bytes: statSync(path).size });
    }
  };
  visit(payload);
  const bytes = Buffer.from(JSON.stringify(index) + '\n');
  if (bytes.length > MAX_INDEX) throw new Error('index exceeds bound');
  const gzipInnerBytes = gzipSync(bytes).length;
  return { index, bytes, payload: { archiveCount: archives.length, archiveBytes: archives.reduce((sum, a) => sum + a.bytes, 0), archives },
    indexRawBytes: bytes.length, gzipInnerBytes, metrics: elapsed(started) };
}

// The raw Turbo JSON can contain configured environment VALUES. Keep it in an
// owned 0700 temporary directory, never print/upload it, and remove it finally.
export async function currentPlan(directory, affected) {
  const args = ['exec', 'turbo', 'run', 'build', '--dry=json', '--no-daemon'];
  if (affected) args.push('--affected');
  return readPrivateJson(directory, 'pnpm', args);
}
function observerEnvironment(plan) {
  const parts = [plan?.globalCacheInputs?.environmentVariables, ...(plan?.tasks ?? []).map(t => t.environmentVariables)];
  return parts.some(part => [...(part?.specified?.env ?? []), ...(part?.configured ?? []), ...(part?.inferred ?? [])]
    .some(value => typeof value === 'string' && value.startsWith('SHADOW_')));
}
function fallbackControls(index, plan, key) {
  const task = plan?.tasks?.[0];
  const cases = [
    ['missing-index', null, plan, key],
    ['wrong-key', { ...index, cacheKey: `${key}-other` }, plan, key],
    ['stale-index', { ...index, createdAt: new Date(Date.now() - 8 * 86400000).toISOString() }, plan, key],
    ['malformed-index', { ...index, hashes: ['invalid'] }, plan, key],
    ['empty-graph', index, { ...plan, tasks: [] }, key],
    ['unknown-version', index, { ...plan, turboVersion: 'unsupported' }, key],
    ['transient-environment', index, { ...plan, globalCacheInputs: { environmentVariables: { specified: { env: ['GITHUB_ACTION'] }, configured: [], inferred: [] } } }, key],
  ];
  if (task) {
    cases.push(['incomplete-task', index, { ...plan, tasks: [{ ...task, hash: null }] }, key]);
    cases.push(['forced-useful-intersection', { ...index, hashes: [task.hash] }, plan, key]);
    cases.push(['non-executable-intersection', { ...index, hashes: [task.hash] }, { ...plan, tasks: [{ ...task, command: '<NONEXISTENT>' }] }, key]);
  }
  return cases.map(([name, candidateIndex, candidatePlan, candidateKey]) => ({ name,
    retained: decideRestore(candidateIndex, candidatePlan, candidateKey).restore,
    scope: 'private predicate control on actual dry-run metadata; not a second Build or warm payload test' }));
}

export async function capture({ root, temp, matchedKey, cleanBeforeRestore, version, affected = false, runPlan }) {
  const started = usage();
  const report = { phase: 'before', matchedKey: safeKey(matchedKey) ? matchedKey : null, cleanBeforeRestore,
    affected, actualRestoreRetained: true, productionPairedIndex: false,
    inventoryProvenance: 'derived from current materialized normal restore; original producer timestamp unknown',
    decision: { restore: true, reason: 'measurement unavailable' } };
  let directory, prepared;
  try {
    if (!safeKey(matchedKey) || version !== SUPPORTED_TURBO) throw new Error('unknown identity');
    directory = mkdtempSync(join(resolve(temp), 'turbo-index-shadow-'));
    prepared = inventory(root, matchedKey, version);
    Object.assign(report, { payload: prepared.payload, indexRawBytes: prepared.indexRawBytes,
      gzipInnerBytes: prepared.gzipInnerBytes, inventoryMetrics: prepared.metrics });
    const dryStart = performance.now(), plan = await (runPlan ? runPlan() : currentPlan(directory, affected));
    report.dryRunWallMs = performance.now() - dryStart;
    report.fallbackControls = fallbackControls(prepared.index, plan, matchedKey);
    if (report.fallbackControls.some(control => !control.retained)) throw new Error('fallback control regression');
    // A hypothetical supported receipt index is separate from a deployed
    // producer-created paired index. An unclean overlay is never eligibility.
    report.decision = !cleanBeforeRestore || observerEnvironment(plan)
      ? { restore: true, reason: 'payload overlay or observer environment is unproved' }
      : decideRestore(prepared.index, plan, matchedKey);
    report.tasks = (plan.tasks ?? []).map(task => ({ taskId: task.taskId, hash: task.hash,
      executable: typeof task.command === 'string' && task.command !== '' && task.command !== '<NONEXISTENT>' }));
    const transport = join(directory, 'transport'); mkdirSync(transport);
    const indexPath = join(transport, 'index.json'), statePath = join(directory, 'state.json');
    writeFileSync(indexPath, prepared.bytes, { mode: 0o600 });
    writeFileSync(statePath, JSON.stringify({ kind: 'owned-turbo-index-shadow-v1', sha256: digest(prepared.bytes),
      bytes: prepared.bytes.length, matchedKey }), { mode: 0o600 });
    report.metrics = elapsed(started);
    return { report, ready: true, indexPath, statePath };
  } catch {
    // Only this call's exclusive temporary directory is eligible for cleanup.
    if (directory) rmSync(directory, { recursive: true, force: true });
    report.decision = { restore: true, reason: 'inventory, identity or bounded dry-run unavailable' };
    report.metrics = elapsed(started);
    return { report, ready: false };
  }
}
export function producer({ root, saveKey, version, payloadSaveAllowed }) {
  if (!safeKey(saveKey)) throw new Error('unknown producer identity');
  const prepared = inventory(root, saveKey, version);
  return { phase: 'after', saveKey, normalPayloadSaveAllowed: payloadSaveAllowed,
    actualPayloadIndexPublished: false, producerTimestamp: prepared.index.createdAt,
    payload: prepared.payload, indexRawBytes: prepared.indexRawBytes, gzipInnerBytes: prepared.gzipInnerBytes,
    metrics: prepared.metrics, fanout: 'join consumer matched keys separately; future consumers unmeasured',
    serializationScope: 'actual inventory/JSON/gzip; gzip is diagnostic inner compression, not backend upload' };
}
function ownedState(statePath) {
  const directory = dirname(resolve(statePath));
  if (basename(statePath) !== 'state.json' || !/^turbo-index-shadow-[A-Za-z0-9]{6}$/.test(basename(directory)) ||
      !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink() ||
      !lstatSync(statePath).isFile() || lstatSync(statePath).isSymbolicLink() || statSync(statePath).size > 4096) throw new Error('unowned transport');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const transport = join(directory, 'transport');
  if (state.kind !== 'owned-turbo-index-shadow-v1' || !safeKey(state.matchedKey) ||
      !lstatSync(transport).isDirectory() || lstatSync(transport).isSymbolicLink()) throw new Error('unowned transport');
  return { state, indexPath: join(transport, 'index.json') };
}
export function clearTransport(statePath) {
  const { indexPath } = ownedState(statePath);
  if (!lstatSync(indexPath).isFile() || lstatSync(indexPath).isSymbolicLink()) throw new Error('non-regular transport');
  unlinkSync(indexPath); // Only the owned tiny transport file; never .turbo.
}
export function verifyTransport(statePath) {
  const { state, indexPath } = ownedState(statePath);
  if (!existsSync(indexPath)) throw new Error('transport unavailable');
  const stat = lstatSync(indexPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INDEX) throw new Error('invalid transport');
  const bytes = readFileSync(indexPath);
  if (bytes.length !== state.bytes || digest(bytes) !== state.sha256) throw new Error('transport digest mismatch');
  return { phase: 'transport', matchedKey: state.matchedKey, rawBytes: bytes.length, sha256: state.sha256,
    sameBytes: true, deployedPairingProven: false, scope: 'actual cache-service same-job round-trip; cross-job production pairing unproved' };
}
