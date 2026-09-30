#!/usr/bin/env node
/* global process */
/**
 * `report`: every time a PR branch took the base branch in and it did not
 * merge cleanly — replayed, classified and counted.
 *
 * A sync that conflicts means somebody merged something into the base that
 * collided with the PR. The evidence is the merge commit the PR author made
 * to resolve it; `git merge-tree` re-runs that merge from its two parents and
 * reports exactly what conflicted, without a worktree. Rebased syncs leave no
 * merge commit and are invisible here — the report says so rather than
 * implying it saw everything.
 *
 * THE BASE LINE HAS TO BE REBUILT. "Which parent is the base side?" is
 * answered by membership in the base branch's first-parent history — but a
 * base branch whose history was ever rewritten (future-pay's was: 1,650 of its
 * 2,066 merge commits are not on today's `main`) no longer contains the
 * commits old PR branches merged in. So the line is the union of the
 * first-parent chains of every merged PR's merge commit plus today's tip;
 * GitHub keeps those commits reachable through `refs/pull/*`.
 *
 * Classification per conflicted file: the caller's bucket (lib/config.mjs)
 * when a rule claims the path; otherwise `code`, split by what the conflict
 * looked like:
 *
 *   code: stacked            the branch already held commits of a PR that
 *                            caused the conflict — a child meeting its own
 *                            squash-merged parent
 *   code: duplicated scope   add/add: both sides created the file
 *   code: append point       insert/insert: both sides added at the same spot
 *   code: moved or deleted   modify/delete, rename, file location
 *   code: concurrent edit    edit/edit: the same lines, changed twice
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { analyzeMerge } from "./lib/analyze.mjs";
import { codeOf } from "./lib/comment.mjs";
import { DEFAULT_BUCKET, loadConfig, ticketsIn } from "./lib/config.mjs";
import { isMain } from "./lib/entry.mjs";
import { countRange, git, lines, revParse } from "./lib/git.mjs";
import { githubClient } from "./lib/github.mjs";

const log = (msg) => console.log(`[conflict-monitor] ${msg}`);
export const PR_REF = (n) => `refs/conflict-monitor/pr/${n}`;

export const GROUPS = {
  stacked: `${DEFAULT_BUCKET}: stacked`,
  duplicate: `${DEFAULT_BUCKET}: duplicated scope`,
  append: `${DEFAULT_BUCKET}: append point`,
  moved: `${DEFAULT_BUCKET}: moved or deleted`,
  edit: `${DEFAULT_BUCKET}: concurrent edit`,
  other: `${DEFAULT_BUCKET}: other`,
};

/** The group a conflicted file is counted under. */
export function groupOf(record, { stacked }) {
  if (record.bucket !== DEFAULT_BUCKET) return record.bucket;
  if (stacked) return GROUPS.stacked;
  if (record.shape === "add/add") return GROUPS.duplicate;
  if (record.shape === "insert/insert") return GROUPS.append;
  if (record.shape === "edit/edit") return GROUPS.edit;
  if (/delete|rename|location/.test(record.shape)) return GROUPS.moved;
  return GROUPS.other;
}

/** First-parent union of every merged PR's merge commit and the base tip. */
export function baseLine({ prs, base, baseTip, cwd }) {
  const tips = prs
    .filter((p) => p.mergedAt && p.base === base && p.mergeCommit)
    .map((p) => p.mergeCommit)
    .filter((sha) => revParse(sha, cwd));
  tips.push(baseTip);
  const { out } = git(["rev-list", "--first-parent", "--stdin"], { cwd, input: tips.join("\n") + "\n" });
  return new Set(lines(out));
}

/**
 * Every merge commit a PR's own history holds that its base does not.
 * A merged PR is bounded by the first parent of its merge commit (what the
 * base was just before it landed); an unmerged one by today's base tip.
 */
