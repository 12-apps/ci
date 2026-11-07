// A shard records only what IT passed, and only when it knows what that was
// (FUT-4548).
//
// The lane-level record waits for every shard; the shard record is what lets
// a lane with one red shard, or a run cancelled by the next push, keep the
// green shards' proof. Its whole safety argument is in these cases: a shard
// whose test step did not succeed writes nothing; a shard split by the
// runner (no leg list) above one shard writes nothing; a shard whose JUnit
// holds zero test cases proved nothing; only files the plan handed the lane,
// with a bounded hash, are ever named.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { SHARD_RECORD_VERSION } from "../lib/manifest.mjs";
import { junitFiles, junitRow, shardRecord, unattributedFailure } from "../shard.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "shard.mjs");
const TMP = mkdtempSync(join(tmpdir(), "skip-green-shard-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const H = (n) => n.toString(16).padStart(64, "0");
const HEAD = "c".repeat(40);
const PLAN = {
  lane: "unit",
  mode: "narrowed",
  inputsVersion: "test-inputs-v2",
  tests: ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"],
  inputs: { "a.test.ts": H(1), "b.test.ts": null, "c.test.ts": H(3), "d.test.ts": H(4) },
};
// What the shard's JUnit shows RAN: every planned file, by default.
const RAN = new Map(PLAN.tests.map((t) => [t, { ran: 2, bad: 0 }]));
const shard = (over = {}) =>
  shardRecord({ lane: "unit", plan: PLAN, leg: ["a.test.ts", "b.test.ts", "c.test.ts"], shard: "2", shardTotal: "3", outcome: "success", headSha: HEAD, runId: "77", junit: RAN, ...over });

test("a green shard records its OWN leg, with the plan's hashes, this head and this run", () => {
  const { record } = shard();
  assert.deepEqual(record, {
    version: SHARD_RECORD_VERSION,
    lane: "unit",
    inputs: "test-inputs-v2",
    sha: HEAD,
    run: "77",
    shard: "2",
    passed: true,
    tests: { "a.test.ts": H(1), "c.test.ts": H(3) },
  });
  assert.equal(record.tests["d.test.ts"], undefined, "another leg's file is never this shard's claim");
});

test("counterexample: a shard whose test step FAILED names no test green — it evicts its whole list", () => {
  const { record } = shard({ outcome: "failure" });
  assert.equal(record.passed, false);
  assert.equal(record.tests, undefined, "no green claim of any kind");
  assert.deepEqual(record.evict, ["a.test.ts", "b.test.ts", "c.test.ts"], "every file of the leg, the null-hash one included");
  assert.equal(shard({ outcome: "failure", leg: null }).record.evict, "*", "a list it cannot name evicts every planned test");
  assert.ok(shard({ outcome: "failure", junit: null }).record, "an eviction needs no JUnit evidence");
});

test("a shard that was cancelled, skipped, or green with no signal writes nothing either way", () => {
  for (const outcome of ["cancelled", "skipped", "no-signal", "", undefined]) {
    assert.equal(shard({ outcome }).record, null, `outcome ${JSON.stringify(outcome)} must write nothing`);
  }
});

test("a test with no hash, or a leg line the plan does not hold, is never named", () => {
  const { record } = shard({ leg: ["b.test.ts", "zz.test.ts", "a.test.ts"] });
  assert.deepEqual(Object.keys(record.tests), ["a.test.ts"]);
});

test("above one shard, a shard split by the runner (no leg list) records nothing", () => {
  assert.equal(shard({ leg: null }).record, null);
  // At one shard the list IS the plan.
  const one = shard({ leg: null, shardTotal: "1" }).record;
  assert.deepEqual(Object.keys(one.tests), ["a.test.ts", "c.test.ts", "d.test.ts"]);
});

test("counterexample (FUT-4563): a planned file the runner never COLLECTED is not recorded, though the shard exited 0", () => {
  // vitest's include did not match it: "No test files found, exiting with code 0", and no JUnit row.
  const notCollected = new Map(RAN);
  notCollected.delete("c.test.ts");
  const { record, why } = shard({ junit: notCollected });
  assert.deepEqual(Object.keys(record.tests), ["a.test.ts"]);
  assert.match(why, /passed: 1 recorded; 1 passed but unhashable \(not recordable\); 1 planned file\(s\) its JUnit does not show running/);
});

test("a file whose JUnit row ran nothing (all skipped) or holds a failure is not recorded", () => {
  assert.deepEqual(Object.keys(shard({ junit: new Map([...RAN, ["c.test.ts", { ran: 0, bad: 0 }]]) }).record.tests), ["a.test.ts"]);
  assert.deepEqual(Object.keys(shard({ junit: new Map([...RAN, ["c.test.ts", { ran: 3, bad: 1 }]]) }).record.tests), ["a.test.ts"]);
});

test("no readable JUnit, no green record", () => {
  assert.equal(shard({ junit: null }).record, null);
  assert.equal(shard({ junit: undefined }).record, null);
});

test("a plan that is not narrowed, carries no inputs, or a head that is not a sha records nothing", () => {
  assert.equal(shard({ plan: { ...PLAN, mode: "none" } }).record, null);
  const { inputs: _drop, ...noInputs } = PLAN;
  assert.equal(shard({ plan: noInputs }).record, null);
  assert.equal(shard({ headSha: "refs/pull/1/merge" }).record, null);
  assert.equal(shard({ runId: "" }).record, null);
});

test("junitFiles keys each vitest suite by repo path, from where its report sits, and counts what RAN", () => {
  const cwd = join(TMP, "repo");
  mkdirSync(join(cwd, "apps/web/reports/junit/unit"), { recursive: true });
  mkdirSync(join(cwd, "reports/junit"), { recursive: true });
  writeFileSync(
    join(cwd, "apps/web/reports/junit/unit/apps-web.xml"),
    '<testsuites><testsuite name="src/a.test.ts" tests="2" failures="0" errors="0" skipped="0"><testcase name="x"/></testsuite>' +
      '<testsuite name="src/skipped.test.ts" tests="1" failures="0" errors="0" skipped="1"></testsuite>' +
      '<testsuite name="src/red.test.ts" tests="2" failures="1" errors="0" skipped="0"></testsuite></testsuites>',
  );
  writeFileSync(join(cwd, "reports/junit/integration.xml"), '<testsuites><testsuite name="tests/integration/b.integration.test.ts" tests="1" failures="0" errors="0" skipped="0"/></testsuites>');
  // node:test's JUnit names describes, not files: it attributes nothing.
  writeFileSync(join(cwd, "reports/junit/root.xml"), '<testsuites><testcase name="a" classname="test"/></testsuites>');
  const files = junitFiles(["apps/web/reports/junit/unit", "reports/junit/integration.xml", "reports/junit/root.xml", "missing/dir"], cwd);
  assert.deepEqual(Object.fromEntries(files), {
    "apps/web/src/a.test.ts": { ran: 2, bad: 0 },
    "apps/web/src/skipped.test.ts": { ran: 0, bad: 0 },
    "apps/web/src/red.test.ts": { ran: 2, bad: 1 },
    "tests/integration/b.integration.test.ts": { ran: 1, bad: 0 },
  });
  assert.equal(junitFiles([join(TMP, "nothing-here")], cwd), null);
});

test("CLI: a green leg writes its passes; a red one writes an eviction", () => {
  const dir = join(TMP, "cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(PLAN));
  writeFileSync(join(dir, "leg.txt"), "a.test.ts\nc.test.ts\n");
  // Only a.test.ts ran; c.test.ts was planned but not collected.
  mkdirSync(join(dir, "reports/junit"), { recursive: true });
  writeFileSync(join(dir, "reports/junit/unit.xml"), '<testsuites><testsuite name="a.test.ts" tests="1" failures="0" errors="0" skipped="0"/></testsuites>');
  const run = (outcome, out) => {
    const outputs = join(dir, `outputs-${outcome}.txt`);
    writeFileSync(outputs, "");
    const r = spawnSync(
      "node",
      [CLI, "--lane", "unit", "--plan", "plan.json", "--leg", "leg.txt", "--shard", "1", "--shard-total", "2", "--outcome", outcome, "--head-sha", HEAD, "--run-id", "77", "--reports", "reports/junit", "--out", out],
      { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: outputs } },
    );
    return { code: r.status, emitted: Object.fromEntries(readFileSync(outputs, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2))) };
  };
  const red = run("failure", "red/unit-s1.json");
  assert.equal(red.code, 0);
  assert.equal(red.emitted.written, "true");
  const evicted = JSON.parse(readFileSync(join(dir, "red/unit-s1.json"), "utf8"));
  assert.deepEqual([evicted.passed, evicted.evict, evicted.tests], [false, ["a.test.ts", "c.test.ts"], undefined]);
  const cut = run("cancelled", "cut/unit-s1.json");
  assert.equal(cut.emitted.written, "false");
  assert.equal(existsSync(join(dir, "cut/unit-s1.json")), false);
  const green = run("success", "green/unit-s1.json");
  assert.equal(green.emitted.written, "true");
  assert.equal(green.emitted.tests, "1");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "green/unit-s1.json"), "utf8")).tests, { "a.test.ts": H(1) }, "the uncollected c.test.ts is not recorded");
});

