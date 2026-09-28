#!/usr/bin/env node
/**
 * Should this scheduled CD run deploy, and from which base?
 *
 * A consumer that deploys on a schedule (every X minutes) instead of on every
 * push asks two questions before building anything:
 *
 *   1. Did anything land since the last deploy ATTEMPT? If `main` still points
 *      at the commit the last attempt ran on, there is nothing to ship.
 *   2. Which commit did the last SUCCESSFUL deploy ship? That is the base the
 *      image-reuse planner diffs against (select-images), and the tag its
 *      reuse job copies from, so it must be a commit whose images all exist.
 *
 * "Since the last attempt", not "in the last X minutes": GitHub starts
 * scheduled runs late, often by 5 to 20 minutes, so a fixed look-back window
 * loses a merge that falls between a punctual run and a late one. A failed
 * attempt is not retried on the next tick (the next merge retries it), and a
 * cancelled one never counts as an attempt, so its commit ships next tick.
 *
 * Any other event (a manual dispatch, a push) always deploys. Any error reading
 * the history deploys with an empty base, which rebuilds every image: the
 * fail-open direction select-images already takes.
 *
 * Env: GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_WORKFLOW_REF,
 * GITHUB_REF_NAME, GITHUB_RUN_ID, GITHUB_EVENT_NAME, GITHUB_SHA, GITHUB_OUTPUT,
 * and DISCOVER_JOB (the engine's first job, default "Discover targets").
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** A run attempted a deploy when the engine's discover job ran to an end. */
export const attempted = (jobs, discoverJob) =>
  jobs.some((j) => (j.name === discoverJob || j.name.endsWith(` / ${discoverJob}`)) && ['success', 'failure'].includes(j.conclusion));

/**
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

async function api({ url, token }, path) {
  const res = await fetch(`${url}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

/** The history `decide` reads: enough runs to find one successful attempt. */
export async function history({ client, repo, workflow, branch, runId, discoverJob, limit = 30 }) {
  const listed = await api(client, `/repos/${repo}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=${limit}`);
  const runs = [];
  for (const run of listed.workflow_runs ?? []) {
    if (String(run.id) === String(runId)) continue;
    const { jobs = [] } = await api(client, `/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    runs.push({ head_sha: run.head_sha, conclusion: run.conclusion, attempted: attempted(jobs, discoverJob) });
    if (runs.some((r) => r.attempted && r.conclusion === 'success')) break;
  }
  return runs;
}

export async function main(env = process.env) {
  const workflow = (env.GITHUB_WORKFLOW_REF ?? '').split('@')[0].split('/').pop();
  let result;
  try {
    if (!workflow) throw new Error('GITHUB_WORKFLOW_REF names no workflow file');
    const runs = await history({
      client: { url: env.GITHUB_API_URL || 'https://api.github.com', token: env.GITHUB_TOKEN },
      repo: env.GITHUB_REPOSITORY,
      workflow,
      branch: env.GITHUB_REF_NAME,
      runId: env.GITHUB_RUN_ID,
      discoverJob: env.DISCOVER_JOB || 'Discover targets',
    });
    result = decide({ event: env.GITHUB_EVENT_NAME, head: env.GITHUB_SHA, runs });
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
