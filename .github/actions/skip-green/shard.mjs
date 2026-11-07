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
 * And it names only what the shard's own JUnit shows RAN (FUT-4563): a file
 * with at least one executed test case and no failure or error. A planned file
 * the runner never collected — outside its `include`, "No test files found",
 * exit 0 — is not recorded, whatever the exit code says. No readable JUnit,
 * no green record.
 *
 * A shard whose test step FAILED writes the opposite claim: evict every file
 * of its list from the manifest (see `shardRecord`). None of its tests — the
 * failed one or the ones beside it — is ever recorded as green.
 *
 * Usage:
 *   node shard.mjs --lane unit --plan .affected-plan/affected-plan.unit.json \
 *     --leg .affected-plan/leg.txt --shard 3 --shard-total 6 --outcome success \
 *     --head-sha <sha> --run-id <id> --out .skip-green-shard/unit.json \
 *     --reports "<junit file or dir> …"
 *
 * Outputs (GITHUB_OUTPUT): written (true|false), tests
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { junitPrefix } from "../lane-timings/lib/reports.mjs";
import { SHARD_RECORD_VERSION, appendOutputs, writeManifest } from "./lib/manifest.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const SHA_RE = /^[0-9a-f]{7,40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (v) => v.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e]);
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : null;
};

/**
 * What this shard's JUnit says RAN, per test file (FUT-4563): `Map<repo path,
 * { ran, bad }>`, or `null` when no report could be read at all.
 *
 * One vitest `<testsuite>` per file, `name` relative to the vitest root that
 * ran it, prefixed with where the report sits (lane-timings' `junitPrefix`:
 * `apps/web/reports/junit/unit/x.xml` → `apps/web/`). `ran` counts test cases
 * that executed (tests − skipped); `bad` counts failures and errors. A file the
 * plan named but the runner never collected (outside its `include`, "No test
 * files found", exit 0) has NO row — which is the whole point: it is never
 * recorded green. A report with no file attribution (node:test's) contributes
 * nothing.
 */
export function junitFiles(paths, cwd = process.cwd()) {
  const files = new Map();
  let reports = 0;
  const read = (path) => {
    const text = readFileSync(path, "utf8");
    reports++;
    const prefix = junitPrefix(relative(cwd, path));
    for (const m of text.matchAll(/<testsuite\s[^>]*>/g)) {
      const name = attr(m[0], "name");
      const tests = Number(attr(m[0], "tests"));
      if (!name || !Number.isFinite(tests)) continue;
      const skipped = Number(attr(m[0], "skipped")) || 0;
      const bad = (Number(attr(m[0], "failures")) || 0) + (Number(attr(m[0], "errors")) || 0);
      const key = `${prefix}${name}`;
      const prev = files.get(key) ?? { ran: 0, bad: 0 };
      files.set(key, { ran: prev.ran + Math.max(0, tests - skipped), bad: prev.bad + bad });
    }
  };
  const visit = (path) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    if (/\.xml$/i.test(path)) read(path);
  };
  for (const path of paths) visit(isAbsolute(path) ? path : join(cwd, path));
  return reports === 0 ? null : files;
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
 * @param {Map<string,{ran:number,bad:number}>|null} o.junit  what this shard's JUnit says ran (`junitFiles`); null when none was read
 * @returns {{ record: object|null, why: string }}
 */
export function shardRecord({ lane, plan, leg, shard, shardTotal, outcome, headSha, runId, junit }) {
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

  if (!(junit instanceof Map)) return none("no JUnit report could be read — which files ran is unknown, so nothing is recorded");
  if (!list) return none(`shard ${shard}/${shardTotal} was split by the runner, not by a leg list — which files it ran is unknown, so nothing is recorded`);

  const planned = new Set(plan.tests);
  const tests = {};
  let uncollected = 0;
  for (const test of list) {
    // Only a file the plan handed the lane, with a bounded hash: a leg line
    // the plan does not hold is not a claim this run can make.
    if (!planned.has(test)) continue;
    const hash = plan.inputs[test];
    if (!HASH_RE.test(String(hash))) continue;
    // FUT-4563: only a file this shard's JUnit shows RUNNING, at least one test
    // case and none failed or errored. A planned file the runner never
    // collected exits 0 with "No test files found" — and has no row here.
    const row = junit.get(test);
    if (!row || row.ran < 1 || row.bad > 0) {
      uncollected++;
      continue;
    }
    tests[test] = hash;
  }
  return {
    record: { ...base, passed: true, tests },
    why:
      `shard ${shard}/${shardTotal} passed ${Object.keys(tests).length} recordable test file(s)` +
      (uncollected ? `; ${uncollected} planned file(s) its JUnit does not show running — not recorded` : ""),
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
    junit: reports.length > 0 ? junitFiles(reports) : null,
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
