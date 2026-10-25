import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const HASH = /^[0-9a-f]{16}$/;
const MAX_AGE_MS = 7 * 86400000;
export const SUPPORTED_TURBO = '2.7.5';

// Step/action/package-manager variables cannot be proven identical to Build.
// Unknown wildcard hashing is conservative too, even if this particular run
// happened to have no matching transient variable.
function equivalentEnvironment(env) {
  if (!env || !env.specified || !Array.isArray(env.specified.env) ||
      !Array.isArray(env.configured) || !Array.isArray(env.inferred)) return false;
  const names = [...env.specified.env, ...env.configured.map(v => typeof v === 'string' ? v.split('=')[0] : null), ...env.inferred.map(v => typeof v === 'string' ? v.split('=')[0] : null)];
  return names.every(name => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(name) &&
    !/^(?:INDEX_|TURBO_|GITHUB_ACTION|GITHUB_(?:OUTPUT|ENV|PATH|STATE|STEP_SUMMARY)$|npm_|PNPM_|BASH|SHLVL$)/.test(name));
}

export function validIndex(index, cacheKey, now = Date.now()) {
  if (!cacheKey || !index || index.version !== 1 || index.cacheKey !== cacheKey || index.turboVersion !== SUPPORTED_TURBO) return false;
  const created = Date.parse(index.createdAt);
  if (!Number.isFinite(created) || created > now + 60000 || now - created > MAX_AGE_MS) return false;
  return Array.isArray(index.hashes) && index.hashes.length <= 100000 && index.hashes.every(h => typeof h === 'string' && HASH.test(h)) && new Set(index.hashes).size === index.hashes.length;
}

/** Advisory only: an unknown input means restore, never skip the build itself. */
export function decideRestore(index, plan, cacheKey, now = Date.now()) {
  if (!validIndex(index, cacheKey, now)) return { restore: true, reason: 'index missing, stale, malformed or not paired to the matched payload' };
  if (!plan || plan.turboVersion !== SUPPORTED_TURBO || !Array.isArray(plan.tasks) || plan.tasks.length === 0 ||
      !plan.tasks.every(t => t && typeof t.taskId === 'string' && t.taskId.length > 0 && typeof t.hash === 'string' && HASH.test(t.hash))) {
    return { restore: true, reason: 'current Turbo dry-run contract is inconclusive' };
  }
  if (!equivalentEnvironment(plan.globalCacheInputs?.environmentVariables) || !plan.tasks.every(t => equivalentEnvironment(t.environmentVariables))) {
    return { restore: true, reason: 'Build and dry-run hash-relevant environments are not proved equivalent' };
  }
  const available = new Set(index.hashes);
  const overlap = plan.tasks.filter(t => available.has(t.hash)).length;
  return { restore: overlap > 0, reason: `${overlap}/${plan.tasks.length} current task hashes intersect ${index.hashes.length} indexed archives` };
}

/** Snapshot exactly the archive inventory that the following payload save sees. */
export function makeIndex(root, cacheKey, turboVersion, now = Date.now()) {
  if (!cacheKey || turboVersion !== SUPPORTED_TURBO) throw new Error('unsupported cache identity or Turbo version');
  const hashes = [];
  let entries = 0;
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 100000) throw new Error('payload inventory exceeds its bound');
      if (entry.isSymbolicLink()) throw new Error('payload inventory contains a non-regular symlink');
      if (entry.isDirectory()) { visit(join(directory, entry.name)); continue; }
      if (!entry.name.endsWith('.tar.zst')) continue;
      const hash = entry.name.slice(0, -8);
      if (!HASH.test(hash)) throw new Error(`unknown Turbo archive name: ${entry.name}`);
      if (!entry.isFile()) throw new Error(`Turbo archive is not a regular file: ${entry.name}`);
      hashes.push(hash);
    }
  };
  // Inventory the saved payload, not an assumed default cacheDir. Archives in
  // `.turbo/custom` are as reusable as those in `.turbo/cache`.
  visit(join(root, '.turbo'));
  return { version: 1, cacheKey, turboVersion, createdAt: new Date(now).toISOString(), hashes: [...new Set(hashes)].sort() };
}
