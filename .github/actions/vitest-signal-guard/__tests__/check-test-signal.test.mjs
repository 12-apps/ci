#!/usr/bin/env node
/**
 * Self-tests for the zero-test-signal guard.
 *
 * `node:test` rather than vitest, matching `fetch-base/__tests__`: the self-test
 * job installs nothing, and neither does this action.
 *
 * The guard's own failure modes are both GREEN — a gate that skips itself and
 * reports success is indistinguishable from a gate that passed — so it needs a
 * test that is not.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { collectReports, parseJUnitTotals } from '../check-test-signal.mjs';

const roots = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function scratch(files) {
  const root = mkdtempSync(join(tmpdir(), 'signal-guard-test-'));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

const suites = (tests) => `<?xml version="1.0"?><testsuites tests="${tests}"/>`;

// ── parseJUnitTotals — the six reference cases ─────────────────────────────

test('parses tests from a standard <testsuites> root', () => {
  const xml = `<?xml version="1.0"?>
<testsuites name="vitest" tests="42" failures="0" errors="0" time="1.5">
  <testsuite name="path/to/foo" tests="10" failures="0">
    <testcase name="x" classname="y"/>
  </testsuite>
</testsuites>`;
  assert.deepEqual(parseJUnitTotals(xml), { tests: 42, source: 'testsuites' });
});

test('sums children when no <testsuites> root is present', () => {
  const xml = `<?xml version="1.0"?>
<testsuite name="a" tests="3"><testcase name="x"/></testsuite>
<testsuite name="b" tests="7"><testcase name="y"/></testsuite>`;
  assert.deepEqual(parseJUnitTotals(xml), { tests: 10, source: 'testsuite-sum' });
});

test('returns 0 when the root reports zero tests', () => {
  assert.deepEqual(parseJUnitTotals(suites(0)), { tests: 0, source: 'testsuites' });
});

test('returns null when no tests attribute is present anywhere', () => {
  assert.equal(parseJUnitTotals(`<?xml version="1.0"?><somethingelse foo="bar"/>`), null);
});

test('handles attribute order variations and single-quoted attributes', () => {
  const xml = `<?xml version="1.0"?>
<testsuites failures="0" tests='17' time="0.1"/>`;
  assert.deepEqual(parseJUnitTotals(xml), { tests: 17, source: 'testsuites' });
});

test('is case-insensitive on element names', () => {
  assert.deepEqual(parseJUnitTotals(`<?xml version="1.0"?><TestSuites tests="5"/>`), {
    tests: 5,
    source: 'testsuites',
  });
});

// ── node --test's junit reporter (FUT-963) ────────────────────────────────
//
// The bytes below are what `node --test --test-reporter=junit` really writes
// for a file of top-level tests: an attribute-less `<testsuites>` and
// `<testcase>` elements directly inside it, no `<testsuite>` wrapper anywhere.
// Both summary branches miss, so before the testcase fallback this report was
// UNPARSEABLE and failed a lane that had just run its tests and passed them.
const NODE_TEST_JUNIT = [
  `<?xml version="1.0" encoding="utf-8"?>`,
  `<testsuites>`,
  `\t<testcase name="a source change moves the fingerprint" time="0.071" classname="test"/>`,
  `\t<testcase name="a deleted source file moves the fingerprint" time="0.073" classname="test"/>`,
  `</testsuites>`,
].join('\n');

test("counts <testcase> when node --test declares no totals at all", () => {
  assert.deepEqual(parseJUnitTotals(NODE_TEST_JUNIT), { tests: 2, source: 'testcase-count' });
});

test('counts a <testcase> written with a closing tag, not just self-closed', () => {
  const xml = `<?xml version="1.0"?><testsuites><testcase name="a"><failure/></testcase></testsuites>`;
  assert.deepEqual(parseJUnitTotals(xml), { tests: 1, source: 'testcase-count' });
});

test('a declared total always wins over counting the cases', () => {
  // Both summary branches are shortcuts to the same number, so a producer that
  // computed one must be believed — otherwise a report that both declares and
  // lists would be read twice as differently as the two disagree.
  const xml = `<?xml version="1.0"?><testsuites tests="9"><testcase name="a"/></testsuites>`;
  assert.deepEqual(parseJUnitTotals(xml), { tests: 9, source: 'testsuites' });

  const flat = `<?xml version="1.0"?><testsuite tests="4"><testcase name="a"/></testsuite>`;
  assert.deepEqual(parseJUnitTotals(flat), { tests: 4, source: 'testsuite-sum' });
});

test('an empty report stays UNPARSEABLE — the fallback must not fail open', () => {
  // The whole point of the guard is to notice a lane that ran nothing. A
  // producer emitting neither a total nor a case has told us nothing, and
  // "nothing" must keep meaning null (fail closed), never 0 (a clean verdict).
  assert.equal(parseJUnitTotals(`<?xml version="1.0"?><testsuites></testsuites>`), null);
});

test('a genuine zero is still a zero, not an unparseable report', () => {
  // vitest DOES declare tests="0" for an empty selection, and that must keep
  // reaching the zero-signal branch rather than the unparseable one.
  const empty = `<?xml version="1.0" encoding="UTF-8" ?>\n<testsuites name="vitest tests" tests="0" failures="0" errors="0" time="0">\n</testsuites>`;
  assert.deepEqual(parseJUnitTotals(empty), { tests: 0, source: 'testsuites' });
});

test('a <testsuites> root is never double-counted by the child branch', () => {
  // `<testsuite\b` cannot match `<testsuites` — there is no word boundary
  // between `e` and `s`. If that ever "simplifies", this catches it: the root
  // says 42 and the single child says 10, so a double-count reads 52.
  const xml = `<?xml version="1.0"?>
<testsuites tests="42"><testsuite name="a" tests="10"/></testsuites>`;
  assert.deepEqual(parseJUnitTotals(xml), { tests: 42, source: 'testsuites' });
});

// ── collectReports — the multi-path layer this port adds ───────────────────

test('collectReports on a nested directory finds every xml, sorted', () => {
  const root = scratch({
    'unit/a.xml': suites(1),
    'unit/nested/b.xml': suites(2),
    'unit/notes.txt': 'ignored',
    'unit/nested/report.json': '{}',
  });
  assert.deepEqual(collectReports(join(root, 'unit')), [
    join(root, 'unit/a.xml'),
    join(root, 'unit/nested/b.xml'),
  ]);
});

test('collectReports on a plain file returns just that file', () => {
  const root = scratch({ 'integration.xml': suites(4) });
  const file = join(root, 'integration.xml');
  assert.deepEqual(collectReports(file), [file]);
});

test('collectReports on a missing path returns [] — the fail-closed branch', () => {
  // This is what turns "the lane wrote no report" into a failure rather than a
  // pass. An empty list must never read as "nothing to check, therefore fine".
  assert.deepEqual(collectReports(join(tmpdir(), 'definitely-not-here-9c3f')), []);
});

test('two reports of 3 and 7 sum to 10 across files', () => {
  const root = scratch({ 'unit/a.xml': suites(3), 'unit/b.xml': suites(7) });
  const total = collectReports(join(root, 'unit'))
    .map((f) => parseJUnitTotals(readFileSync(f, 'utf-8')).tests)
    .reduce((a, b) => a + b, 0);
  assert.equal(total, 10);
});
