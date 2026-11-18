import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { durationsRun, mergeReports } from "../lib/reports.mjs";
import { attemptOfArtifact, legSeconds, readReports } from "../refresh.mjs";

const UNIT = { files: "\\.(xml|durations\\.json)$", format: "junit", junitRoot: "reports/" };

function leg(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "lane-timings-replayed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const junit = (name, time) => `<testsuites><testsuite name="${name}" tests="1" time="${time}"></testsuite></testsuites>`;
const durations = (run, rows) => JSON.stringify({ $run: run, ...rows });

// FUT-4409, run 44188546201 (attempt 2): turbo replayed apps/admin from cache,
// restoring the XML and the durations JSON attempt 1 wrote, while apps/web ran.
function attemptTwoLeg(t) {
  return leg(t, {
    "apps/admin/reports/junit/unit/admin.xml": junit("src/a.test.tsx", 1),
    "apps/admin/reports/junit/unit/admin.durations.json": durations("44188546201.1", { "apps/admin/src/a.test.tsx": 300 }),
    "apps/web/reports/junit/unit/web.xml": junit("lib/b.test.ts", 2),
    "apps/web/reports/junit/unit/web.durations.json": durations("44188546201.2", { "apps/web/lib/b.test.ts": 40 }),
  });
}

test("a durations map names the run that wrote it", () => {
  assert.equal(durationsRun(durations("1.2", { a: 1 })), "1.2");
  assert.equal(durationsRun(JSON.stringify({ a: 1 })), null);
  assert.equal(durationsRun("not json"), null);
});

test("an artifact's attempt is its -a<n>- part", () => {
  assert.equal(attemptOfArtifact("unit-junit-a2-s3"), 2);
  assert.equal(attemptOfArtifact("spa-e2e-report-s3"), null);
});

test("a replayed package keeps its cost but stays out of the leg's measured seconds", (t) => {
  const reports = readReports(attemptTwoLeg(t), UNIT, { expectRun: "44188546201.2" });
  const merged = mergeReports(reports);
  // The ledger still learns what the admin file costs…
  assert.equal(merged.get("apps/admin/src/a.test.tsx").seconds, 300);
  assert.equal(merged.get("apps/web/lib/b.test.ts").seconds, 40);
  // …but only the web package ran inside this leg's step.
  assert.equal(legSeconds(reports), 40);
});

test("the JUnit beside a replayed map is replayed too", (t) => {
  const reports = readReports(attemptTwoLeg(t), UNIT, { expectRun: "44188546201.2" });
  assert.equal(reports.filter((r) => r.replayed).length, 2);
});

test("with no run to expect, or unstamped maps, every report counts as before", (t) => {
  assert.equal(legSeconds(readReports(attemptTwoLeg(t), UNIT)), 340);
  const unstamped = leg(t, {
    "apps/web/reports/junit/unit/web.xml": junit("lib/b.test.ts", 2),
    "apps/web/reports/junit/unit/web.durations.json": JSON.stringify({ "apps/web/lib/b.test.ts": 40 }),
  });
  assert.equal(legSeconds(readReports(unstamped, UNIT, { expectRun: "9.1" })), 40);
});
