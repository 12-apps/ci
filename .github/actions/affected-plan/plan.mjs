#!/usr/bin/env node
/* global process */
/**
 * `affected-plan` — produce THE list of test files a lane will run.
 *
 * The list is the point. A plan job that answers only "how many shards?" and a
 * test lane that re-derives its own selection are two implementations of the
 * same decision, and they drift: the plan can say one thing while the lane runs
 * another, and nothing compares them. Here the plan job writes an explicit list
 * of files, publishes it as an artifact, and the lane runs exactly that list.
 * There is one selection per run, and it is reviewable before it executes.
 *
 * Usage:
 *   node plan.mjs --lane unit --base <ref> --config .affected-plan.json --out plan.json
 *
 * Outputs (GITHUB_OUTPUT): mode, count, shard-total, shards, plan-file
 * Exit code is 0 for every outcome including the full-suite fallback — a plan
 * is a decision, not a verdict, and a non-zero exit here would fail the lane
 * for the crime of being asked.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { selectAffected } from "./lib/select.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const repoRoot = resolve(arg("repo-root", process.cwd()));
const lane = arg("lane", "unit");
const base = arg("base", "origin/main");
const configPath = resolve(repoRoot, arg("config", ".affected-plan.json"));
const outPath = resolve(repoRoot, arg("out", `affected-plan.${lane}.json`));
const maxShards = Number(arg("max-shards", "4")) || 4;
const perShard = Number(arg("min-tests-per-shard", "40")) || 40;

const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  console.error(`[affected-plan] cannot read ${configPath}: ${error.message}`);
  console.error("[affected-plan] falling back to the FULL suite — a missing config must never narrow a lane.");
  emit({ mode: "full", tests: [], why: "no readable affected-plan config", stats: {}, symbols: {}, reasons: {} });
  process.exit(0);
}

const laneConfig = config.lanes?.[lane];
if (!laneConfig) {
  console.error(`[affected-plan] no lane "${lane}" in ${configPath} — running the FULL suite.`);
  emit({ mode: "full", tests: [], why: `lane "${lane}" is not configured`, stats: {}, symbols: {}, reasons: {} });
  process.exit(0);
}

/** Expand `apps/*` style workspace globs to the directories that exist. */
const expandWorkspaces = () => {
  const out = [];
  for (const pattern of config.workspaces ?? []) {
    if (!pattern.includes("*")) {
      if (existsSync(resolve(repoRoot, pattern))) out.push(pattern);
      continue;
    }
    const prefix = pattern.slice(0, pattern.indexOf("*")).replace(/\/$/, "");
    let entries = [];
    try {
      entries = readdirSync(resolve(repoRoot, prefix), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) if (entry.isDirectory()) out.push(`${prefix}/${entry.name}`);
  }
  return out;
};

const dirs = expandWorkspaces();
const rx = (source) => (source ? new RegExp(source) : null);
const ignoreRe = rx(config.ignore);
const untraceableRe = rx(config.untraceable);
const testRe = rx(laneConfig.test);
const excludeRe = rx(laneConfig.exclude);

/**
 * `@/x` resolves against the workspace that OWNS the importing file, so the
 * alias table is computed per file rather than once for the repo.
 */
const aliasesFor = (file) => {
  const owner = dirs.find((d) => file === d || file.startsWith(`${d}/`));
  return (config.aliases ?? []).map(({ prefix, replacement }) => ({
    prefix,
    replacement: replacement.replace("<workspace>", owner ?? ""),
  }));
};

let mergeBase;
try {
  mergeBase = git(["merge-base", base, "HEAD"]);
} catch {
  mergeBase = base; // a caller-supplied SHA is used as-is
}

const nameOnly = (filter) => {
  try {
    return git(["diff", "--name-only", `--diff-filter=${filter}`, mergeBase, "HEAD"]).split("\n").filter(Boolean);
  } catch {
    return null;
  }
};
const changed = nameOnly("d");
const deleted = nameOnly("D") ?? [];
if (changed === null) {
  console.error(`[affected-plan] cannot diff against ${mergeBase} — running the FULL suite.`);
  emit({ mode: "full", tests: [], why: `no diff against ${mergeBase}`, stats: {}, symbols: {}, reasons: {} });
  process.exit(0);
}

const readBase = (file) => {
  try {
    // stderr silenced: "exists on disk, but not in <rev>" is the ordinary
    // answer for a file the PR adds, not a problem worth printing per file.
    return execFileSync("git", ["show", `${mergeBase}:${file}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null; // new file
  }
};

const result = selectAffected({
  repoRoot,
  changed,
  deleted,
  readBase,
  roots: laneConfig.roots ?? dirs,
  workspaceDirs: dirs,
  isTest: (f) => Boolean(testRe?.test(f)) && !(excludeRe?.test(f) ?? false),
  isIgnored: (f) => Boolean(ignoreRe?.test(f)),
  isUntraceable: (f) => Boolean(untraceableRe?.test(f)),
  aliasesFor,
});

emit({ ...result, base: mergeBase, lane, changed });

/** Write the plan file, set the action outputs, and print the summary. */
function emit(plan) {
  const tests = plan.tests ?? [];
  // Nothing to run means an EMPTY matrix, not one idle shard: the matrix is
  // expanded before any runner exists, so a `1` here boots a machine to pay a
  // checkout, an install and a setup before exiting 0. The document and the
  // outputs must agree about that — the document is the artifact a reviewer
  // reads afterwards, so a `1` recorded beside `shards=[]` is a record of a
  // run that did not happen.
  const shardTotal =
    plan.mode === "none" && tests.length === 0
      ? 0
      : plan.mode === "full"
        ? maxShards
        : Math.max(1, Math.min(maxShards, Math.ceil(tests.length / perShard)));
  const document = {
    lane: plan.lane ?? lane,
    base: plan.base ?? null,
    mode: plan.mode,
    why: plan.why,
    generatedFrom: "12-apps/ci .github/actions/affected-plan",
    counts: { ...(plan.stats ?? {}), selected: tests.length, shardTotal },
    changed: plan.changed ?? [],
    affectedSymbols: plan.symbols ?? {},
    tests,
    reasons: plan.reasons ?? {},
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);

  const shards = Array.from({ length: shardTotal }, (_, i) => i + 1);
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(
      out,
      [
        `mode=${plan.mode}`,
        `count=${tests.length}`,
        `shard-total=${shardTotal}`,
        `shards=${JSON.stringify(shards)}`,
        `plan-file=${outPath}`,
        "",
      ].join("\n"),
    );
  }
  console.error(`[affected-plan] ${plan.lane ?? lane}: ${plan.mode} — ${plan.why}`);
  console.error(`[affected-plan] ${tests.length} test file(s), ${shards.length} shard(s) → ${outPath}`);
  for (const test of tests.slice(0, 25)) console.error(`    • ${test}`);
  if (tests.length > 25) console.error(`    …and ${tests.length - 25} more (full list in the plan artifact)`);
}
