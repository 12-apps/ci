#!/usr/bin/env node
/* global process */
/**
 * `skip-green shard` — inside ONE shard, after its test step exited 0, write
 * down what that shard proved, so a lane that fails or is cancelled elsewhere
 * still keeps it (FUT-4548).
 *
 * The lane-level record (`record.mjs` from the verdict job) only ever runs
 * when EVERY shard passed. One red shard of six, or a run cancelled by the
 * next push, therefore threw away the five green shards' proof, and the next
 * push re-ran all of it: 21 unit and 14 integration lanes, ~660 job-minutes,
 * on 2026-11-05 alone.
 *
 * The claim a shard can make is narrower than the lane's and exactly as
 * strong: "every test in THIS shard's list passed, with these input hashes".
 * It holds only when the shard knows its list:
 *   - the lane is sized by measured time (lane-timings wrote this leg's files
 *     to `--leg`, and the runner ran exactly those, with `--shard` dropped), or
 *   - the lane has one shard, so its list is the plan's `tests`.
 * A shard split by vitest's own `--shard=i/n` cannot name which files it ran,
 * so it records NOTHING — never a guess.
 *
 * And it holds only when the shard ran something: with JUnit reports given, a
 * shard whose reports hold zero test cases proved nothing and records nothing
 * (the per-shard echo of the zero-test guard).
 *
 * A shard whose test step FAILED writes the opposite claim: evict every file
 * of its list from the manifest (see `shardRecord`). None of its tests — the
 * failed one or the ones beside it — is ever recorded as green.
 *
 * Usage:
 *   node shard.mjs --lane unit --plan .affected-plan/affected-plan.unit.json \
 *     --leg .affected-plan/leg.txt --shard 3 --shard-total 6 --outcome success \
 *     --head-sha <sha> --run-id <id> --out .skip-green-shard/unit.json \
 *     [--reports "<junit file or dir> …"]
 *
 * Outputs (GITHUB_OUTPUT): written (true|false), tests
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { SHARD_RECORD_VERSION, appendOutputs, writeManifest } from "./lib/manifest.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const SHA_RE = /^[0-9a-f]{7,40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

/** Test cases across JUnit files and directories (recursive); `null` when none is readable. */
export function countTestCases(paths) {
  let files = 0;
  let cases = 0;
  const visit = (path) => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    if (!/\.xml$/i.test(path)) return;
    files++;
    cases += (readFileSync(path, "utf8").match(/<testcase\b/g) ?? []).length;
  };
  for (const path of paths) visit(path);
  return files === 0 ? null : cases;
}

/**
 * This shard's record, pure so the tests can drive it; `record: null` when
 * the shard may not claim anything.
 *
 * Two kinds, one file:
 *   - `passed: true`  — the test step SUCCEEDED: `tests` maps every file of
 *     this shard's list to the plan's hash. The merge records them.
 *   - `passed: false` — the test step FAILED: `evict` names every file of this
 *     shard's list (or `"*"`, every planned test, when the list is unknown).
 *     The merge DELETES their manifest entries, so a test green at an earlier
 *     head and failing now — on inputs the hash does not see moving, say a
 *     change on main — is never skipped on that stale proof. The whole leg is
 *     evicted, not only the red test: which file failed is the runner's
 *     output, and a guess may only ever evict more.
 * Any other outcome (`cancelled`, `skipped`, `no-signal`) writes nothing; for a
 * FAILED lane the merge evicts such a shard's leg itself, from the plan.
 *
 * @param {object} o
 * @param {string[]|null} o.leg  this leg's file list, or null when the lane was not sized
 * @param {number|null} o.testCases  JUnit test cases this shard reported; null when no reports were asked for
 * @returns {{ record: object|null, why: string }}
 */
