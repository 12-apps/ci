/**
 * Which PR a base commit squash-merged, asked of GitHub, cached per run.
 *
 * The `(#N)` a squash's subject carries is not reliable: a title without one
 * gives a subject without one, and a squash can name another PR's number
 * (future-pay, since 2026-09-01: 34 of 744 squashes carry none, 4 a wrong
 * one). The authority is the PR whose `merge_commit_sha` IS the commit:
 * `GET /commits/{sha}/pulls` answers it. `(#N)` is only a fast path, taken
 * when PR N's `merge_commit_sha` agrees.
 *
 * The parent's head is fetched from `refs/pull/N/head`, which GitHub keeps
 * after the head branch is deleted on merge.
 */
import { prOfSubject } from "./analyze.mjs";
import { revParse } from "./git.mjs";

export function squashResolver({ api, repo, cwd, fetch, localRef, log = () => {} }) {
  const bySha = new Map();
  const pulls = new Map();
  const stats = { lookups: 0, unresolved: 0 };

  async function pull(n) {
    if (!pulls.has(n)) {
      stats.lookups += 1;
      try {
        pulls.set(n, await api.request("GET", `/repos/${repo}/pulls/${n}`));
      } catch {
        pulls.set(n, null);
      }
    }
    return pulls.get(n);
  }

  const landed = (p, sha) => Boolean(p && p.merged_at && p.merge_commit_sha === sha);

  async function lookup(squash) {
    const hinted = prOfSubject(squash.subject ?? "");
    if (hinted) {
      const p = await pull(hinted);
      if (landed(p, squash.sha)) return p;
    }
    stats.lookups += 1;
    const list = await api.request("GET", `/repos/${repo}/commits/${squash.sha}/pulls`);
    return (Array.isArray(list) ? list : []).find((p) => landed(p, squash.sha)) ?? null;
  }

  return {
    stats,
    /** Map every squash not yet known, then fetch the heads of the PRs found. */
    async prime(squashes) {
      const found = new Set();
      for (const s of squashes) {
        if (bySha.has(s.sha)) continue;
        try {
          const p = await lookup(s);
          bySha.set(s.sha, p ? { number: p.number, headSha: p.head?.sha ?? null } : null);
          if (p) found.add(p.number);
        } catch (err) {
          // Unmapped is "not a stacked parent": the PR keeps E0's comment.
          stats.unresolved += 1;
          bySha.set(s.sha, null);
          log(`${s.sha.slice(0, 7)}: could not map to a PR (${err.message})`);
        }
      }
      const missing = [...found].filter((n) => !revParse(localRef(n), cwd));
      if (missing.length) fetch(missing, { cwd });
    },
    /** `{ number, head }` for a primed squash, or null. Synchronous: lib/restack.mjs calls it. */
    get(squash) {
      const r = bySha.get(squash.sha);
      if (!r) return null;
      const head = revParse(localRef(r.number), cwd) ?? (r.headSha ? revParse(r.headSha, cwd) : null);
      return head ? { number: r.number, head } : null;
    },
  };
}
