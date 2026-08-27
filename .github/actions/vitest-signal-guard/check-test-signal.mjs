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
 * The number of test cases a JUnit XML report accounts for.
 *
 * Three shapes, tried in order, because the summary attribute is a convention
 * rather than part of the format:
 *
 *   1. `<testsuites tests="N">` — what vitest's junit reporter writes.
 *   2. `<testsuite tests="N">`, summed — what some configs write instead.
 *   3. `<testcase>` elements, COUNTED — what is left when neither exists.
 *
 * The third arrived with node:test. Its junit reporter emits `<testsuites>` with
 * no attributes at all and puts the totals in XML COMMENTS (`<!-- tests 10 -->`),
 * so both attribute branches miss and the guard refused the file outright:
 * "Could not extract a `tests="N"` attribute … the junit reporter format may
 * have changed". That is the correct fail-closed answer to a shape nobody has
 * read, and the wrong answer to this one — the file is perfectly legible, it
 * simply does not restate what its own elements already say.
 *
 * Counting elements does not weaken the guard, and that is worth stating because
 * it is the only reason this is safe to add. The claim being made is "at least
 * one test ran", and a file with no `<testcase>` counts zero and still fails.
 * The comments are deliberately NOT parsed: a comment is not data, and a total
 * that disagreed with the elements beside it would be unarbitrable.
 *
 * `<testsuite\b` does not match `<testsuites` (no word boundary between `e` and
 * `s`), so the two attribute branches cannot double-count. Do not "simplify" the
 * boundary. The element count runs only when both have already declined, so it
 * cannot double-count either.
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

  // Neither attribute exists. Count the elements themselves — self-closing
  // `<testcase … />` and the `<testcase>…</testcase>` form that wraps a
  // failure or a skip alike, which is why this matches the OPENING tag rather
  // than a whole element.
  const cases = [...xml.matchAll(/<testcase\b/gi)].length;
  if (cases > 0) return { tests: cases, source: 'testcase-count' };

  // A file with no totals and no cases says nothing. Refusing it is the point:
  // an unreadable report must never be read as a passing lane.
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
        `Found no totals and no \`<testcase>\` elements in ${report}. The junit ` +
          'reporter format may have changed; inspect the file and update parseJUnitTotals.',
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
