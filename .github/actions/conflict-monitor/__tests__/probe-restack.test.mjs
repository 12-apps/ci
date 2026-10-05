import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { MARKER, RESOLVED, stateOf } from "../lib/comment.mjs";
import { parseConfig } from "../lib/config.mjs";
import { git } from "../lib/git.mjs";
import { fetchHeads, parseRestacked, runProbe } from "../probe.mjs";
import { buildCase, caseApi, caseNamed } from "./restack-world.mjs";

// The probe on a STACKED PR: its one comment lists only what still conflicts
// with the parent's pre-squash head as a merge base, plus how to take the
// base in; and a PR the restack job just pushed is not fetched again.

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const config = parseConfig("{}");

function setup(name) {
  const world = buildCase(caseNamed(name));
  dirs.push(world.dir);
  for (const [n, pr] of Object.entries(world.case.prs)) world.git("update-ref", `refs/pull/${n}/head`, world.tipOf(pr.branch));
  const local = mkdtempSync(join(tmpdir(), "probe-checkout-"));
  dirs.push(local);
  git(["init", "-q", "-b", "main"], { cwd: local });
  git(["remote", "add", "origin", world.dir], { cwd: local });
  git(["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"], { cwd: local });
  const baseSha = git(["rev-parse", "origin/main"], { cwd: local }).out.trim();
  const gh = caseApi(world);
  const open = Object.entries(world.case.prs).filter(([, p]) => !p.squash).map(([n]) => gh.pullOf(n));
  const comments = new Map(open.map((p) => [p.number, []]));
  const writes = [];
  const api = {
    comments,
    writes,
    calls: gh.calls,
    async paginate(path) {
      if (/\/pulls\?state=open/.test(path)) return open;
      const m = /\/issues\/(\d+)\/comments/.exec(path);
      if (m) return [...(comments.get(Number(m[1])) ?? [])];
      throw new Error(`unexpected paginate ${path}`);
    },
    async request(method, path, body) {
      let m = /\/issues\/(\d+)\/comments$/.exec(path);
      if (method === "POST" && m) {
        const c = { id: 100 + writes.length, body: body.body, user: { type: "Bot" } };
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
      return gh.request(method, path, body);
    },
  };
  const fetched = [];
  const fetch = (numbers, opts) => {
    fetched.push(...numbers);
    return fetchHeads(numbers, opts);
  };
  const probe = (over = {}) => runProbe({ api, repo: "o/r", base: "main", baseSha, config, cwd: local, fetch, command: "pnpm restack", ...over });
  return { world, api, probe, baseSha, fetched };
}

test("the #1849 shape: the comment lists only the residual file, the parent, the command and the recipe", async () => {
  const { world, api, probe } = setup("residual");
  const { tally } = await probe();
  assert.deepEqual(api.writes, [["create", 2]]);
  assert.equal(tally.stacked, 1);
  const body = api.comments.get(2)[0].body;
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /\| <code>doc\.txt<\/code> \| edit\/edit \| code \|/);
  assert.doesNotMatch(body, /p\.txt/, "the parent's own file is the re-stack's, not a conflict");
  assert.match(body, /Stacked on #1 \(squash-merged\): these files conflict even with #1's pre-squash head as the merge base\./);
  assert.match(body, /Take `main` in with `pnpm restack`, or by hand:/);
  assert.ok(body.includes(`-p ${world.labels.get("p1")} -m restack`), "the recipe names the held head");
  assert.match(body, /MERGE_HEAD/);
  // Re-run: same state, no write.
  api.writes.length = 0;
  await probe();
  assert.deepEqual(api.writes, []);
});

test("a stacked PR the re-stack would merge cleanly still has a comment, with the command, and is not 'resolved'", async () => {
  const { api, probe } = setup("clean re-stack");
  await probe();
  const body = api.comments.get(2)[0].body;
  assert.match(body, /### This PR conflicts with `main` only through its parent's squash/);
  assert.match(body, /Stacked on #1 \(squash-merged\): every conflicted file is the parent's own code/);
  assert.match(body, /`pnpm restack`/);
  assert.notEqual(stateOf(body), RESOLVED);
  // Without a configured command, the recipe alone.
  const other = setup("clean re-stack");
  await other.probe({ command: null });
  const plain = other.api.comments.get(2)[0].body;
  assert.match(plain, /Take `main` in this way:/);
  assert.doesNotMatch(plain, /pnpm/);
});

test("a PR the restack job pushed is not fetched again, and its comment is marked resolved at that base", async () => {
  const { api, probe, fetched, baseSha } = setup("clean re-stack");
  await probe();
  assert.deepEqual(api.writes, [["create", 2]]);
  fetched.length = 0;
  api.writes.length = 0;
  const { tally } = await probe({ restacked: { 2: { head: "a".repeat(40), baseSha } } });
  assert.ok(!fetched.includes(2), "refs/pull/2/head lags the push: never re-read");
  assert.deepEqual(api.writes, [["update", 2]]);
  assert.equal(stateOf(api.comments.get(2)[0].body), RESOLVED);
  assert.match(api.comments.get(2)[0].body, new RegExp(`at \`${baseSha.slice(0, 7)}\``));
  assert.equal(tally.restacked, 1);
});

test("a non-stacked conflict keeps exactly E0's comment", async () => {
  const { api, probe } = setup("reverted parent");
  await probe();
  const body = api.comments.get(2)[0].body;
  assert.doesNotMatch(body, /Stacked on/);
  assert.match(body, /Bring `main` into this branch and resolve the files above\./);
});

test("parseRestacked: empty is none; anything malformed is an error", () => {
  assert.deepEqual(parseRestacked(""), {});
  assert.deepEqual(parseRestacked("{}"), {});
  const ok = { 12: { head: "a".repeat(40), baseSha: "b".repeat(40) } };
  assert.deepEqual(parseRestacked(JSON.stringify(ok)), ok);
  for (const bad of ["nope", "[]", '{"x":{}}', `{"12":{"head":"a"}}`, `{"0":{"head":"${"a".repeat(40)}","baseSha":"${"b".repeat(40)}"}}`]) {
    assert.throws(() => parseRestacked(bad), /restacked/);
  }
});
