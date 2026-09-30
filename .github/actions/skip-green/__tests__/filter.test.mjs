// The filter may only ever SKIP LESS than the manifest allows.
//
// Every uncertainty runs the test: no manifest, a corrupt one, a plan without
// hashes, a test without a hash, a test on the always-run list, an always-run
// list that cannot be read, a plan that is not `narrowed`. And `shadow` filters
// nothing at all — it only says what it would have done. The enforcing path is
// pinned too: a skipped test is removed, the rest keep their order, an empty
// remainder is `none` with an empty matrix, and the skip line names the run
// that earned it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { decide } from "../filter.mjs";
import { MANIFEST_VERSION, readAlwaysRun, readManifest, shardTotalFor } from "../lib/manifest.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "filter.mjs");
const TMP = mkdtempSync(join(tmpdir(), "skip-green-filter-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const H = (n) => n.toString(16).padStart(64, "0");
const SHA = "a".repeat(40);
const PLAN = {
  lane: "unit",
  mode: "narrowed",
  why: "3 test file(s) reach a changed symbol",
  counts: { selected: 3, shardTotal: 1 },
  tests: ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts"],
  inputs: { "src/a.test.ts": H(1), "src/b.test.ts": H(2), "src/c.test.ts": H(3) },
};
const manifest = (entries) => ({ version: MANIFEST_VERSION, lane: "unit", entries });
const run = (over = {}) =>
  decide({ plan: PLAN, manifest: manifest({}), always: new Set(), policy: "enforce", maxShards: 4, perShard: 40, ...over });

test("enforce: a test whose hash matches a recorded green entry is skipped, the rest run in order", () => {
  const { plan, skipped, kept } = run({ manifest: manifest({ "src/b.test.ts": { hash: H(2), sha: SHA, run: "77" } }) });
  assert.deepEqual(kept, ["src/a.test.ts", "src/c.test.ts"]);
  assert.deepEqual(skipped, [{ test: "src/b.test.ts", greenAt: SHA, greenRun: "77" }]);
  assert.equal(plan.mode, "narrowed");
  assert.deepEqual(plan.tests, kept);
  assert.equal(plan.counts.skipped, 1);
  assert.equal(plan.counts.planned, 3);
});

test("a recorded entry with a DIFFERENT hash runs the test", () => {
  const { kept, skipped } = run({ manifest: manifest({ "src/b.test.ts": { hash: H(99), sha: SHA, run: "77" } }) });
  assert.deepEqual(kept, PLAN.tests);
  assert.equal(skipped.length, 0);
});

test("everything skipped is mode `none` and an EMPTY matrix", () => {
  const all = Object.fromEntries(PLAN.tests.map((t) => [t, { hash: PLAN.inputs[t], sha: SHA, run: "5" }]));
  const { plan } = run({ manifest: manifest(all) });
  assert.equal(plan.mode, "none");
  assert.deepEqual(plan.tests, []);
  assert.equal(plan.counts.shardTotal, 0, "no shard boots to discover it has nothing to do");
  assert.equal(plan.skipped.length, 3);
});

test("shadow: nothing is removed, the plan only records what would have been", () => {
  const all = Object.fromEntries(PLAN.tests.map((t) => [t, { hash: PLAN.inputs[t], sha: SHA, run: "5" }]));
  const { plan, skipped, kept } = run({ manifest: manifest(all), policy: "shadow" });
  assert.deepEqual(kept, PLAN.tests);
  assert.deepEqual(skipped, []);
  assert.deepEqual(plan.tests, PLAN.tests);
  assert.equal(plan.mode, "narrowed");
  assert.equal(plan.wouldSkip.length, 3);
});

test("a test with no hash is never skipped, whatever the manifest says", () => {
  const withNull = { ...PLAN, inputs: { ...PLAN.inputs, "src/b.test.ts": null } };
  const { kept } = run({ plan: withNull, manifest: manifest({ "src/b.test.ts": { hash: H(2), sha: SHA, run: "1" } }) });
  assert.ok(kept.includes("src/b.test.ts"), "an unbounded closure has no claim to reuse");
});

test("a test on the always-run list runs even when its hash matches", () => {
  const { kept, skipped } = run({
    manifest: manifest({ "src/b.test.ts": { hash: H(2), sha: SHA, run: "1" } }),
    always: new Set(["src/b.test.ts"]),
  });
  assert.ok(kept.includes("src/b.test.ts"));
  assert.equal(skipped.length, 0);
});

test("no manifest, a plan without inputs, or a plan that is not narrowed: passthrough", () => {
  assert.deepEqual(run({ manifest: null }).kept, PLAN.tests);
  const { inputs: _drop, ...noInputs } = PLAN;
  assert.deepEqual(run({ plan: noInputs }).kept, PLAN.tests);
  assert.deepEqual(run({ plan: { ...PLAN, mode: "full" } }).kept, PLAN.tests);
});

// ── the manifest reader is the second line of defence ───────────────────────

function write(rel, body) {
  const path = join(TMP, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

test("readManifest refuses another lane's file, a wrong version and malformed entries", () => {
  const other = write("other.json", JSON.stringify(manifest({ "src/a.test.ts": { hash: H(1), sha: SHA, run: "1" } })));
  assert.equal(readManifest(other, "integration").manifest, null, "a unit manifest must not answer for integration");
  const stale = write("stale.json", JSON.stringify({ ...manifest({}), version: "green-manifest-v0" }));
  assert.equal(readManifest(stale, "unit").manifest, null);
  const mixed = write(
    "mixed.json",
    JSON.stringify(manifest({ "src/a.test.ts": { hash: "nope", sha: SHA, run: "1" }, "src/b.test.ts": { hash: H(2), sha: SHA, run: "2" } })),
  );
  assert.deepEqual(Object.keys(readManifest(mixed, "unit").manifest.entries), ["src/b.test.ts"], "a bad line costs its own test, never the lane");
  assert.equal(readManifest(write("garbage.json", "{not json"), "unit").manifest, null);
  assert.equal(readManifest(join(TMP, "absent.json"), "unit").manifest, null);
});

test("readAlwaysRun accepts an array or {tests}, and reports an unreadable list as an error", () => {
  assert.deepEqual([...readAlwaysRun(write("a1.json", '["x.test.ts"]')).always], ["x.test.ts"]);
  assert.deepEqual([...readAlwaysRun(write("a2.json", '{"tests":["y.test.ts"]}')).always], ["y.test.ts"]);
  assert.ok(readAlwaysRun(write("a3.json", '{"nope":1}')).error);
  assert.ok(readAlwaysRun(join(TMP, "absent-always.json")).error);
  assert.equal(readAlwaysRun("").error, null, "no list given is not an error");
});

test("shardTotalFor sizes a filtered list by the plan's own rule", () => {
  assert.equal(shardTotalFor(0, 4, 40), 0);
  assert.equal(shardTotalFor(1, 4, 40), 1);
  assert.equal(shardTotalFor(81, 4, 40), 3);
  assert.equal(shardTotalFor(1000, 4, 40), 4);
});

// ── the CLI, end to end ─────────────────────────────────────────────────────

function cli(dir, args) {
  const outputs = join(dir, "outputs.txt");
  writeFileSync(outputs, "");
  const result = spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: "" } });
  const emitted = Object.fromEntries(readFileSync(outputs, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, emitted };
}

test("CLI enforce: rewrites the plan in place, prints the skip line naming the green run, emits the outputs", () => {
  const dir = join(TMP, "cli-enforce");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(PLAN));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest({ "src/a.test.ts": { hash: H(1), sha: SHA, run: "4242" } })));
  const { code, stdout, emitted } = cli(dir, ["--lane", "unit", "--plan", "plan.json", "--manifest", "manifest.json", "--policy", "enforce"]);
  assert.equal(code, 0);
  assert.match(stdout, /skipped: src\/a\.test\.ts — green at aaaaaaaaaaaa \(run 4242\) with identical inputs/);
  const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
  assert.deepEqual(plan.tests, ["src/b.test.ts", "src/c.test.ts"]);
  assert.equal(emitted.count, "2");
  assert.equal(emitted.skipped, "1");
  assert.equal(emitted.filtered, "true");
  assert.equal(emitted["shard-total"], "1");
});

