import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { authEnv, redact } from "../lib/auth.mjs";
import { git, isAncestor } from "../lib/git.mjs";
import { BOT, trailersOf } from "../lib/restack.mjs";
import { forcePushedAfterRestack, pushRestack, pushedOutput, restackLogLine, restackSummary, runRestack } from "../restack.mjs";
import { buildCase, caseApi, caseNamed } from "./restack-world.mjs";

// The `restack` mode end to end: the case's repository plays GitHub's git
// side (head branches, `refs/pull/N/head`, the parent's branch deleted at
// its merge), a fresh clone of it is the job's checkout of the base, and a
// stub answers the REST calls. Every push is a real `git push` with a lease.

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const REPO = "o/r";
const restackConfig = (over = {}) => ({ push: true, ignoreHeads: [], command: null, ...over });

/** The case as GitHub would hold it, and a checkout of its base. */
function setup(name, { prs = {} } = {}) {
  const world = buildCase(caseNamed(name));
  dirs.push(world.dir);
  const c = world.case;
  const open = [];
  for (const [n, pr] of Object.entries(c.prs)) {
    const head = world.tipOf(pr.branch);
    world.git("update-ref", `refs/pull/${n}/head`, head);
    if (!pr.squash) open.push(Number(n));
  }
  // delete_branch_on_merge: a merged parent's branch is gone, its refs/pull stays.
  for (const pr of Object.values(c.prs)) if (pr.squash) world.git("update-ref", "-d", `refs/heads/${pr.branch}`);
  for (const n of open) {
    const pr = c.prs[n];
    const ref = pr.headRef ?? pr.branch;
    if (ref !== pr.branch) {
      world.git("update-ref", `refs/heads/${ref}`, world.tipOf(pr.branch));
      world.git("update-ref", "-d", `refs/heads/${pr.branch}`);
    }
  }
  const local = mkdtempSync(join(tmpdir(), "restack-checkout-"));
  dirs.push(local);
  git(["init", "-q", "-b", "main"], { cwd: local });
  git(["remote", "add", "origin", world.dir], { cwd: local });
  git(["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"], { cwd: local });
  const baseSha = git(["rev-parse", "origin/main"], { cwd: local }).out.trim();

  const base = caseApi(world);
  const timelines = new Map();
  const branchInfo = new Map();
  const pulls = () =>
    open.map((n) => {
      const pr = c.prs[n];
      const ref = pr.headRef ?? pr.branch;
      const tip = git(["rev-parse", "-q", "--verify", `refs/heads/${ref}`], { cwd: world.dir, ok: [0, 1] }).out.trim();
      return {
        number: n,
        state: "open",
        draft: false,
        head: { ref, sha: tip, repo: { full_name: REPO } },
        base: { ref: "main" },
        ...(prs[n] ?? {}),
      };
    });
  const api = {
    calls: base.calls,
    timelines,
    branchInfo,
    async paginate(path) {
      base.calls.push(`PAGINATE ${path}`);
      if (/\/pulls\?state=open$/.test(path)) return pulls();
      const m = /\/issues\/(\d+)\/timeline$/.exec(path);
      if (m) return timelines.get(Number(m[1])) ?? [];
      throw new Error(`unexpected paginate ${path}`);
    },
    async request(method, path, body) {
      const b = /\/branches\/(.+)$/.exec(path);
      if (method === "GET" && b) {
        base.calls.push(`${method} ${path}`);
        const ref = b[1].split("/").map(decodeURIComponent).join("/");
        const exists = git(["rev-parse", "-q", "--verify", `refs/heads/${ref}`], { cwd: world.dir, ok: [0, 1] }).status === 0;
        if (!exists) throw Object.assign(new Error("Branch not found"), { status: 404 });
        return { name: ref, protected: false, ...(branchInfo.get(ref) ?? {}) };
      }
      const one = /\/pulls\/(\d+)$/.exec(path);
      if (method === "GET" && one) {
        const pr = pulls().find((p) => p.number === Number(one[1]));
        if (pr) {
          base.calls.push(`${method} ${path}`);
          return pr;
        }
      }
      return base.request(method, path, body);
    },
  };
  const run = (over = {}) =>
    runRestack({ api, repo: REPO, base: "main", baseSha, restack: restackConfig(), cwd: local, remote: "origin", canPush: true, date: "@1767300000 +0000", ...over });
  const remoteHead = (ref) => git(["rev-parse", "-q", "--verify", `refs/heads/${ref}`], { cwd: world.dir, ok: [0, 1] }).out.trim() || null;
  return { world, local, api, run, baseSha, remoteHead };
}

