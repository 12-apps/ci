import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { mergeReports } from "../lib/reports.mjs";
import { legSeconds, readReports } from "../refresh.mjs";

const UNIT = { files: "\\.(xml|durations\\.json)$", format: "junit", junitRoot: "reports/" };

function leg(files) {
  const dir = mkdtempSync(join(tmpdir(), "lane-timings-durations-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

// What vitest's JUnit reporter writes: `time` is the test phase only.
const junit = `<testsuites><testsuite name="src/heavy.test.ts" tests="2" time="0.4"></testsuite>
<testsuite name="src/light.test.ts" tests="1" time="1.5"></testsuite></testsuites>`;
// What a durations reporter writes beside it: import + setup + tests, repo-relative.
const durations = JSON.stringify({ "apps/web/src/heavy.test.ts": 42.5, "apps/web/src/light.test.ts": 1.6 });

test("a junit lane reads a durations JSON beside its XML, and the larger cost wins", (t) => {
  const dir = leg({
    "apps/web/reports/junit/unit/web.xml": junit,
    "apps/web/reports/junit/unit/web.durations.json": durations,
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const merged = mergeReports(readReports(dir, UNIT));
  assert.equal(merged.get("apps/web/src/heavy.test.ts").seconds, 42.5);
  assert.equal(merged.get("apps/web/src/light.test.ts").seconds, 1.6);
});

test("an item in both reports counts once toward its leg's measured seconds", (t) => {
  const dir = leg({
    "apps/web/reports/junit/unit/web.xml": junit,
    "apps/web/reports/junit/unit/web.durations.json": durations,
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 42.5 + 1.6, not 42.5 + 1.6 + 0.4 + 1.5: a double count inflates concurrency.
  assert.equal(legSeconds(readReports(dir, UNIT)), 44.1);
});

test("a junit lane with no durations JSON reads exactly as before", (t) => {
  const dir = leg({ "apps/web/reports/junit/unit/web.xml": junit });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const merged = mergeReports(readReports(dir, { ...UNIT, files: "\\.xml$" }));
  assert.equal(merged.get("apps/web/src/heavy.test.ts").seconds, 0.4);
  assert.equal(legSeconds(readReports(dir, { ...UNIT, files: "\\.xml$" })), 1.9);
});

test("a durations JSON the lane's files pattern does not match is ignored", (t) => {
  const dir = leg({
    "apps/web/reports/junit/unit/web.xml": junit,
    "apps/web/reports/junit/unit/web.durations.json": durations,
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const merged = mergeReports(readReports(dir, { ...UNIT, files: "\\.xml$" }));
  assert.equal(merged.get("apps/web/src/heavy.test.ts").seconds, 0.4);
});
