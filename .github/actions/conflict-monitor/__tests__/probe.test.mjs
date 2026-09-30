import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { MARKER, RESOLVED, stateOf } from "../lib/comment.mjs";
import { parseConfig } from "../lib/config.mjs";
import { git } from "../lib/git.mjs";
import { fetchHeads, probeSummary, runProbe } from "../probe.mjs";
import { lines, makeRepo } from "./fixture.mjs";

// The probe end to end, against a real repository and a stubbed GitHub.
//
// The "remote" is a fixture repo whose `refs/pull/N/head` refs are written by
// hand — exactly the refs GitHub keeps on the base repository for every PR,
// fork or not — and the checkout under test is a real clone of it, so the
// fetch path is the one CI takes.

const repos = [];
after(() => repos.forEach((r) => r.cleanup()));

function world() {
  const remote = makeRepo();
  repos.push(remote);
  remote.commit("base", { "a.txt": lines("one", "two"), "lock.yaml": lines("v: 1") });
  remote.checkout("conflicting", true);
  const conflicting = remote.commit("pr 1", { "a.txt": lines("one", "branch"), "lock.yaml": lines("v: 1", "b: 1") });
  remote.checkout("main");
  remote.checkout("clean", true);
  const clean = remote.commit("pr 2", { "c.txt": "c\n" });
  remote.checkout("main");
  remote.commit("land (#9)", { "a.txt": lines("one", "main"), "lock.yaml": lines("v: 1", "m: 1") });
  remote.git("update-ref", "refs/pull/1/head", conflicting);
  remote.git("update-ref", "refs/pull/2/head", clean);

  const local = makeRepo();
  repos.push(local);
  local.git("remote", "add", "origin", remote.dir);
  local.git("fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main");
  return { remote, local, baseSha: local.git("rev-parse", "origin/main") };
}

/** A GitHub stand-in: open PRs, a comment store, and a log of every write. */
function stubApi(pulls) {
  const comments = new Map(pulls.map((p) => [p.number, []]));
  const writes = [];
  let nextId = 100;
  return {
    comments,
    writes,
    async paginate(path) {
      if (/\/pulls\?state=open/.test(path)) return pulls;
      const m = /\/issues\/(\d+)\/comments/.exec(path);
      if (m) return [...(comments.get(Number(m[1])) ?? [])];
      throw new Error(`unexpected paginate ${path}`);
    },
    async request(method, path, body) {
      let m = /\/pulls\/(\d+)$/.exec(path);
      if (method === "GET" && m) return pulls.find((p) => p.number === Number(m[1]));
      m = /\/issues\/(\d+)\/comments$/.exec(path);
      if (method === "POST" && m) {
        const c = { id: nextId++, body: body.body };
        comments.get(Number(m[1])).push(c);
        writes.push(["create", Number(m[1])]);
        return c;
      }
      m = /\/issues\/comments\/(\d+)$/.exec(path);
      if (method === "PATCH" && m) {
        for (const [pr, list] of comments) {
          const c = list.find((x) => x.id === Number(m[1]));
          if (c) {
            c.body = body.body;
            writes.push(["update", pr]);
            return c;
          }
        }
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

const config = parseConfig(JSON.stringify({ buckets: [{ name: "dependencies", paths: ["lock.yaml"] }] }));
const pulls = [
  { number: 1, state: "open", base: { ref: "main" } },
  { number: 2, state: "open", base: { ref: "main" } },
];

test("a conflicted PR gets one comment naming its files and groups; a clean one gets none", async () => {
  const { local, baseSha } = world();
  const api = stubApi(pulls);
  const { tally } = await runProbe({ api, repo: "o/r", base: "main", baseSha, config, cwd: local.dir });
  assert.deepEqual(api.writes, [["create", 1]]);
  const body = api.comments.get(1)[0].body;
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /\| `a\.txt` \| edit\/edit \| code \| #9 \|/);
  assert.match(body, /\| `lock\.yaml` \| insert\/insert \| dependencies \| #9 \|/);
  assert.equal(api.comments.get(2).length, 0);
  assert.equal(tally.conflicted, 1);
  assert.equal(tally.probed, 2);
});

test("a second run over the same state writes nothing", async () => {
  const { local, baseSha } = world();
  const api = stubApi(pulls);
  await runProbe({ api, repo: "o/r", base: "main", baseSha, config, cwd: local.dir });
  api.writes.length = 0;
  const { tally } = await runProbe({ api, repo: "o/r", base: "main", baseSha, config, cwd: local.dir });
  assert.deepEqual(api.writes, []);
  assert.equal(tally.unchanged, 1);
});

test("once the branch merges the base in, the comment is edited to resolved — by a single-PR probe", async () => {
  const { remote, local, baseSha } = world();
  const api = stubApi(pulls);
  await runProbe({ api, repo: "o/r", base: "main", baseSha, config, cwd: local.dir });
  remote.checkout("conflicting");
  const fixed = remote.mergeResolving("main", { "a.txt": lines("one", "both"), "lock.yaml": lines("v: 1", "m: 1", "b: 1") });
  remote.git("update-ref", "refs/pull/1/head", fixed);
  api.writes.length = 0;
  await runProbe({ api, repo: "o/r", base: "main", baseSha, config, only: 1, cwd: local.dir });
  assert.deepEqual(api.writes, [["update", 1]]);
  assert.equal(stateOf(api.comments.get(1)[0].body), RESOLVED);
});

test("a PR whose head cannot be fetched is skipped; the others are still probed", async () => {
  const { local, baseSha } = world();
  const api = stubApi([...pulls, { number: 3, state: "open", base: { ref: "main" } }]);
  const { tally } = await runProbe({ api, repo: "o/r", base: "main", baseSha, config, cwd: local.dir });
  assert.deepEqual(tally.skipped, [3]);
  assert.deepEqual(api.writes, [["create", 1]]);
});

test("a failed comment write is counted, so the run can fail loudly", async () => {
  const { local, baseSha } = world();
  const api = stubApi(pulls);
  api.request = async () => {
    throw new Error("403 Resource not accessible by integration");
  };
  const { tally } = await runProbe({ api, repo: "o/r", base: "main", baseSha, config, cwd: local.dir });
  assert.deepEqual(tally.failedWrites, [1]);
});

test("a dry run writes nothing", async () => {
  const { local, baseSha } = world();
  const api = stubApi(pulls);
  await runProbe({ api, repo: "o/r", base: "main", baseSha, config, cwd: local.dir, dryRun: true });
  assert.deepEqual(api.writes, []);
});

test("fetchHeads isolates the one bad ref in a batch", () => {
  const { local } = world();
  const failed = fetchHeads([1, 7, 2], { cwd: local.dir });
  assert.deepEqual(failed, [7]);
  assert.equal(git(["rev-parse", "-q", "--verify", "refs/conflict-monitor/pr/2"], { cwd: local.dir, ok: [0, 1] }).status, 0);
});

test("the job summary lists the conflicted PRs and their groups", async () => {
  const { local, baseSha } = world();
  const result = await runProbe({ api: stubApi(pulls), repo: "o/r", base: "main", baseSha, config, cwd: local.dir, dryRun: true });
  const md = probeSummary(result, { base: "main" });
  assert.match(md, /\*\*1 conflicted\*\*/);
  assert.match(md, /\| #1 \| 2 \| code, dependencies \|/);
});
