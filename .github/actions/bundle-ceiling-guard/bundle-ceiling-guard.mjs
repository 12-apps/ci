#!/usr/bin/env node
/**
 * Fail a pull request that LOOSENED a committed bundle budget without saying why.
 *
 * ## The hole this closes
 *
 * A bundle budget is a ledger of ceilings committed next to the code, re-measured
 * on every build. It fails in both directions — over the ceiling, and stale when
 * the bundle shrank and the number did not — and that pair is what keeps it
 * honest over time.
 *
 * What it cannot do is defend its own ledger. Every such gate ships an `--update`
 * that rewrites the ceilings from the current measurement, because the stale half
 * REQUIRES one. The same command also raises them. So the cheapest path out of a
 * red budget is the command the failure message itself taught you, and the result
 * is a green run, a diff where two numbers went up, and a critical path that grew
 * with nobody deciding that it should.
 *
 * That is not hypothetical: it is what a byte gate looks like to anyone — human or
 * agent — optimising for a green check. The failing message can ask them not to
 * ("check what the entry chunk gained before raising this"), but prose is not a
 * gate, and the one thing a local script cannot see is the number it USED to have.
 *
 * A diff can. This guard reads the ledger at the merge base and at HEAD and holds
 * one rule:
 *
 *   **Tightening is free. Loosening costs a sentence.**
 *
 * Loosening is a ceiling that rose, a floor that fell, or a surface that stopped
 * being measured at all — that last one because a gate you can delete in one line
 * is not a gate, and deleting it is the loosest move available.
 *
 * ## Why the justification must name the number
 *
 * A `why` alone would be written once and then quietly cover every later raise,
 * which is how an exemption list becomes a place things go to be forgotten. So the
 * recorded justification must name the EXACT value it is justifying. The moment
 * the ceiling moves again the recorded number no longer matches, and the next
 * author owes their own sentence about their own regression.
 *
 * ```jsonc
 * {
 *   "surfaces": {
 *     "storefront": {
 *       "dist": "apps/client/dist",
 *       "raw": 760000,
 *       "brotli": 210000,
 *       "chunks": 4,
 *       // Required only because `raw` went UP in this diff. Must name the new
 *       // value, and must be rewritten the next time it moves.
 *       "loosened": {
 *         "raw": 760000,
 *         "why": "PIX QR rendering moved onto the first paint: the shopper cannot pay without it, so deferring it would trade bytes for a broken checkout."
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * ## Deliberately host-agnostic
 *
 * It never builds anything and never measures anything — the consumer's own gate
 * owns that, and stays the single implementation of it. This reads two JSON files
 * out of git history and compares numbers, so it is node builtins only, runs in a
 * second, and cannot disagree with the measurement it is protecting.
 *
 * Which keys are ceilings and which are floors is the caller's to declare, because
 * only the caller knows: bytes have a maximum, and a chunk COUNT has a minimum
 * (recombining four cacheable chunks into one is a regression that leaves the byte
 * totals untouched).
 *
 * ## Fail-open exactly once, and say so
 *
 * A ledger absent from the base is an ADOPTION, not a violation — there is no
 * previous number to loosen. Everything else fails closed: a head ledger that is
 * missing, unreadable or malformed is an error, because a guard that cannot read
 * the thing it guards must never report success.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** A justification has to read like an argument, not a label. */
const MIN_WHY_CHARS = 40;

/**
 * Openers that are a placeholder wearing a sentence's clothes. Matched only at
 * the START: a real argument may well contain the word "temporary" partway in
 * ("...until the temporary vendor script is removed"), and rejecting that would
 * push authors toward vaguer prose rather than clearer.
 */
const PLACEHOLDER_RE = /^(tbd|todo|n\/?a|none|temporary|temp|wip|fixme|later|because\.?$)\b/i;

/** Read a path as it stood at a git ref; null when it did not exist there. */
export function readAtRef(ref, file, cwd = process.cwd()) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // `git show` cannot distinguish "no such path in that tree" from several
    // other failures by exit code alone, and the difference does not change
    // what we do: with no base copy there is no previous number, so there is
    // nothing this guard can judge. The caller reports that as an adoption.
    return null;
  }
}

/** Parse a ledger, turning every failure into one sentence a reader can act on. */
export function parseLedger(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const { surfaces } = parsed;
  if (surfaces === null || typeof surfaces !== 'object' || Array.isArray(surfaces)) {
    throw new Error(`${label} has no \`surfaces\` object — nothing to compare`);
  }
  return parsed;
}

/**
 * Is this justification an argument?
 *
 * Returns null when it is, or the reason it is not. Length is a blunt proxy for
 * "someone thought about it", and a deliberately low bar: the point is to stop a
 * one-word label from passing as a reason, not to grade the writing.
 */
function whyProblem(why) {
  if (typeof why !== 'string') return 'no `why` was written';
  const trimmed = why.trim();
  if (trimmed === '') return 'the `why` is empty';
  if (PLACEHOLDER_RE.test(trimmed)) return `the \`why\` is a placeholder ("${trimmed.slice(0, 30)}")`;
  if (trimmed.length < MIN_WHY_CHARS) {
    return `the \`why\` is ${trimmed.length} characters — a label, not an argument (${MIN_WHY_CHARS} minimum)`;
  }
  return null;
}

/**
 * Does `entry.loosened` justify moving `key` to `value`?
 *
 * The recorded number must equal the new committed one. That is what stops a
 * sentence written for one raise from silently covering the next.
 */
