#!/usr/bin/env node
/* global process */
/**
 * `probe`: after a push to the base branch, find every open PR that no longer
 * merges cleanly with it and say so ON THE PR, once.
 *
 * GitHub has no "this PR just became conflicting" event, and its own
 * `mergeable` flag is computed lazily — a list call returns `null` for most
 * PRs until somebody opens them. So this does not ask GitHub: it fetches each
 * open PR's head (`refs/pull/N/head`, which exists on the base repository for
 * fork PRs too) and re-runs the merge itself with `git merge-tree`, which
 * needs no worktree and no checkout of the PR.
 *
 * Each conflicted PR gets ONE comment (lib/comment.mjs), edited in place and
 * marked resolved when the branch is clean again. A PR whose conflict did not
 * change is not written to, so a run on every merge to main costs its authors
 * nothing until something new happens to them.
 *
 * A STACKED PR — a branch cut from another PR's branch, after that PR was
 * squash-merged — is analysed against the re-stack base (lib/restack.mjs)
 * instead of the base tip, so its comment lists only the conflicts no merge
 * base removes, plus how to take the base in. A PR the restack job just
 * pushed (`restacked`, that job's output) is not fetched again — its
 * `refs/pull/N/head` lags the push — and counts as clean against the base
 * commit the job merged.
 *
 * A PR this cannot probe (its head could not be fetched) is reported in the
 * log and skipped: the other PRs' comments are still worth writing. A failed
 * WRITE fails the run, because a monitor that cannot comment is one nobody
 * hears — and a run started with the workflow token has no watcher that would
 * notice it silently stopped.
 */
import { appendFileSync } from "node:fs";

import { analyzeMerge } from "./lib/analyze.mjs";
import { decide, isOwnComment } from "./lib/comment.mjs";
import { loadConfig, loadRestackConfig } from "./lib/config.mjs";
import { isMain } from "./lib/entry.mjs";
import { git, revParse } from "./lib/git.mjs";
import { githubClient } from "./lib/github.mjs";
import { squashResolver } from "./lib/parents.mjs";
import { culpritSquashes, recipeOf, stackedParents, virtualBase } from "./lib/restack.mjs";

const log = (msg) => console.log(`[conflict-monitor] ${msg}`);
export const LOCAL_REF = (n) => `refs/conflict-monitor/pr/${n}`;

/** Fetch every PR head into a local ref, in batches; returns the numbers that failed. */
export function fetchHeads(numbers, { cwd, remote = "origin", batch = 50, env } = {}) {
  const failed = [];
  for (let i = 0; i < numbers.length; i += batch) {
    const slice = numbers.slice(i, i + batch);
    const specs = slice.map((n) => `+refs/pull/${n}/head:${LOCAL_REF(n)}`);
    const res = git(["fetch", "--no-tags", "--quiet", remote, ...specs], { cwd, env, ok: [0, 1, 128] });
    if (res.status === 0) continue;
    // One bad ref fails the whole batch; retry one by one to find it.
    for (const n of slice) {
      const one = git(["fetch", "--no-tags", "--quiet", remote, `+refs/pull/${n}/head:${LOCAL_REF(n)}`], { cwd, env, ok: [0, 1, 128] });
      if (one.status !== 0) failed.push(n);
    }
  }
  return failed;
}

/**
 * The stacked parents of a conflicted head and the re-stack base Z, or null.
 * A squash that cannot be mapped to a PR is no parent: the PR keeps E0's
 * plain comment.
 */
export async function stackOf({ head, records, baseSha, resolver, self, cwd, cache }) {
  const squashes = culpritSquashes({ base: baseSha, child: head, files: records.map((r) => r.file), cwd });
  await resolver.prime(squashes);
  const { parents } = stackedParents({ base: baseSha, child: head, squashes, resolve: resolver.get, self, cwd, cache });
  if (!parents.length) return null;
  return { parents, z: virtualBase({ base: baseSha, pOlds: parents.map((p) => p.pOld), cwd }) };
}

/**
 * The restack job's `pushed` output: `{"<pr>": {"head": <sha>, "baseSha": <sha>}}`.
 * Empty is no PR. Anything else malformed is an error, never "nothing pushed".
 */
