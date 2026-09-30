#!/usr/bin/env node
/* global process */
/**
 * `overlap`: tell two open PRs, BEFORE either merges, that whichever merges
 * second will conflict — and tell both of them.
 *
 * `probe` says so after the base has moved; by then one of the two has merged
 * and the other has a conflict to resolve. Here every unordered pair of open
 * PRs is merged against each other the way git would (lib/overlap.mjs), and a
 * predicted conflict becomes ONE overlap comment on each PR, naming the
 * partner, the path and the kind (lib/overlap-state.mjs keeps its memory,
 * lib/comment.mjs renders it). A pair that only shares a file and merges
 * cleanly goes to the job summary and the log line, never to a comment.
 *
 * Every run is a full recompute over every open PR, and it writes other PRs'
 * comments — so it runs under ONE repository-wide concurrency group, and a
 * newer pending run replacing an older one loses nothing.
 *
 * Nothing happens without an `overlap` key in the caller's config: the mode
 * exits 0 having read nothing and written nothing. A PR whose head or files
 * cannot be read is logged and skipped, and its partners keep what their
 * comments already said about it. A failed WRITE fails the run, as in `probe`.
 */
import { appendFileSync } from "node:fs";

import { codeOf, renderOverlap } from "./lib/comment.mjs";
import { bucketOf, loadOverlapConfig } from "./lib/config.mjs";
import { isMain } from "./lib/entry.mjs";
import { pathExists, revParse } from "./lib/git.mjs";
import { githubClient } from "./lib/github.mjs";
import { analyzePair, pathSetOf } from "./lib/overlap.mjs";
import { isOverlapComment, partnersOf, planOverlap, readComment } from "./lib/overlap-state.mjs";
import { LOCAL_REF, fetchHeads } from "./probe.mjs";

const log = (msg) => console.log(`[conflict-monitor] ${msg}`);
const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** A path the caller's `overlap` block ignores: by glob, or by the bucket that claims it. */
export function ignorerFor({ config, overlap, baseSha, cwd }) {
  const present = new Map();
  const exists = (p) => {
    if (!present.has(p)) present.set(p, pathExists(baseSha, p, cwd));
    return present.get(p);
  };
  return (path) =>
    overlap.ignorePaths.some((re) => re.test(path)) ||
    (overlap.ignoreBuckets.size > 0 && overlap.ignoreBuckets.has(bucketOf(path, config, exists)));
}

/** Every open PR's head and paths; the ones that cannot be read are `skipped`. */
async function readPulls({ api, repo, pulls, fetch, cwd, ignored }) {
  const skipped = new Set(fetch(pulls.map((p) => p.number), { cwd }));
  const sides = [];
  for (const pr of pulls) {
    if (skipped.has(pr.number)) {
      log(`#${pr.number}: head could not be fetched — skipped`);
      continue;
    }
    const head = revParse(LOCAL_REF(pr.number), cwd);
    if (!head) {
      skipped.add(pr.number);
      log(`#${pr.number}: fetched ref did not resolve — skipped`);
      continue;
    }
    try {
      const files = await api.paginate(`/repos/${repo}/pulls/${pr.number}/files`);
      sides.push({ number: pr.number, head, paths: pathSetOf(files, ignored) });
    } catch (err) {
      skipped.add(pr.number);
      log(`#${pr.number}: files could not be listed — skipped (${err.message})`);
    }
  }
  return { sides, skipped };
}

/** Every unordered pair, once. `rows` holds each PR's rows from this run. */
function analyzeAll(sides, { baseSha, cwd }) {
  const cache = new Map();
  const rows = new Map(sides.map((s) => [s.number, []]));
  const r2 = [];
  const r1 = [];
  const failed = new Set();
  for (let i = 0; i < sides.length; i += 1) {
    for (let j = i + 1; j < sides.length; j += 1) {
      const [a, b] = [sides[i], sides[j]];
      let result;
      try {
        result = analyzePair({ baseSha, a, b, cwd, cache });
      } catch (err) {
        failed.add(pairKey(a.number, b.number));
        log(`#${a.number} × #${b.number}: could not merge the pair — skipped (${err.message})`);
        continue;
      }
      if (result.stacked) continue;
      if (result.overlaps.length) {
        r2.push({ a: a.number, b: b.number, overlaps: result.overlaps });
        for (const [self, partner] of [[a.number, b.number], [b.number, a.number]]) {
          rows.get(self).push(...result.overlaps.map((o) => ({ partner, path: o.path, kind: o.kind })));
        }
      } else if (result.shared.length) {
        r1.push({ a: a.number, b: b.number, shared: result.shared });
      }
    }
  }
  return { rows, r2, r1, failed };
}

/**
 * Whether a partner that left the open list merged. One `GET /pulls/{n}` per
 * partner per run; a 404 is a partner that never was, an error is "unknown"
 * (its rows are kept as they were, so a flaky read does not flap the comment).
 */
