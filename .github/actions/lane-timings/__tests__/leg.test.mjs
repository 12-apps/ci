import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { legOf } from "../leg.mjs";

const LEG = join(dirname(fileURLToPath(import.meta.url)), "..", "leg.mjs");
const plan = { mode: "narrowed", tests: ["a", "b", "c"], counts: { shardTotal: 2 }, legs: [["b"], ["a", "c"]] };

test("a leg gets exactly the list the plan dealt it", () => {
  assert.deepEqual(legOf(plan, 1), { items: ["b"], total: 2 });
  assert.deepEqual(legOf(plan, 2), { items: ["a", "c"], total: 2 });
  // A Gherkin-shaped plan: its own key, its own top-level shardTotal.
  assert.deepEqual(legOf({ features: ["x"], shardTotal: 1, legs: [["x"]] }, 1, "features"), { items: ["x"], total: 1 });
  // An empty selection still has its one (empty) leg.
  assert.deepEqual(legOf({ features: [], shardTotal: 1, legs: [[]] }, 1, "features"), { items: [], total: 1 });
});

test("every plan a leg cannot trust is refused, never guessed at", () => {
  const cases = {
    "no legs": { ...plan, legs: undefined },
    "legs of the wrong shape": { ...plan, legs: [["a"], [7]] },
    "sized for another count": { ...plan, counts: { shardTotal: 3 } },
    "an item dealt twice": { ...plan, legs: [["a", "b"], ["b", "c"]] },
    "an item undealt": { ...plan, legs: [["a"], ["b"]] },
    "an item not in the list": { ...plan, legs: [["a", "b"], ["c", "z"]] },
    "no list to check against": { legs: [["a"]] },
  };
  for (const [why, p] of Object.entries(cases)) assert.ok("error" in legOf(p, 1), why);
  assert.ok("error" in legOf(plan, 0), "leg 0");
  assert.ok("error" in legOf(plan, 3), "leg past the last");
});

test("the CLI writes the list and its outputs, and fails loudly on a bad plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "lane-timings-leg-"));
  const good = join(dir, "plan.json");
  const bad = join(dir, "bad.json");
  const out = join(dir, "leg.txt");
  const gh = join(dir, "out");
  writeFileSync(good, JSON.stringify(plan));
  writeFileSync(bad, JSON.stringify({ ...plan, legs: [["a"], ["b"]] }));
  writeFileSync(gh, "");
  const ok = spawnSync("node", [LEG, "--plan", good, "--leg", "2", "--out", out, "--lane", "t"], {
    env: { ...process.env, GITHUB_OUTPUT: gh },
    encoding: "utf8",
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readFileSync(out, "utf8"), "a\nc\n");
  assert.match(readFileSync(gh, "utf8"), /count=2\ntotal=2/);
  assert.match(ok.stdout, /leg 2\/2 runs 2 item\(s\), packed by measured time/);
  const no = spawnSync("node", [LEG, "--plan", bad, "--leg", "1", "--out", out, "--lane", "t"], { encoding: "utf8" });
  assert.equal(no.status, 1);
  assert.match(no.stderr, /::error title=lane-timings \(t\)::leg 1: the legs do not cover the plan's list exactly/);
});

test("--when-sized lets an unsized plan through with no list, and still refuses bad legs", () => {
  const dir = mkdtempSync(join(tmpdir(), "lane-timings-leg-"));
  const unsized = join(dir, "unsized.json");
  const bad = join(dir, "bad.json");
  const gh = join(dir, "out");
  writeFileSync(unsized, JSON.stringify({ mode: "none", tests: [] }));
  writeFileSync(bad, JSON.stringify({ ...plan, timings: {}, legs: [["a"], ["b"]] }));
  writeFileSync(gh, "");
  const run = (file, extra) =>
    spawnSync("node", [LEG, "--plan", file, "--leg", "1", "--out", join(dir, "leg.txt"), ...extra], {
      env: { ...process.env, GITHUB_OUTPUT: gh },
      encoding: "utf8",
    });
  const skipped = run(unsized, ["--when-sized"]);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(readFileSync(gh, "utf8"), /^file=\n/);
  assert.equal(run(unsized, []).status, 1, "without the flag an unsized plan is a failure");
  assert.equal(run(bad, ["--when-sized"]).status, 1, "a sized plan with bad legs fails either way");
});
