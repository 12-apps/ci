#!/usr/bin/env node
/**
 * The CD gate: when may this run deploy, and from which base?
 *
 * Two ways a consumer can pace its deploys, both read from the caller
 * workflow's own run history:
 *
 * ── On every merge, at most once per X minutes (MIN_INTERVAL_MINUTES) ──
 *
 * A push always runs the gate. It finds when the last deploy ATTEMPT started
 * (a run whose engine `Discover targets` job started, still running or not),
 * waits until X minutes have passed since then, and deploys. The caller gives
 * the gate job a concurrency group that cancels in progress, so a newer merge
 * cancels a gate that is still waiting: a burst of merges becomes ONE deploy of
 * the newest commit, never more than one per X minutes, and the last merge of a
 * burst always ships. Push events are delivered on time, which is why this
 * mode exists: GitHub's `schedule` fired future-pay's daily crons 3-7.5 hours
 * late every day of 2026-09-15..28, so a cron is no clock for "every 30 min".
 *
 * ── On a schedule (MIN_INTERVAL_MINUTES unset) ──
 *
 * A scheduled run deploys only when the branch moved since the last attempt.
 * "Since the last attempt", not "in the last X minutes": a late tick would
 * otherwise drop a merge that landed between a punctual tick and a late one.
 *
 * In both modes a manual dispatch deploys at once, and the base is the commit
 * of the last SUCCESSFUL attempt: the image-reuse planner diffs against it and
 * copies its tags, so every image must exist under it. Any error reading the
 * history deploys with an empty base, which rebuilds every image: the
 * fail-open direction select-images already takes.
 *
 * Env: GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_WORKFLOW_REF,
 * GITHUB_REF_NAME, GITHUB_RUN_ID, GITHUB_EVENT_NAME, GITHUB_SHA, GITHUB_OUTPUT,
 * DISCOVER_JOB (default "Discover targets") and MIN_INTERVAL_MINUTES.
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const isDiscover = (job, discoverJob) => job.name === discoverJob || job.name.endsWith(` / ${discoverJob}`);

/** A run attempted a deploy when the engine's discover job ran to an end. */
export const attempted = (jobs, discoverJob) =>
  jobs.some((j) => isDiscover(j, discoverJob) && ['success', 'failure'].includes(j.conclusion));

/** When a run's discover job started, finished or not; null when it never did. */
export const attemptStartedAt = (jobs, discoverJob) => {
  const job = jobs.find((j) => isDiscover(j, discoverJob) && j.started_at && j.conclusion !== 'skipped');
  return job ? Date.parse(job.started_at) : null;
};

/**
 * The schedule mode's decision.
 * @param {{event: string, head: string, runs: {head_sha: string, conclusion: string, attempted: boolean}[]}} input
 *   `runs` newest first, completed only, the current run excluded.
 */
export function decide({ event, head, runs }) {
  const tried = runs.filter((r) => r.attempted);
  const lastAttempt = tried[0]?.head_sha ?? '';
  const base = tried.find((r) => r.conclusion === 'success')?.head_sha ?? '';
  if (event !== 'schedule') return { deploy: true, base, reason: `${event}: always deploys` };
  if (!lastAttempt) return { deploy: true, base, reason: 'no earlier deploy attempt found' };
  if (lastAttempt === head) return { deploy: false, base, reason: `nothing landed since the last attempt (${head.slice(0, 9)})` };
  return { deploy: true, base, reason: `new commits since the last attempt (${lastAttempt.slice(0, 9)} -> ${head.slice(0, 9)})` };
}

/**
 * The interval mode's wait: how long, in ms, until X minutes have passed since
 * the last attempt started. Zero when there is none, or it is already that old.
 */
export function waitMs({ event, now, lastStart, intervalMinutes }) {
  if (event === 'workflow_dispatch' || lastStart == null) return 0;
  return Math.max(0, lastStart + intervalMinutes * 60_000 - now);
}

/** The last successful attempt's commit: the image-reuse base. */
export const baseOf = (runs) => runs.find((r) => r.attempted && r.conclusion === 'success')?.head_sha ?? '';

async function api({ url, token }, path) {
  const res = await fetch(`${url}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

/**
 * The history the gate reads, newest first, the current run excluded: enough
 * runs to find one successful attempt. With `inProgress`, runs still going are
 * read too, so a deploy that is building counts as the last attempt.
 */
export async function history({ client, repo, workflow, branch, runId, discoverJob, inProgress = false, limit = 30 }) {
  const status = inProgress ? '' : '&status=completed';
  const listed = await api(client, `/repos/${repo}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}${status}&per_page=${limit}`);
  const runs = [];
  for (const run of listed.workflow_runs ?? []) {
    if (String(run.id) === String(runId)) continue;
    const { jobs = [] } = await api(client, `/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    runs.push({
      head_sha: run.head_sha,
      conclusion: run.conclusion,
      attempted: attempted(jobs, discoverJob),
      startedAt: attemptStartedAt(jobs, discoverJob),
    });
    if (runs.some((r) => r.attempted && r.conclusion === 'success')) break;
  }
  return runs;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function main(env = process.env, { now = Date.now, wait = sleep } = {}) {
  const workflow = (env.GITHUB_WORKFLOW_REF ?? '').split('@')[0].split('/').pop();
  const interval = Number(env.MIN_INTERVAL_MINUTES || 0);
  const read = (inProgress) => history({
    client: { url: env.GITHUB_API_URL || 'https://api.github.com', token: env.GITHUB_TOKEN },
    repo: env.GITHUB_REPOSITORY,
    workflow,
    branch: env.GITHUB_REF_NAME,
    runId: env.GITHUB_RUN_ID,
    discoverJob: env.DISCOVER_JOB || 'Discover targets',
    inProgress,
  });
  let result;
  try {
    if (!workflow) throw new Error('GITHUB_WORKFLOW_REF names no workflow file');
    if (interval > 0) {
      const runs = await read(true);
      const lastStart = runs.find((r) => r.startedAt != null)?.startedAt ?? null;
      const ms = waitMs({ event: env.GITHUB_EVENT_NAME, now: now(), lastStart, intervalMinutes: interval });
      if (ms > 0) {
        console.log(`::notice::cd-gate: the last deploy started ${new Date(lastStart).toISOString()}; waiting ${Math.ceil(ms / 1000)}s so deploys stay ${interval} min apart (a newer merge cancels this wait)`);
        await wait(ms);
      }
      // Read again after the wait: the deploy that was building has most likely
      // finished, and if it succeeded it is the better base.
      const after = ms > 0 ? await read(false) : runs;
      result = { deploy: true, base: baseOf(after), reason: ms > 0 ? `waited ${Math.ceil(ms / 1000)}s for the ${interval}-min interval` : `the last deploy started over ${interval} min ago` };
    } else {
      result = decide({ event: env.GITHUB_EVENT_NAME, head: env.GITHUB_SHA, runs: await read(false) });
    }
  } catch (error) {
    result = { deploy: true, base: '', reason: `history unreadable, deploying with a full rebuild: ${error.message}` };
  }
  console.log(`::notice::cd-gate: ${result.deploy ? 'deploy' : 'skip'} — ${result.reason}; base ${result.base || '(none: full rebuild)'}`);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `deploy=${result.deploy}\nbase_sha=${result.base}\nreason=${result.reason}\n`);
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
