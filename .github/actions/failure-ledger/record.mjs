#!/usr/bin/env node
/* global process */
/**
 * Record what THIS run broke, so the next push can replay it first.
 *
 * Runs in the consumer's final aggregate job (`ci-success` or equivalent),
 * where every other job has finished and the jobs API reports conclusions
 * rather than a snapshot. The document it writes is consumed by `probe.mjs` on
 * the next push to the same branch, and published as a workflow artifact so a
 * human can read the same thing without opening thirty job logs.
 *
 * Never fails the job that runs it. A ledger is an optimisation for the NEXT
 * run; a missing one costs that run a few minutes of ordinary CI, and a red
 * aggregate step for failing to DESCRIBE a failure helps nobody.
 */
import { appendFileSync, writeFileSync } from "node:fs";

import { SCHEMA, classify, failedJobs, parseExtraLanes } from "./lib/ledger.mjs";

/**
 * Whether a ledger was written, for the step that publishes it.
 *
 * The publish step must NOT re-derive this from the filesystem. An earlier
 * version asked `hashFiles(...) != ''` and skipped the upload on a red run
 * whose log showed the file being written one step above — a green step, no
 * artifact, and nothing anywhere saying why. The script knows; it says so.
 */
function reportWrote(wrote) {
  console.log(`[ledger] wrote=${wrote}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `wrote=${wrote}\n`);
}

/** What was recorded, in the log, so a red run says so without the artifact. */
function report(out, { replay, unreplayable }) {
  const count = replay.reduce((n, e) => n + e.files.length, 0);
  console.log(`[ledger] ${count} file(s) across ${replay.length} lane(s) recorded to ${out}`);
  for (const entry of replay) console.log(`  ${entry.lane}: ${entry.files.join(", ")}`);
  for (const entry of unreplayable) console.log(`  (not replayable) ${entry.job} — ${entry.why}`);
}

async function main() {
  const out = process.env.LEDGER_OUT || "ci-failure-ledger.json";
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!token || !repo || !runId) {
    console.log("[ledger] no token/repo/run in the environment — nothing recorded.");
    return reportWrote(false);
  }

  let failures;
  try {
    failures = await failedJobs(repo, runId, token);
  } catch (error) {
    console.log(`[ledger] could not read this run's jobs (${error.message}) — nothing recorded.`);
    return reportWrote(false);
  }
  if (failures.length === 0) {
    console.log("[ledger] no job failed — nothing to record.");
    return reportWrote(false);
  }

  const classified = classify(failures, {
    extraLanes: parseExtraLanes(process.env.LEDGER_EXTRA_LANES),
    marker: process.env.LEDGER_WORKSPACE_MARKER || undefined,
  });
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        schema: SCHEMA,
        run: { id: String(runId), url: `https://github.com/${repo}/actions/runs/${runId}` },
        branch: process.env.GITHUB_HEAD_REF || "",
        headSha: process.env.LEDGER_HEAD_SHA || process.env.GITHUB_SHA || "",
        createdAt: new Date().toISOString(),
        ...classified,
      },
      null,
      2,
    )}\n`,
  );
  report(out, classified);
  return reportWrote(true);
}

if (process.argv[1]?.endsWith("record.mjs")) {
  main().catch((error) => {
    // Recording a failure must never BE a failure — see the header.
    console.log(`[ledger] ${error.message} — nothing recorded.`);
    reportWrote(false);
  });
}
