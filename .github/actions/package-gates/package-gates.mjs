// Run a consumer's own gate scripts, and report which ones failed BY NAME.
//
// The logic lives here rather than as bash inside the reusable workflow for one
// reason: it is testable. A gate runner that stopped recognising a gate would
// report "all gates passed" and go green — the same silent-success failure mode
// the gates it runs are usually built to prevent — so it needs its own tests,
// like every other checked-in CI script here.
import { spawnSync } from 'node:child_process';

/** A line is `LABEL|COMMAND`. Blank lines and # comments are skipped. */
export function parseGates(input) {
  const gates = [];
  const lines = String(input ?? '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const sep = line.indexOf('|');
    // A line with no separator is an ERROR, not a command with a blank label.
    // A gate nobody can name in a failure is what the label exists to prevent.
    if (sep === -1) throw new Error(`gates: line is not LABEL|COMMAND -> ${line}`);
    const label = line.slice(0, sep).trim();
    const command = line.slice(sep + 1).trim();
    if (label === '' || command === '') {
      throw new Error(`gates: LABEL and COMMAND must both be non-empty -> ${line}`);
    }
    gates.push({ label, command });
  }
  if (gates.length === 0) {
    throw new Error('gates: no gates given — a caller that runs nothing proves nothing');
  }
  return gates;
}

/**
 * Run every gate, collect the failures, and return them.
 *
 * Deliberately does NOT stop at the first failure. A budget sweep usually trips
 * several ratchets at once, and reporting one per push turns one fix into four.
 */
export function runGates(gates, { cwd = '.', run = defaultRun, log = console.log } = {}) {
  const failed = [];
  for (const { label, command } of gates) {
    log(`::group::${label}`);
    const code = run(command, cwd);
    log('::endgroup::');
    if (code !== 0) {
      log(`::error title=${label}::exit ${code} — ${command}`);
      failed.push({ label, command, code });
    }
  }
  return failed;
}

function defaultRun(command, cwd) {
  const result = spawnSync('bash', ['-c', command], { cwd, stdio: 'inherit' });
  // A command killed by a signal reports status null; that is a failure, and
  // returning 0 for it would be the silent pass this file exists to avoid.
  if (result.status === null) return result.signal ? 1 : 1;
  return result.status;
}

export function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  const gates = parseGates(env.GATES);
  log(`::notice::${gates.length} gate(s) to run`);
  const failed = runGates(gates, { cwd: env.PACKAGE_DIR || '.', log });
  if (failed.length > 0) {
    log('');
    log(`${failed.length} gate(s) failed:`);
    for (const f of failed) log(`  - ${f.label}`);
    return 1;
  }
  log('all gates passed');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main());
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exit(1);
  }
}
