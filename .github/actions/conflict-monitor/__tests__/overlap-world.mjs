/**
 * The overlap mode's test world, shared by the end-to-end suites.
 *
 * A real "remote" whose `refs/pull/N/head` refs are written by hand (as GitHub
 * keeps them), a real clone of it as the checkout under test, and a stubbed
 * GitHub whose files API is computed from the remote's own refs — so a push
 * to a PR is one `update-ref` away. `serveApi` puts the same stub behind a
 * local HTTP server, for the tests that run the real client and the real
 * entry point.
 */
import { createServer } from "node:http";

import { parseConfig, parseOverlapConfig } from "../lib/config.mjs";
import { OVERLAP_BOT, OVERLAP_MARKER } from "../lib/overlap-state.mjs";
import { runOverlap } from "../overlap.mjs";
import { lines, makeRepo } from "./fixture.mjs";

const repos = [];
export const cleanupWorlds = () => repos.splice(0).forEach((r) => r.cleanup());

export const A = (second, last = "eight") => lines("one", second, "three", "four", "five", "six", "seven", last);

export function world() {
  const remote = makeRepo();
  repos.push(remote);
  remote.commit("base", { "a.txt": A("two"), "gen.txt": lines("g"), "list.txt": lines("alpha", "omega") });
  const local = makeRepo();
  repos.push(local);
  local.git("remote", "add", "origin", remote.dir);
  const w = {
    remote,
    local,
    pulls: [],
    /** Open (or push to) PR `n`: a branch off `from` with one more commit. */
    push(n, files, { from = null, base = "main", draft = false, head = `feat/pr${n}` } = {}) {
      const exists = w.pulls.find((p) => p.number === n);
      remote.checkout(exists ? exists.head.ref : from ?? "main");
      if (!exists) remote.checkout(head, true);
      const sha = remote.commit(`pr ${n}`, files);
      remote.checkout("main");
      remote.git("update-ref", `refs/pull/${n}/head`, sha);
      if (!exists) w.pulls.push({ number: n, state: "open", draft, base: { ref: base }, head: { ref: head } });
      return sha;
    },
    pull: (n) => w.pulls.find((p) => p.number === n),
    baseSha() {
      local.git("fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main");
      return local.git("rev-parse", "origin/main");
    },
  };
  return w;
}