function syncMergesOf(pr, { baseTip, cwd }) {
  const head = revParse(PR_REF(pr.number), cwd);
  if (!head) return [];
  const bound = pr.mergedAt && pr.mergeCommit && revParse(pr.mergeCommit, cwd) ? `${pr.mergeCommit}^1` : baseTip;
  const { out } = git(["rev-list", "--merges", "--parents", head, `^${bound}`], { cwd });
  return lines(out).map((l) => {
    const [commit, ...parents] = l.split(" ");
    return { commit, parents };
  });
}

/**
 * The branch already contained commits of `culprit`'s own PR: some of that
 * PR's commits are reachable from the branch side but not from the base side.
 */
function heldCommitsOf(culpritPr, { mainSide, branchSide, cwd, cache }) {
  const head = revParse(PR_REF(culpritPr), cwd);
  if (!head) return false;
  const key = `${culpritPr}:${mainSide}:${branchSide}`;
  if (!cache.has(key)) {
    // |H \ M ∩ B|: the culprit's commits that are not on the base side but
    // ARE on the branch side. Computed as |H \ M| − |H \ (M ∪ B)|, never as
    // |H \ M| − |H \ B|: a parent that merged the base after the child
    // branched holds base commits the child lacks, and those would cancel
    // out the commits the child really holds.
    const notOnBase = countRange(head, [mainSide], cwd);
    const onNeither = countRange(head, [mainSide, branchSide], cwd);
    cache.set(key, notOnBase - onNeither > 0);
  }
  return cache.get(key);
}

export function replay({ prs, base, baseTip, config, until = null, cwd = process.cwd(), onProgress = () => {} }) {
  const untilMs = until ? instant(until, "until") : null;
  const line = baseLine({ prs, base, baseTip, cwd });
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const syncs = [];
  let otherMerges = 0;
  const cache = new Map();
  prs.forEach((pr, i) => {
    if (i % 200 === 0) onProgress(i, prs.length);
    for (const { commit, parents } of syncMergesOf(pr, { baseTip, cwd })) {
      const date = git(["show", "-s", "--format=%cI", commit], { cwd }).out.trim();
      // `until` pins a replay to a moment: a merge committed after it is not
      // counted — in any column — so a report re-run later reproduces it.
      if (untilMs !== null && Date.parse(date) > untilMs) continue;
      const mainParents = parents.filter((p) => line.has(p));
      if (!mainParents.length) {
        otherMerges += 1;
        continue;
      }
      const mainSide = mainParents[0];
      const branchSide = parents.find((p) => p !== mainSide);
      if (!branchSide) continue;
      const records = analyzeMerge({ mainSide, branchSide, config, baseTip, cwd });
      if (!records) {
        syncs.push({ pr: pr.number, commit, date, conflicted: false, files: [] });
        continue;
      }
      const culpritPrs = new Set(records.flatMap((r) => r.culprits.map((c) => c.pr)).filter((n) => n && n !== pr.number));
      const stackedOn = [...culpritPrs].filter((n) => heldCommitsOf(n, { mainSide, branchSide, cwd, cache }));
      const stacked = stackedOn.length > 0;
      const mine = ticketsOf(pr, config);
      const files = records.map((r) => {
        const prsTouching = [...new Set(r.culprits.map((c) => c.pr).filter(Boolean))];
        const sameTicket =
          r.shape === "add/add" &&
          prsTouching.some((n) => {
            const other = byNumber.get(n);
            if (!other) return false;
            if (other.head && other.head === pr.head) return true;
            const theirs = ticketsOf(other, config);
            return [...mine].some((t) => theirs.has(t));
          });
        return { file: r.file, shape: r.shape, bucket: r.bucket, group: groupOf(r, { stacked }), culprits: prsTouching, sameTicket };
      });
      syncs.push({ pr: pr.number, commit, date, conflicted: true, stackedOn, files });
    }
  });
  return { syncs, otherMerges };
}