function justificationProblem(entry, key, value) {
  const loosened = entry?.loosened;
  if (loosened === null || typeof loosened !== 'object' || Array.isArray(loosened)) {
    return 'no `loosened` block records why';
  }
  if (!(key in loosened)) return `\`loosened\` does not mention \`${key}\``;
  if (loosened[key] !== value) {
    return (
      `\`loosened.${key}\` records ${loosened[key]}, but the committed \`${key}\` is ${value} — ` +
      'a justification written for one value does not carry to the next'
    );
  }
  return whyProblem(loosened.why);
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * Compare two ledgers and return one message per loosening that was not argued.
 *
 * Pure: no git, no filesystem, no process exit — so the rules above are testable
 * without building a repository to hold them.
 */
export function findUnjustifiedLoosenings({ base, head, ceilingKeys, floorKeys }) {
  const violations = [];
  const baseSurfaces = base.surfaces ?? {};
  const headSurfaces = head.surfaces ?? {};
  const retired = head.retired ?? {};

  for (const [name, baseEntry] of Object.entries(baseSurfaces)) {
    const headEntry = headSurfaces[name];

    // A surface that stopped being measured is the loosest change available:
    // every ceiling it carried is gone at once, and the diff is one deleted
    // block rather than a number going the wrong way.
    if (headEntry === undefined) {
      const problem = whyProblem(retired[name]?.why);
      if (problem !== null) {
        violations.push(
          `surface \`${name}\` is no longer in the ledger, so nothing measures it any more — ` +
            `${problem}. Record it under a top-level \`retired.${name}.why\`.`,
        );
      }
      continue;
    }

    const checks = [
      ...ceilingKeys.map((key) => ({ key, kind: 'ceiling' })),
      ...floorKeys.map((key) => ({ key, kind: 'floor' })),
    ];

    for (const { key, kind } of checks) {
      const before = num(baseEntry?.[key]);
      const after = num(headEntry?.[key]);
      // Nothing to compare: the key is new here, or was never a number. A key
      // REMOVED from a surface that still exists is a loosening, though — it
      // silently drops that one limit while the surface keeps its others.
      if (before === null) continue;
      if (after === null) {
        const problem = whyProblem(headEntry?.loosened?.why);
        if (problem !== null) {
          violations.push(
            `surface \`${name}\` no longer declares \`${key}\` (was ${before}), so that limit is gone — ${problem}.`,
          );
        }
        continue;
      }

      const loosened = kind === 'ceiling' ? after > before : after < before;
      if (!loosened) continue;

      const problem = justificationProblem(headEntry, key, after);
      if (problem === null) continue;

      const direction = kind === 'ceiling' ? 'raised' : 'lowered';
      const move = kind === 'ceiling' ? `${before} → ${after}` : `${before} → ${after}`;
      violations.push(
        `surface \`${name}\`: \`${key}\` ${direction} (${move}), which loosens the gate — ${problem}.`,
      );
    }
  }

  return violations;
}

const splitKeys = (raw) =>
  String(raw ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

export function main(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const [ledgerPath, baseRef] = argv;
  if (!ledgerPath || !baseRef) {
    console.error('usage: bundle-ceiling-guard.mjs <ledger-path> <base-ref>');
    return 2;
  }

  const ceilingKeys = splitKeys(env.CEILING_KEYS ?? 'raw,brotli');
  const floorKeys = splitKeys(env.FLOOR_KEYS ?? 'chunks');
  if (ceilingKeys.length === 0 && floorKeys.length === 0) {
    console.error('::error::neither ceiling-keys nor floor-keys names anything — this guard would check nothing');
    return 2;
  }

  let headText;
  try {
    headText = readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    // Fail closed. A ledger this guard cannot read is indistinguishable from
    // one that was deleted to make a budget stop failing.
    console.error(`::error::cannot read ${ledgerPath}: ${error.message}`);
    return 1;
  }

  const baseText = readAtRef(baseRef, ledgerPath, cwd);
  if (baseText === null) {
    console.log(
      `${ledgerPath} does not exist at ${baseRef} — this diff ADOPTS the budget, ` +
        'so there is no previous ceiling to loosen. Nothing to check.',
    );
    return 0;
  }

  let base;
  let head;
  try {
    base = parseLedger(baseText, `${ledgerPath} at ${baseRef}`);
    head = parseLedger(headText, ledgerPath);
  } catch (error) {
    console.error(`::error::${error.message}`);
    return 1;
  }

  const violations = findUnjustifiedLoosenings({ base, head, ceilingKeys, floorKeys });
  if (violations.length === 0) {
    console.log(
      `${ledgerPath}: no unjustified loosening against ${baseRef} ` +
        `(ceilings: ${ceilingKeys.join(', ') || 'none'}; floors: ${floorKeys.join(', ') || 'none'})`,
    );
    return 0;
  }

  for (const violation of violations) console.error(`::error::${violation}`);
  console.error(
    `\n${violations.length} unjustified loosening(s) of ${ledgerPath}.\n` +
      'Tightening a budget is always free. Loosening one is a decision, so it is recorded\n' +
      'with the value it applies to and a sentence saying why the bytes had to move:\n\n' +
      '  "loosened": { "<key>": <the new committed value>, "why": "<what moved onto the\n' +
      '                 critical path, and why deferring it was not an option>" }\n\n' +
      'If you did not mean to loosen anything, the fix is the regression, not the ledger.',
  );
  return 1;
}

// `node --test` imports this module for the pure helpers above; only a direct
// run should be able to exit the process.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
