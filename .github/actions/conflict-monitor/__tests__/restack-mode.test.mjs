import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { authEnv, redact } from "../lib/auth.mjs";
import { git, isAncestor } from "../lib/git.mjs";
import { BOT, trailersOf } from "../lib/restack.mjs";
import { forcePushOverRestack, isBotRestack, protectionOf, pushRestack, pushedOutput, restackLogLine, restackSummary, runRestack } from "../restack.mjs";
import { ACTIVITY, buildCase, caseApi, caseNamed, compareShape, forcePushEvent } from "./restack-world.mjs";

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
  const activity = new Map();
  const branchInfo = new Map();
  const rulesInfo = new Map();
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
    activity,
    branchInfo,
    rulesInfo,
    async paginate(path) {
      base.calls.push(`PAGINATE ${path}`);
      if (/\/pulls\?state=open$/.test(path)) return pulls();
      const r = /\/rules\/branches\/(.+)$/.exec(path);
      if (r) {
        const ref = r[1].split("/").map(decodeURIComponent).join("/");
        const rules = rulesInfo.get(ref);
        if (rules instanceof Error) throw rules;
        return rules ?? [];
      }
      const m = /\/activity\?ref=([^&]+)&activity_type=force_push$/.exec(path);
      if (m) return activity.get(decodeURIComponent(m[1])) ?? [];
      throw new Error(`unexpected paginate ${path}`);
    },
    async request(method, path, body) {
      const r = /\/rules\/branches\/(.+)$/.exec(path);
      if (method === "GET" && r) {
        base.calls.push(`${method} ${path}`);
        const ref = r[1].split("/").map(decodeURIComponent).join("/");
        const rules = rulesInfo.get(ref);
        if (rules instanceof Error) throw rules;
        return rules ?? [];
      }
      const b = /\/branches\/(.+)$/.exec(path);
      if (method === "GET" && b) {
        base.calls.push(`${method} ${path}`);
        const ref = b[1].split("/").map(decodeURIComponent).join("/");
        const exists = git(["rev-parse", "-q", "--verify", `refs/heads/${ref}`], { cwd: world.dir, ok: [0, 1] }).status === 0;
        if (!exists) throw Object.assign(new Error("Branch not found"), { status: 404 });
        return { name: ref, protected: false, ...(branchInfo.get(ref) ?? {}) };
      }
      const cmp = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path);
      if (method === "GET" && cmp) {
        base.calls.push(`${method} ${path}`);
        return compareShape(world.dir, cmp[1], cmp[2]);
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

test("a force-push over the bot's re-stack stops further re-stacks; one over the author's own commits does not", async () => {
  const { world, api, run, remoteHead } = setup("clean re-stack");
  const original = remoteHead("c");
  const first = await run();
  const restack = first.pushed[0].head;
  // The author force-pushes the branch back over the re-stack, with one more
  // commit of their own: the PR no longer lists the bot's commit anywhere.
  const tree = world.git("rev-parse", `${original}^{tree}`);
  const rewritten = git(["commit-tree", tree, "-p", original, "-m", "author: rework"], {
    cwd: world.dir,
    env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.invalid", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.invalid" },
  }).out.trim();
  world.git("update-ref", "refs/heads/c", rewritten);
  api.activity.set("refs/heads/c", [forcePushEvent({ before: restack, after: rewritten, ref: "c" })]);
  const second = await run();
  assert.deepEqual(second.pushed, []);
  assert.match(second.skipped[0].reason, /^force-pushed over the bot's re-stack for this parent \([0-9a-f]{7} -> [0-9a-f]{7}\)/);
  assert.equal(remoteHead("c"), rewritten);
  assert.ok(api.calls.includes(`GET /repos/o/r/compare/${rewritten}...${restack}`));

  // A force-push that discarded only the author's own commits does not stop it.
  const control = setup("clean re-stack");
  const before = control.remoteHead("c");
  const redo = git(["commit-tree", control.world.git("rev-parse", `${before}^{tree}`), "-p", before, "-m", "author: amend"], {
    cwd: control.world.dir,
    env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.invalid", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.invalid" },
  }).out.trim();
  const amended = git(["commit-tree", control.world.git("rev-parse", `${before}^{tree}`), "-p", `${before}^`, "-m", "author: amended"], {
    cwd: control.world.dir,
    env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.invalid", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.invalid" },
  }).out.trim();
  control.world.git("update-ref", "refs/heads/c", amended);
  control.api.activity.set("refs/heads/c", [forcePushEvent({ before: redo, after: amended, ref: "c" })]);
  assert.deepEqual((await control.run()).pushed.map((p) => p.pr), [2]);
});