test("a clean re-stack is pushed as (child, main) with its trailers, and a second run pushes nothing", async () => {
  const { world, local, run, baseSha, remoteHead } = setup("clean re-stack");
  const before = remoteHead("c");
  const result = await run();
  assert.deepEqual(result.pushed.map((p) => p.pr), [2]);
  const after = remoteHead("c");
  assert.equal(result.pushed[0].head, after);
  assert.deepEqual(world.git("rev-list", "--parents", "-n1", after).split(" ").slice(1), [before, baseSha]);
  assert.equal(world.git("rev-parse", `${after}^{tree}`), caseNamed("clean re-stack").expect["2"].tree);
  assert.deepEqual(trailersOf(after, world.dir).parents, [1]);
  assert.equal(world.git("log", "-1", "--format=%ae", after), BOT.email);
  assert.deepEqual(JSON.parse(pushedOutput(result)), { 2: { head: after, baseSha } });
  assert.match(restackLogLine(result), /^restack \{"base":"[0-9a-f]{40}","open":1,"pushed":\[\[2,"[0-9a-f]{40}",\[1\]\]\]/);
  assert.match(restackSummary(result, { base: "main" }), /\| #2 \| re-stacked on #1 \|/);

  // Idempotency: the branch now holds main, so its default merge is clean.
  const again = await run();
  assert.deepEqual(again.pushed, []);
  assert.equal(again.clean, 1);
  assert.equal(remoteHead("c"), after);
  assert.ok(isAncestor(after, git(["rev-parse", "refs/conflict-monitor/branch/2"], { cwd: local }).out.trim(), local));
});

test("two children of one parent are two pushes on two branches; a draft is re-stacked too", async () => {
  const { run, remoteHead } = setup("two children", { prs: { 3: { draft: true } } });
  const result = await run();
  assert.deepEqual(result.pushed.map((p) => p.pr).sort(), [2, 3]);
  assert.equal(result.pushed.find((p) => p.pr === 2).head, remoteHead("c"));
  assert.equal(result.pushed.find((p) => p.pr === 3).head, remoteHead("d"));
});

test("the #1849 shape pushes nothing and reports the residual files", async () => {
  const { run, remoteHead } = setup("residual");
  const before = remoteHead("c");
  const result = await run();
  assert.deepEqual(result.pushed, []);
  assert.deepEqual(result.residual, [{ pr: 2, parents: [1], files: ["doc.txt"] }]);
  assert.equal(remoteHead("c"), before);
  assert.match(restackSummary(result, { base: "main" }), /\| #2 \| still conflicting on #1 \| <code>doc\.txt<\/code> \|/);
});

test("a PR whose default merge is clean is not touched", async () => {
  const { run, remoteHead } = setup("default merge clean");
  const before = remoteHead("c");
  const result = await run();
  assert.deepEqual([result.pushed, result.planned, result.skipped], [[], [], []]);
  assert.equal(result.clean, 1);
  assert.equal(remoteHead("c"), before);
});

test("a reverted parent is not re-stacked", async () => {
  const { run } = setup("reverted parent");
  const result = await run();
  assert.deepEqual(result.pushed, []);
  assert.deepEqual(result.skipped, [{ pr: 2, reason: "it conflicts, but not through a squash-merged parent it holds" }]);
});

test("branch-name reuse: the push goes to the child PR's branch, found by PR", async () => {
  const { run, remoteHead } = setup("branch-name reuse");
  const result = await run();
  assert.deepEqual(result.pushed.map((p) => p.pr), [2]);
  assert.equal(remoteHead("feat/doc"), result.pushed[0].head);
});

test("lease: the author pushes between plan and push — nothing is overwritten, the next run converges", async () => {
  const { world, run, remoteHead } = setup("clean re-stack");
  let authorHead = null;
  const raced = await run({
    push: (args) => {
      // The author's push lands first.
      const tip = remoteHead("c");
      const tree = world.git("rev-parse", `${tip}^{tree}`);
      authorHead = git(["commit-tree", tree, "-p", tip, "-m", "author: more work"], {
        cwd: world.dir,
        env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.invalid", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.invalid" },
      }).out.trim();
      world.git("update-ref", "refs/heads/c", authorHead);
      return pushRestack(args);
    },
  });
  assert.deepEqual(raced.pushed, []);
  assert.deepEqual(raced.leaseFailed.map((l) => l.pr), [2]);
  assert.equal(remoteHead("c"), authorHead, "the author's push stands");
  const next = await run();
  assert.deepEqual(next.pushed.map((p) => p.pr), [2]);
  assert.deepEqual(world.git("rev-list", "--parents", "-n1", remoteHead("c")).split(" ")[1], authorHead);
});

test("lease: the author deletes the branch between plan and push — it is not recreated", async () => {
  const { world, run, remoteHead } = setup("clean re-stack");
  const raced = await run({
    push: (args) => {
      world.git("update-ref", "-d", "refs/heads/c");
      return pushRestack(args);
    },
  });
  assert.deepEqual(raced.pushed, []);
  assert.deepEqual(raced.leaseFailed.map((l) => l.pr), [2]);
  assert.equal(remoteHead("c"), null, "never recreated");
  const next = await run();
  assert.deepEqual(next.pushed, []);
  assert.equal(remoteHead("c"), null);
});

test("a commit that does not descend from the planned head is never pushed", () => {
  const { world, local } = setup("clean re-stack");
  git(["fetch", "-q", "origin", "+refs/heads/c:refs/heads/c"], { cwd: local });
  const head = git(["rev-parse", "refs/heads/c"], { cwd: local }).out.trim();
  const main = git(["rev-parse", "origin/main"], { cwd: local }).out.trim();
  assert.throws(() => pushRestack({ cwd: local, remote: "origin", ref: "c", expected: head, commit: main }), /does not descend/);
  assert.equal(world.tipOf("c"), head);
});

test("a force-push after the bot's re-stack for the same parent stops further re-stacks", async () => {
  const { api, run, remoteHead } = setup("clean re-stack");
  const restacked = { event: "committed", sha: "f".repeat(40), message: "chore(stack): merge main after the squash of #1 (#2)\n\nRestack-Base: x\nRestack-Parent: #1\n", author: { email: BOT.email, date: "2026-01-02T00:00:00Z" }, committer: { email: BOT.email, date: "2026-01-02T00:00:00Z" } };
  api.timelines.set(2, [restacked, { event: "head_ref_force_pushed", created_at: "2026-01-02T00:05:00Z" }]);
  const before = remoteHead("c");
  const result = await run();
  assert.deepEqual(result.pushed, []);
  assert.match(result.skipped[0].reason, /^force-pushed after the bot's last re-stack/);
  assert.equal(remoteHead("c"), before);
  // A force-push BEFORE the re-stack, or a re-stack for another parent, does not stop it.
  api.timelines.set(2, [{ event: "head_ref_force_pushed", created_at: "2026-01-01T00:00:00Z" }, restacked]);
  assert.deepEqual((await run()).pushed.map((p) => p.pr), [2]);
});

test("forcePushedAfterRestack reads only the bot's own re-stack commits", () => {
  const at = (d) => ({ date: d });
  const human = { event: "committed", message: "x\n\nRestack-Parent: #1\n", author: { email: "dev@example.invalid", ...at("2026-01-02T00:00:00Z") }, committer: { email: "dev@example.invalid", ...at("2026-01-02T00:00:00Z") } };
  const push = { event: "head_ref_force_pushed", created_at: "2026-01-03T00:00:00Z" };
  assert.equal(forcePushedAfterRestack([human, push], [{ pr: 1 }]), false);
  const bot = { ...human, author: { email: BOT.email, ...at("2026-01-02T00:00:00Z") }, committer: { email: BOT.email, ...at("2026-01-02T00:00:00Z") } };
  assert.equal(forcePushedAfterRestack([bot, push], [{ pr: 1 }]), true);
  assert.equal(forcePushedAfterRestack([bot, push], [{ pr: 9 }]), false, "another parent");
});

test("exclusions: a fork, a protected head, an ignored head, a non-default base, a protected branch", async () => {
  const cases = [
    [{ head: { ref: "c", repo: { full_name: "someone/fork" } } }, {}, "a fork"],
    [{ head: { ref: "c", repo: null } }, {}, "a fork"],
    [{ base: { ref: "develop" } }, {}, "its base is develop, not main"],
    [{ head: { ref: "release/1.0", repo: { full_name: REPO } } }, {}, "a protected head"],
    [{}, { ignoreHeads: ["c"] }, "an ignored head"],
  ];
  for (const [override, cfg, reason] of cases) {
    const { run, remoteHead } = setup("clean re-stack", { prs: { 2: override } });
    const before = remoteHead("c");
    const result = await run({ restack: restackConfig(cfg) });
    assert.deepEqual(result.skipped, [{ pr: 2, reason }], reason);
    assert.deepEqual(result.pushed, []);
    assert.equal(remoteHead("c"), before);
  }
  const { api, run, remoteHead } = setup("clean re-stack");
  api.branchInfo.set("c", { protected: true });
  const before = remoteHead("c");
  const result = await run();
  assert.deepEqual(result.skipped, [{ pr: 2, reason: "a protected head" }]);
  assert.equal(remoteHead("c"), before);
});

test("no token: plan and log, push nothing", async () => {
  const { run, remoteHead } = setup("clean re-stack");
  const before = remoteHead("c");
  const result = await run({ canPush: false });
  assert.deepEqual(result.pushed, []);
  assert.deepEqual(result.planned.map((p) => p.pr), [2]);
  assert.equal(remoteHead("c"), before);
  assert.equal(pushedOutput(result), "{}");
});

test("a single-PR run plans that PR only", async () => {
  const { api, run } = setup("two children");
  const result = await run({ only: 3 });
  assert.deepEqual(result.pushed.map((p) => p.pr), [3]);
  assert.ok(!api.calls.some((c) => /pulls\?state=open/.test(c)), "no full listing");
});

test("the token reaches git as an extraheader only, and is redacted from messages", () => {
  const env = authEnv("s3cr3t-token");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.ok(!JSON.stringify(env).includes("s3cr3t-token"));
  assert.equal(redact(`fatal: ${env.GIT_CONFIG_VALUE_0} and s3cr3t-token`, ["s3cr3t-token"]), "fatal: AUTHORIZATION: basic *** and ***");
  assert.deepEqual(authEnv(""), {});
});

// The process, as the composite action runs it, against a local HTTP stub of
// the REST API: the two behaviours that live in main().
async function runMain({ config, env = {} }) {
  const { world, local } = setup("clean re-stack");
  const api = caseApi(world);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let body;
    try {
      if (url.pathname === "/repos/o/r/pulls") body = [{ number: 2, state: "open", head: { ref: "c", sha: world.tipOf("c"), repo: { full_name: REPO } }, base: { ref: "main" } }];
      else if (/\/issues\/\d+\/timeline$/.test(url.pathname)) body = [];
      else if (/\/branches\//.test(url.pathname)) body = { protected: false };
      else body = await api.request("GET", url.pathname);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(err.status ?? 500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: err.message }));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const out = mkdtempSync(join(tmpdir(), "restack-out-"));
  dirs.push(out);
  const configPath = join(out, "conflict-monitor.json");
  if (config) writeFileSync(configPath, JSON.stringify(config));
  const before = world.tipOf("c");
  const child = spawn(process.execPath, [new URL("../restack.mjs", import.meta.url).pathname], {
    cwd: local,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      GITHUB_REPOSITORY: REPO,
      BASE_BRANCH: "main",
      CONFIG_PATH: configPath,
      GITHUB_OUTPUT: join(out, "output"),
      ...env,
    },
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stdout += d));
  const code = await new Promise((r) => child.on("close", r));
  server.close();
  let output = "";
  try {
    output = readFileSync(join(out, "output"), "utf8");
  } catch {
    output = "";
  }
  return { code, stdout, output, moved: world.tipOf("c") !== before };
}

test("main: no `restack` key exits 0 having read and written nothing", async () => {
  const r = await runMain({ config: { buckets: [] } });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /no "restack" key/);
  assert.equal(r.output, "pushed={}\n");
  assert.equal(r.moved, false);
});

test("main: no PUSH_TOKEN plans, warns and pushes nothing", async () => {
  const r = await runMain({ config: { restack: { push: true } } });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /^::warning title=conflict-restack::no PUSH_TOKEN/m);
  assert.match(r.stdout, /^restack \{.*"planned":\[\[2,/m);
  assert.equal(r.output, "pushed={}\n");
  assert.equal(r.moved, false);
});

test("main: `restack.push: false` is the kill switch even with a token", async () => {
  const r = await runMain({ config: { restack: { push: false } }, env: { PUSH_TOKEN: "unused-token" } });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /^::warning title=conflict-restack::restack\.push is false/m);
  assert.ok(!r.stdout.includes("unused-token"));
  assert.equal(r.moved, false);
});

test("main: with a token, the re-stack is pushed and handed to the probe", async () => {
  const r = await runMain({ config: { restack: {} }, env: { PUSH_TOKEN: "a-token" } });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.moved, true);
  assert.match(r.output, /^pushed=\{"2":\{"head":"[0-9a-f]{40}","baseSha":"[0-9a-f]{40}"\}\}\n$/);
  assert.ok(!r.stdout.includes("a-token"));
});
