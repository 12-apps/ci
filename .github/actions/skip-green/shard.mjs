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
 * A shard whose test step FAILED evicts every file of its list that did not
 * run clean, and records the clean ones — but only when its lane log shows no
 * failure JUnit cannot pin on a file (an unhandled error, a crashed or timed
 * out worker); with one, it records nothing and evicts its whole list. The
 * failed test is never recorded green either way (see `shardRecord`).
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
import { basename, isAbsolute, join, relative } from "node:path";

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
  // Reports at the junit root itself, by basename: `reports/junit/unit/
  // packages-combos.xml` is one vitest run of the workspace `packages/combos`,
  // its suites named relative to that workspace (see `junitRow`).
  const bySlug = new Map();
  let reports = 0;
  const read = (path) => {
    const text = readFileSync(path, "utf8");
    reports++;
    const prefix = junitPrefix(relative(cwd, path));
    const slug = prefix === "" ? basename(path).replace(/\.xml$/i, "") : null;
    for (const m of text.matchAll(/<testsuite\s[^>]*>/g)) {
      const name = attr(m[0], "name");
      const tests = Number(attr(m[0], "tests"));
      if (!name || !Number.isFinite(tests)) continue;
      const skipped = Number(attr(m[0], "skipped")) || 0;
      const bad = (Number(attr(m[0], "failures")) || 0) + (Number(attr(m[0], "errors")) || 0);
      const key = `${prefix}${name}`;
      const row = { ran: Math.max(0, tests - skipped), bad };
      const add = (map, k) => {
        const prev = map.get(k) ?? { ran: 0, bad: 0 };
        map.set(k, { ran: prev.ran + row.ran, bad: prev.bad + row.bad });
      };
      add(files, key);
      if (slug) {
        if (!bySlug.has(slug)) bySlug.set(slug, new Map());
        add(bySlug.get(slug), name);
      }
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
  if (reports === 0) return null;
  files.bySlug = bySlug;
  return files;
}

/**
 * The JUnit row for one planned file, or `undefined`. Exact in both forms:
 *   - the row keyed by the file's own repo path (a report inside the
 *     workspace, or one whose suites are named from the repo root);
 *   - a row of a report sitting AT the junit root whose basename is a
 *     workspace path with `/` turned to `-` (`packages-combos.xml`, the way a
 *     per-workspace runner names it), naming the rest of the path — and only
 *     when the file's own leading directories slugify to exactly that name.
 */
export function junitRow(junit, test) {
  const own = junit.get(test);
  if (own) return own;
  for (let i = test.indexOf("/"); i > 0; i = test.indexOf("/", i + 1)) {
    const rows = junit.bySlug?.get(test.slice(0, i).replace(/\//g, "-"));
    const row = rows?.get(test.slice(i + 1));
    if (row) return row;
  }
  return undefined;
}

/**
 * Did the shard's run fail in a way JUnit cannot pin on a file? (FUT-4548.)
 * Vitest reports an unhandled error or rejection AFTER the files it ran, in
 * its "Unhandled Errors" section, with no file attached; a worker that
 * crashed, timed out or ran out of memory leaves files half-run. When any of
 * these shows in the lane log, a red shard's clean JUnit rows prove nothing:
 * the culprit may be one of them. A log that cannot be read counts as one.
 * Over-matching (a passing test's NAME saying "unhandled error") only ever
 * falls back to recording nothing — the safe direction.
 */
export const UNATTRIBUTED = [
  /\bUnhandled (?:Errors?|Rejections?)\b/i,
  /\bcaught \d+ unhandled error/i,
  /\bWorker (?:exited|terminated)\b/i,
  /\[vitest-pool\]/i,
  /\bTimeout (?:calling|starting|terminating)\b/i,
  /\bERR_IPC_CHANNEL_CLOSED\b/,
  /heap out of memory/i,
  /\b(?:SIGSEGV|SIGKILL|SIGABRT)\b|Segmentation fault/,
];
export function unattributedFailure(logText) {
  if (typeof logText !== "string") return "the lane log could not be read";
  const hit = UNATTRIBUTED.find((re) => re.test(logText));
  return hit ? `the lane log matches ${hit}` : null;
}

/**
 * The files of `list` this shard may record: handed to the lane by the plan,
 * with a bounded hash, and shown by its JUnit RUNNING — at least one executed
 * case, none failed or errored (FUT-4563: a planned file the runner never
 * collected exits 0 with "No test files found", and has no row).
 */
function cleanFiles(list, plan, junit) {
  const planned = new Set(plan.tests);
  const tests = {};
  const ranClean = new Set();
  let uncollected = 0;
  let unhashable = 0;
  for (const test of list) {
    const row = junitRow(junit, test);
    const clean = Boolean(row && row.ran >= 1 && row.bad === 0);
    if (clean) ranClean.add(test);
    if (!planned.has(test)) continue;
    const hash = plan.inputs[test];
    if (!HASH_RE.test(String(hash))) {
      if (clean) unhashable++;
      continue;
    }
    if (!clean) {
      uncollected++;
      continue;
    }
    tests[test] = hash;
  }
  return { tests, ranClean, uncollected, unhashable };
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
export function shardRecord({ lane, plan, leg, shard, shardTotal, outcome, headSha, runId, junit, unattributed = "not checked" }) {
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
    // Which files are CLEAN: run, every case passed, collected — and only when
    // nothing failed in a way JUnit cannot pin on a file (`unattributed`).
    if (!list || unattributed || !(junit instanceof Map)) {
      const evict = list ? [...new Set(list)] : "*";
      const reason = !list ? "its list is unknown" : unattributed ? unattributed : "no JUnit report could be read";
      return {
        record: { ...base, passed: false, evict },
        why: `shard ${shard}/${shardTotal} FAILED — ${reason}; evicting ${evict === "*" ? "every planned test" : `its ${evict.length} file(s)`}, recording none`,
      };
    }
    const clean = cleanFiles(list, plan, junit);
    // Evict what did not run clean (failed, or never reached). A file that ran
    // clean but has no bounded hash is neither recorded nor evicted: it can
    // hold no entry to begin with (affected-plan gave it `null`).
    const evict = [...new Set(list)].filter((t) => !clean.ranClean.has(t));
    return {
      record: { ...base, passed: false, evict, tests: clean.tests },
      why:
        `shard ${shard}/${shardTotal} FAILED with no unattributed error — ${Object.keys(clean.tests).length} passed and recorded; ` +
        `${clean.unhashable} passed but unhashable (not recordable); ${evict.length} evicted (failed, or not run)`,
    };
  }

  if (!(junit instanceof Map)) return none("no JUnit report could be read — which files ran is unknown, so nothing is recorded");
  if (!list) return none(`shard ${shard}/${shardTotal} was split by the runner, not by a leg list — which files it ran is unknown, so nothing is recorded`);

  const { tests, uncollected, unhashable } = cleanFiles(list, plan, junit);
  return {
    record: { ...base, passed: true, tests },
    why:
      `shard ${shard}/${shardTotal} passed: ${Object.keys(tests).length} recorded` +
      (unhashable ? `; ${unhashable} passed but unhashable (not recordable)` : "") +
      (uncollected ? `; ${uncollected} planned file(s) its JUnit does not show running — not recorded` : ""),
  };
}

function readLog(path) {
  if (!path) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
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
    unattributed: unattributedFailure(readLog(arg("log", ""))),
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