test("CLI shadow: the plan file is untouched and the outputs describe the unfiltered plan", () => {
  const dir = join(TMP, "cli-shadow");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(PLAN));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest({ "src/a.test.ts": { hash: H(1), sha: SHA, run: "1" } })));
  const { code, stdout, emitted } = cli(dir, ["--lane", "unit", "--plan", "plan.json", "--manifest", "manifest.json", "--policy", "shadow"]);
  assert.equal(code, 0);
  assert.match(stdout, /would skip: src\/a\.test\.ts/);
  const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
  assert.deepEqual(plan.tests, PLAN.tests, "shadow never removes a test");
  assert.equal(plan.wouldSkip.length, 1);
  assert.equal(emitted.count, "3");
  assert.equal(emitted["would-skip"], "1");
  assert.equal(emitted.filtered, "false");
});

test("CLI: an unreadable always-run list skips nothing", () => {
  const dir = join(TMP, "cli-always");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(PLAN));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest({ "src/a.test.ts": { hash: H(1), sha: SHA, run: "1" } })));
  const { code, stdout, emitted } = cli(dir, ["--lane", "unit", "--plan", "plan.json", "--manifest", "manifest.json", "--policy", "enforce", "--always-run", "missing.json"]);
  assert.equal(code, 0);
  assert.match(stdout, /always-run list unreadable — skipping nothing/);
  assert.equal(emitted.count, "3");
});

test("CLI: an unreadable plan exits non-zero so the workflow runs the plan unfiltered", () => {
  const dir = join(TMP, "cli-noplan");
  mkdirSync(dir, { recursive: true });
  const { code } = cli(dir, ["--lane", "unit", "--plan", "absent.json", "--manifest", "m.json"]);
  assert.notEqual(code, 0);
});
