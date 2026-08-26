#!/usr/bin/env node
/* global process */
/**
 * Is there anything worth replaying before this tier runs?
 *
 * Answers from a BARE CHECKOUT with no toolchain, because that is what keeps
 * the retry gate free on a green branch: everything after this step — pnpm,
 * Node, install, the pre-command, the replay itself — is gated on the `any`
 * output. A push whose predecessor was green (nearly all of them) pays a
 * checkout and three API calls. Only a push following a RED one installs
 * anything.
 *
 * It FAILS OPEN in every direction. No earlier failed run, no artifact, an
 * unreadable document, a file that has left the checkout (the rebase case):
 * each reports `any=false` and lets the pipeline proceed exactly as it did
 * before this existed. A gate that ran nothing costs seconds; a gate that
 * reddens a sound tree costs a cycle plus the trust that makes the next red
 * believable.
 *
 * What it deliberately does NOT decide: whether the consumer's runners can
 * actually invoke a given path. That is the consumer's own knowledge, and its
 * replay command makes the final call — standing down there costs one install
 * on a rare push, where encoding lane ownership here would put a consumer's
 * vocabulary into a shared package.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { SCHEMA, api } from "./lib/ledger.mjs";

const LEDGER_ARTIFACT = "ci-failure-ledger";

function setOutput(key, value) {
  console.log(`[retry-gate] ${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

/** Every "I don't know" lands here: say why, in the log, and let CI proceed. */
function standDown(why) {
  console.log(`[retry-gate] ${why} — nothing to replay, the pipeline proceeds as usual.`);
  return null;
}

/**
 * The most recent FAILED run of this workflow on this branch, before this one.
 *
 * Run ids are monotonic, so "before this one" is simply a smaller id. Scoping
 * by workflow NAME as well as branch matters because a branch collects runs
 * from several workflows, and another workflow's failure is not this
 * pipeline's to replay.
 */
async function previousFailedRun(repo, branch, token) {
  const runId = Number(process.env.GITHUB_RUN_ID);
  const workflow = process.env.GITHUB_WORKFLOW;
  const query = `branch=${encodeURIComponent(branch)}&event=pull_request&status=completed&per_page=30`;
  const { workflow_runs: runs = [] } = await api(`/repos/${repo}/actions/runs?${query}`, token);
  return (
    runs
      .filter((r) => r.name === workflow && Number(r.id) < runId && r.conclusion === "failure")
      .sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null
  );
}

/** The ledger JSON out of a run's artifacts, or null if it has none. */
async function fetchLedger(repo, runId, token, out) {
  const { artifacts = [] } = await api(`/repos/${repo}/actions/runs/${runId}/artifacts`, token);
  const artifact = artifacts.find((a) => a.name === LEDGER_ARTIFACT && !a.expired);
  if (!artifact) return null;

  const response = await fetch(artifact.archive_download_url, {
    headers: { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`artifact download → ${response.status}`);
  const zip = `${out}.zip`;
  writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
  // An artifact is a zip and node ships no reader. `unzip -p` is on every
  // GitHub-hosted runner; a failure here is caught by the caller and stands the
  // gate down like any other unknown.
  const { status, stdout } = spawnSync("unzip", ["-p", zip, "*.json"], { encoding: "utf8" });
  if (status !== 0) throw new Error("could not read the ledger artifact");
  return JSON.parse(stdout);
}

/** Paths a quarantine file already excuses; never replay one. */
function quarantined(file) {
  if (!file) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const entries = Array.isArray(raw) ? raw : (raw?.tests ?? []);
    return entries.map((e) => (typeof e === "string" ? e : (e?.file ?? e?.path ?? ""))).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The ledger reduced to what THIS checkout could still run.
 *
 * Every rule narrows, and any of them can empty the ledger — which is a
 * stand-down, not a failure. Exported so the shared contract is testable
 * without a network.
 */
export function survivors(ledger, skipped = []) {
  if (ledger?.schema !== SCHEMA) return standDown(`ledger schema ${ledger?.schema} is not ${SCHEMA}`);
  const entries = Array.isArray(ledger.replay) ? ledger.replay : [];
  if (entries.length === 0) return standDown("the ledger records nothing replayable");

  const plan = [];
  for (const entry of entries) {
    const files = (entry.files ?? []).filter((file) => {
      // A rebase, a revert or a deletion can take the file with it. Absent from
      // THIS checkout means the ledger no longer describes this tree.
      if (!existsSync(file)) {
        console.log(`[retry-gate] ${file}: not in this checkout — skipped.`);
        return false;
      }
      // The one way this lane can be worse than not existing: a test that
      // failed by chance last time and fails by chance again turns a sound push
      // red early instead of green late. A path the repo excuses never gets to.
      if (skipped.some((q) => file.includes(q))) {
        console.log(`[retry-gate] ${file}: quarantined as flaky — skipped.`);
        return false;
      }
      return true;
    });
    if (files.length > 0) plan.push({ lane: entry.lane, files });
  }
  if (plan.length === 0) return standDown("nothing the ledger names survives in this checkout");
  return plan;
}

async function main() {
  const out = process.env.LEDGER_OUT || ".ci-failure-ledger.json";
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_HEAD_REF;
  if (!token || !repo || !branch) return standDown("no token/repo/branch in the environment");

  const run = await previousFailedRun(repo, branch, token);
  if (!run) return standDown(`no earlier failed run of "${process.env.GITHUB_WORKFLOW}" on ${branch}`);
  console.log(`[retry-gate] last failure on this branch: run ${run.id} (${run.head_sha?.slice(0, 8)}).`);

  const ledger = await fetchLedger(repo, run.id, token, out);
  if (!ledger) return standDown(`run ${run.id} published no ${LEDGER_ARTIFACT} artifact`);

  const plan = survivors(ledger, quarantined(process.env.LEDGER_QUARANTINE_FILE));
  if (!plan) return null;
  // Written for the REPLAY command, which re-derives its own view: this probe
  // answered "is there anything?", and the replay answers "what exactly?" with
  // the consumer's own knowledge of what its runners can invoke.
  writeFileSync(out, `${JSON.stringify(ledger, null, 2)}\n`);
  const count = plan.reduce((n, e) => n + e.files.length, 0);
  console.log(`[retry-gate] ${count} file(s) across ${plan.length} lane(s) may be replayable.`);
  return plan;
}

// Only when RUN, never when imported: `survivors` is exported for the tests,
// and a module that probes GitHub on import would run it for them too.
if (process.argv[1]?.endsWith("probe.mjs")) {
  main()
    .then((plan) => setOutput("any", plan ? "true" : "false"))
    // An unexpected error in the PROBE must never be a failure OF the gate: the
    // pipeline behind it is the real verdict, and it has not run yet.
    .catch((error) => {
      standDown(`unexpected error (${error.message})`);
      setOutput("any", "false");
    });
}
