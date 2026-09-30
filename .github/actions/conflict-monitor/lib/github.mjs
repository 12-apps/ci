/* global fetch, process */
/**
 * The few REST calls the monitor makes, behind one function the tests replace.
 *
 * `request(method, path, body)` resolves to the parsed JSON body, or throws
 * with the status and GitHub's message. `paginate` follows `Link: next` until
 * it runs out, so an open-PR list longer than one page is not silently cut at
 * 100 — a truncated list would read as "those PRs are fine".
 *
 * `stats` counts the calls and keeps the rate headers of the last response:
 * the `GITHUB_TOKEN` budget is shared by every workflow in the repository, so
 * what a run spent is worth printing, and only the headers say it.
 */

export function githubClient({ token = process.env.GITHUB_TOKEN, apiUrl = process.env.GITHUB_API_URL || "https://api.github.com" } = {}) {
  const stats = { reads: 0, writes: 0, rateLimit: null, rateUsed: null };
  async function raw(method, path, body) {
    const res = await fetch(path.startsWith("http") ? path : `${apiUrl}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (method === "GET") stats.reads += 1;
    else stats.writes += 1;
    const header = (name) => (res.headers.get(name) == null ? null : Number(res.headers.get(name)));
    stats.rateLimit = header("x-ratelimit-limit") ?? stats.rateLimit;
    stats.rateUsed = header("x-ratelimit-used") ?? stats.rateUsed;
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(`${method} ${path} → ${res.status}: ${json?.message ?? text}`);
      err.status = res.status;
      throw err;
    }
    return { json, link: res.headers.get("link") ?? "" };
  }
  return {
    stats,
    async request(method, path, body) {
      return (await raw(method, path, body)).json;
    },
    async paginate(path) {
      const out = [];
      let next = path.includes("?") ? `${path}&per_page=100` : `${path}?per_page=100`;
      while (next) {
        const { json, link } = await raw("GET", next);
        out.push(...json);
        next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
      }
      return out;
    },
  };
}
