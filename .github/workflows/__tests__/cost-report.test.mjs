import { strict as assert } from "node:assert";
import { test } from "node:test";
import { defaultRates, job, report, run } from "./cost-report-harness.mjs";

// The cost report's script runs inline in cost-report.yml (actions/github-script),
// so the tests lift that exact script out of the YAML and run it against a fake
// GitHub. What is tested is what ships.
//
// The reason for the tests: with the jobs moved onto the self-hosted fleet, the
// comment read "76.0 billed min · $0.00" on a PR whose runs cost real AWS money.
// Self-hosted time was priced at zero, rounded per job like GitHub's bill, and
// dropped entirely from any run where the billing endpoint answered for the
// GitHub-hosted jobs.

const selfRate = JSON.parse(defaultRates).self_hosted;

test("the default rates price the self-hosted fleet, never at zero", () => {
  assert.equal(typeof selfRate, "number");
  assert.ok(selfRate > 0);
});

test("self-hosted time is billed per second, not rounded per job", async () => {
  // 30 s + 90 s + 10 s: GitHub would bill 1 + 2 + 1 = 4 minutes; EC2 bills 130 s.
  const { cost, billed, body } = await report({
    runs: [run(2)], jobs: { 2: [job(1, 30), job(2, 90), job(3, 10)] },
  });
  assert.equal(billed, Number((130 / 60).toFixed(1)));
  assert.equal(cost, Number(((130 / 60) * selfRate).toFixed(2)));
  assert.match(body, /\| SELF_HOSTED \| 2\.2 \| 2\.2 \|/);
});

test("the comment states what the same jobs would have cost on GitHub-hosted runners", async () => {
  const { body } = await report({
    runs: [run(2)], jobs: { 2: Array.from({ length: 30 }, (_, i) => job(i, 150)) },
  });
  // 30 jobs of 2.5 min: 90 billed minutes at the linux rate.
  const linux = JSON.parse(defaultRates).linux;
  assert.match(body, /the 30 self-hosted jobs would have billed \*\*90\.0 min\*\*/);
  assert.ok(body.includes(`**$${(90 * linux).toFixed(2)}**`), body);
  assert.match(body, /less\*\* \(\d+%\)/);
});

test("self-hosted jobs survive a run whose billing endpoint answers for the hosted ones", async () => {
  const { body } = await report({
    runs: [run(2)],
    jobs: { 2: [job(1, 120), job(2, 60, { selfHosted: false, labels: ["ubuntu-latest"] })] },
    usage: { 2: { billable: { UBUNTU: { total_ms: 60000, job_runs: [{ job_id: 2, duration_ms: 60000 }] } } } },
  });
  assert.match(body, /\| SELF_HOSTED \| 2\.0 \|/);
  assert.match(body, /\| UBUNTU \| 1\.0 \|/);
});

test("a caller that prices only GitHub runners sees self-hosted as unpriced, not free", async () => {
  const { body } = await report({
    runs: [run(2)], jobs: { 2: [job(1, 60)] }, rates: '{"linux":0.006}',
  });
  assert.match(body, /\| SELF_HOSTED \| 1\.0 \| 1\.0 \| — _\(no rate configured\)_ \|/);
  assert.match(body, /No rate configured for \*\*SELF_HOSTED\*\*/);
});

test("a re-run's earlier attempt is counted too: it was billed", async () => {
  // Attempt 1 lost its host after 4 minutes; attempt 2 ran the job for 3.
  const { billed } = await report({
    runs: [run(2)], jobs: { 2: [{ ...job(1, 240), run_attempt: 1, conclusion: "failure" }, { ...job(2, 180), run_attempt: 2 }] },
  });
  assert.equal(billed, 7);
});

test("a job cancelled before it got a runner bills nothing", async () => {
  // GitHub gives it start and end times 0 s apart, and no runner at all.
  const queuedThenCancelled = { ...job(2, 0), conclusion: "cancelled", runner_name: null, runner_group_name: null };
  const { billed, body } = await report({ runs: [run(2)], jobs: { 2: [job(1, 60), queuedThenCancelled] } });
  assert.equal(billed, 1);
  assert.doesNotMatch(body, /FUTURE-PAY-CI/);
});

test("an earlier PR's runs on the same branch are not billed to this one", async () => {
  // Renovate reopens every grouped bump on one branch name. Once an earlier PR
  // closes its runs lose `pull_requests`, so only the branch ties them here, and
  // the newest PR was billed every PR the branch ever held (US$ 14.70 on a PR
  // whose own runs cost US$ 0.47).
  const opened = "2026-09-24T12:00:00Z";
  const earlier = { ...run(2), pull_requests: [], created_at: "2026-09-20T09:00:00Z" };
  const unlinked = { ...run(3), pull_requests: [], created_at: "2026-09-24T12:30:00Z" };
  const linked = { ...run(4), created_at: "2026-09-24T13:00:00Z" };
  const jobs = { 2: [job(1, 600)], 3: [job(2, 60)], 4: [job(3, 60)] };
  const bounded = await report({ runs: [earlier, unlinked, linked], jobs, openedAt: opened });
  const unbounded = await report({ runs: [earlier, unlinked, linked], jobs });
  assert.ok(bounded.cost < unbounded.cost, "the earlier PR's run must drop out once the PR's open time is known");
  assert.equal(Math.round(bounded.cost * 1e6), Math.round((await report({ runs: [unlinked, linked], jobs, openedAt: opened })).cost * 1e6),
    "exactly the earlier PR's run is excluded; this PR's unlinked and linked runs stay");
});
