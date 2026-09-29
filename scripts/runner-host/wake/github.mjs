// The scaler's calls to the GitHub API. index.mjs wires them to the token in
// SSM; the tests fake `fetch`.
//
// Every `workflow_job` delivery re-reads the queue: the queued and the
// in-progress runs, the jobs of each of those runs, and the runners. That is
// about fourteen requests a delivery, and a job sends two deliveries (queued,
// completed). On 2026-09-28 it spent the token's hourly allowance 12 to 30
// minutes after each reset, from 11:00 to 02:48 UTC. The scaler then answered
// 403 until the hour turned and launched nothing; it was blind for 307
// minutes of the day (5,725 of 13,702 evaluations failed).
//
// A conditional request answered 304 Not Modified does not count against the
// primary rate limit. Measured on 2026-09-29: three 304s left `remaining`
// where it was, and the unconditional 200 after them took one. So a read of
// the queue carries the ETag of the last answer for its path, and a 304 reuses
// what was derived from that answer. Only the derived value is kept (a count,
// a list of run ids), never the body, so a container that lives for hours
// holds a few numbers per run.

/** Why a call failed, from what GitHub says and the rate-limit headers. */
async function why(res) {
  const parts = [];
  const message = await res.json().then((b) => b?.message, () => undefined);
  if (message) parts.push(String(message).slice(0, 160));
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (remaining !== null) {
    parts.push(`${remaining} left${reset ? `, resets ${new Date(reset * 1000).toISOString().slice(11, 19)}Z` : ""}`);
  }
  const retry = res.headers.get("retry-after");
  if (retry) parts.push(`retry after ${retry}s`);
  return parts.length ? `: ${parts.join("; ")}` : "";
}

/**
 * @param {object} cfg
 * @param {string} cfg.repo owner/name
 * @param {string} cfg.label the fleet's runner label (lostJobs)
 * @param {() => string | Promise<string>} cfg.token
 * @param {typeof fetch} [cfg.fetchFn]
 */
export function makeGithub({ repo, label: fleetLabel, token, fetchFn = fetch }) {
  /** @type {Map<string, { etag: string, value: unknown }>} what the last answer for a read meant */
  const kept = new Map();
  let usage = { billed: 0, free: 0, remaining: undefined };
  let limit;

  // `memo` names a read whose meaning is worth keeping: the ETag goes out with
  // the next read of the same path, and a 304 answers with the kept value.
  async function call(path, { method = "GET", memo, derive = (body) => body } = {}) {
    const known = memo ? kept.get(memo) : undefined;
    const res = await fetchFn(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await token()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        ...(known ? { "If-None-Match": known.etag } : {}),
      },
    });
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining !== null) usage.remaining = Number(remaining);
    if (res.headers.get("x-ratelimit-limit") !== null) limit = Number(res.headers.get("x-ratelimit-limit"));
    if (res.status === 304 && known) {
      usage.free++;
      return known.value;
    }
    usage.billed++;
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${method} ${path}${await why(res)}`);
    const value = derive(res.status === 204 || res.status === 201 ? {} : await res.json());
    const etag = res.headers.get("etag");
    if (memo && etag) kept.set(memo, { etag, value });
    return value;
  }

  return {
    // Jobs waiting for a runner with this label, across every run that has one.
    async queuedJobIds(label) {
      const queued = [];
      const live = new Set();
      for (const status of ["queued", "in_progress"]) {
        const ids = await call(`/repos/${repo}/actions/runs?status=${status}&per_page=100`, {
          memo: `runs ${status}`, derive: (b) => b.workflow_runs.map((run) => run.id),
        });
        for (const id of ids) {
          const memo = `jobs ${id} ${label}`;
          live.add(memo);
          queued.push(...await call(`/repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`, {
            memo, derive: (b) => b.jobs.filter((j) => j.status === "queued" && j.labels.includes(label)).map((j) => j.id),
          }));
        }
      }
      // A run that has left both lists is not read again.
      for (const memo of kept.keys()) if (memo.startsWith("jobs ") && !live.has(memo)) kept.delete(memo);
      return queued;
    },
    async queuedJobs(label) {
      return (await this.queuedJobIds(label)).length;
    },
    // Failed jobs of this attempt that lost their runner. When the host goes
    // (spot reclaim, a crash), GitHub closes the job as a failure but leaves
    // the step it was in unfinished; a job that fails on its own finishes every
    // step it ran. The Actions API alone tells them apart, so this holds after
    // EC2 has forgotten the host: a terminated instance has no private address
    // left to look it up by, which is how the first version of this missed
    // future-pay #1985's two lost jobs.
    async lostJobs(runId, attempt) {
      const { jobs } = await call(`/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
      return jobs.filter((j) => j.conclusion === "failure" && j.labels.includes(fleetLabel)
        && (j.steps ?? []).some((s) => s.status !== "completed")).length;
    },
    // Needs Actions: Read and write on the token.
    async rerunFailed(runId) {
      await call(`/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`, { method: "POST" });
    },
    async idleRunners(label) {
      return call(`/repos/${repo}/actions/runners?per_page=100`, {
        memo: `runners ${label}`,
        derive: (b) => b.runners.filter((r) => r.status === "online" && !r.busy && r.labels.some((l) => l.name === label)).length,
      });
    },
    // The allowance GitHub last reported, for a caller that rations it.
    allowance() {
      return usage.remaining === undefined || limit === undefined ? undefined : { remaining: usage.remaining, limit };
    },
    // What the calls since the last take cost: `billed` came back with a body
    // (those count against the hourly allowance), `free` were 304s, and
    // `remaining` is the allowance GitHub last reported.
    take() {
      const spent = usage;
      usage = { billed: 0, free: 0, remaining: spent.remaining };
      return spent;
    },
  };
}