test("the recorded shape of a real force-push: a discarded hand merge is not the bot's; a discarded bot re-stack is", async () => {
  const api = (compare) => ({
    calls: [],
    async paginate(path) {
      this.calls.push(path);
      return ACTIVITY.activity;
    },
    async request(method, path) {
      this.calls.push(path);
      return compare;
    },
  });
  const real = api(ACTIVITY.compare);
  assert.equal(await forcePushOverRestack({ api: real, repo: "o/r", ref: "feat/child", parents: [{ pr: 1 }] }), null);
  assert.deepEqual(real.calls, [
    "/repos/o/r/activity?ref=refs%2Fheads%2Ffeat%2Fchild&activity_type=force_push",
    `/repos/o/r/compare/${ACTIVITY.activity[0].after}...${ACTIVITY.activity[0].before}`,
  ]);
  // The same force-push, had the discarded merge been the bot's re-stack for #1.
  const commits = structuredClone(ACTIVITY.compare.commits);
  commits[1].commit.author.email = BOT.email;
  commits[1].commit.committer.email = BOT.email;
  commits[1].commit.message = "chore(stack): merge main after the squash of #1 (#2)\n\nRestack-Base: x\nRestack-Parent: #1";
  const found = await forcePushOverRestack({ api: api({ ...ACTIVITY.compare, commits }), repo: "o/r", ref: "feat/child", parents: [{ pr: 1 }] });
  assert.deepEqual(found, { before: ACTIVITY.activity[0].before, after: ACTIVITY.activity[0].after, at: ACTIVITY.activity[0].timestamp });
  assert.equal(isBotRestack(commits[1], [{ pr: 9 }]), false, "another parent");
  const byHuman = structuredClone(commits[1]);
  byHuman.commit.author.email = byHuman.commit.committer.email = "dev@example.invalid";
  assert.equal(isBotRestack(byHuman, [{ pr: 1 }]), false, "a person's trailer is not the bot's push");
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
  // Classic branch protection, and a ruleset rule that stops a fast-forward push.
  const blocked = [
    [{ protected: true, protection: { enabled: true } }, null, "a protected head (classic branch protection)"],
    [{ protected: true, protection: { enabled: false } }, [{ type: "branch_name_pattern" }, { type: "pull_request" }, { type: "required_status_checks" }], "a protected head (ruleset: pull_request, required_status_checks)"],
    [{ protected: true, protection: { enabled: false } }, Object.assign(new Error("Resource not accessible"), { status: 403 }), "a protected head whose rules could not be read (Resource not accessible)"],
    [{ protected: true, protection: { enabled: false } }, [{ type: "non_fast_forward" }, { type: "update" }], "a protected head (ruleset: update)"],
    [{ protected: true, protection: { enabled: false } }, [...Array.from({ length: 30 }, () => ({ type: "branch_name_pattern" })), { type: "required_linear_history" }], "a protected head (ruleset: required_linear_history)"],
    [{ protected: true }, [{ type: "branch_name_pattern" }], "a protected head (classic protection unknown)"],
  ];
  for (const [info, rules, reason] of blocked) {
    const { api, run, remoteHead } = setup("clean re-stack");
    api.branchInfo.set("c", info);
    if (rules) api.rulesInfo.set("c", rules);
    const before = remoteHead("c");
    const result = await run();
    assert.deepEqual(result.skipped, [{ pr: 2, reason }], reason);
    assert.equal(remoteHead("c"), before);
  }
});

