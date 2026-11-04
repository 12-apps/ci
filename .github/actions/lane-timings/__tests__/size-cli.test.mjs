import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SIZE = join(dirname(fileURLToPath(import.meta.url)), "..", "size.mjs");

function run(plan, ledger, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), "lane-timings-size-"));
  const planPath = join(dir, "plan.json");
  const ledgerPath = join(dir, "ledger.json");
  const out = join(dir, "out");
  writeFileSync(planPath, JSON.stringify(plan));
  if (ledger) writeFileSync(ledgerPath, JSON.stringify(ledger));
  writeFileSync(out, "");
  const log = execFileSync("node", [SIZE, "--lane", "t", "--plan", planPath, "--ledger", ledgerPath, ...extra], {
    env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: "" },
    encoding: "utf8",
  });
  const outputs = Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  return { plan: JSON.parse(readFileSync(planPath, "utf8")), outputs, log };
}

test("an affected-plan document gains legs and its counts follow the matrix", () => {
  const files = { a: 500, b: 500, c: 400, d: 100 };
  const { plan, outputs } = run(
    { mode: "narrowed", tests: ["a", "b", "c", "d"], counts: { selected: 4, shardTotal: 1 } },
    { concurrency: 1, files },
    ["--max-shards", "8"],
  );
  assert.equal(outputs["shard-total"], "3"); // 1500 s / 600 s
  assert.equal(outputs.shards, "[1,2,3]");
  assert.equal(outputs.sized, "true");
  assert.equal(plan.counts.shardTotal, 3);
  assert.equal(plan.legs.length, 3);
  assert.deepEqual(plan.legs.flat().sort(), ["a", "b", "c", "d"]);
  assert.equal(plan.timings.estimateSeconds, 1500);
});

test("a Gherkin-shaped plan keeps its own shardTotal and shards in step", () => {
  const { plan, outputs } = run(
    { any: true, features: ["x.feature", "y.feature"], shardTotal: 1, shards: [1], legs: [["x.feature", "y.feature"]] },
    { files: { "x.feature": 700, "y.feature": 700 } },
    ["--items-key", "features", "--max-shards", "6", "--empty-shards", "1"],
  );
  assert.equal(plan.shardTotal, 2);
  assert.deepEqual(plan.shards, [1, 2]);
  assert.deepEqual(plan.legs, [["x.feature"], ["y.feature"]]);
  assert.equal(outputs.binding, "false");
});

test("a full plan is left untouched", () => {
  const original = { mode: "full", tests: [], counts: { shardTotal: 4 } };
  const { plan, outputs } = run(original, { files: {} });
  assert.deepEqual(plan, original);
  assert.equal(outputs.sized, "false");
});

test("no ledger at all is an even split by count, never a failure", () => {
  const { plan, outputs } = run({ mode: "narrowed", tests: Array.from({ length: 30 }, (_, i) => `t${i}`), counts: {} }, null, ["--max-shards", "4"]);
  // 30 items at the 30 s default = 900 s → 2 legs of 15 items.
  assert.equal(outputs["shard-total"], "2");
  assert.deepEqual(plan.legs.map((l) => l.length), [15, 15]);
});

test("a binding cap is a warning in the log and an output", () => {
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, 600]));
  const { outputs, log } = run({ mode: "narrowed", tests: Object.keys(files), counts: {} }, { files }, ["--max-shards", "4"]);
  assert.equal(outputs["shard-total"], "4");
  assert.equal(outputs.binding, "true");
  assert.match(log, /::warning title=shard cap binds \(t\)::this selection wants 10 leg\(s\)/);
});
