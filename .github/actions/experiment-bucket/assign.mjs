// Composite-action entry point: reads the run's creation time and the
// registry from the DEFAULT branch (never the pull request's own tree, so a
// pull request cannot put itself into an experiment), then writes the outputs.
import { appendFileSync } from "node:fs";
import { assign } from "./lib/assign.mjs";

const env = process.env;
const TIMEOUT_MS = Number(env.EXPERIMENT_BUCKET_TIMEOUT_MS) || 10_000;
const api = env.GITHUB_API_URL || "https://api.github.com";
const headers = { authorization: `Bearer ${env.GH_TOKEN}`, "x-github-api-version": "2022-11-28" };

async function get(path, accept = "application/vnd.github+json") {
  try {
    // Bounded: Detect Changes gates the whole pipeline, and a hung API call
    // must cost seconds, not the job's time limit.
    const res = await fetch(`${api}${path}`, { headers: { ...headers, accept }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { error: `HTTP ${res.status} on ${path}` };
    return { body: accept.includes("raw") ? await res.text() : await res.json() };
  } catch (e) {
    return { error: `${e.message} on ${path}` };
  }
}

const notes = [];
let createdAt = env.RUN_CREATED_AT || "";
if (!createdAt) {
  const run = await get(`/repos/${env.REPO}/actions/runs/${env.RUN_ID}`);
  if (run.error) notes.push(run.error); else createdAt = run.body.created_at;
}
let registry = null;
const file = await get(`/repos/${env.REPO}/contents/${encodeURI(env.FILE)}?ref=${encodeURIComponent(env.DEFAULT_BRANCH)}`, "application/vnd.github.raw+json");
if (file.error) notes.push(file.error);
else {
  try { registry = JSON.parse(file.body); } catch (e) { notes.push(`registry is not JSON: ${e.message}`); }
}

let out;
try {
  out = assign({ runId: env.RUN_ID, event: env.EVENT, createdAt, registry, off: env.OFF });
} catch (e) {
  // Fail open: whatever the registry holds, the run is control.
  notes.push(`assignment failed: ${e.message}`);
  out = { digit: null, experiment: "", reason: "assignment failed" };
}
const reason = [out.reason, ...notes].join("; ");
console.log(`ci-experiment run=${env.RUN_ID} digit=${out.digit ?? "-"} experiment=${out.experiment || "control"} reason="${reason}"`);
if (notes.length) console.log(`::warning title=CI experiment bucket::${notes.join("; ")} - this run is control`);
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `experiment=${out.experiment}\ndigit=${out.digit ?? ""}\n`);
