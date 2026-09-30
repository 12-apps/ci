#!/usr/bin/env node
/* global process */
/**
 * `skip-green filter` — drop from a lane's plan every test that is already
 * green on this pull request with identical inputs.
 *
 * Selection is cumulative on purpose: every push diffs against the merge base
 * with `main`, so a three-push PR re-runs push 1's tests on push 3 even when
 * push 3 changed nothing they can see. This is the complement. The plan job
 * has hashed each selected test's inputs (its import closure plus the lane's
 * global inputs, as blob shas — affected-plan lib/inputs.mjs); an earlier
 * GREEN run of this lane on this PR recorded the hashes of what it ran
 * (record.mjs). A test whose hash is unchanged since a run that passed it is
 * reported as skipped, with the head and run that earned it, and does not
 * run.
 *
 * Two policies:
 *   - `shadow`  — decide, report `wouldSkip`, run everything anyway. This is
 *                 how the mechanism earns trust: a week of shadow with no
 *                 "would have skipped, then failed" is the evidence to enforce.
 *   - `enforce` — rewrite the plan without the skipped tests.
 *
 * Every doubt runs the test: no manifest, an unreadable one, a plan without
 * hashes, a test with no hash (an unresolved import in its closure), a test on
 * the consumer's always-run list, an always-run list we cannot read. This
 * script never widens what the plan selected and never narrows below what the
 * manifest proves; it exits non-zero only when it cannot read the plan at all,
 * which the workflow treats as "run the plan unfiltered".
 *
 * Usage:
 *   node filter.mjs --lane unit --plan affected-plan.unit.json \
 *     --manifest .skip-green/unit.json --policy shadow|enforce \
 *     [--always-run .skip-green-always.json] --max-shards 4 --min-tests-per-shard 40
 *
 * Outputs (GITHUB_OUTPUT): mode, count, shard-total, skipped, would-skip, filtered
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { appendOutputs, readAlwaysRun, readManifest, shardTotalFor } from "./lib/manifest.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

/**
 * The decision over one plan + one manifest, pure so the tests can drive it.
 *
 * @returns {{ plan: object, skipped: object[], kept: string[], why: string[] }}
 *   `plan` is the rewritten document (identical to the input under `shadow`).
 */
export function decide({ plan, manifest, always, policy, maxShards, perShard }) {
  const why = [];
  const passthrough = (reason) => {
    why.push(reason);
    return { plan, skipped: [], kept: plan.tests ?? [], why };
  };
  if (plan.mode !== "narrowed") return passthrough(`plan mode is ${plan.mode} — nothing to filter`);
  if (!plan.inputs || typeof plan.inputs !== "object") return passthrough("plan carries no test inputs — the lane did not opt into skipGreen");
  if (!manifest) return passthrough("no usable manifest");

  const skipped = [];
  const kept = [];
  for (const test of plan.tests) {
    const hash = plan.inputs[test];
    const entry = manifest.entries[test];
    if (!hash) {
      kept.push(test);
      continue; // unbounded inputs — never skippable
    }
    if (always.has(test)) {
      kept.push(test);
      continue;
    }
    if (entry && entry.hash === hash) {
      skipped.push({ test, greenAt: entry.sha, greenRun: entry.run });
      continue;
    }
    kept.push(test);
  }

  if (skipped.length === 0) {
    why.push("every planned test has inputs that moved since it last passed, or never passed on this pull request");
    return { plan, skipped, kept, why };
  }

  if (policy !== "enforce") {
    why.push(`shadow: ${skipped.length} of ${plan.tests.length} planned test(s) would be skipped — running them anyway`);
    return {
      plan: { ...plan, wouldSkip: skipped, skipGreen: { policy: "shadow", wouldSkip: skipped.length } },
      skipped: [],
      kept: plan.tests,
      why,
    };
  }

  const mode = kept.length > 0 ? "narrowed" : "none";
  const shardTotal = shardTotalFor(kept.length, maxShards, perShard);
  why.push(`enforce: ${skipped.length} of ${plan.tests.length} planned test(s) already green with identical inputs — ${kept.length} run`);
  return {
    plan: {
      ...plan,
      mode,
      why: `${plan.why}; ${skipped.length} skipped as already green with identical inputs (skip-green)`,
      counts: { ...(plan.counts ?? {}), planned: plan.tests.length, selected: kept.length, skipped: skipped.length, shardTotal },
      tests: kept,
      skipped,
      skipGreen: { policy: "enforce", skipped: skipped.length },
    },
    skipped,
    kept,
    why,
  };
}

function main() {
  const lane = arg("lane", "unit");
  const planPath = arg("plan");
  const manifestPath = arg("manifest");
  const policy = arg("policy", "shadow");
  const alwaysPath = arg("always-run", "");
  const maxShards = Number(arg("max-shards", "4")) || 4;
  const perShard = Number(arg("min-tests-per-shard", "40")) || 40;
  if (!planPath || !manifestPath) {
    console.error("[skip-green] usage: filter.mjs --lane <lane> --plan <file> --manifest <file> --policy shadow|enforce");
    return 2;
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (error) {
    console.error(`[skip-green] cannot read the plan at ${planPath}: ${error.message}`);
    return 1;
  }

  const { manifest, why: manifestWhy } = readManifest(manifestPath, lane);
  console.log(`[skip-green] ${lane}: manifest — ${manifestWhy}`);
  const { always, error: alwaysError } = readAlwaysRun(alwaysPath);
  // A list we cannot read might name anything, so it names everything.
  const effectiveManifest = alwaysError ? null : manifest;
  if (alwaysError) console.log(`::warning::skip-green (${lane}): always-run list unreadable — skipping nothing (${alwaysError})`);

  const decision = decide({ plan, manifest: effectiveManifest, always, policy, maxShards, perShard });
  for (const line of decision.why) console.log(`[skip-green] ${lane}: ${line}`);

  const shown = decision.plan.skipped ?? decision.plan.wouldSkip ?? [];
  for (const s of shown) {
    console.log(
      `[skip-green] ${decision.plan.skipped ? "skipped" : "would skip"}: ${s.test} — green at ${String(s.greenAt).slice(0, 12)} (run ${s.greenRun}) with identical inputs`,
    );
  }

  if (decision.plan !== plan) writeFileSync(planPath, `${JSON.stringify(decision.plan, null, 2)}\n`);

  const tests = decision.plan.tests ?? [];
  const shardTotal = decision.plan.counts?.shardTotal ?? shardTotalFor(tests.length, maxShards, perShard);
  appendOutputs({
    mode: decision.plan.mode,
    count: tests.length,
    "shard-total": shardTotal,
    skipped: decision.plan.skipped?.length ?? 0,
    "would-skip": decision.plan.wouldSkip?.length ?? 0,
    filtered: decision.plan.skipped ? "true" : "false",
  });

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary && shown.length > 0) {
    const label = decision.plan.skipped ? "skipped as already green" : "would be skipped as already green (shadow)";
    const lines = [
      `### ${lane} — ${shown.length} test file(s) ${label}`,
      "",
      `Of \`${plan.tests.length}\` planned, \`${tests.length}\` run.`,
      "",
      "<details><summary>Already green with identical inputs</summary>",
      "",
      ...shown.slice(0, 100).map((s) => `- \`${s.test}\` — green at \`${String(s.greenAt).slice(0, 12)}\` (run ${s.greenRun})`),
      ...(shown.length > 100 ? ["", `_… and ${shown.length - 100} more._`] : []),
      "",
      "</details>",
      "",
    ];
    appendFileSync(summary, `${lines.join("\n")}\n`);
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("filter.mjs")) process.exit(main());