function partnerStates({ api, repo }) {
  const seen = new Map();
  return async (n) => {
    if (!seen.has(n)) {
      let state;
      try {
        const pr = await api.request("GET", `/repos/${repo}/pulls/${n}`);
        state = pr?.merged_at || pr?.merged === true ? "merged" : "closed";
      } catch (err) {
        state = err.status === 404 ? "closed" : "unknown";
        if (state === "unknown") log(`#${n}: state could not be read — its rows are kept (${err.message})`);
      }
      seen.set(n, state);
    }
    return seen.get(n);
  };
}

/**
 * This run's rows for one PR, plus what its previous comment said about the
 * partners this run could not see: a partner that could not be read keeps its
 * rows; one that left the open list becomes a merged row, or is dropped when it
 * closed without merging.
 */
async function rowsFor(self, { live, prev, open, readable, failed, stateOf }) {
  const rows = [...(live.get(self) ?? [])];
  if (!prev?.trusted) return rows;
  for (const partner of partnersOf(prev.rows)) {
    const before = prev.rows.filter((r) => r.partner === partner);
    if (open.has(partner)) {
      // Open and read this run: this run's rows are the answer, even none. An
      // ignored head is never paired, so there is nothing to say about it.
      if (!open.get(partner).paired) continue;
      // Open, but its head, its files or the pair's merge could not be read:
      // keep what the comment said, so the next good run is not a re-post.
      if (!readable.has(partner) || failed.has(pairKey(self, partner))) rows.push(...before);
      continue;
    }
    if (before.every((r) => r.merged)) {
      rows.push(...before);
      continue;
    }
    const state = await stateOf(partner);
    if (state === "merged") rows.push(...before.map((r) => ({ ...r, merged: true })));
    else if (state === "unknown") rows.push(...before);
  }
  return rows;
}