test("a report AT the junit root, named after its workspace, keys its package-relative suites onto that workspace only", () => {
  const cwd = join(TMP, "slug");
  mkdirSync(join(cwd, "reports/junit/unit"), { recursive: true });
  // The way a per-workspace runner names it: `packages/combos` → `packages-combos.xml`.
  writeFileSync(
    join(cwd, "reports/junit/unit/packages-combos.xml"),
    '<testsuites><testsuite name="src/core/__tests__/flow.test.ts" tests="3" failures="0" errors="0" skipped="0"/></testsuites>',
  );
  const junit = junitFiles(["reports/junit/unit"], cwd);
  assert.deepEqual(junitRow(junit, "packages/combos/src/core/__tests__/flow.test.ts"), { ran: 3, bad: 0 });
  // Same relative name in ANOTHER workspace: that report does not answer for it.
  assert.equal(junitRow(junit, "packages/delivery/src/core/__tests__/flow.test.ts"), undefined);
  assert.equal(junitRow(junit, "packages/combos/src/core/__tests__/other.test.ts"), undefined);
  // A planned file the workspace's vitest did not collect is still absent.
  const rec = shardRecord({
    lane: "unit",
    plan: { mode: "narrowed", tests: ["packages/combos/src/core/__tests__/flow.test.ts", "packages/combos/src/core/uncollected.test.ts"], inputs: { "packages/combos/src/core/__tests__/flow.test.ts": H(5), "packages/combos/src/core/uncollected.test.ts": H(6) } },
    leg: null, shard: "1", shardTotal: "1", outcome: "success", headSha: HEAD, runId: "77", junit,
  }).record;
  assert.deepEqual(Object.keys(rec.tests), ["packages/combos/src/core/__tests__/flow.test.ts"]);
});