export function parseRestacked(text) {
  if (!text || !text.trim()) return {};
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`restacked is not JSON (${err.message})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("restacked must be an object keyed by PR number");
  const sha = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
  for (const [k, v] of Object.entries(raw)) {
    if (!/^[1-9]\d*$/.test(k) || !v || !sha.test(v.head ?? "") || !sha.test(v.baseSha ?? "")) {
      throw new Error(`restacked: entry "${k}" must be {"head": <sha>, "baseSha": <sha>}`);
    }
  }
  return raw;
}

export async function runProbe({
  api,
  repo,
  base,
  baseSha,
  config,
  only = null,
  cwd = process.cwd(),
  fetch = fetchHeads,
  dryRun = false,
  restacked = {},
  command = null,
}) {
  // `only`: probe one PR (the `pull_request: synchronize` path), so a branch
  // that was just fixed — by its author or by a heal push — reads "resolved"
  // within minutes instead of at the next merge to the base.
  const pulls = only
    ? [await api.request("GET", `/repos/${repo}/pulls/${only}`)].filter((p) => p.state === "open" && p.base?.ref === base)
    : await api.paginate(`/repos/${repo}/pulls?state=open&base=${encodeURIComponent(base)}`);
  const pushed = (n) => Object.hasOwn(restacked, String(n));
  const numbers = pulls.map((p) => p.number).filter((n) => !pushed(n));
  const unfetched = new Set(fetch(numbers, { cwd }));
  const tally = { probed: 0, conflicted: 0, stacked: 0, restacked: 0, created: 0, updated: 0, unchanged: 0, skipped: [...unfetched], failedWrites: [] };
  const rows = [];
  const resolver = squashResolver({ api, repo, cwd, fetch, localRef: LOCAL_REF, log });
  const cache = new Map();

  for (const pr of pulls) {
    if (pushed(pr.number)) {
      // Clean against the base the restack job merged: its own push. The
      // ref is not re-read; the next push to either side probes it again.
      tally.restacked += 1;
      const at = restacked[String(pr.number)].baseSha;
      const comments = await api.paginate(`/repos/${repo}/issues/${pr.number}/comments`);
      const existing = comments.find(isOwnComment) ?? null;
      await write(pr, decide(null, existing, { base, baseSha: at }), existing, null);
      continue;
    }
    if (unfetched.has(pr.number)) {
      log(`#${pr.number}: head could not be fetched — skipped`);
      continue;
    }
    const head = revParse(LOCAL_REF(pr.number), cwd);
    if (!head) {
      tally.skipped.push(pr.number);
      log(`#${pr.number}: fetched ref did not resolve — skipped`);
      continue;
    }
    let records;
    try {
      records = analyzeMerge({ mainSide: baseSha, branchSide: head, config, baseTip: baseSha, cwd });
    } catch (err) {
      // One PR git cannot merge (unrelated histories, a missing object) must
      // not cost every other PR its comment.
      tally.skipped.push(pr.number);
      log(`#${pr.number}: could not re-run the merge — ${err.message}`);
      continue;
    }
    let stack = null;
    if (records) {
      try {
        const found = await stackOf({ head, records, baseSha, resolver, self: pr.number, cwd, cache });
        if (found) {
          // The residual conflicts: what is left with the parent's
          // pre-squash head as an extra merge base. The rest is the parent's
          // own code meeting its squash, which the re-stack resolves.
          records = analyzeMerge({ mainSide: found.z, branchSide: head, config, baseTip: baseSha, cwd }) ?? [];
          stack = { parents: found.parents, command, recipe: recipeOf({ base, parents: found.parents, child: pr.number }) };
        }
      } catch (err) {
        log(`#${pr.number}: could not test for a squash-merged parent — ${err.message}`);
      }
    }
    tally.probed += 1;
    if (records || stack) {
      tally.conflicted += 1;
      if (stack) tally.stacked += 1;
      rows.push({ pr, records: records ?? [], stack });
    }
    const comments = await api.paginate(`/repos/${repo}/issues/${pr.number}/comments`);
    const existing = comments.find(isOwnComment) ?? null;
    await write(pr, decide(records, existing, { base, baseSha, stack }), existing, records, stack);
  }

  async function write(pr, plan, existing, records, stack = null) {
    if (plan.action === "none") {
      if (records || existing || stack) tally.unchanged += 1;
      return;
    }
    const verb = plan.action === "create" ? "comment" : "update the comment on";
    if (dryRun) {
      log(`#${pr.number}: would ${verb} the PR (dry run)`);
      return;
    }
    try {
      if (plan.action === "create") {
        // Re-read right before creating: a full probe and a single-PR probe
        // run in different concurrency groups, and both may have started
        // before either wrote. The second one to get here edits instead.
        const again = (await api.paginate(`/repos/${repo}/issues/${pr.number}/comments`)).find(isOwnComment);
        if (again) await api.request("PATCH", `/repos/${repo}/issues/comments/${again.id}`, { body: plan.body });
        else await api.request("POST", `/repos/${repo}/issues/${pr.number}/comments`, { body: plan.body });
        tally.created += 1;
      } else {
        await api.request("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body: plan.body });
        tally.updated += 1;
      }
      const what = records?.length || stack ? `${records?.length ?? 0} conflicted file(s)${stack ? ", stacked" : ""}` : "resolved";
      log(`#${pr.number}: ${plan.action === "create" ? "commented" : "updated the comment"} (${what})`);
    } catch (err) {
      tally.failedWrites.push(pr.number);
      log(`#${pr.number}: could not ${verb} the PR — ${err.message}`);
    }
  }
  log(
    `probed ${tally.probed} of ${pulls.length} open PR(s) against ${base}@${baseSha.slice(0, 7)}: ` +
      `${tally.conflicted} conflicted (${tally.stacked} stacked), ${tally.restacked} re-stacked by the restack job; ` +
      `${tally.created} commented, ${tally.updated} updated, ` +
      `${tally.unchanged} unchanged, ${tally.skipped.length} skipped`,
  );
  return { tally, rows };
}

