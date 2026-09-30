#!/usr/bin/env node
/* global process */
/**
 * `skip-green record` — after a GREEN lane, write down what it proved.
 *
 * For every test the lane RAN and passed, record the input hash the plan
 * computed for it, with the head and run that earned it. Tests the run
 * SKIPPED as already green keep their earlier entry: their hash is equal by
 * definition, and the entry should keep naming the run that actually executed
 * them. Entries for tests this run did not plan at all are kept too — the
 * manifest accumulates over the pull request, which is what lets push 3 skip
 * what push 1 proved even when push 2 did not select it.
 *
 * The one rule that matters: ONLY A GREEN LANE RECORDS. The caller passes the
 * lane's result and anything but `success` records nothing — a failed test
 * must never enter the manifest, and a cancelled run proved nothing. A test
 * with no hash (`null`: an unresolved import in its closure) is never recorded
 * either; there is no bounded claim to make about it.
 *
 * Usage:
 *   node record.mjs --lane unit --plan affected-plan.unit.json \
 *     --manifest .skip-green/unit.json --lane-result success \
 *     --head-sha <sha> --run-id <id>
 *
 * Outputs (GITHUB_OUTPUT): recorded (true|false), entries, added
 */
import { readFileSync } from "node:fs";

import { MANIFEST_VERSION, appendOutputs, readManifest, writeManifest } from "./lib/manifest.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

/**
 * The next manifest, pure so the tests can drive it; `null` when nothing may
 * be recorded.
 *
 * @returns {{ manifest: object|null, added: number, why: string }}
 */
export function nextManifest({ lane, plan, previous, laneResult, headSha, runId }) {
  if (laneResult !== "success") return { manifest: null, added: 0, why: `lane result is ${JSON.stringify(laneResult)} — a manifest records only what a green lane proved` };
  if (!plan || !plan.inputs || typeof plan.inputs !== "object") return { manifest: null, added: 0, why: "plan carries no test inputs — nothing to record" };
  if (!/^[0-9a-f]{7,40}$/.test(String(headSha))) return { manifest: null, added: 0, why: `head sha ${JSON.stringify(headSha)} is not a sha — nothing to record` };

  const entries = { ...(previous?.entries ?? {}) };
  let added = 0;
  for (const test of plan.tests ?? []) {
    const hash = plan.inputs[test];
    if (!hash) continue; // unbounded — no claim to make
    const before = entries[test];
    entries[test] = { hash, sha: headSha, run: String(runId) };
    if (!before || before.hash !== hash) added++;
  }
  // Skipped tests keep the entry that earned them; a skipped test with no
  // entry is a contradiction (it was skipped BECAUSE of one) and is left out.
  return {
    manifest: { version: MANIFEST_VERSION, lane, entries },
    added,
    why: `${added} entr${added === 1 ? "y" : "ies"} added or refreshed, ${Object.keys(entries).length} in the manifest`,
  };
}

function main() {
  const lane = arg("lane", "unit");
  const planPath = arg("plan");
  const manifestPath = arg("manifest");
  const laneResult = arg("lane-result", "");
  const headSha = arg("head-sha", process.env.GITHUB_SHA ?? "");
  const runId = arg("run-id", process.env.GITHUB_RUN_ID ?? "");
  if (!planPath || !manifestPath) {
    console.error("[skip-green] usage: record.mjs --lane <lane> --plan <file> --manifest <file> --lane-result <result>");
    return 2;
  }
  let plan = null;
  try {
    plan = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (error) {
    console.log(`[skip-green] ${lane}: cannot read the plan at ${planPath} — nothing recorded (${error.message})`);
    appendOutputs({ recorded: "false", entries: 0, added: 0 });
    return 0;
  }
  const { manifest: previous, why: previousWhy } = readManifest(manifestPath, lane);
  console.log(`[skip-green] ${lane}: previous manifest — ${previousWhy}`);
  const { manifest, added, why } = nextManifest({ lane, plan, previous, laneResult, headSha, runId });
  console.log(`[skip-green] ${lane}: ${why}`);
  if (!manifest) {
    appendOutputs({ recorded: "false", entries: Object.keys(previous?.entries ?? {}).length, added: 0 });
    return 0;
  }
  writeManifest(manifestPath, manifest);
  appendOutputs({ recorded: "true", entries: Object.keys(manifest.entries).length, added });
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("record.mjs")) process.exit(main());
