import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The cost report's script runs inline in cost-report.yml (actions/github-script),
// so the tests lift that exact script out of the YAML and run it against a fake
// GitHub. What is tested is what ships.
//
// The reason for the tests: with the jobs moved onto the self-hosted fleet, the
// comment read "76.0 billed min · $0.00" on a PR whose runs cost real AWS money.
// Self-hosted time was priced at zero, rounded per job like GitHub's bill, and
// dropped entirely from any run where the billing endpoint answered for the
// GitHub-hosted jobs.

const here = path.dirname(fileURLToPath(import.meta.url));
const yaml = readFileSync(path.join(here, "..", "cost-report.yml"), "utf8");

function extractScript() {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^\s+script: \|\s*$/.test(l));
  assert.ok(start > 0, "cost-report.yml has a `script: |` block");
  const indent = lines[start + 1].match(/^\s*/)[0].length;
  const body = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() && l.match(/^\s*/)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join("\n");
}
const script = extractScript();
const defaultRates = yaml.match(/runner-rates:[\s\S]*?default: '([^']+)'/)[1];
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const at = (s) => new Date(Date.UTC(2026, 8, 24, 12, 0, s)).toISOString();
const job = (id, seconds, { selfHosted = true, labels = ["future-pay-ci"] } = {}) => ({
  id, conclusion: "success", started_at: at(0), completed_at: at(seconds), labels,
  runner_group_name: selfHosted ? "Default" : "GitHub Actions", runner_name: `runner-${id}`,
});

async function report({ runs, jobs, usage = {}, rates = defaultRates }) {
  const posted = [];
  const outputs = {};
  const listJobsForWorkflowRun = async () => {};
  const listComments = async () => {};
  const github = {
    // Like the API: `latest` returns only the last attempt's jobs, `all` every attempt's.
    paginate: async (fn, params) => {
      if (fn !== listJobsForWorkflowRun) return [];
      const all = jobs[params.run_id] ?? [];
      const last = Math.max(0, ...all.map((j) => j.run_attempt ?? 1));
      return params.filter === "all" ? all : all.filter((j) => (j.run_attempt ?? 1) === last);
    },
    rest: {
      actions: {
        listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: runs } }),
        // The run posting the comment is still in progress and has no finished job.
        getWorkflowRun: async ({ run_id }) => ({ data: runs.find((r) => r.id === run_id) ?? run(run_id, "in_progress") }),
        getWorkflowRunUsage: async ({ run_id }) => ({ data: usage[run_id] ?? { billable: {} } }),
        listJobsForWorkflowRun,
      },
      issues: {
        listComments,
        createComment: async ({ body }) => {
          posted.push(body);
          return { data: { id: 1 } };
        },
        updateComment: async () => {},
      },
    },
  };
  const summary = { addHeading: () => summary, addRaw: () => summary, write: async () => {} };
  const core = {
    notice() {}, warning() {}, info() {}, summary,
    setFailed: (m) => { throw new Error(m); },
    setOutput: (k, v) => { outputs[k] = v; },
  };
  const context = {
    repo: { owner: "o", repo: "r" }, runId: 1, eventName: "pull_request",
    payload: { pull_request: { number: 7, head: { ref: "b" } }, repository: { private: true } },
  };
  const env = { RUNNER_RATES: rates, COMMENT_MARKER: "<!-- m -->", REPORT_TITLE: "CI cost estimate", MAX_RUN_PAGES: "5" };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    await new AsyncFunction("github", "context", "core", script)(github, context, core);
  } finally {
    for (const k of Object.keys(env)) {
      if (k in saved) process.env[k] = saved[k];
      else delete process.env[k];
    }
  }
  return { body: posted[0], cost: Number(outputs.cost), billed: Number(outputs["billed-minutes"]) };
}

const run = (id, status = "completed") => ({
  id, status, name: "CI", run_number: id, html_url: `https://x/${id}`, event: "pull_request",
  pull_requests: [{ number: 7 }], head_branch: "b",
});
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