/** An ISO date or timestamp as epoch ms; an unparseable one is an error, never "no limit". */
export function instant(value, name) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${name} is not a date or timestamp: "${value}"`);
  return ms;
}

/** A PR's ticket ids, read from its title and its head branch name. */
const ticketsOf = (pr, config) => new Set([...ticketsIn(pr.title, config), ...ticketsIn(pr.head, config)]);

const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);

export function aggregate({ syncs, otherMerges }, { since, config }) {
  const conflicted = syncs.filter((s) => s.conflicted);
  // Compared as instants: `%cI` carries the committer's own UTC offset, so a
  // string comparison against a `…Z` bound is off by that offset at the edge.
  const sinceMs = instant(since, "since");
  const inWindow = (s) => Date.parse(s.date) >= sinceMs;
  const declared = new Set(config.rules.map((r) => r.name));
  const groups = new Map();
  const shapes = new Map();
  const files = { all: new Map(), window: new Map() };
  const culprits = new Map();
  let entries = 0;
  let windowEntries = 0;
  for (const s of conflicted) {
    const w = inWindow(s);
    for (const f of s.files) {
      entries += 1;
      if (w) windowEntries += 1;
      const g = groups.get(f.group) ?? { all: 0, window: 0 };
      g.all += 1;
      if (w) g.window += 1;
      groups.set(f.group, g);
      bump(shapes, f.shape);
      bump(files.all, f.file);
      if (w) bump(files.window, f.file);
    }
    for (const n of new Set(s.files.flatMap((f) => f.culprits))) bump(culprits, n);
  }
  const mechanicalOnly = conflicted.filter((s) => s.files.every((f) => declared.has(f.bucket))).length;
  const duplicates = conflicted.flatMap((s) => s.files.filter((f) => f.group === GROUPS.duplicate));
  return {
    since,
    syncs: {
      total: syncs.length,
      conflicted: conflicted.length,
      conflictedInWindow: conflicted.filter(inWindow).length,
      prsWithConflicts: new Set(conflicted.map((s) => s.pr)).size,
      // A stacked branch inherits its parent's merges, so one merge commit can
      // be counted under several PRs. The unit above is the (PR, merge) pair —
      // "this PR had to resolve this" — and this is the distinct-commit count.
      distinctMerges: new Set(syncs.map((s) => s.commit)).size,
      distinctConflictedMerges: new Set(conflicted.map((s) => s.commit)).size,
      mechanicalOnly,
      stacked: conflicted.filter((s) => s.stackedOn?.length).length,
      otherMerges,
    },
    files: { total: entries, inWindow: windowEntries },
    groups: [...groups.entries()]
      .map(([name, v]) => ({ name, declared: declared.has(name), ...v }))
      .sort((a, b) => b.window - a.window || b.all - a.all || a.name.localeCompare(b.name)),
    shapes: top(shapes, 50).map(([shape, count]) => ({ shape, count })),
    duplicatedScopeSameTicket: duplicates.filter((f) => f.sameTicket).length,
    topFiles: top(files.all, 20).map(([file, count]) => ({ file, count, inWindow: files.window.get(file) ?? 0 })),
    topFilesInWindow: top(files.window, 20).map(([file, count]) => ({ file, count })),
    topCulprits: top(culprits, 15).map(([pr, syncsTouched]) => ({ pr, syncsTouched })),
  };
}

const cell = (s) => String(s).replace(/[&<>|`\\_*[\]]/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderReport(r, { repo, base }) {
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "—");
  const out = [
    `## Conflict report — ${repo}, syncs with \`${base}\``,
    "",
    `Every merge of \`${base}\` into a PR branch, replayed with \`git merge-tree\`. Rebased syncs leave no merge commit and are not counted.`,
    "",
    `* **${r.syncs.conflicted} of ${r.syncs.total} syncs conflicted** (${pct(r.syncs.conflicted, r.syncs.total)}), across ${r.syncs.prsWithConflicts} PRs; ${r.syncs.conflictedInWindow} since ${r.since.slice(0, 10)}. A sync is a (PR, merge) pair: a stacked branch inherits its parent's merges, so these are ${r.syncs.distinctConflictedMerges} of ${r.syncs.distinctMerges} distinct merge commits.`,
    `* ${r.files.total} conflicted files in total, **${r.files.inWindow} since ${r.since.slice(0, 10)}**.`,
    `* ${r.syncs.mechanicalOnly} conflicted syncs (${pct(r.syncs.mechanicalOnly, r.syncs.conflicted)}) touched ONLY declared groups; ${r.syncs.stacked} were a stacked branch meeting its parent.`,
    "",
    `| group | all | since ${r.since.slice(0, 10)} |`,
    "|---|---|---|",
    ...r.groups.map((g) => `| ${g.declared ? cell(g.name) : `_${cell(g.name)}_`} | ${g.all} | ${g.window} |`),
    "",
    `Declared groups come from the caller's config; _italic_ rows are files no rule claims, split by conflict shape. ${r.duplicatedScopeSameTicket} of the duplicated-scope files were created by two PRs sharing a ticket id or a branch.`,
    "",
    `### Most conflicted files since ${r.since.slice(0, 10)}`,
    "",
    "| file | conflicts |",
    "|---|---|",
    ...r.topFilesInWindow.map((f) => `| ${codeOf(f.file)} | ${f.count} |`),
    "",
    "### Base-branch PRs behind the most conflicting syncs (candidates: they touched a conflicted file)",
    "",
    ...r.topCulprits.map((c) => `* #${c.pr} — ${c.syncsTouched} sync(s)`),
  ];
  return out.join("\n") + "\n";
}