async function writePlan({ api, repo, self, plan, existing, extras, body, dryRun, tally }) {
  const deletes = [...extras, ...(plan.action === "repost" ? [existing] : [])];
  if (plan.action === "none" && !deletes.length) {
    tally.unchanged += 1;
    return;
  }
  if (dryRun) {
    log(`#${self}: would ${plan.action === "none" ? "delete a duplicate overlap comment" : `${plan.action} the overlap comment`} (dry run)`);
    return;
  }
  try {
    // Create BEFORE delete: if the create fails, the old comment is still
    // there; if the delete fails, the next run keeps the newest and deletes
    // the rest.
    if (plan.action === "create" || plan.action === "repost") {
      await api.request("POST", `/repos/${repo}/issues/${self}/comments`, { body });
      tally[plan.action === "create" ? "created" : "reposted"] += 1;
    } else if (plan.action === "update") {
      await api.request("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
      tally.updated += 1;
    }
    for (const c of deletes) {
      await api.request("DELETE", `/repos/${repo}/issues/comments/${c.id}`);
      tally.deleted += 1;
    }
    if (plan.action !== "none") log(`#${self}: ${plan.action} the overlap comment (${plan.rows.length} row(s))`);
  } catch (err) {
    tally.failedWrites.push(self);
    log(`#${self}: could not write the overlap comment — ${err.message}`);
  }
}

export async function runOverlap({ api, repo, base, baseSha, config, overlap, cwd = process.cwd(), fetch = fetchHeads, dryRun = false }) {
  const listed = await api.paginate(`/repos/${repo}/pulls?state=open&base=${encodeURIComponent(base)}`);
  // Only PRs whose base IS the base: a stack member above the bottom targets
  // its parent's branch and is never paired. Drafts are paired — most PRs
  // open as drafts, and leaving them out would forfeit the lead time.
  const pulls = listed.filter((p) => p.base?.ref === base).sort((a, b) => a.number - b.number);
  const ignoredHead = (p) => overlap.ignoreHeads.some((h) => (p.head?.ref ?? "").startsWith(h));
  const paired = pulls.filter((p) => !ignoredHead(p));
  const open = new Map(pulls.map((p) => [p.number, { paired: !ignoredHead(p) }]));
  const ignored = ignorerFor({ config, overlap, baseSha, cwd });
  const { sides, skipped } = await readPulls({ api, repo, pulls: paired, fetch, cwd, ignored });
  const { rows: live, r2, r1, failed } = analyzeAll(sides, { baseSha, cwd });
  const tally = { open: pulls.length, paired: paired.length, created: 0, updated: 0, reposted: 0, deleted: 0, unchanged: 0, skipped: [...skipped].sort((a, b) => a - b), failedWrites: [] };
  const result = { tally, r2, r1, failedPairs: [...failed] };
  if (!overlap.comment) {
    log("`overlap.comment` is false: summary and log line only");
    return result;
  }
  const readable = new Set(sides.map((s) => s.number));
  const stateOf = partnerStates({ api, repo });
  for (const { number: self } of sides) {
    const comments = await api.paginate(`/repos/${repo}/issues/${self}/comments`);
    const own = comments.filter(isOverlapComment).sort((a, b) => a.id - b.id);
    const existing = own.at(-1) ?? null;
    const prev = existing ? readComment(existing, { self, open: new Set(open.keys()) }) : null;
    if (prev && !prev.trusted) log(`#${self}: the overlap comment's entries did not validate — recomputed from this run`);
    const rows = await rowsFor(self, { live, prev, open, readable, failed, stateOf });
    const plan = planOverlap(prev, rows);
    const body = plan.action === "none" ? null : renderOverlap(plan, { base, baseSha });
    await writePlan({ api, repo, self, plan, existing, extras: own.slice(0, -1), body, dryRun, tally });
  }
  log(
    `${r2.length} predicted conflict(s) and ${r1.length} shared-file pair(s) among ${sides.length} of ${pulls.length} open PR(s) ` +
      `against ${base}@${baseSha.slice(0, 7)}: ${tally.created} created, ${tally.reposted} re-posted, ${tally.updated} updated, ` +
      `${tally.deleted} deleted, ${tally.skipped.length} skipped`,
  );
  return result;
}

/** The one machine-readable line a run prints: the record a later script counts pairs from. */
export function overlapLogLine({ tally, r2, r1, failedPairs }, { baseSha, stats }) {
  return `overlap-pairs ${JSON.stringify({
    base: baseSha,
    open: tally.open,
    reads: stats?.reads ?? null,
    rateUsed: stats?.rateUsed ?? null,
    rateLimit: stats?.rateLimit ?? null,
    r2: r2.map((p) => [p.a, p.b, [...new Set(p.overlaps.map((o) => o.path))]]),
    r1: r1.map((p) => [p.a, p.b]),
    skipped: tally.skipped,
    failedPairs,
  })}`;
}

export function overlapSummary({ tally, r2, r1 }, { base, baseSha }) {
  const out = [`## Conflict monitor — overlapping open PRs against \`${base}\``, ""];
  out.push(
    `${tally.open} open PR(s) at \`${baseSha.slice(0, 7)}\`, ${tally.paired} paired: **${r2.length} predicted conflict(s)**, ` +
      `${r1.length} pair(s) sharing a file that merges cleanly. ${tally.created} commented, ${tally.reposted} re-posted, ` +
      `${tally.updated} updated, ${tally.skipped.length} skipped.`,
    "",
  );
  if (r2.length) {
    out.push("### Predicted conflicts (commented on both PRs)", "", "| PRs | file | overlap |", "|---|---|---|");
    for (const p of r2) for (const o of p.overlaps) out.push(`| #${p.a} × #${p.b} | ${codeOf(o.path)} | ${codeOf(o.kind)} |`);
    out.push("");
  }
  if (r1.length) {
    out.push("### Shared files that merge cleanly (no comment)", "", "| PRs | shared files |", "|---|---|");
    for (const p of r1) {
      const files = p.shared.slice(0, 10).map(codeOf).join(", ") + (p.shared.length > 10 ? ` +${p.shared.length - 10}` : "");
      out.push(`| #${p.a} × #${p.b} | ${files} |`);
    }
    out.push("");
  }
  return out.join("\n");
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const base = process.env.BASE_BRANCH || process.env.GITHUB_REF_NAME;
  const configPath = process.env.CONFIG_PATH || ".github/conflict-monitor.json";
  const { config, overlap } = loadOverlapConfig(configPath);
  if (!overlap) {
    // The consumer PR that adds the key is green on arrival: its own run
    // checks out the BASE, whose config does not have the key yet.
    log(`no "overlap" key in ${configPath}: nothing to do`);
    return;
  }
  const baseSha = revParse(process.env.BASE_SHA || `origin/${base}`) ?? revParse("HEAD");
  if (!repo || !base || !baseSha) throw new Error("needs GITHUB_REPOSITORY, a base branch and a checkout");
  const api = githubClient();
  const result = await runOverlap({ api, repo, base, baseSha, config, overlap, dryRun: process.env.DRY_RUN === "true" });
  console.log(overlapLogLine(result, { baseSha, stats: api.stats }));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, overlapSummary(result, { base, baseSha }));
  if (result.tally.paired > 0 && result.tally.skipped.length === result.tally.paired) {
    // Every head or files list failed: auth, network, a broken checkout.
    console.log(`::error::read none of ${result.tally.paired} open PR(s) — every one was skipped`);
    process.exitCode = 1;
  }
  if (result.tally.failedWrites.length) {
    console.log(`::error::could not write the overlap comment on ${result.tally.failedWrites.map((n) => `#${n}`).join(", ")}`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.log(`::error::${err.message}`);
    process.exitCode = 1;
  });
}
