// A lane that FAILED or was CANCELLED keeps what its green shards proved, and
// nothing else (FUT-4548). The counterexamples are the point: the red shard's
// failed test, and the tests that shared its shard, never enter the manifest;
// a record from another run, head, lane or inputs construction is refused; a
// record's hash must be the plan's own; and a green test whose inputs moved
// runs again on the next push.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { decide } from "../filter.mjs";
import { MANIFEST_VERSION, SHARD_RECORD_VERSION } from "../lib/manifest.mjs";
import { nextManifest } from "../record.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "record.mjs");
const TMP = mkdtempSync(join(tmpdir(), "skip-green-record-shards-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const H = (n) => n.toString(16).padStart(64, "0");
const OLD = "b".repeat(40);
const NEW = "c".repeat(40);

function cli(dir, args) {
  const outputs = join(dir, "outputs.txt");
  writeFileSync(outputs, "");
  const result = spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: outputs, GITHUB_RUN_ID: "9" } });
  const emitted = Object.fromEntries(readFileSync(outputs, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  return { code: result.status, stdout: result.stdout, emitted };
}


const SHARD_PLAN = {
  lane: "unit",
  mode: "narrowed",
  inputsVersion: "test-inputs-v2",
  tests: ["s1/a.test.ts", "s1/b.test.ts", "s2/failed.test.ts", "s2/beside.test.ts"],
  legs: [["s1/a.test.ts", "s1/b.test.ts"], ["s2/failed.test.ts", "s2/beside.test.ts"]],
  inputs: { "s1/a.test.ts": H(11), "s1/b.test.ts": H(12), "s2/failed.test.ts": H(21), "s2/beside.test.ts": H(22) },
};
// Shard 1 passed and wrote its record; shard 2 had a red test and wrote an eviction.
const shard1 = { version: SHARD_RECORD_VERSION, lane: "unit", inputs: "test-inputs-v2", sha: NEW, run: "9", shard: "1", passed: true, tests: { "s1/a.test.ts": H(11), "s1/b.test.ts": H(12) } };
const shard2 = { version: SHARD_RECORD_VERSION, lane: "unit", inputs: "test-inputs-v2", sha: NEW, run: "9", shard: "2", passed: false, evict: ["s2/failed.test.ts", "s2/beside.test.ts"] };
// Earlier heads proved every test green: the stale proofs eviction must drop.
const GREEN_BEFORE = {
  version: MANIFEST_VERSION,
  lane: "unit",
  entries: Object.fromEntries(SHARD_PLAN.tests.map((t) => [t, { hash: SHARD_PLAN.inputs[t], sha: OLD, run: "5" }])),
};
const partial = (over = {}) =>
  nextManifest({ lane: "unit", plan: SHARD_PLAN, previous: null, laneResult: "failure", headSha: NEW, runId: "9", shardRecords: [shard1], ...over });

test("a FAILED lane records its green shards' tests, and nothing of the red shard", () => {
  const { manifest, added } = partial();
  assert.deepEqual(Object.keys(manifest.entries).sort(), ["s1/a.test.ts", "s1/b.test.ts"]);
  assert.deepEqual(manifest.entries["s1/a.test.ts"], { hash: H(11), sha: NEW, run: "9" });
  assert.equal(manifest.entries["s2/failed.test.ts"], undefined, "the failed test is never recorded");
  assert.equal(manifest.entries["s2/beside.test.ts"], undefined, "nor anything that shared its shard");
  assert.equal(added, 2);
  assert.ok(partial({ laneResult: "cancelled" }).manifest, "a cancelled run keeps its green shards too");
});

test("shard records answer only for THIS run, head, lane and inputs construction", () => {
  for (const [label, record] of [
    ["another run", { ...shard1, run: "8" }],
    ["another head", { ...shard1, sha: OLD }],
    ["another lane", { ...shard1, lane: "integration" }],
    ["another inputs construction", { ...shard1, inputs: "test-inputs-v1" }],
    ["another record version", { ...shard1, version: "green-shard-v0" }],
  ]) {
    assert.equal(partial({ shardRecords: [record] }).manifest, null, `${label}: refused`);
  }
});

test("a record's hash must be the plan's, and its test one the plan handed the lane", () => {
  const forged = { ...shard1, tests: { "s1/a.test.ts": H(99), "s2/failed.test.ts": H(21), "elsewhere.test.ts": H(5) } };
  // Cancelled, so nothing is evicted for a silent shard and only the record speaks.
  const { manifest } = partial({ laneResult: "cancelled", shardRecords: [forged] });
  assert.equal(manifest.entries["s1/a.test.ts"], undefined, "a hash the plan does not carry is no claim about this plan");
  assert.deepEqual(manifest.entries["s2/failed.test.ts"], { hash: H(21), sha: NEW, run: "9" }, "(a record naming it means its shard passed it)");
  assert.equal(manifest.entries["elsewhere.test.ts"], undefined);
});

// ── eviction: a test red NOW loses the proof an earlier head gave it ──────────

test("counterexample: a test green at an earlier head and red now is EVICTED, with its whole leg", () => {
  const { manifest, evicted } = partial({ previous: GREEN_BEFORE, shardRecords: [shard1, shard2] });
  assert.equal(manifest.entries["s2/failed.test.ts"], undefined, "its stale green entry is gone");
  assert.equal(manifest.entries["s2/beside.test.ts"], undefined, "the red shard's whole list goes");
  assert.deepEqual(manifest.entries["s1/a.test.ts"], { hash: H(11), sha: NEW, run: "9" });
  assert.equal(evicted, 2);
  // …and the next push, with the failed test's inputs unchanged, RUNS it.
  const { plan } = decide({ plan: SHARD_PLAN, manifest, always: new Set(), policy: "enforce", maxShards: 4, perShard: 40 });
  assert.deepEqual(plan.tests, ["s2/failed.test.ts", "s2/beside.test.ts"]);
});

test("a FAILED lane evicts the leg of a shard that left no record at all (timed out, died, lost)", () => {
  const { manifest } = partial({ previous: GREEN_BEFORE, shardRecords: [shard1] });
  assert.equal(manifest.entries["s2/failed.test.ts"], undefined);
  assert.equal(manifest.entries["s2/beside.test.ts"], undefined);
  assert.ok(manifest.entries["s1/a.test.ts"]);
  // No legs in the plan: the silent shard's list is unknown, so every planned test goes.
  const { legs: _l, ...unsized } = SHARD_PLAN;
  const blind = partial({ plan: unsized, previous: GREEN_BEFORE, shardRecords: [], shardTotal: "2" }).manifest;
  assert.deepEqual(blind.entries, {});
  const noTotal = partial({ plan: unsized, previous: GREEN_BEFORE, shardRecords: [] }).manifest;
  assert.deepEqual(noTotal.entries, {}, "no shard count either: evict everything planned");
});

test("a CANCELLED lane evicts only what a red shard named — a shard the push cut off proved nothing either way", () => {
  const cut = partial({ laneResult: "cancelled", previous: GREEN_BEFORE, shardRecords: [shard1] }).manifest;
  assert.deepEqual(cut.entries["s2/failed.test.ts"], GREEN_BEFORE.entries["s2/failed.test.ts"], "kept: no evidence against it");
  const red = partial({ laneResult: "cancelled", previous: GREEN_BEFORE, shardRecords: [shard1, shard2] }).manifest;
  assert.equal(red.entries["s2/failed.test.ts"], undefined);
});

test("eviction wins over a green claim, and `*` evicts every planned test", () => {
  const both = { ...shard1, tests: { ...shard1.tests, "s2/failed.test.ts": H(21) } };
  assert.equal(partial({ shardRecords: [both, shard2] }).manifest.entries["s2/failed.test.ts"], undefined);
  const all = partial({ previous: GREEN_BEFORE, shardRecords: [{ ...shard2, evict: "*" }] }).manifest;
  assert.deepEqual(all.entries, {});
});

test("an eviction from another run or head is refused like any record", () => {
  const { manifest } = partial({ laneResult: "cancelled", previous: GREEN_BEFORE, shardRecords: [shard1, { ...shard2, run: "8" }] });
  assert.ok(manifest.entries["s2/failed.test.ts"], "another run's eviction is not this run's evidence");
});

test("no shard records, or a lane result other than failure/cancelled, still records nothing", () => {
  assert.equal(partial({ laneResult: "cancelled", shardRecords: [] }).manifest, null);
  assert.equal(partial({ shardRecords: null }).manifest, null);
  assert.equal(partial({ laneResult: "skipped" }).manifest, null);
  assert.equal(partial({ laneResult: "" }).manifest, null);
});

test("previous entries outside the evicted legs survive a partial merge", () => {
  const prev = { version: MANIFEST_VERSION, lane: "unit", entries: { "old.test.ts": { hash: H(7), sha: OLD, run: "1" } } };
  assert.deepEqual(partial({ previous: prev }).manifest.entries["old.test.ts"], { hash: H(7), sha: OLD, run: "1" });
});

test("end to end: push 2 skips the green shard's tests, runs the failed one, and re-runs a green one whose inputs moved", () => {
  const { manifest } = partial();
  const push2 = { ...SHARD_PLAN, inputs: { ...SHARD_PLAN.inputs, "s1/b.test.ts": H(120) } };
  const { plan, skipped } = decide({ plan: push2, manifest, always: new Set(), policy: "enforce", maxShards: 4, perShard: 40 });
  assert.deepEqual(skipped.map((s) => s.test), ["s1/a.test.ts"]);
  assert.deepEqual(plan.tests, ["s1/b.test.ts", "s2/failed.test.ts", "s2/beside.test.ts"], "the failed test runs; so does a green test whose own inputs changed");
});

test("CLI: a failed lane with --shard-records merges the green shards", () => {
  const dir = join(TMP, "cli-shards");
  mkdirSync(join(dir, "shards/skip-green-unit-a1-s1"), { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(SHARD_PLAN));
  writeFileSync(join(dir, "shards/skip-green-unit-a1-s1/unit-s1.json"), JSON.stringify(shard1));
  writeFileSync(join(dir, "shards/garbage.json"), "{");
  const { code, emitted, stdout } = cli(dir, ["--lane", "unit", "--plan", "plan.json", "--manifest", "m/unit.json", "--lane-result", "failure", "--head-sha", NEW, "--shard-records", "shards"]);
  assert.equal(code, 0);
  assert.equal(emitted.recorded, "true", stdout);
  assert.equal(emitted.entries, "2");
  assert.match(stdout, /1 shard record\(s\), 1 unusable file\(s\) dropped/);
  const without = cli(join(TMP, "cli-shards"), ["--lane", "unit", "--plan", "plan.json", "--manifest", "m2/unit.json", "--lane-result", "failure", "--head-sha", NEW, "--shard-records", ""]);
  assert.equal(without.emitted.recorded, "false", "a failed lane with no shard records records nothing");
});