export function probeSummary({ tally, rows }, { base }) {
  const out = [`## Conflict monitor — open PRs against \`${base}\``, ""];
  const extra = tally.stacked || tally.restacked ? ` (${tally.stacked} stacked on a squash-merged parent; ${tally.restacked} re-stacked by the restack job)` : "";
  out.push(`Probed ${tally.probed}; **${tally.conflicted} conflicted**${extra}; ${tally.created} commented, ${tally.updated} updated, ${tally.skipped.length} skipped.`, "");
  if (rows.length) {
    out.push("| PR | files | groups |", "|---|---|---|");
    for (const { pr, records, stack } of rows) {
      const groups = [...new Set(records.map((r) => r.bucket))].sort().join(", ");
      const on = stack ? ` (stacked on ${stack.parents.map((p) => `#${p.pr}`).join(", ")})` : "";
      out.push(`| #${pr.number}${on} | ${records.length} | ${groups} |`);
    }
  }
  return out.join("\n") + "\n";
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const base = process.env.BASE_BRANCH || process.env.GITHUB_REF_NAME;
  const configPath = process.env.CONFIG_PATH || ".github/conflict-monitor.json";
  const config = loadConfig(configPath);
  const baseSha = revParse(process.env.BASE_SHA || `origin/${base}`) ?? revParse("HEAD");
  const only = process.env.PR_NUMBER ? Number(process.env.PR_NUMBER) : null;
  if (!repo || !base || !baseSha) throw new Error("needs GITHUB_REPOSITORY, a base branch and a checkout");
  const restacked = parseRestacked(process.env.RESTACKED ?? "");
  // Only the command line is read from the `restack` block, and a bad block
  // is the restack job's to fail: the probe still writes its comments.
  let command = null;
  try {
    command = loadRestackConfig(configPath).restack?.command ?? null;
  } catch (err) {
    log(`the "restack" block is not usable here (${err.message}); the comment shows the git recipe only`);
  }
  const result = await runProbe({ api: githubClient(), repo, base, baseSha, config, only, dryRun: process.env.DRY_RUN === "true", restacked, command });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, probeSummary(result, { base }));
  if (result.tally.probed === 0 && result.tally.skipped.length > 0) {
    // Every head failed to fetch or merge: auth, network, a broken checkout.
    // "Probed 0" is not "nothing conflicts".
    console.log(`::error::probed none of ${result.tally.skipped.length} open PR(s) — every one was skipped`);
    process.exitCode = 1;
  }
  if (result.tally.failedWrites.length) {
    console.log(`::error::could not write the conflict comment on ${result.tally.failedWrites.map((n) => `#${n}`).join(", ")}`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.log(`::error::${err.message}`);
    process.exitCode = 1;
  });
}
