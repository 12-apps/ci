import assert from "node:assert/strict";
import { test } from "node:test";

import { junitPrefix, mergeReports, parseDurationsJson, parseJunit, reportItems, rewriteKey } from "../lib/reports.mjs";
import { annotations, mergeLedger, slowReport, summaryMarkdown } from "../lib/refresh.mjs";
import { normaliseLedger } from "../lib/timings.mjs";

// Verbatim shape of future-pay's vitest JUnit (run 41818675238, unit-junit-a1-s1).
const UNIT_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="122" failures="0" errors="0" time="1.415914106">
    <testsuite name="tests/migration-discovery.test.ts" timestamp="2026-11-04T11:20:20.126Z" hostname="h" tests="3" failures="0" errors="0" skipped="0" time="0.025173425">
        <testcase classname="tests/migration-discovery.test.ts" name="a &gt; b" time="0.006"></testcase>
    </testsuite>
    <testsuite name="src/a &amp; b.test.ts" timestamp="t" hostname="h" tests="2" failures="0" errors="0" skipped="0" time="190.5">
    </testsuite>
</testsuites>`;

test("a package's junit keys are prefixed with the package; a root report's are not", () => {
  assert.equal(junitPrefix("packages/prisma/reports/junit/unit/packages-prisma.xml"), "packages/prisma/");
  assert.equal(junitPrefix("./apps/web/reports/junit/unit/x.xml"), "apps/web/");
  assert.equal(junitPrefix("reports/junit/unit/root.xml"), "");
  assert.equal(junitPrefix("integration.xml"), "");
  const rows = parseJunit(UNIT_XML, "packages/prisma/");
  assert.deepEqual(rows, [
    { key: "packages/prisma/tests/migration-discovery.test.ts", seconds: 0.025173425, tests: 3 },
    { key: "packages/prisma/src/a & b.test.ts", seconds: 190.5, tests: 2 },
  ]);
});

test("Gherkin generated specs rewrite onto their feature, summed across projects", () => {
  const rows = parseDurationsJson(
    JSON.stringify({
      ".features-gen/admin/tests/e2e/features/admin/x.feature.spec.js": 100,
      ".features-gen/admin-mobile/tests/e2e/features/admin/x.feature.spec.js": 44,
      "apps/admin/src/y.e2e.ts": 3,
      bad: "x",
    }),
  );
  const rules = [{ pattern: "^\\.features-gen/[^/]+/(.+)\\.spec\\.js$", replace: "$1" }];
  assert.equal(rewriteKey("apps/admin/src/y.e2e.ts", rules), "apps/admin/src/y.e2e.ts");
  const items = reportItems(rows, rules);
  assert.deepEqual(items.get("tests/e2e/features/admin/x.feature"), { seconds: 144, tests: null });
  assert.equal(items.size, 2);
  assert.deepEqual(parseDurationsJson("not json"), []);
});

test("a re-run attempt of the same item keeps the longer measurement", () => {
  const a = new Map([["f", { seconds: 10, tests: 1 }]]);
  const b = new Map([["f", { seconds: 30, tests: 1 }], ["g", { seconds: 1, tests: 1 }]]);
  assert.equal(mergeReports([a, b]).get("f").seconds, 30);
  assert.equal(mergeReports([b, a]).get("f").seconds, 30);
});

test("the merge takes today's cost, keeps the unmeasured, drops the deleted, measures concurrency", () => {
  const ledger = normaliseLedger({ concurrency: 2, files: { kept: 50, updated: 10, gone: 5 } });
  const measured = new Map([["updated", { seconds: 40, tests: 1 }], ["added", { seconds: 20, tests: 1 }], ["ghost", { seconds: 9, tests: 1 }]]);
  const exists = (item) => item !== "gone" && item !== "ghost";
  const { ledger: next, changes } = mergeLedger(ledger, measured, { exists, paired: { measured: 69, wall: 20 } });
  assert.deepEqual(Object.fromEntries(next.files), { updated: 40, added: 20, kept: 50 });
  assert.deepEqual(changes, { added: ["added"], removed: ["gone"], updated: 1, kept: 1 });
  assert.equal(next.concurrency, 3.45); // 69 / 20
  // No leg with both a report and a step time: yesterday's ratio stands.
  assert.equal(mergeLedger(ledger, measured, { exists }).ledger.concurrency, 2);
});

test("a 3-minute file, a 10-minute leg and a binding cap are each reported", () => {
  const ledger = normaliseLedger({ concurrency: 1, files: { a: 1500, b: 1500 } });
  const measured = new Map([["a", { seconds: 900, tests: 120 }], ["b", { seconds: 179, tests: 1 }]]);
  const report = slowReport("gherkin", measured, { slowFileSeconds: 180, targetSeconds: 600, stepSeconds: [700, 300], ledger, maxShards: 4 });
  assert.deepEqual(report.slowFiles, [{ lane: "gherkin", item: "a", seconds: 900, tests: 120 }]);
  assert.deepEqual(report.slowLegs, [{ lane: "gherkin", leg: 1, seconds: 700 }]);
  assert.deepEqual(report.cap, { maxShards: 4, fullWidthWants: 5, binding: true, fullWidthSeconds: 3000 });

  const lines = annotations(report, { targetSeconds: 600, slowFileSeconds: 180 });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^::warning file=a,title=slow test file \(gherkin\)::a took 15m00s \(120 test\(s\)\)/);
  assert.match(lines[1], /leg 1 ran its tests for 11m40s/);
  assert.match(lines[2], /wants 5 leg\(s\).*cap is 4/);

  const md = summaryMarkdown(
    [{ lane: "gherkin", report, measuredCount: 2, ledgerCount: 2, concurrency: 1, missing: ["s3"] }],
    { targetSeconds: 600, slowFileSeconds: 180 },
  );
  assert.match(md, /\| gherkin \| `a` \| 15m00s \| 120 \|/);
  assert.match(md, /5 \/ 4 ⚠️/);
  assert.match(md, /no report from s3/);
});
