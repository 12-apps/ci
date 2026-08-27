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

test('returns null when there are no totals AND no cases', () => {
  // Still the fail-closed branch: a file that says nothing must never be read
  // as a passing lane. What changed is only that "says nothing" now means no
  // `<testcase>` either, rather than no `tests="N"`.
  assert.equal(parseJUnitTotals(`<?xml version="1.0"?><somethingelse foo="bar"/>`), null);
  assert.equal(parseJUnitTotals(`<?xml version="1.0"?><testsuites>\n<!-- tests 0 -->\n</testsuites>`), null);
});

// ── node:test's shape: no attributes, totals in COMMENTS ─────────────────────
// A consumer whose lane runs node:test (a repo's own CI scripts, typically)
// writes `<testsuites>` with no attributes at all and puts the totals in XML
// comments. Both attribute branches miss, and the guard refused the file
// outright — the correct fail-closed answer to a shape nobody has read, and the
// wrong one to this, which is perfectly legible and simply does not restate what
// its own elements already say. Measured on 12-apps/future-pay run 33041928751.
test('counts <testcase> elements when neither totals attribute exists', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
\t<testcase name="each side's raise survives" time="0.003965" classname="test"/>
\t<testcase name="numeric comparison, not lexicographic" time="0.000221" classname="test"/>
\t<!-- tests 2 -->
\t<!-- pass 2 -->
</testsuites>`;
  assert.deepEqual(parseJUnitTotals(xml), { tests: 2, source: 'testcase-count' });
});

test('a wrapped <testcase> counts once, failure or skip included', () => {
  // The opening tag is what is matched, so the self-closing form and the form
  // that wraps a <failure> or <skipped> child count the same.
  const xml = `<testsuites>
  <testcase name="a"><failure message="boom">stack</failure></testcase>
  <testcase name="b"><skipped/></testcase>
  <testcase name="c"/>
</testsuites>`;
  assert.deepEqual(parseJUnitTotals(xml), { tests: 3, source: 'testcase-count' });
});

test('an attribute total always wins over the element count', () => {
  // Order matters: vitest emits BOTH a root total and the cases beneath it, so
  // counting elements first would be a second, disagreeing answer for every
  // report this guard already reads correctly.
  const xml = `<testsuites tests="9"><testsuite tests="9">
  <testcase name="a"/><testcase name="b"/>
</testsuite></testsuites>`;
  assert.deepEqual(parseJUnitTotals(xml), { tests: 9, source: 'testsuites' });

  const flat = `<testsuite tests="4"><testcase name="a"/></testsuite>`;
  assert.deepEqual(parseJUnitTotals(flat), { tests: 4, source: 'testsuite-sum' });
});

test('the comment totals are deliberately not parsed', () => {
  // A comment is not data. If one ever disagreed with the elements beside it
  // there would be no way to arbitrate, so the elements are the only source.
  const xml = `<testsuites>
  <testcase name="a"/>
  <!-- tests 999 -->
</testsuites>`;
  assert.deepEqual(parseJUnitTotals(xml), { tests: 1, source: 'testcase-count' });
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
