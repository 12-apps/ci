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
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${json?.message ?? text}`);
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
      if (json?.errors?.length) throw new Error(`graphql: ${json.errors.map((e) => e.message).join("; ")}`);
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
 * Turn auto-merge on. A PR whose checks have ALL already passed is "clean", and
 * GitHub refuses auto-merge on it — there is nothing to wait for — so that one
 * is merged directly, with the same token and method.
 */
export async function enableAutoMerge(bot, repo, pr) {
  try {
    await bot.graphql(ENABLE, { id: pr.node_id });
    return "auto-merge";
  } catch (err) {
    if (!/clean status/i.test(String(err.message))) throw err;
    await bot.request("PUT", `/repos/${repo}/pulls/${pr.number}/merge`, { merge_method: "squash" });
    return "merged";
  }
}

/** Turn auto-merge off; a PR that never had it is left alone. */
export async function disableAutoMerge(bot, pr) {
  if (!pr.auto_merge) return false;
  await bot.graphql(DISABLE, { id: pr.node_id });
  return true;
}
