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
// A lane may ignore MORE than the repo-wide set. Prisma migrations are the
// motivating case: they decide what the integration lane runs against a real
// database, and they cannot reach a unit test, which mocks the client. One
// global list cannot say both, so a lane may add to it — never subtract, since
// a lane that ignores something the repo counts is a lane that can go green on
// a change nothing looked at.
const laneIgnoreRe = rx(laneConfig.ignore);

/**
 * What the graph can trace directly.
 *
 * `source` replaces the old `untraceable` rule, and inverts it. `untraceable`
 * was a negative lookahead — "anything that is not a workspace .ts file" — so
 * it swept up every JSON, every migration, every root script, and answered each
 * with the whole suite. This states the positive instead: these extensions,
 * under these roots. A path that is neither source, nor ignored, nor routed is
 * UNCLASSIFIED, and the action exits non-zero naming it.
 */
const sourceRe = rx(config.source ?? String.raw`\.(ts|tsx|js|jsx|mjs|cjs)$`);
const sourceRoots = config.sourceRoots ?? ["apps", "packages"];
const isSource = (f) =>
  Boolean(sourceRe?.test(f)) && sourceRoots.some((r) => f === r || f.startsWith(`${r}/`));

/**
 * Codegen inputs, routed to the source file that carries their whole effect.
 * Lane entries are appended to the repo-wide ones, so a lane can add a route
 * without restating the shared set.
 */
const routes = [...(config.routes ?? []), ...(laneConfig.routes ?? [])].map((r) => ({
  match: rx(r.match),
  entry: r.entry ? (Array.isArray(r.entry) ? r.entry : [r.entry]) : null,
  command: r.command ?? null,
}));

/**
 * Some inputs cannot name their entry in a regex.
 *
 * A catalog bump is the case: the changed path is `pnpm-workspace.yaml`, and
 * the files that carry its effect are whichever source files import the
 * packages whose PINS moved — knowable only by reading the diff. So a route may
 * name a `command` instead of an `entry`, run once with every matching path,
 * printing one entry file per line.
 *
 * A command that fails, or prints nothing for paths it claimed, leaves those
 * paths unrouted — and therefore UNCLASSIFIED, which stops the run. That is
 * deliberate: the failure mode a silent empty produces here is a lane that
 * skips the very tests the bump was supposed to reach.
 */
let commandRoutes = null;
// Resolved on FIRST USE, not at module scope: `changed`, `deleted` and
// `mergeBase` are computed further down, and `routeOf` is only ever reached
// from inside selectAffected, which runs after all three exist.
const resolveCommandRoutes = () => {
  if (commandRoutes) return commandRoutes;
  commandRoutes = new Map();
  const all = [...changed, ...deleted];
  for (const r of routes) {
    if (!r.command || !r.match) continue;
    const hit = all.filter((f) => r.match.test(f));
    if (hit.length === 0) continue;
    let out = "";
    try {
      out = execFileSync("bash", ["-c", `${r.command} ${hit.map((f) => JSON.stringify(f)).join(" ")}`], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, AFFECTED_PLAN_BASE: mergeBase, AFFECTED_PLAN_LANE: lane },
      });
    } catch (error) {
      console.error(`::warning::route command failed for ${hit.length} path(s); they stay unclassified — ${error.message}`);
      continue;
    }
    const entries = out.split("\n").map((x) => x.trim()).filter(Boolean);
    if (entries.length === 0) continue;
    for (const f of hit) commandRoutes.set(f, entries);
  }
  return commandRoutes;
};

const routeOf = (file) => {
  const out = [...(resolveCommandRoutes().get(file) ?? [])];
  for (const r of routes) if (r.entry && r.match?.test(file)) out.push(...r.entry);
  return [...new Set(out)];
};
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
  isIgnored: (f) => Boolean(ignoreRe?.test(f)) || Boolean(laneIgnoreRe?.test(f)),
  isSource,
  routeOf,
  aliasesFor,
});

emit({ ...result, base: mergeBase, lane, changed });

// An unclassified path is the one outcome that must stop the run. Emitting
// first means the document still lands, so the failure is inspectable: the
// artifact names every path, not just the six the message had room for.
if (result.mode === "unclassified") {
  console.error(
    `::error::affected-plan (${lane}): ${result.unclassified.length} changed path(s) match no rule.\n` +
      result.unclassified.map((f) => `  - ${f}`).join("\n") +
      `\nAdd each to the config as an \`ignore\` (it cannot change a ${lane} verdict), ` +
      `a \`route\` (its effect is carried by a source file), or a \`sourceRoots\` entry (it IS source).`,
  );
  process.exit(1);
}

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
    tests.length === 0
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
    // Present only on the failing mode, and complete: the log message truncates
    // at six, the artifact does not.
    ...(plan.unclassified ? { unclassified: plan.unclassified } : {}),
    ...(plan.routes && Object.keys(plan.routes).length ? { routes: plan.routes } : {}),
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