export function shardRecord({ lane, plan, leg, shard, shardTotal, outcome, headSha, runId, reportsAsked, testCases }) {
  const none = (why) => ({ record: null, why });
  if (outcome !== "success" && outcome !== "failure") return none(`the shard's test step is ${JSON.stringify(outcome)} — no claim either way`);
  if (!plan || !plan.inputs || typeof plan.inputs !== "object") return none("plan carries no test inputs — nothing to record");
  if (plan.mode !== "narrowed" || !Array.isArray(plan.tests)) return none(`plan mode is ${JSON.stringify(plan?.mode)} — nothing to record`);
  if (!SHA_RE.test(String(headSha))) return none(`head sha ${JSON.stringify(headSha)} is not a sha — nothing to record`);
  if (!/^\d+$/.test(String(runId))) return none(`run id ${JSON.stringify(runId)} is not a run — nothing to record`);

  let list = null;
  if (Array.isArray(leg)) list = leg;
  else if (Number(shardTotal) === 1) list = plan.tests;
  const base = { version: SHARD_RECORD_VERSION, lane, inputs: plan.inputsVersion ?? null, sha: headSha, run: String(runId), shard: String(shard) };

  if (outcome === "failure") {
    const evict = list ? [...new Set(list)] : "*";
    return {
      record: { ...base, passed: false, evict },
      why: `shard ${shard}/${shardTotal} FAILED — evicting ${evict === "*" ? "every planned test (its list is unknown)" : `its ${evict.length} file(s)`} from the manifest`,
    };
  }

  if (reportsAsked && !(testCases > 0)) return none(`the shard's JUnit reports hold ${testCases ?? "no readable"} test case(s) — it proved nothing`);
  if (!list) return none(`shard ${shard}/${shardTotal} was split by the runner, not by a leg list — which files it ran is unknown, so nothing is recorded`);

  const planned = new Set(plan.tests);
  const tests = {};
  for (const test of list) {
    // Only a file the plan handed the lane, with a bounded hash: a leg line
    // the plan does not hold is not a claim this run can make.
    if (!planned.has(test)) continue;
    const hash = plan.inputs[test];
    if (!HASH_RE.test(String(hash))) continue;
    tests[test] = hash;
  }
  return {
    record: { ...base, passed: true, tests },
    why: `shard ${shard}/${shardTotal} passed ${Object.keys(tests).length} recordable test file(s)`,
  };
}

function main() {
  const lane = arg("lane", "unit");
  const planPath = arg("plan");
  const legPath = arg("leg", "");
  const out = arg("out");
  const reports = (arg("reports", "") ?? "").split(/\s+/).filter(Boolean);
  if (!planPath || !out) {
    console.error("[skip-green] usage: shard.mjs --lane <lane> --plan <file> --out <file> --outcome <outcome>");
    return 2;
  }
  let plan = null;
  try {
    plan = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (error) {
    console.log(`[skip-green] ${lane}: cannot read the plan at ${planPath} — nothing recorded (${error.message})`);
    appendOutputs({ written: "false", tests: 0 });
    return 0;
  }
  let leg = null;
  if (legPath) {
    try {
      leg = readFileSync(legPath, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    } catch (error) {
      console.log(`[skip-green] ${lane}: cannot read the leg list at ${legPath} — nothing recorded (${error.message})`);
      appendOutputs({ written: "false", tests: 0 });
      return 0;
    }
  }
  const { record, why } = shardRecord({
    lane,
    plan,
    leg,
    shard: arg("shard", ""),
    shardTotal: arg("shard-total", ""),
    outcome: arg("outcome", ""),
    headSha: arg("head-sha", ""),
    runId: arg("run-id", process.env.GITHUB_RUN_ID ?? ""),
    reportsAsked: reports.length > 0,
    testCases: reports.length > 0 ? countTestCases(reports) : null,
  });
  console.log(`[skip-green] ${lane}: ${why}`);
  if (!record || (record.passed && Object.keys(record.tests).length === 0)) {
    appendOutputs({ written: "false", tests: 0 });
    return 0;
  }
  writeManifest(out, record);
  appendOutputs({ written: "true", tests: record.passed ? Object.keys(record.tests).length : 0 });
  return 0;
}

// `exitCode`, never `process.exit()` — see filter.mjs.
if (process.argv[1] && process.argv[1].endsWith("shard.mjs")) process.exitCode = main();
