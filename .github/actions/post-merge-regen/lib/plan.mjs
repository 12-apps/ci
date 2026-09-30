/**
 * What a post-merge regeneration run does to the open regen PRs, decided from
 * data alone so the tests can hold every branch of it without GitHub or git.
 *
 * A regen PR is one whose head branch, in THIS repository, starts with the
 * prefix. There is one branch per run, named after the base tip it regenerated
 * (`<prefix><sha7>`), because a consumer's ruleset may refuse a non-fast-forward
 * push to any branch: a reused branch could not be rebuilt from a newer tip.
 */

/** The branch a run regenerating `tip` pushes. */
export function branchFor(prefix, tip) {
  if (!prefix) throw new Error("post-merge-regen: branch-prefix is empty");
  if (!/^[0-9a-f]{40}$/.test(tip)) throw new Error(`post-merge-regen: not a commit sha: ${tip}`);
  return `${prefix}${tip.slice(0, 7)}`;
}

/** The open PRs this job owns: same-repository heads under the prefix. */
export function regenPrs(open, { prefix, repo }) {
  return open.filter((pr) => pr.head?.repo?.full_name === repo && pr.head.ref.startsWith(prefix));
}

/**
 * Before regenerating: is there already a PR for this exact tip (keep it, and
 * make sure its auto-merge is on — a re-run or a dispatch must never leave it
 * switched off), or do we regenerate, and which PRs are then stale?
 */
export function planStart({ tip, prefix, owned }) {
  const branch = branchFor(prefix, tip);
  const keep = owned.find((pr) => pr.head.ref === branch) ?? null;
  if (keep) return { kind: "keep", keep, stale: [] };
  return { kind: "regen", branch, stale: owned };
}