const STATUS = { A: "added", M: "modified", D: "removed", R: "renamed" };
export function filesOf(remote, n) {
  const head = remote.git("rev-parse", `refs/pull/${n}/head`);
  const mb = remote.git("merge-base", "main", head);
  return remote
    .git("diff", "--name-status", "-M", "-z", mb, head)
    .split("\0")
    .reduce((acc, part, i, all) => {
      // -z: `<status> NUL <path> NUL` or, for a rename, `<status> NUL <from> NUL <to> NUL`.
      if (acc.skip) {
        acc.skip -= 1;
        return acc;
      }
      if (!part) return acc;
      if (part[0] === "R") {
        acc.out.push({ filename: all[i + 2], previous_filename: all[i + 1], status: "renamed" });
        acc.skip = 2;
      } else {
        acc.out.push({ filename: all[i + 1], status: STATUS[part[0]] ?? "modified" });
        acc.skip = 1;
      }
      return acc;
    }, { out: [], skip: 0 }).out;
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * GitHub, stubbed: open PRs, their files, a comment store, closed PRs' states
 * (`closed[n]`: the PR object's fields, or `{ status }` for a failing read),
 * and a log of every write. `fail` injects failures.
 */
export function stubApi(w, { closed = {} } = {}) {
  const comments = new Map();
  const list = (n) => comments.get(n) ?? comments.set(n, []).get(n);
  const writes = [];
  const lookups = [];
  const fail = { files: new Set(), comments: new Set(), write: null };
  let nextId = 100;
  const stats = { reads: 0, writes: 0, rateLimit: 1000, rateUsed: 0 };
  return {
    comments: list,
    writes,
    lookups,
    fail,
    stats,
    closed,
    async paginate(path) {
      stats.reads += 1;
      if (/\/pulls\?state=open/.test(path)) return w.pulls.filter((p) => p.state === "open").map((p) => structuredClone(p));
      let m = /\/pulls\/(\d+)\/files$/.exec(path);
      if (m) {
        if (fail.files.has(Number(m[1]))) throw httpError(502, "502 Bad Gateway");
        return filesOf(w.remote, Number(m[1]));
      }
      m = /\/issues\/(\d+)\/comments$/.exec(path);
      if (m) {
        if (fail.comments.has(Number(m[1]))) throw httpError(502, "502 Bad Gateway");
        return [...list(Number(m[1]))].map((c) => ({ ...c }));
      }
      throw new Error(`unexpected paginate ${path}`);
    },
    async request(method, path, body) {
      if (method === "GET") {
        stats.reads += 1;
        const n = Number(/\/pulls\/(\d+)$/.exec(path)?.[1]);
        lookups.push(n);
        const c = closed[n];
        if (c?.status) throw httpError(c.status, `GET ${path} → ${c.status}`);
        if (c) return { number: n, state: "closed", base: { ref: "main" }, ...c };
        throw httpError(404, `GET ${path} → 404: Not Found`);
      }
      stats.writes += 1;
      if (fail.write?.(method)) throw httpError(403, `${method} ${path} → 403: Resource not accessible by integration`);
      // GitHub's own limit on a comment body.
      if (body?.body?.length > 65_536) throw httpError(422, `${method} ${path} → 422: body is too long (maximum is 65536 characters)`);
      let m = /\/issues\/(\d+)\/comments$/.exec(path);
      if (method === "POST" && m) {
        const c = { id: nextId++, body: body.body, user: { type: "Bot", login: OVERLAP_BOT } };
        list(Number(m[1])).push(c);
        writes.push(["create", Number(m[1])]);
        return c;
      }
      m = /\/issues\/comments\/(\d+)$/.exec(path);
      for (const [pr, cs] of comments) {
        const i = cs.findIndex((x) => x.id === Number(m?.[1]));
        if (i === -1) continue;
        if (method === "PATCH") {
          cs[i].body = body.body;
          writes.push(["update", pr]);
        } else if (method === "DELETE") {
          cs.splice(i, 1);
          writes.push(["delete", pr]);
        }
        return null;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

/**
 * The stub behind a real HTTP server, so `githubClient` and the entry point
 * run for real: lists are one page (no `Link`), errors carry their status,
 * and every response sets the rate headers (`used` counts the requests).
 */
export async function serveApi(api) {
  let used = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      used += 1;
      const path = req.url.replace(/[?&]per_page=100$/, "");
      const headers = { "content-type": "application/json", "x-ratelimit-limit": "1000", "x-ratelimit-used": String(used) };
      try {
        const isList = req.method === "GET" && /\/pulls\?state=open|\/files$|\/comments$/.test(path);
        const out = isList ? await api.paginate(path) : await api.request(req.method, path, raw ? JSON.parse(raw) : undefined);
        res.writeHead(out == null ? 204 : 200, headers);
        res.end(out == null ? "" : JSON.stringify(out));
      } catch (err) {
        res.writeHead(err.status ?? 500, headers);
        res.end(JSON.stringify({ message: err.message }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

export const config = parseConfig(
  JSON.stringify({ buckets: [{ name: "generated", paths: ["gen.txt"] }, { name: "removed", absent: true, paths: ["gone/*.txt"] }] }),
);
export const overlapOf = (block = {}) => parseOverlapConfig(block, config.rules);
export const run = (w, api, opts = {}) =>
  runOverlap({ api, repo: "o/r", base: "main", baseSha: w.baseSha(), config, overlap: overlapOf(opts.block), cwd: w.local.dir, dryRun: opts.dryRun });
export const own = (api, n) => api.comments(n).filter((c) => c.body.startsWith(OVERLAP_MARKER));

/** #1 and #2 (a draft) change the same line; #3 shares the file and merges cleanly with both. */
export function pair() {
  const w = world();
  w.push(1, { "a.txt": A("ONE") });
  w.push(2, { "a.txt": A("TWO") }, { draft: true });
  w.push(3, { "a.txt": A("two", "THREE") });
  return w;
}