async function listPulls(api, repo) {
  const raw = await api.paginate(`/repos/${repo}/pulls?state=all&sort=created&direction=asc`);
  return raw.map((p) => ({
    number: p.number,
    title: p.title ?? "",
    head: p.head?.ref ?? "",
    base: p.base?.ref ?? "",
    mergedAt: p.merged_at ?? null,
    mergeCommit: p.merge_commit_sha ?? null,
  }));
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  // A `schedule` payload carries no repository object, so the action's
  // default-branch fallback is empty there; GITHUB_REF_NAME is the default
  // branch on a scheduled run.
  const base = process.env.BASE_BRANCH || process.env.GITHUB_REF_NAME || "main";
  const config = loadConfig(process.env.CONFIG_PATH || ".github/conflict-monitor.json");
  const days = Number(process.env.WINDOW_DAYS || 7);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`window-days must be a positive number, got "${process.env.WINDOW_DAYS}"`);
  const since = process.env.SINCE || new Date(Date.now() - days * 86_400_000).toISOString();
  const until = process.env.UNTIL || null;
  const prs = process.env.PRS_FILE
    ? readFileSync(process.env.PRS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : await listPulls(githubClient(), repo);
  if (process.env.SKIP_FETCH !== "true") {
    git(["fetch", "--no-tags", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`, `+refs/pull/*/head:${PR_REF("*")}`]);
  }
  const baseTip = revParse(process.env.BASE_TIP || `origin/${base}`) ?? revParse("HEAD");
  log(`replaying the sync merges of ${prs.length} PR(s) against ${base}@${baseTip.slice(0, 7)}`);
  const result = replay({ prs, base, baseTip, config, until, onProgress: (i, n) => log(`${i}/${n} PRs`) });
  const report = aggregate(result, { since, config });
  const md = renderReport(report, { repo, base });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  else console.log(md);
  const outPath = process.env.OUT || "conflict-report/report.json";
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ repo, base, baseTip, until, report, syncs: result.syncs }, null, 1));
  log(`wrote ${outPath}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.log(`::error::${err.message}`);
    process.exitCode = 1;
  });
}
