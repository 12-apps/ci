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
import { countTestCases, shardRecord } from "../shard.mjs";

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
const shard = (over = {}) =>
  shardRecord({ lane: "unit", plan: PLAN, leg: ["a.test.ts", "b.test.ts", "c.test.ts"], shard: "2", shardTotal: "3", outcome: "success", headSha: HEAD, runId: "77", reportsAsked: false, testCases: null, ...over });

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
  assert.ok(shard({ outcome: "failure", reportsAsked: true, testCases: 0 }).record, "an eviction needs no JUnit evidence");
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

test("with JUnit asked for, a shard that reported zero test cases proved nothing", () => {
  assert.equal(shard({ reportsAsked: true, testCases: 0 }).record, null);
  assert.equal(shard({ reportsAsked: true, testCases: null }).record, null, "no readable report is not evidence");
  assert.ok(shard({ reportsAsked: true, testCases: 5 }).record);
});

test("a plan that is not narrowed, carries no inputs, or a head that is not a sha records nothing", () => {
  assert.equal(shard({ plan: { ...PLAN, mode: "none" } }).record, null);
  const { inputs: _drop, ...noInputs } = PLAN;
  assert.equal(shard({ plan: noInputs }).record, null);
  assert.equal(shard({ headSha: "refs/pull/1/merge" }).record, null);
  assert.equal(shard({ runId: "" }).record, null);
});

test("countTestCases sums test cases across files and directories, and is null with no report", () => {
  const dir = join(TMP, "junit");
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(join(dir, "a.xml"), '<testsuites><testsuite><testcase name="x"/><testcase name="y"></testcase></testsuite></testsuites>');
  writeFileSync(join(dir, "nested/b.xml"), '<testsuite><testcase name="z"/></testsuite>');
  writeFileSync(join(dir, "notes.txt"), "<testcase/>");
  assert.equal(countTestCases([dir]), 3);
  assert.equal(countTestCases([join(TMP, "missing")]), null);
  writeFileSync(join(TMP, "empty.xml"), "<testsuites/>");
  assert.equal(countTestCases([join(TMP, "empty.xml")]), 0);
});

test("CLI: a green leg writes its passes; a red one writes an eviction", () => {
  const dir = join(TMP, "cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(PLAN));
  writeFileSync(join(dir, "leg.txt"), "a.test.ts\nc.test.ts\n");
  const run = (outcome, out) => {
    const outputs = join(dir, `outputs-${outcome}.txt`);
    writeFileSync(outputs, "");
    const r = spawnSync(
      "node",
      [CLI, "--lane", "unit", "--plan", "plan.json", "--leg", "leg.txt", "--shard", "1", "--shard-total", "2", "--outcome", outcome, "--head-sha", HEAD, "--run-id", "77", "--reports", "", "--out", out],
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
  assert.equal(green.emitted.tests, "2");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "green/unit-s1.json"), "utf8")).tests, { "a.test.ts": H(1), "c.test.ts": H(3) });
});
