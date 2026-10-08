import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runBounded } from '../setup-playwright/install-playwright.mjs';
import { decideRestore, makeIndex, validIndex } from './index.mjs';

const mode = process.argv[2];
if (!['check', 'record'].includes(mode)) {
  console.error('usage: node main.mjs check|record');
  process.exit(2);
}
const indexPath = join(process.cwd(), '.turbo/index/build.json');
const output = (key, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};

if (mode === 'record') {
  // Remove an earlier restored index before a failed measurement can publish it.
  try {
    rmSync(indexPath, { force: true });
    const require = createRequire(join(process.cwd(), 'package.json'));
    const index = makeIndex(process.cwd(), process.env.TURBO_SAVE_KEY, require('turbo/package.json').version);
    mkdirSync(join(process.cwd(), '.turbo/index'), { recursive: true });
    writeFileSync(indexPath, JSON.stringify(index) + '\n');
    output('ready', 'true');
    console.log(`Turbo index pairs ${index.hashes.length} archives to ${index.cacheKey} (${statSync(indexPath).size} bytes)`);
  } catch (error) {
    output('ready', 'false');
    console.log(`::warning::Turbo index not recorded: ${error.message}; future restores retain the payload fallback.`);
  }
} else {
  let decision = { restore: true, reason: 'index unavailable' };
  const started = performance.now();
  try {
    const key = process.env.TURBO_MATCHED_KEY;
    if (statSync(indexPath).size > 4000000) throw new Error('index exceeds the measurement bound');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    if (validIndex(index, key)) {
      const path = join(process.env.RUNNER_TEMP || process.cwd(), `turbo-dry-${process.pid}.json`);
      const fd = openSync(path, 'w');
      try {
        const args = ['exec', 'turbo', 'run', 'build', '--dry=json', '--no-daemon'];
        if (process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.SELECTION_BASE) args.push('--affected');
        const result = await runBounded('pnpm', args, {
          timeoutMs: 30000, graceMs: 5000,
          spawnFn: (command, argv, options) => spawn(command, argv, { ...options, stdio: ['ignore', fd, 'ignore'] }),
        });
        if (!result.ok) throw new Error('bounded Turbo dry-run failed or timed out');
        if (statSync(path).size > 32000000) throw new Error('dry-run exceeds the measurement bound');
        decision = decideRestore(index, JSON.parse(readFileSync(path, 'utf8')), key);
      } finally { closeSync(fd); rmSync(path, { force: true }); }
    } else decision = decideRestore(index, null, key);
  } catch (error) {
    decision = { restore: true, reason: `inconclusive measurement: ${error.message}` };
  }
  output('restore', String(decision.restore));
  console.log(`Turbo cache ${decision.restore ? 'restore retained' : 'download skipped'}: ${decision.reason}; index decision ${Math.round(performance.now() - started)}ms`);
}
