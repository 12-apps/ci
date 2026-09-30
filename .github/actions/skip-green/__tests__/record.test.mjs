// Only a GREEN lane records, and it records only what it can prove.
//
// The manifest is what the next push trusts to skip a test, so what goes into
// it is the whole safety argument: a failed or cancelled lane must write
// nothing; a test with no bounded hash must never gain an entry; a skipped
// test keeps the entry of the run that actually executed it; and entries for
// tests this run did not plan survive, because the manifest accumulates over
// the pull request.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { MANIFEST_VERSION } from "../lib/manifest.mjs";
import { nextManifest } from "../record.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "record.mjs");
const TMP = mkdtempSync(join(tmpdir(), "skip-green-record-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const H = (n) => n.toString(16).padStart(64, "0");
const OLD = "b".repeat(40);
const NEW = "c".repeat(40);
const PLAN = {
  lane: "unit",
  mode: "narrowed",
  tests: ["src/a.test.ts", "src/b.test.ts"],
  skipped: [{ test: "src/z.test.ts", greenAt: OLD, greenRun: "1" }],
  inputs: { "src/a.test.ts": H(1), "src/b.test.ts": null, "src/z.test.ts": H(26) },
};
const previous = { version: MANIFEST_VERSION, lane: "unit", entries: { "src/z.test.ts": { hash: H(26), sha: OLD, run: "1" }, "src/old.test.ts": { hash: H(7), sha: OLD, run: "1" } } };
const record = (over = {}) => nextManifest({ lane: "unit", plan: PLAN, previous, laneResult: "success", headSha: NEW, runId: "9", ...over });

test("a green lane records the tests it RAN, with the head and run that earned them", () => {
  const { manifest, added } = record();
  assert.deepEqual(manifest.entries["src/a.test.ts"], { hash: H(1), sha: NEW, run: "9" });
  assert.equal(added, 1);
});

test("a test with no hash never gains an entry", () => {
  const { manifest } = record();
  assert.equal(manifest.entries["src/b.test.ts"], undefined, "an unbounded closure is never a claim");
});

test("a skipped test keeps the entry of the run that executed it; unplanned entries survive", () => {
  const { manifest } = record();
  assert.deepEqual(manifest.entries["src/z.test.ts"], { hash: H(26), sha: OLD, run: "1" });
  assert.deepEqual(manifest.entries["src/old.test.ts"], { hash: H(7), sha: OLD, run: "1" }, "push 3 may skip what push 1 proved even if push 2 did not select it");
});

test("anything but `success` records NOTHING", () => {
  for (const result of ["failure", "cancelled", "skipped", "", undefined]) {
    const { manifest, why } = record({ laneResult: result });
    assert.equal(manifest, null, `lane result ${JSON.stringify(result)} must not write a manifest`);
    assert.match(why, /green lane/);
  }
});

test("a plan without inputs, or a head that is not a sha, records nothing", () => {
  const { inputs: _drop, ...noInputs } = PLAN;
  assert.equal(record({ plan: noInputs }).manifest, null);
  assert.equal(record({ headSha: "refs/pull/1/merge" }).manifest, null);
});

test("a refreshed entry with the same hash is not counted as added", () => {
  const same = { ...previous, entries: { ...previous.entries, "src/a.test.ts": { hash: H(1), sha: OLD, run: "1" } } };
  const { manifest, added } = record({ previous: same });
  assert.equal(added, 0);
  assert.equal(manifest.entries["src/a.test.ts"].sha, NEW, "…but it now names the latest run that passed it");
});

// ── the CLI ─────────────────────────────────────────────────────────────────

function cli(dir, args) {
  const outputs = join(dir, "outputs.txt");
  writeFileSync(outputs, "");
  const result = spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: outputs, GITHUB_RUN_ID: "9" } });
  const emitted = Object.fromEntries(readFileSync(outputs, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  return { code: result.status, stdout: result.stdout, emitted };
}

test("CLI: a green lane writes the manifest; a red one leaves the previous file untouched", () => {
  const dir = join(TMP, "cli");
  mkdirSync(join(dir, "m"), { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(PLAN));
  writeFileSync(join(dir, "m/unit.json"), JSON.stringify(previous));

  const red = cli(dir, ["--lane", "unit", "--plan", "plan.json", "--manifest", "m/unit.json", "--lane-result", "failure", "--head-sha", NEW]);
  assert.equal(red.code, 0);
  assert.equal(red.emitted.recorded, "false");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "m/unit.json"), "utf8")), previous, "a red lane changed nothing");

  const green = cli(dir, ["--lane", "unit", "--plan", "plan.json", "--manifest", "m/unit.json", "--lane-result", "success", "--head-sha", NEW]);
  assert.equal(green.code, 0);
  assert.equal(green.emitted.recorded, "true");
  assert.equal(green.emitted.entries, "3");
  const written = JSON.parse(readFileSync(join(dir, "m/unit.json"), "utf8"));
  assert.equal(written.entries["src/a.test.ts"].run, "9");
});

test("CLI: no manifest yet is fine — the first green run creates it", () => {
  const dir = join(TMP, "cli-first");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(PLAN));
  const { code, emitted } = cli(dir, ["--lane", "unit", "--plan", "plan.json", "--manifest", "m/unit.json", "--lane-result", "success", "--head-sha", NEW]);
  assert.equal(code, 0);
  assert.equal(emitted.recorded, "true");
  assert.equal(emitted.entries, "1");
});
