import { strict as assert } from "node:assert";
import { test } from "node:test";
import { job, report, run } from "./cost-report-harness.mjs";

// The optional per-lane table (`lane-rules`). A lane is what a team reads its
// CI bill by, so the table must use the same grouping as the daily report
// (fleet-cost.mjs › costGroup: `<workflow> / <job>`, every number folded), must not
// appear for a caller that did not ask for it, and must refuse rules it cannot
// read rather than file every job under `other`.

const named = (id, seconds, name, opts) => ({ ...job(id, seconds, opts), name });
const rules = JSON.stringify([
  { lane: "unit", match: "^CI / Unit Tests · shard #/#$" },
  { lane: "e2e", match: "e2e" },
]);

test("no lane-rules, no lane table: the comment is what it was", async () => {
  const { body } = await report({ runs: [run(2)], jobs: { 2: [named(1, 60, "Unit Tests · shard 1/4")] } });
  assert.doesNotMatch(body, /Per lane/);
});

test("lanes fold matrix legs, price each job at its runner's rate, and file the rest under other", async () => {
  const { body } = await report({
    laneRules: rules,
    rates: '{"linux":0.01,"self_hosted":0.002}',
    runs: [run(2)],
    jobs: {
      2: [
        named(1, 120, "Unit Tests · shard 1/4"),
        named(2, 60, "Unit Tests · shard 2/4"),
        named(3, 30, "SPA E2E (client)", { selfHosted: false, labels: ["ubuntu-latest"] }),
        named(4, 60, "Lint"),
      ],
    },
  });
  assert.match(body, /<summary>Per lane<\/summary>/);
  // unit: 3 self-hosted minutes, per second, at $0.002.
  assert.match(body, /\| unit \| 2 \| 3\.0 \| \$0\.01 \|/);
  // e2e: 30 s on a GitHub runner bills a whole minute at $0.01.
  assert.match(body, /\| e2e \| 1 \| 0\.5 \| \$0\.01 \|/);
  assert.match(body, /\| other \| 1 \| 1\.0 \| \$0\.00 \|/);
});

test("lanes count every attempt, like the totals", async () => {
  const { body } = await report({
    laneRules: rules,
    runs: [run(2)],
    jobs: { 2: [{ ...named(1, 240, "Unit Tests · shard 1/4"), run_attempt: 1, conclusion: "failure" }, { ...named(2, 180, "Unit Tests · shard 1/4"), run_attempt: 2 }] },
  });
  assert.match(body, /\| unit \| 2 \| 7\.0 \|/);
});

test("rules that do not parse fail the job instead of posting a wrong table", async () => {
  for (const bad of ["{", '{"lane":"x"}', '[{"lane":"x"}]', '[{"lane":"x","match":"("}]']) {
    await assert.rejects(
      report({ laneRules: bad, runs: [run(2)], jobs: { 2: [named(1, 60, "Lint")] } }),
      /lane-rules is not a valid rule list/,
      bad,
    );
  }
});

test("the comment groups a job exactly as fleet-cost.mjs does, so one rule means one lane in both", async () => {
  const { costGroup } = await import("../../../scripts/runner-host/fleet-cost.mjs");
  const names = ["Tests / Unit Tests · shard 3/4", "SPA E2E (3)", "Gherkin Journeys · shard 1/2", "Lint", `Smoke @ ${"a1".repeat(20)}`];
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exact = JSON.stringify(names.map((n, i) => ({ lane: `l${i}`, match: `^${escape(costGroup("CI", n))}$` })));
  const { body } = await report({ laneRules: exact, runs: [run(2)], jobs: { 2: names.map((n, i) => named(i + 1, 60, n)) } });
  for (let i = 0; i < names.length; i++) assert.match(body, new RegExp(`\\| l${i} \\| 1 \\|`), names[i]);
  assert.doesNotMatch(body, /\| other \|/);
});

test("a lane with a runner that has no rate says so instead of reading as free", async () => {
  const { body } = await report({
    laneRules: rules, rates: '{"linux":0.006}', runs: [run(2)], jobs: { 2: [named(1, 60, "Unit Tests · shard 1/4")] },
  });
  assert.match(body, /\| unit \| 1 \| 1\.0 \| \$0\.00 \+ unpriced \|/);
});

test("the lane table says where its numbers come from", async () => {
  const { body } = await report({ laneRules: rules, runs: [run(2)], jobs: { 2: [named(1, 60, "Lint")] } });
  assert.match(body, /Lanes are priced from each job's start and end times/);
});

test("an event with no pull request skips quietly, whatever the lane rules say", async () => {
  const { body } = await report({ laneRules: "{", pullRequest: false, runs: [run(2)], jobs: { 2: [named(1, 60, "Lint")] } });
  assert.equal(body, undefined, "nothing posted, nothing failed");
});
