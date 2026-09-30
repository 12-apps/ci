/* global fetch, process */
/**
 * The REST and GraphQL calls the job makes, behind one small client per token
 * so the tests can replace both.
 *
 * TWO tokens, on purpose (see action.yml):
 *   - the PAT (`pr-token`) pushes the branch and opens the PR, so the
 *     consumer's `pull_request` workflows run and its required checks report;
 *   - `GITHUB_TOKEN` enables auto-merge, so the eventual merge is attributed
 *     to it and starts NO workflow run on the base — no deploy, no second
 *     regeneration.
 * Auto-merge has no REST endpoint; it is GraphQL only.
 */

/** An API error keeps its status, so callers can tell "already gone" from "refused". */
export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function githubClient({ token, apiUrl = process.env.GITHUB_API_URL || "https://api.github.com", graphqlUrl = process.env.GITHUB_GRAPHQL_URL || "https://api.github.com/graphql" } = {}) {
  if (!token) throw new Error("post-merge-regen: a GitHub client needs a token");
  const headers = (body) => ({
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
    ...(body ? { "content-type": "application/json" } : {}),
  });
  async function raw(method, url, body) {
    const res = await fetch(url, { method, headers: headers(body), body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // A proxy's HTML error page: keep the status, drop the page.
      json = { message: `non-JSON body (${text.length} bytes)` };
    }
    if (!res.ok) throw new GitHubError(`${method} ${url} → ${res.status}: ${json?.message ?? text}`, res.status);
    return { json, link: res.headers.get("link") ?? "" };
  }
  return {
    async request(method, path, body) {
      return (await raw(method, `${apiUrl}${path}`, body)).json;
    },
    async paginate(path) {
      const out = [];
      let next = `${apiUrl}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
      while (next) {
        const { json, link } = await raw("GET", next);
        out.push(...json);
        next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
      }
      return out;
    },
    async graphql(query, variables) {
      const { json } = await raw("POST", graphqlUrl, { query, variables });
      if (json?.errors?.length) throw new GitHubError(`graphql: ${json.errors.map((e) => e.message).join("; ")}`, 200);
      return json.data;
    },
  };
}

const ENABLE = `mutation($id: ID!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId }
}`;
const DISABLE = `mutation($id: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId }
}`;

/**
 * GitHub refuses auto-merge on a PR that is already mergeable — nothing to
 * wait for. The refusal names the merge state: `clean` (every check passed),
 * `unstable` (required checks passed, an optional one did not) or `has_hooks`.
 * Each of those is mergeable under the branch's own rules, so it is merged
 * directly, with the same token and method.
 */
const ALREADY_MERGEABLE = /\b(clean|unstable|has_hooks) status\b/i;

export async function enableAutoMerge(bot, repo, pr) {
  try {
    await bot.graphql(ENABLE, { id: pr.node_id });
    return "auto-merge";
  } catch (err) {
    if (!ALREADY_MERGEABLE.test(String(err.message))) throw err;
    await bot.request("PUT", `/repos/${repo}/pulls/${pr.number}/merge`, { merge_method: "squash" });
    return "merged";
  }
}

/**
 * Turn auto-merge off; a PR that never had it is left alone. A PR that merged
 * or closed between the listing and this call — the race the run is ordered
 * around — makes the mutation fail; that PR is already out of the way, so the
 * failure is read back and ignored.
 */
export async function disableAutoMerge(bot, repo, pr) {
  if (!pr.auto_merge) return "none";
  try {
    await bot.graphql(DISABLE, { id: pr.node_id });
    return "disabled";
  } catch (err) {
    const now = await bot.request("GET", `/repos/${repo}/pulls/${pr.number}`);
    if (now?.state !== "open") return now?.merged ? "merged" : "closed";
    throw err;
  }
}
