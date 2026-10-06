#!/usr/bin/env node
/* global process */
/**
 * `restack`: after a parent PR is squash-merged, take the base into each open
 * PR cut from the parent's branch, with the parent's pre-squash head as an
 * extra merge base, and push the merge — or, when that merge still
 * conflicts, push nothing and leave the PR to the probe's comment.
 *
 * The algorithm is lib/restack.mjs; this file is who may be written to, and
 * the push.
 *
 * WHO IS NEVER WRITTEN TO: a fork; a PR whose base is not the default
 * branch (a real `gh stack` member, which GitHub re-stacks, or an ad-hoc
 * `--base` PR); the heads `main`, `master`, `develop`, `release/*`; a branch
 * under classic branch protection, or under a ruleset rule that stops a
 * fast-forward push (`protectionOf` — NOT the branch API's `protected` flag,
 * which a repo-wide naming or no-force-push ruleset sets on every branch);
 * a head matching `restack.ignoreHeads`;
 * and a PR whose head branch was force-pushed over one of the bot's re-stacks
 * for the same parent (the probe's comment carries the command instead).
 * Drafts ARE re-stacked.
 *
 * THE PUSH is a compare-and-swap: `--force-with-lease=<ref>:<planned head>`,
 * after asserting that the new commit descends from that head, so nothing is
 * ever rewritten. A branch the author moved or deleted fails the lease — it
 * is never overwritten and never recreated — and the next event re-plans. The
 * token travels as an http extraheader in the push call's environment only.
 *
 * A push a ruleset or a server hook refuses (`[remote rejected]`) fails that
 * PR's entry with a warning, never the run.
 *
 * Without a PUSH_TOKEN, or with `restack.push: false`, the mode plans, logs a
 * warning and pushes nothing. Without a `restack` key it exits 0 having read
 * and written nothing.
 *
 * THE TOKENS: PUSH_TOKEN and GITHUB_TOKEN are taken out of the environment
 * before any git call, so no git subprocess inherits them; the push alone
 * gets the PAT, as an extraheader in its own environment. Every git call runs
 * with hooks and fsmonitor off (lib/git.mjs `hardenGit`).
 */
import { appendFileSync } from "node:fs";

import { authEnv, readAuthEnv, redact } from "./lib/auth.mjs";
import { codeOf } from "./lib/comment.mjs";
import { loadRestackConfig } from "./lib/config.mjs";
import { isMain } from "./lib/entry.mjs";
import { git, hardenGit, isAncestor, mergeTree, revParse } from "./lib/git.mjs";
import { githubClient } from "./lib/github.mjs";
import { squashResolver } from "./lib/parents.mjs";
import { BOT, TRAILER, commitRestack, culpritSquashes, planRestack, restackMessage } from "./lib/restack.mjs";
import { LOCAL_REF, fetchHeads } from "./probe.mjs";

// Every line is redacted: a push error is git's own output.
const masked = [];
const log = (msg) => console.log(`[conflict-monitor] ${redact(msg, masked)}`);

/** Git never runs a hook or an fsmonitor from the checkout's config here. */
const HARDENED = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const PROTECTED_HEAD = /^(main|master|develop|release\/.+)$/;

/**
 * Ruleset rule types that stop the bot's push: a fast-forward merge commit on
 * an existing branch. `branch_name_pattern`, `non_fast_forward`, `deletion` and
 * `creation` never do. A message or e-mail pattern might; that push is refused
 * by the remote and handled per PR, like any other refusal.
 */
const BLOCKING_RULES = new Set([
  "update",
  "pull_request",
  "required_status_checks",
  "required_linear_history",
  "required_signatures",
  "required_deployments",
  "merge_queue",
]);

/**
 * Why the branch refuses the bot's push, or null. The branch API's `protected`
 * is true under ANY ruleset — future-pay's repo-wide naming ruleset
 * (`branch_name_pattern` + `non_fast_forward`) sets it on every branch, which
 * made the bot skip every PR there (FUT-3341 live proof, run 37452210190). So
 * the decision reads classic protection (`protection.enabled`) and the
 * effective rule types (`GET /rules/branches/{branch}`) instead.
 */
export function protectionOf(branch, rules) {
  if (branch?.protection?.enabled) return "a protected head (classic branch protection)";
  const blocking = [...new Set((rules ?? []).map((r) => r?.type).filter((t) => BLOCKING_RULES.has(t)))];
  return blocking.length ? `a protected head (ruleset: ${blocking.join(", ")})` : null;
}

