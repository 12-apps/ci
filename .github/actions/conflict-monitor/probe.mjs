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
 * A PR this cannot probe (its head could not be fetched) is reported in the
 * log and skipped: the other PRs' comments are still worth writing. A failed
 * WRITE fails the run, because a monitor that cannot comment is one nobody
 * hears — and a run started with the workflow token has no watcher that would
 * notice it silently stopped.
 */
import { appendFileSync } from "node:fs";

import { analyzeMerge } from "./lib/analyze.mjs";
import { MARKER, decide } from "./lib/comment.mjs";
import { loadConfig } from "./lib/config.mjs";
import { git, revParse } from "./lib/git.mjs";
import { githubClient } from "./lib/github.mjs";

const log = (msg) => console.log(`[conflict-monitor] ${msg}`);
const LOCAL_REF = (n) => `refs/conflict-monitor/pr/${n}`;

/** Fetch every PR head into a local ref, in batches; returns the numbers that failed. */
export function fetchHeads(numbers, { cwd, remote = "origin", batch = 50 } = {}) {
  const failed = [];
  for (let i = 0; i < numbers.length; i += batch) {
    const slice = numbers.slice(i, i + batch);
    const specs = slice.map((n) => `+refs/pull/${n}/head:${LOCAL_REF(n)}`);
    const res = git(["fetch", "--no-tags", "--quiet", remote, ...specs], { cwd, ok: [0, 1, 128] });
    if (res.status === 0) continue;
    // One bad ref fails the whole batch; retry one by one to find it.
    for (const n of slice) {
      const one = git(["fetch", "--no-tags", "--quiet", remote, `+refs/pull/${n}/head:${LOCAL_REF(n)}`], { cwd, ok: [0, 1, 128] });
      if (one.status !== 0) failed.push(n);
    }
  }
  return failed;
}

export async function runProbe({ api, repo, base, baseSha, config, only = null, cwd = process.cwd(), fetch = fetchHeads, dryRun = false }) {
  // `only`: probe one PR (the `pull_request: synchronize` path), so a branch
  // that was just fixed — by its author or by a heal push — reads "resolved"
  // within minutes instead of at the next merge to the base.
  const pulls = only
    ? [await api.request("GET", `/repos/${repo}/pulls/${only}`)].filter((p) => p.state === "open" && p.base?.ref === base)
    : await api.paginate(`/repos/${repo}/pulls?state=open&base=${encodeURIComponent(base)}`);
  const numbers = pulls.map((p) => p.number);
  const unfetched = new Set(fetch(numbers, { cwd }));
  const tally = { probed: 0, conflicted: 0, created: 0, updated: 0, unchanged: 0, skipped: [...unfetched], failedWrites: [] };
  const rows = [];

  for (const pr of pulls) {
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
    tally.probed += 1;
    const records = analyzeMerge({ mainSide: baseSha, branchSide: head, config, baseTip: baseSha, cwd });
    if (records) {
      tally.conflicted += 1;
      rows.push({ pr, records });
    }
    const comments = await api.paginate(`/repos/${repo}/issues/${pr.number}/comments`);
    const existing = comments.find((c) => typeof c.body === "string" && c.body.startsWith(MARKER)) ?? null;
    const plan = decide(records, existing, { base, baseSha });
    if (plan.action === "none") {
      if (records || existing) tally.unchanged += 1;
      continue;
    }
    const verb = plan.action === "create" ? "comment" : "update the comment on";
    if (dryRun) {
      log(`#${pr.number}: would ${verb} the PR (dry run)`);
      continue;
    }
    try {
      if (plan.action === "create") {
        // Re-read right before creating: a full probe and a single-PR probe
        // run in different concurrency groups, and both may have started
        // before either wrote. The second one to get here edits instead.
        const again = (await api.paginate(`/repos/${repo}/issues/${pr.number}/comments`)).find(
          (c) => typeof c.body === "string" && c.body.startsWith(MARKER),
        );
        if (again) await api.request("PATCH", `/repos/${repo}/issues/comments/${again.id}`, { body: plan.body });
        else await api.request("POST", `/repos/${repo}/issues/${pr.number}/comments`, { body: plan.body });
        tally.created += 1;
      } else {
        await api.request("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body: plan.body });
        tally.updated += 1;
      }
      log(`#${pr.number}: ${plan.action === "create" ? "commented" : "updated the comment"} (${records ? `${records.length} conflicted file(s)` : "resolved"})`);
    } catch (err) {
      tally.failedWrites.push(pr.number);
      log(`#${pr.number}: could not ${verb} the PR — ${err.message}`);
    }
  }
  log(
    `probed ${tally.probed} of ${pulls.length} open PR(s) against ${base}@${baseSha.slice(0, 7)}: ` +
      `${tally.conflicted} conflicted; ${tally.created} commented, ${tally.updated} updated, ` +
      `${tally.unchanged} unchanged, ${tally.skipped.length} skipped`,
  );
  return { tally, rows };
}

export function probeSummary({ tally, rows }, { base }) {
  const out = [`## Conflict monitor — open PRs against \`${base}\``, ""];
  out.push(`Probed ${tally.probed}; **${tally.conflicted} conflicted**; ${tally.created} commented, ${tally.updated} updated, ${tally.skipped.length} skipped.`, "");
  if (rows.length) {
    out.push("| PR | files | groups |", "|---|---|---|");
    for (const { pr, records } of rows) {
      const groups = [...new Set(records.map((r) => r.bucket))].sort().join(", ");
      out.push(`| #${pr.number} | ${records.length} | ${groups} |`);
    }
  }
  return out.join("\n") + "\n";
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const base = process.env.BASE_BRANCH || process.env.GITHUB_REF_NAME;
  const config = loadConfig(process.env.CONFIG_PATH || ".github/conflict-monitor.json");
  const baseSha = revParse(process.env.BASE_SHA || `origin/${base}`) ?? revParse("HEAD");
  const only = process.env.PR_NUMBER ? Number(process.env.PR_NUMBER) : null;
  if (!repo || !base || !baseSha) throw new Error("needs GITHUB_REPOSITORY, a base branch and a checkout");
  const result = await runProbe({ api: githubClient(), repo, base, baseSha, config, only, dryRun: process.env.DRY_RUN === "true" });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, probeSummary(result, { base }));
  if (result.tally.failedWrites.length) {
    console.log(`::error::could not write the conflict comment on ${result.tally.failedWrites.map((n) => `#${n}`).join(", ")}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.log(`::error::${err.message}`);
    process.exitCode = 1;
  });
}
