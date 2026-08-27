#!/usr/bin/env node
/**
 * Fail a test lane that reported ZERO executed test cases.
 *
 * Affected-test selection (`vitest related` / `--changed`) is paired with
 * `--passWithNoTests`, which is correct per-invocation — a changed file with no
 * importing test legitimately runs nothing — but is indistinguishable at the job
 * level from "the selector resolved nothing at all". A stale impact map, an
 * unresolvable diff base, or a mis-classified path all land on exit 0 with every
 * check green and no test signal whatsoever.
 *
 * This asserts the lane's JUnit reports at least one test case. Fail-closed:
 * missing or unparseable reports fail too, because "no report" and "no tests" are
 * the same amount of evidence.
 *
 * Usage: node check-test-signal.mjs <path>...
 *   Each path is a JUnit XML file OR a directory scanned recursively for *.xml.
 *   Multiple paths are summed — a monorepo whose unit lane runs vitest per
 *   workspace package produces one report per package, not one merged report.
 *
 * Env:
 *   LANE_LABEL    name used in log/annotation text (default "test").
 *   BYPASS_LABEL  PR label that skips this guard, named in the failure message.
 *                 Passed in rather than hardcoded: telling a blocked author to
 *                 apply a label the caller never configured is worse than
 *                 saying nothing.
 *
 * Node builtins only, by design: this runs inside a consumer's job, which may
 * have no dependencies installed at the point the guard fires.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LANE = process.env.LANE_LABEL || 'test';
const BYPASS_LABEL = process.env.BYPASS_LABEL || 'ci:allow-zero-tests';

/**
 * How many test cases does this JUnit report account for?
 *
 * Three readings of the same number, cheapest first. Vitest's junit reporter
 * puts `tests="N"` on the root `<testsuites>`; some configs only emit a flat
 * `<testsuite tests="N">`; and a producer may declare neither, in which case
 * the `<testcase>` elements ARE the count.
 *
 * That third branch is not a nicety. `node --test --test-reporter=junit` — the
 * runner a consumer reaches for when a suite has no vitest project, e.g. root
 * `scripts/__tests__` — emits an attribute-less `<testsuites>` and, for a file
 * of top-level tests, puts `<testcase>` directly inside it with no
 * `<testsuite>` wrapper anywhere. Both earlier branches miss, and the guard
 * then reported the report UNPARSEABLE and failed a lane that had just run its
 * tests and passed them. Measured on future-pay#1242, whose new root suite is
 * exactly that shape:
 *
 *     <testsuites>
 *       <testcase name="a source change moves the fingerprint" … />
 *
 * A `<testcase>` is the unit this guard exists to count, so counting them is
 * the definition rather than a heuristic — the other two branches are summaries
 * of it that a producer happened to compute already.
 *
 * `<testsuite\b` does not match `<testsuites` (no word boundary between `e` and
 * `s`), so the two branches cannot double-count. Do not "simplify" the boundary.
 * The `<testcase>` branch is only reached when NEITHER matched, so it cannot
 * double-count either.
 */
export function parseJUnitTotals(xml) {
  const rootMatch = xml.match(/<testsuites\b[^>]*\btests=["'](\d+)["']/i);
  if (rootMatch && rootMatch[1] !== undefined) {
    return { tests: Number.parseInt(rootMatch[1], 10), source: 'testsuites' };
  }

  let summed = 0;
  let matched = false;
  const suiteRe = /<testsuite\b[^>]*\btests=["'](\d+)["']/gi;
  for (const match of xml.matchAll(suiteRe)) {
    const value = match[1];
    if (value === undefined) continue;
    summed += Number.parseInt(value, 10);
    matched = true;
  }
  if (matched) return { tests: summed, source: 'testsuite-sum' };

  // Neither summary was declared. Count the cases themselves — self-closing
  // `<testcase … />` and `<testcase …>…</testcase>` alike, which is why the
  // pattern stops at the tag name rather than trying to match a closing form.
  let cases = 0;
  for (const _ of xml.matchAll(/<testcase\b/gi)) cases += 1;
  if (cases > 0) return { tests: cases, source: 'testcase-count' };

  return null;
}

/** Every *.xml under `target`, or `[target]` when it is a file. Missing → []. */
export function collectReports(target) {
  if (!existsSync(target)) return [];
  if (!statSync(target).isDirectory()) return [target];

  const found = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const child = join(target, entry.name);
    if (entry.isDirectory()) found.push(...collectReports(child));
    else if (entry.name.endsWith('.xml')) found.push(child);
  }
  return found.sort();
}

function fail(title, body) {
  process.stderr.write(`::error title=${title}::${body}\n`);
  process.exit(1);
}

/** Sum `tests` across every report, failing closed on an unparseable one. */
function totalTests(reports) {
  let total = 0;
  for (const report of reports) {
    const totals = parseJUnitTotals(readFileSync(report, 'utf-8'));
    if (totals === null) {
      fail(
        `${LANE} JUnit report unparseable`,
        `Could not extract a \`tests="N"\` attribute from ${report}. The junit reporter ` +
          'format may have changed; inspect the file and update parseJUnitTotals.',
      );
    }
    total += totals.tests;
  }
  return total;
}

function reportZeroSignal(count) {
  process.stderr.write(
    [
      `::error title=${LANE} lane executed zero tests::${count} JUnit report(s) ` +
        'totalled 0 test cases. Affected-test selection resolved no specs for this diff.',
      '',
      'This usually means one of:',
      '  1. The change is not covered by this lane. Add or extend a test that exercises it.',
      '  2. The PR is genuinely test-free (workflow YAML, docs, a baseline artifact).',
      `     Label the PR \`${BYPASS_LABEL}\` to skip this guard deliberately and on the record.`,
      '     That label ONLY disarms this check — it does not widen selection.',
      '  3. The change-impact graph is stale and missed the link between the changed file',
      '     and its test. Reproduce the selector locally; if it returns zero, that is a bug',
      '     in the selector, not a reason to bypass this gate.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

function main() {
  const targets = process.argv.slice(2).filter(Boolean);
  if (targets.length === 0) {
    fail(
      `${LANE} signal guard misconfigured`,
      'No report path given. Pass at least one JUnit file or directory.',
    );
  }

  const reports = targets.flatMap((t) => collectReports(resolve(t)));
  if (reports.length === 0) {
    fail(
      `${LANE} JUnit report missing`,
      `No JUnit XML found under ${targets.join(', ')}. The lane must run vitest with ` +
        '`--reporter=junit --outputFile.junit=<path>`. A missing report is treated as ' +
        'zero signal, not as success.',
    );
  }

  const total = totalTests(reports);
  if (total === 0) reportZeroSignal(reports.length);

  process.stdout.write(
    `[vitest-signal-guard] OK — ${LANE} lane executed ${total} test case(s) across ` +
      `${reports.length} report(s).\n`,
  );
}

/**
 * Exact identity, not a substring match.
 *
 * A `argv[1].includes('check-test-signal')` check is also true of
 * `check-test-signal.test.mjs`, so importing this module from its own test ran
 * `main()` with no arguments and exited 1 before a single case executed. Any
 * test file named after its subject trips that, which is most of them.
 */
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