test("a repo-wide naming ruleset marks every branch protected, and the bot still pushes (FUT-3341 live proof)", async () => {
  // future-pay's ruleset 19208143: branch_name_pattern + non_fast_forward on
  // every branch. GET /branches/<b> reports protected: true with classic
  // protection off; the run of 37452210190 skipped the PR as "a protected head".
  const { api, run, remoteHead } = setup("clean re-stack");
  api.branchInfo.set("c", { protected: true, protection: { enabled: false, required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } } });
  api.rulesInfo.set("c", [{ type: "branch_name_pattern", ruleset_source_type: "Repository", ruleset_id: 19208143 }, { type: "non_fast_forward", ruleset_source_type: "Repository", ruleset_id: 19208143 }]);
  const before = remoteHead("c");
  const result = await run();
  assert.deepEqual(result.skipped, []);
  assert.equal(result.pushed.length, 1);
  assert.notEqual(remoteHead("c"), before);
  assert.ok(api.calls.some((c) => /PAGINATE \/repos\/o\/r\/rules\/branches\/c$/.test(c)), "the rules were read, every page, because the branch reads protected");
});

test("an unprotected branch is pushed without reading its rules", async () => {
  const { api, run } = setup("clean re-stack");
  api.branchInfo.set("c", { protected: false, protection: { enabled: false } });
  const result = await run();
  assert.equal(result.pushed.length, 1);
  assert.ok(!api.calls.some((c) => /\/rules\/branches\//.test(c)), "no rules call for a branch that does not read protected");
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
async function runMain({ config, env = {}, prepare = () => {} }) {
  const { world, local } = setup("clean re-stack");
  prepare({ world, local });
  const api = caseApi(world);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let body;
    try {
      if (url.pathname === "/repos/o/r/pulls") body = [{ number: 2, state: "open", head: { ref: "c", sha: world.tipOf("c"), repo: { full_name: REPO } }, base: { ref: "main" } }];
      else if (/\/activity$/.test(url.pathname)) body = [];
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
  return { code, stdout, output, moved: world.tipOf("c") !== before, world };
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

test("main: no git call inherits a token, only the push carries the PAT, and every call runs hardened", async () => {
  // A `git` that logs what each call was given, then runs the real one.
  const bin = mkdtempSync(join(tmpdir(), "restack-gitwrap-"));
  dirs.push(bin);
  const log = join(bin, "calls.tsv");
  const real = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(
    join(bin, "git"),
    `#!/bin/bash\nprintf '%s\\t%s\\t%s\\t%s\\n' "\${PUSH_TOKEN:+P}" "\${GITHUB_TOKEN:+G}" "\${GIT_CONFIG_VALUE_0:-}" "$*" >> "${log}"\nexec "${real}" "$@"\n`,
    { mode: 0o755 },
  );
  const r = await runMain({
    config: { restack: {} },
    env: { PUSH_TOKEN: "push-secret", GITHUB_TOKEN: "read-secret", PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.moved, true);
  const calls = readFileSync(log, "utf8").trimEnd().split("\n").map((l) => l.split("\t"));
  const header = (t) => `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${t}`).toString("base64")}`;
  assert.ok(calls.length > 5, `saw ${calls.length} git calls`);
  for (const [push, read, value, args] of calls) {
    assert.equal(push + read, "", `no token in the environment of: git ${args}`);
    assert.match(args, /^-c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false /, `hardened: git ${args}`);
    if (/ push /.test(` ${args} `)) assert.equal(value, header("push-secret"), "the push carries the PAT");
    else assert.notEqual(value, header("push-secret"), `the PAT reaches only the push, not: git ${args}`);
  }
  assert.equal(calls.filter(([, , , a]) => / push /.test(` ${a} `)).length, 1);
  assert.ok(calls.some(([, , v, a]) => /fetch/.test(a) && v === header("read-secret")), "fetches use the read token");
  assert.ok(!r.stdout.includes("push-secret") && !r.stdout.includes("read-secret"));
  assert.ok(r.stdout.includes(`::add-mask::${Buffer.from("x-access-token:push-secret").toString("base64")}`));
});

test("main: a push the remote refuses (a ruleset, a hook) fails that PR's entry with a warning, not the run", async () => {
  const r = await runMain({
    config: { restack: {} },
    env: { PUSH_TOKEN: "a-token" },
    prepare: ({ world }) => {
      const hook = join(world.dir, "hooks", "pre-receive");
      writeFileSync(hook, "#!/bin/sh\necho 'refs/heads/c is protected by a ruleset' >&2\nexit 1\n", { mode: 0o755 });
    },
  });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.moved, false);
  assert.match(r.stdout, /^::warning title=conflict-restack::#2: the push to c was refused by the remote/m);
  assert.match(r.stdout, /^restack \{.*"rejected":\[2\],"failed":\[\]/m);
  assert.equal(r.output, "pushed={}\n");
});

test("the commit is dated by its parents: two runs planning the same head write the same commit", async () => {
  const { run, local } = setup("clean re-stack");
  const a = await run({ canPush: false, date: null });
  const b = await run({ canPush: false, date: null });
  assert.equal(a.planned[0].head, b.planned[0].head);
  const dates = (fmt, ...revs) => git(["show", "-s", `--format=${fmt}`, ...revs], { cwd: local }).out.split("\n").filter(Boolean).map(Number);
  const head = a.planned[0].head;
  const latest = Math.max(...dates("%ct", `${head}^1`, `${head}^2`));
  assert.equal(git(["show", "-s", "--format=%at %ct", head], { cwd: local }).out.trim(), `${latest} ${latest}`);
});

test("an unreadable force-push record fails closed with a warning that names the cause", async () => {
  const { api, run, remoteHead } = setup("clean re-stack");
  const paginate = api.paginate.bind(api);
  api.paginate = async (path) => {
    if (/\/activity\?/.test(path)) throw Object.assign(new Error("GET /activity -> 403: Resource not accessible by integration"), { status: 403 });
    return paginate(path);
  };
  const before = remoteHead("c");
  const printed = [];
  const log = console.log;
  console.log = (line) => printed.push(String(line));
  let result;
  try {
    result = await run();
  } finally {
    console.log = log;
  }
  assert.deepEqual(result.pushed, []);
  assert.equal(remoteHead("c"), before);
  assert.ok(
    printed.some((l) => /^::warning title=conflict-restack::#2: could not read the force-push record of c \(GET \/activity and \/compare need contents: read\): GET \/activity -> 403/.test(l)),
    printed.join("\n"),
  );
});

test("the force-push scan: an old force-push of an earlier PR is ignored, and a compare 404 is no bot re-stack", async () => {
  const bot = structuredClone(ACTIVITY.compare);
  bot.commits[1].commit.author.email = bot.commits[1].commit.committer.email = BOT.email;
  bot.commits[1].commit.message = "x\n\nRestack-Parent: #1";
  const api = (request) => ({ paginate: async () => ACTIVITY.activity, request });
  const args = { repo: "o/r", ref: "feat/child", parents: [{ pr: 1 }] };
  assert.equal(await forcePushOverRestack({ ...args, api: api(async () => bot), since: "2026-09-20T00:00:00Z" }), null, "before the PR was opened");
  assert.notEqual(await forcePushOverRestack({ ...args, api: api(async () => bot), since: "2026-09-19T00:00:00Z" }), null);
  const gone = api(async () => {
    throw Object.assign(new Error("Not Found"), { status: 404 });
  });
  assert.equal(await forcePushOverRestack({ ...args, api: gone }), null);
  const denied = api(async () => {
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  });
  await assert.rejects(forcePushOverRestack({ ...args, api: denied }), /Forbidden/);
});

test("protectionOf: every rule type that stops a fast-forward push, and none that does not", () => {
  const open = { protected: true, protection: { enabled: false } };
  const blocking = ["update", "pull_request", "required_status_checks", "required_linear_history", "required_signatures", "required_deployments", "merge_queue"];
  for (const type of blocking) assert.equal(protectionOf(open, [{ type }]), `a protected head (ruleset: ${type})`, type);
  const passing = ["branch_name_pattern", "non_fast_forward", "deletion", "creation", "commit_message_pattern", "commit_author_email_pattern", "committer_email_pattern"];
  for (const type of passing) assert.equal(protectionOf(open, [{ type }]), null, type);
  assert.equal(protectionOf({ protected: false, protection: { enabled: false } }, []), null);
  assert.equal(protectionOf({ protected: true, protection: { enabled: true } }, []), "a protected head (classic branch protection)");
});