/** Why the bot never writes to this PR, or null. */
export function exclusionOf(pr, { repo, base, restack }) {
  if (pr.state && pr.state !== "open") return "not open";
  if ((pr.head?.repo?.full_name ?? null) !== repo) return "a fork";
  if (pr.base?.ref !== base) return `its base is ${pr.base?.ref ?? "unknown"}, not ${base}`;
  const ref = pr.head?.ref ?? "";
  if (!ref || ref === base || PROTECTED_HEAD.test(ref)) return "a protected head";
  if (restack.ignoreHeads.some((p) => ref.startsWith(p))) return "an ignored head";
  return null;
}

/** A commit (as the compare API lists it) that is the bot's re-stack for one of `parents`. */
export function isBotRestack(c, parents) {
  const prs = new Set(parents.map((p) => p.pr));
  const trailer = new RegExp(`^${TRAILER.parent}:\\s*#(\\d+)\\s*$`, "gim");
  const byBot = [c?.commit?.author?.email, c?.commit?.committer?.email].includes(BOT.email);
  return byBot && [...(c?.commit?.message ?? "").matchAll(trailer)].some((m) => prs.has(Number(m[1])));
}

/**
 * The ping-pong cap: was the head branch ever force-pushed over one of the
 * bot's re-stacks for these parents? A re-stack is needed again only when the
 * branch no longer holds the last one, which only a force-push does; the bot
 * does not fight it.
 *
 * The record has to survive the force-push, and the PR timeline does not: it
 * lists only the commits the PR has now. The repository activity API keeps
 * every `force_push` of the ref with its `before` and `after`, and the compare
 * API still serves the commits a force-push discarded, so each force-push is
 * checked for a discarded bot re-stack: `compare/{after}...{before}` lists
 * exactly them. One activity read per candidate PR, one compare per
 * force-push of its branch (compare's first page: 250 commits, newest last).
 *
 * Both endpoints need `contents: read`, which the job's GITHUB_TOKEN (an
 * installation token) has; GitHub's REST docs list `GET /activity` and
 * `GET /compare` under "Contents" (read) for installation tokens. Only
 * force-pushes since the PR was opened (`since`) count: an older one belongs
 * to an earlier PR that used the same branch name. A compare that answers 404
 * (a discarded commit GitHub no longer keeps) is no bot re-stack; any other
 * error is thrown, and the caller skips the PR with a warning.
 * Returns the force-push found, or null.
 */
export async function forcePushOverRestack({ api, repo, ref, parents, since = null }) {
  const events = await api.paginate(`/repos/${repo}/activity?ref=${encodeURIComponent(`refs/heads/${ref}`)}&activity_type=force_push`);
  const from = since ? Date.parse(since) : null;
  for (const e of events) {
    if (e?.activity_type !== "force_push" || !e.before || !e.after) continue;
    if (from !== null && Date.parse(e.timestamp ?? "") < from) continue;
    let cmp;
    try {
      cmp = await api.request("GET", `/repos/${repo}/compare/${e.after}...${e.before}`);
    } catch (err) {
      if (err.status === 404) {
        log(`${ref}: force-push ${e.before.slice(0, 7)} -> ${e.after.slice(0, 7)} cannot be compared any more (404); not a bot re-stack`);
        continue;
      }
      throw err;
    }
    if ((cmp?.commits ?? []).some((c) => isBotRestack(c, parents))) return { before: e.before, after: e.after, at: e.timestamp ?? null };
  }
  return null;
}

/**
 * Push `commit` to `ref` only if the branch still is `expected`. Returns
 * `{ ok }`, `{ lease }` (the author moved or deleted the branch) or
 * `{ error }`. Never pushes a commit that does not descend from `expected`.
 */
export function pushRestack({ cwd, remote, ref, expected, commit, env }) {
  if (!isAncestor(expected, commit, cwd)) {
    throw new Error(`refusing to push ${commit.slice(0, 7)} to ${ref}: it does not descend from ${expected.slice(0, 7)}`);
  }
  const res = git(
    [...HARDENED, "push", "--porcelain", `--force-with-lease=refs/heads/${ref}:${expected}`, remote, `${commit}:refs/heads/${ref}`],
    { cwd, env, ok: [0, 1, 128] },
  );
  if (res.status === 0) return { ok: true };
  const text = `${res.out}\n${res.err}`;
  if (/\[rejected\][^\n]*(stale info|fetch first|non-fast-forward)/.test(text)) return { lease: true, detail: text.trim() };
  if (/\[remote rejected\]/.test(text)) return { rejected: true, detail: text.trim() };
  return { error: text.trim() || `git push exited ${res.status}` };
}