// ── a RED shard with no unattributed error records its clean files ───────────

test("red shard, no unattributed error: its clean files are recorded, the failed and the unreached evicted", () => {
  // a ran clean; c failed; b has no hash; d is another leg's. --bail left nothing else unreached here.
  const junit = new Map([["a.test.ts", { ran: 2, bad: 0 }], ["c.test.ts", { ran: 2, bad: 1 }]]);
  const { record, why } = shard({ outcome: "failure", junit, unattributed: null });
  assert.equal(record.passed, false);
  assert.deepEqual(record.tests, { "a.test.ts": H(1) }, "the clean file, at the plan's hash");
  assert.deepEqual(record.evict, ["b.test.ts", "c.test.ts"], "the failed one, and every file that did not run clean");
  assert.match(why, /1 passed and recorded; 0 passed but unhashable \(not recordable\); 2 evicted \(failed, or not run\)/);
  // b ran clean but has no hash: neither recorded nor evicted, and counted apart.
  const withB = shard({ outcome: "failure", junit: new Map([...junit, ["b.test.ts", { ran: 1, bad: 0 }]]), unattributed: null });
  assert.deepEqual(withB.record.evict, ["c.test.ts"]);
  assert.match(withB.why, /1 passed and recorded; 1 passed but unhashable \(not recordable\); 1 evicted/);
});

test("counterexample: red shard, a file --bail never reached has no JUnit row and is evicted, not recorded", () => {
  const junit = new Map([["c.test.ts", { ran: 1, bad: 1 }]]); // bail stopped after c
  const { record } = shard({ outcome: "failure", junit, unattributed: null });
  assert.deepEqual(record.tests, {});
  assert.deepEqual(record.evict, ["a.test.ts", "b.test.ts", "c.test.ts"]);
});

test("counterexample: red shard WITH an unattributed error records nothing and evicts its whole leg", () => {
  for (const unattributed of ["the lane log matches /Unhandled Errors/", "the lane log could not be read", "not checked"]) {
    const { record } = shard({ outcome: "failure", junit: RAN, unattributed });
    assert.equal(record.tests, undefined, unattributed);
    assert.deepEqual(record.evict, ["a.test.ts", "b.test.ts", "c.test.ts"], unattributed);
  }
  assert.equal(shard({ outcome: "failure", junit: null, unattributed: null }).record.tests, undefined, "no JUnit: nothing recorded either");
});

test("unattributedFailure: vitest's unhandled-error section and worker crashes, timeouts and OOMs count; a clean log does not", () => {
  for (const line of [
    "⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯",
    "Vitest caught 1 unhandled error during the test run.",
    "⎯⎯⎯ Unhandled Rejection ⎯⎯⎯",
    "Error: Worker exited unexpectedly",
    "[vitest-pool]: Timeout starting forks runner.",
    "Error [ERR_IPC_CHANNEL_CLOSED]: Channel closed",
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    "Command failed with signal SIGKILL",
  ]) assert.ok(unattributedFailure(`ok\n${line}\nmore`), line);
  assert.equal(unattributedFailure(" Test Files  1 failed | 3 passed (4)\n FAIL src/a.test.ts > adds\nAssertionError: expected 2 to be 3"), null);
  assert.match(unattributedFailure(null), /could not be read/);
});
