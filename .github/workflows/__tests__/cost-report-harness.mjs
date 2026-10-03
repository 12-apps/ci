import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The cost report's script runs inline in cost-report.yml (actions/github-script),
// so the tests lift that exact script out of the YAML and run it against a fake
// GitHub. What is tested is what ships. Shared by every cost-report test file.

const here = path.dirname(fileURLToPath(import.meta.url));
export const yaml = readFileSync(path.join(here, "..", "cost-report.yml"), "utf8");

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
export const defaultRates = yaml.match(/runner-rates:[\s\S]*?default: '([^']+)'/)[1];
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const at = (s) => new Date(Date.UTC(2026, 8, 24, 12, 0, s)).toISOString();
export const job = (id, seconds, { selfHosted = true, labels = ["future-pay-ci"] } = {}) => ({
  id, conclusion: "success", started_at: at(0), completed_at: at(seconds), labels,
  runner_group_name: selfHosted ? "Default" : "GitHub Actions", runner_name: `runner-${id}`,
});

export async function report({ runs, jobs, usage = {}, rates = defaultRates, laneRules = "", pullRequest = true }) {
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
    payload: { ...(pullRequest ? { pull_request: { number: 7, head: { ref: "b" } } } : {}), repository: { private: true } },
  };
  const env = { RUNNER_RATES: rates, COMMENT_MARKER: "<!-- m -->", REPORT_TITLE: "CI cost estimate", MAX_RUN_PAGES: "5", LANE_RULES: laneRules };
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

export const run = (id, status = "completed") => ({
  id, status, name: "CI", run_number: id, html_url: `https://x/${id}`, event: "pull_request",
  pull_requests: [{ number: 7 }], head_branch: "b",
});