const segments = (ref) => ref.split("/").map(encodeURIComponent).join("/");
export const BRANCH_REF = (n) => `refs/conflict-monitor/branch/${n}`;

/**
 * Fetch each PR's head BRANCH, not `refs/pull/N/head`: that ref lags a push
 * by seconds, and a plan made on a stale head only fails its lease. Forks are
 * excluded before this, so every branch is in this repository. Returns the
 * numbers that failed (a branch already deleted, among others).
 */
export function fetchBranches(pulls, { cwd, remote = "origin", env } = {}) {
  const failed = [];
  const spec = (p) => `+refs/heads/${p.head.ref}:${BRANCH_REF(p.number)}`;
  if (!pulls.length) return failed;
  const all = git(["fetch", "--no-tags", "--quiet", remote, ...pulls.map(spec)], { cwd, env, ok: [0, 1, 128] });
  if (all.status === 0) return failed;
  for (const p of pulls) {
    if (git(["fetch", "--no-tags", "--quiet", remote, spec(p)], { cwd, env, ok: [0, 1, 128] }).status !== 0) failed.push(p.number);
  }
  return failed;
}

export async function runRestack({
  api,
  repo,
  base,
  baseSha,
  restack,
  only = null,
  cwd = process.cwd(),
  fetch = fetchHeads,
  fetchHeadBranches = fetchBranches,
  push = pushRestack,
  remote = "origin",
  pushEnv = {},
  canPush = false,
  date = null,
}) {
  const pulls = only
    ? [await api.request("GET", `/repos/${repo}/pulls/${only}`)].filter(Boolean)
    : await api.paginate(`/repos/${repo}/pulls?state=open`);
  const result = { base: baseSha, open: pulls.length, clean: 0, pushed: [], planned: [], residual: [], skipped: [], leaseFailed: [], rejected: [], failed: [] };
  const skip = (pr, reason) => {
    result.skipped.push({ pr: pr.number, reason });
    log(`#${pr.number}: skipped — ${reason}`);
  };

  const eligible = [];
  for (const pr of pulls) {
    const why = exclusionOf(pr, { repo, base, restack });
    if (why) skip(pr, why);
    else eligible.push(pr);
  }
  const unfetched = new Set(fetchHeadBranches(eligible, { cwd, remote }));
  const resolver = squashResolver({ api, repo, cwd, fetch, localRef: LOCAL_REF, log });
  const cache = new Map();

  // Plan every PR first, then push: a plan reads only what this run fetched.
  const ready = [];
  for (const pr of eligible) {
    const head = unfetched.has(pr.number) ? null : revParse(BRANCH_REF(pr.number), cwd);
    if (!head) {
      skip(pr, "its head branch could not be fetched");
      continue;
    }
    let plan;
    try {
      const merge = mergeTree(head, baseSha, cwd);
      if (!merge.conflicted) {
        result.clean += 1;
        continue;
      }
      const squashes = culpritSquashes({ base: baseSha, child: head, files: merge.files, cwd });
      await resolver.prime(squashes);
      plan = planRestack({ child: head, base: baseSha, cwd, resolve: resolver.get, self: pr.number, merge, squashes, cache });
    } catch (err) {
      skip(pr, `could not plan (${err.message})`);
      continue;
    }
    for (const s of plan.skipped ?? []) log(`#${pr.number}: parent #${s.pr} not used — ${s.reason}`);
    if (plan.status === "not-stacked") {
      skip(pr, "it conflicts, but not through a squash-merged parent it holds");
      continue;
    }
    const parents = plan.parents.map((p) => p.pr);
    if (plan.status === "residual") {
      result.residual.push({ pr: pr.number, parents, files: plan.residual });
      log(`#${pr.number}: stacked on ${parents.map((n) => `#${n}`).join(", ")}; still conflicts on ${plan.residual.length} file(s) — not pushed`);
      continue;
    }
    ready.push({ pr, head, plan, parents });
  }

  for (const { pr, head, plan, parents } of ready) {
    const ref = pr.head.ref;
    try {
      let over;
      try {
        over = await forcePushOverRestack({ api, repo, ref, parents: plan.parents, since: pr.created_at ?? null });
      } catch (err) {
        // Fail closed, and say so: without the record the bot cannot know
        // whether it would be fighting a force-push.
        const why = `could not read the force-push record of ${ref} (GET /activity and /compare need contents: read): ${err.message}`;
        console.log(redact(`::warning title=conflict-restack::#${pr.number}: ${why}; not re-stacked`, masked));
        skip(pr, why);
        continue;
      }
      if (over) {
        skip(pr, `force-pushed over the bot's re-stack for this parent (${over.before.slice(0, 7)} -> ${over.after.slice(0, 7)}); the probe's comment carries the command`);
        continue;
      }
      let branch;
      try {
        branch = await api.request("GET", `/repos/${repo}/branches/${segments(ref)}`);
      } catch (err) {
        if (err.status === 404) {
          skip(pr, "its head branch is gone");
          continue;
        }
        throw err;
      }
      let rules = [];
      if (branch?.protected) {
        try {
          rules = await api.request("GET", `/repos/${repo}/rules/branches/${segments(ref)}`);
        } catch (err) {
          skip(pr, `a protected head whose rules could not be read (${err.message})`);
          continue;
        }
      }
      const protectedBy = protectionOf(branch, Array.isArray(rules) ? rules : []);
      if (protectedBy) {
        skip(pr, protectedBy);
        continue;
      }
    } catch (err) {
      skip(pr, `could not read the PR's events or branch (${err.message})`);
      continue;
    }
    const message = restackMessage({ base, child: pr.number, parents: plan.parents });
    // Dated by its parents, not by the clock: two runs planning the same head
    // on the same base write the same commit, and the second push is a no-op.
    const commit = commitRestack({ tree: plan.tree, child: head, base: baseSha, message, cwd, date: date ?? parentsDate(head, baseSha, cwd) });
    if (!canPush) {
      result.planned.push({ pr: pr.number, head: commit, parents });
      log(`#${pr.number}: would push ${commit.slice(0, 7)} to ${ref} (re-stack on ${parents.map((n) => `#${n}`).join(", ")})`);
      continue;
    }
    let res;
    try {
      res = push({ cwd, remote, ref, expected: head, commit, env: pushEnv });
    } catch (err) {
      res = { error: err.message };
    }
    if (res.ok) {
      result.pushed.push({ pr: pr.number, head: commit, baseSha, parents });
      log(`#${pr.number}: pushed ${commit.slice(0, 7)} to ${ref} (re-stack on ${parents.map((n) => `#${n}`).join(", ")})`);
    } else if (res.lease) {
      result.leaseFailed.push({ pr: pr.number, ref });
      log(`#${pr.number}: ${ref} moved since the plan; nothing pushed, the next event re-plans`);
    } else if (res.rejected) {
      // A ruleset or a server hook the branch API's `protected` flag does not
      // show: this PR's entry, not the run, which covers every other PR.
      result.rejected.push({ pr: pr.number, ref, detail: res.detail });
      console.log(redact(`::warning title=conflict-restack::#${pr.number}: the push to ${ref} was refused by the remote; nothing was pushed`, masked));
      log(`#${pr.number}: push to ${ref} refused by the remote — ${res.detail}`);
    } else {
      result.failed.push({ pr: pr.number, ref, error: res.error });
      log(`#${pr.number}: push to ${ref} failed — ${res.error}`);
    }
  }
  return result;
}

/** The later of the two parents' committer dates, as git takes it. */
export function parentsDate(head, base, cwd) {
  const secs = git(["show", "-s", "--format=%ct", head, base], { cwd }).out.split("\n").filter(Boolean).map(Number);
  return `@${Math.max(...secs)} +0000`;
}

/** The job output the probe consumes: `{"<pr>": {"head", "baseSha"}}`. */
export const pushedOutput = (result) =>
  JSON.stringify(Object.fromEntries(result.pushed.map((p) => [String(p.pr), { head: p.head, baseSha: p.baseSha }])));

/** The one machine-readable line a run prints. */
export function restackLogLine(result, { stats } = {}) {
  return `restack ${JSON.stringify({
    base: result.base,
    open: result.open,
    pushed: result.pushed.map((p) => [p.pr, p.head, p.parents]),
    planned: result.planned.map((p) => [p.pr, p.head, p.parents]),
    residual: result.residual.map((r) => [r.pr, r.parents, r.files]),
    skipped: result.skipped.map((s) => [s.pr, s.reason]),
    leaseFailed: result.leaseFailed.map((l) => l.pr),
    rejected: result.rejected.map((r) => r.pr),
    failed: result.failed.map((f) => f.pr),
    reads: stats?.reads ?? null,
  })}`;
}

export function restackSummary(result, { base }) {
  const on = (parents) => parents.map((n) => `#${n}`).join(", ");
  const out = [`## Conflict monitor — re-stack after a parent's squash, against \`${base}\``, ""];
  out.push(
    `${result.open} open PR(s) at \`${result.base.slice(0, 7)}\`: ${result.pushed.length} re-stacked, ${result.planned.length} planned only, ` +
      `${result.residual.length} still conflicting, ${result.leaseFailed.length} moved before the push, ${result.rejected.length} refused by the remote, ${result.skipped.length} skipped, ` +
      `${result.clean} merging cleanly.`,
    "",
  );
  const rows = [
    ...result.pushed.map((p) => `| #${p.pr} | re-stacked on ${on(p.parents)} | ${codeOf(p.head.slice(0, 7))} |`),
    ...result.planned.map((p) => `| #${p.pr} | planned on ${on(p.parents)}, not pushed | ${codeOf(p.head.slice(0, 7))} |`),
    ...result.residual.map((r) => `| #${r.pr} | still conflicting on ${on(r.parents)} | ${r.files.slice(0, 10).map(codeOf).join(", ")}${r.files.length > 10 ? ` +${r.files.length - 10}` : ""} |`),
    ...result.leaseFailed.map((l) => `| #${l.pr} | the branch moved; nothing pushed | |`),
    ...result.rejected.map((r) => `| #${r.pr} | the remote refused the push | |`),
    ...result.failed.map((f) => `| #${f.pr} | push failed | |`),
    ...result.skipped.map((s) => `| #${s.pr} | skipped | ${s.reason.replace(/[|<>&]/g, (c) => `&#${c.charCodeAt(0)};`)} |`),
  ];
  if (rows.length) out.push("| PR | outcome | detail |", "|---|---|---|", ...rows, "");
  return out.join("\n");
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const base = process.env.BASE_BRANCH || process.env.GITHUB_REF_NAME;
  const configPath = process.env.CONFIG_PATH || ".github/conflict-monitor.json";
  const output = (value) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pushed=${value}\n`);
  };
  const { restack } = loadRestackConfig(configPath);
  if (!restack) {
    // The consumer PR that adds the key is green on arrival: its own run
    // checks out the BASE, whose config does not have the key yet.
    log(`no "restack" key in ${configPath}: nothing to do`);
    output("{}");
    return;
  }
  // Out of the environment before the first git call below: no git child
  // inherits either token; the push gets the PAT in its own environment.
  const token = process.env.PUSH_TOKEN || "";
  const readToken = process.env.GITHUB_TOKEN || "";
  delete process.env.PUSH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  hardenGit();
  for (const t of [token, readToken].filter(Boolean)) {
    const header = Buffer.from(`x-access-token:${t}`).toString("base64");
    masked.push(t);
    console.log(`::add-mask::${header}`);
  }
  const secrets = masked;
  const baseSha = revParse(process.env.BASE_SHA || `origin/${base}`) ?? revParse("HEAD");
  if (!repo || !base || !baseSha) throw new Error("needs GITHUB_REPOSITORY, a base branch and a checkout");
  const dryRun = process.env.DRY_RUN === "true";
  if (!token) console.log("::warning title=conflict-restack::no PUSH_TOKEN: planned the re-stacks and pushed nothing");
  else if (!restack.push) console.log("::warning title=conflict-restack::restack.push is false: planned the re-stacks and pushed nothing");
  const api = githubClient({ token: readToken });
  const readEnv = readAuthEnv(readToken, process.cwd());
  const result = await runRestack({
    api,
    repo,
    base,
    baseSha,
    restack,
    only: process.env.PR_NUMBER ? Number(process.env.PR_NUMBER) : null,
    fetch: (numbers, opts) => fetchHeads(numbers, { ...opts, env: readEnv }),
    fetchHeadBranches: (prs, opts) => fetchBranches(prs, { ...opts, env: readEnv }),
    pushEnv: authEnv(token),
    canPush: Boolean(token) && restack.push && !dryRun,
  });
  console.log(redact(restackLogLine(result, { stats: api.stats }), secrets));
  output(pushedOutput(result));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, restackSummary(result, { base }));
  if (result.failed.length) {
    console.log(`::error::${redact(`could not push the re-stack of ${result.failed.map((f) => `#${f.pr}`).join(", ")}: ${result.failed[0].error}`, secrets)}`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.log(`::error::${redact(err.message, [...masked, process.env.PUSH_TOKEN, process.env.GITHUB_TOKEN])}`);
    process.exitCode = 1;
  });
}
