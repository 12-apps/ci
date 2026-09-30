/**
 * Post-merge regeneration, both token-holding halves.
 *
 * `prepare` runs against a stubbed GitHub. It reads nothing from disk; the
 * order of its calls IS its behaviour: which tip it picks, and whether a
 * superseded PR can still merge under it.
 *
 * `land` runs against a REAL throwaway repository (a bare `origin` plus a
 * checkout at the tip) with a patch made the way the command job makes one:
 * `git add -A` then `git diff --cached --binary` in a separate clone. The
 * git half is real because applying, committing and reusing a branch are the
 * behaviour.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { GitHubError, disableAutoMerge, enableAutoMerge } from "../lib/github.mjs";
import { branchFor, planStart, regenPrs } from "../lib/plan.mjs";
import { authEnv, redact, runLand } from "../land.mjs";
import { runPrepare } from "../prepare.mjs";

const REPO = "acme/app";
const PREFIX = "chore/post-merge-regen-";
const AUTHOR = "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sh(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const pr = (number, ref, extra = {}) => ({ number, node_id: `PR_${number}`, head: { ref, repo: { full_name: REPO } }, auto_merge: null, state: "open", ...extra });

/**
 * A stubbed GitHub. `tips` is the sequence `GET …/git/ref/heads/main` answers
 * (the last one repeats); `lists` the sequence the open-PR listing answers.
 */
function github({ tips = ["a".repeat(40)], lists = [[]], onGraphql, onPut } = {}) {
  const calls = [];
  let tipAt = 0;
  let listAt = 0;
  let next = 100;
  const bot = {
    async paginate(path) {
      calls.push(["bot", "LIST", path]);
      const list = lists[Math.min(listAt, lists.length - 1)];
      listAt += 1;
      return list;
    },
    async request(method, path, body) {
      calls.push(["bot", method, path, body]);
      if (method === "GET" && path.includes("/git/ref/heads/")) {
        const sha = tips[Math.min(tipAt, tips.length - 1)];
        tipAt += 1;
        return { object: { sha } };
      }
      if (method === "PUT" && onPut) return onPut(path, body);
      if (method === "DELETE" && bot.deleteError) throw bot.deleteError;
      if (method === "GET" && bot.readBack) return bot.readBack(path);
      return {};
    },
    async graphql(query, variables) {
      const op = /(enable|disable)PullRequestAutoMerge/.exec(query)[0];
      calls.push(["bot", "GRAPHQL", op, variables.id]);
      if (onGraphql) return onGraphql(op, variables);
      return {};
    },
  };
  const pat = {
    async request(method, path, body) {
      calls.push(["pat", method, path, body]);
      next += 1;
      return { number: next, node_id: `PR_${next}`, head: { ref: body.head } };
    },
  };
  return { bot, pat, calls, writes: () => calls.filter((c) => c[1] !== "LIST" && !(c[1] === "GET")) };
}

describe("plan", () => {
  it("names the branch after the tip it regenerates", () => {
    assert.equal(branchFor(PREFIX, "a".repeat(40)), `${PREFIX}aaaaaaa`);
    assert.throws(() => branchFor("", "a".repeat(40)), /branch-prefix is empty/);
    assert.throws(() => branchFor(PREFIX, "HEAD"), /not a commit sha/);
  });

  it("owns only same-repository heads under the prefix", () => {
    const fork = { ...pr(3, `${PREFIX}bbbbbbb`), head: { ref: `${PREFIX}bbbbbbb`, repo: { full_name: "fork/app" } } };
    const open = [pr(1, `${PREFIX}aaaaaaa`), pr(2, "feat/x"), fork];
    assert.deepEqual(regenPrs(open, { prefix: PREFIX, repo: REPO }).map((p) => p.number), [1]);
  });

  it("keeps a PR that already regenerates this tip, else marks every owned PR stale", () => {
    const tip = "c".repeat(40);
    const owned = [pr(1, `${PREFIX}aaaaaaa`), pr(2, `${PREFIX}ccccccc`)];
    assert.equal(planStart({ tip, prefix: PREFIX, owned }).keep.number, 2);
    assert.deepEqual(planStart({ tip, prefix: PREFIX, owned: [owned[0]] }).stale.map((p) => p.number), [1]);
  });
});

describe("prepare", () => {
  const cfg = { repo: REPO, base: "main", prefix: PREFIX };

  it("reads the LIVE tip from the API, never the event's sha", async () => {
    const gh = github({ tips: ["b".repeat(40)] });
    const res = await runPrepare(cfg, gh);
    assert.deepEqual(res, { action: "regen", tip: "b".repeat(40) });
  });

  it("keeps a PR for this exact tip and RE-ARMS its auto-merge, touching nothing else", async () => {
    const tip = "c".repeat(40);
    const gh = github({ tips: [tip], lists: [[pr(9, branchFor(PREFIX, tip)), pr(8, `${PREFIX}0000000`, { auto_merge: {} })]] });
    const res = await runPrepare(cfg, gh);
    assert.deepEqual(res, { action: "keep", tip, pr: 9 });
    assert.deepEqual(gh.writes().map((c) => c.slice(0, 4)), [["bot", "GRAPHQL", "enablePullRequestAutoMerge", "PR_9"]]);
  });

  it("switches auto-merge off on superseded PRs BEFORE reading the tip again", async () => {
    const gh = github({ tips: ["d".repeat(40)], lists: [[pr(7, `${PREFIX}0000000`, { auto_merge: {} }), pr(6, `${PREFIX}1111111`)]] });
    await runPrepare(cfg, gh);
    const order = gh.calls.filter((c) => c[1] === "GRAPHQL" || (c[1] === "GET" && c[2].includes("/git/ref/"))).map((c) => (c[1] === "GET" ? "tip" : `${c[2]}:${c[3]}`));
    // PR 6 never had auto-merge, so nothing is sent for it.
    assert.deepEqual(order, ["tip", "disablePullRequestAutoMerge:PR_7", "tip"]);
  });

  it("when the tip moved under it, keeps a PR that already covers the NEW tip", async () => {
    const old = "e".repeat(40);
    const moved = "f".repeat(40);
    const gh = github({ tips: [old, moved], lists: [[pr(5, `${PREFIX}0000000`)], [pr(5, `${PREFIX}0000000`), pr(11, branchFor(PREFIX, moved))]] });
    const res = await runPrepare(cfg, gh);
    assert.deepEqual(res, { action: "keep", tip: moved, pr: 11 });
  });

  it("ignores a superseded PR that merged between the listing and the switch-off", async () => {
    const gh = github({
      lists: [[pr(4, `${PREFIX}0000000`, { auto_merge: {} })]],
      onGraphql: (op) => {
        if (op === "disablePullRequestAutoMerge") throw new GitHubError("graphql: Pull request is not open", 200);
        return {};
      },
    });
    gh.bot.readBack = () => ({ state: "closed", merged: true });
    const res = await runPrepare(cfg, gh);
    assert.equal(res.action, "regen");
  });

  it("still fails when the switch-off fails on a PR that is open", async () => {
    const gh = github({ lists: [[pr(4, `${PREFIX}0000000`, { auto_merge: {} })]], onGraphql: () => { throw new GitHubError("graphql: forbidden", 200); } });
    gh.bot.readBack = () => ({ state: "open" });
    await assert.rejects(runPrepare(cfg, gh), /forbidden/);
  });
});

/** A bare origin, a checkout at its tip (the land job's), and a patch made in another clone (the command job's). */
function world(regenerate) {
  const root = mkdtempSync(join(tmpdir(), "post-merge-regen-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  sh(seed, "config", "user.name", "Fixture");
  sh(seed, "config", "user.email", "fixture@example.invalid");
  sh(seed, "config", "commit.gpgsign", "false");
  writeFileSync(join(seed, "draft.txt"), "draft\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-q", "-m", "seed");
  sh(seed, "remote", "add", "origin", origin);
  sh(seed, "push", "-q", "origin", "main");
  const tip = sh(origin, "rev-parse", "main");

  const gen = join(root, "gen");
  execFileSync("git", ["clone", "-q", origin, gen]);
  let patch = null;
  if (regenerate) {
    regenerate(gen);
    sh(gen, "add", "-A");
    patch = join(root, "regen.patch");
    writeFileSync(patch, execFileSync("git", ["diff", "--cached", "--binary"], { cwd: gen }));
  }
  const work = join(root, "work");
  execFileSync("git", ["clone", "-q", origin, work]);
  return { origin, work, tip, patch, git: (...args) => sh(work, ...args) };
}

const landCfg = (w, overrides = {}) => ({ repo: REPO, base: "main", prefix: PREFIX, tip: w.tip, title: "chore(docs): regenerate (FUT-1)", body: "Regenerated after the merge.", author: AUTHOR, patch: w.patch, ...overrides });
const landDeps = (w, gh) => ({ bot: gh.bot, pat: gh.pat, git: w.git, remote: w.origin });

describe("land", () => {
  it("commits the patch on <prefix><sha7>, pushes it, opens the PR with the PAT, enables auto-merge with GITHUB_TOKEN", async () => {
    const w = world((dir) => {
      writeFileSync(join(dir, "draft.txt"), "numbered\n");
      writeFileSync(join(dir, "new.txt"), "added\n");
    });
    const gh = github();
    const res = await runLand(landCfg(w), landDeps(w, gh));
    const branch = branchFor(PREFIX, w.tip);
    assert.equal(res.action, "opened");
    assert.equal(sh(w.origin, "rev-parse", `${branch}^`), w.tip);
    assert.equal(sh(w.origin, "show", `${branch}:draft.txt`), "numbered");
    assert.equal(sh(w.origin, "show", `${branch}:new.txt`), "added");
    assert.equal(sh(w.origin, "log", "-1", "--format=%an|%s", branch), "github-actions[bot]|chore(docs): regenerate (FUT-1)");
    const opened = gh.calls.find((c) => c[1] === "POST");
    assert.equal(opened[0], "pat", "a PR opened with GITHUB_TOKEN never gets its pull_request runs");
    assert.equal(opened[3].draft, false);
    const enabled = gh.calls.find((c) => c[2] === "enablePullRequestAutoMerge");
    assert.equal(enabled[0], "bot", "a merge enabled by the PAT would start a deploy");
  });

  it("closes superseded regen PRs and deletes their branches, after the new one is open", async () => {
    const w = world((dir) => writeFileSync(join(dir, "draft.txt"), "numbered\n"));
    const gh = github({ lists: [[pr(7, `${PREFIX}0000000`)]] });
    await runLand(landCfg(w), landDeps(w, gh));
    const writes = gh.writes().map((c) => `${c[0]} ${c[1]} ${c[2]}`);
    const opened = writes.findIndex((c) => c.startsWith("pat POST"));
    const closed = writes.indexOf(`bot PATCH /repos/${REPO}/pulls/7`);
    assert.ok(opened >= 0 && closed > opened, writes.join("\n"));
    assert.ok(writes.includes(`bot DELETE /repos/${REPO}/git/refs/heads/${PREFIX}0000000`));
  });

  it("with no patch, opens nothing and closes the superseded PRs", async () => {
    const w = world(null);
    const gh = github({ lists: [[pr(4, `${PREFIX}1111111`)]] });
    const res = await runLand(landCfg(w), landDeps(w, gh));
    assert.deepEqual(res, { action: "none" });
    assert.ok(!gh.calls.some((c) => c[0] === "pat"));
    assert.ok(gh.calls.some((c) => c[1] === "PATCH" && c[2] === `/repos/${REPO}/pulls/4`));
  });

  it("reuses a branch an earlier attempt pushed when its tree is this regeneration (a retry after a failed PR open)", async () => {
    const w = world((dir) => writeFileSync(join(dir, "draft.txt"), "numbered\n"));
    await assert.rejects(runLand(landCfg(w), { ...landDeps(w, github()), pat: { request: async () => { throw new Error("502"); } } }), /502/);
    const retry = world(null);
    // Same origin, a fresh land checkout: re-point this world at the first origin.
    const again = { ...w, work: retry.work, git: (...args) => sh(retry.work, ...args) };
    sh(retry.work, "remote", "set-url", "origin", w.origin);
    sh(retry.work, "fetch", "-q", "origin");
    sh(retry.work, "checkout", "-q", "--detach", w.tip);
    const gh = github();
    const res = await runLand(landCfg(again), landDeps(again, gh));
    assert.equal(res.action, "opened");
    assert.ok(gh.calls.some((c) => c[0] === "pat" && c[1] === "POST"));
  });

  it("refuses a branch that exists with a DIFFERENT tree, naming it", async () => {
    const w = world((dir) => writeFileSync(join(dir, "draft.txt"), "numbered\n"));
    const branch = branchFor(PREFIX, w.tip);
    const other = join(w.origin, "..", "other");
    execFileSync("git", ["clone", "-q", w.origin, other]);
    writeFileSync(join(other, "draft.txt"), "something else\n");
    sh(other, "-c", "user.name=X", "-c", "user.email=x@example.invalid", "commit", "-qam", "other");
    sh(other, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    await assert.rejects(runLand(landCfg(w), landDeps(w, github())), new RegExp(`${branch} already exists with a different tree`));
  });

  it("refuses a regeneration that writes a workflow", async () => {
    const w = world((dir) => {
      execFileSync("mkdir", ["-p", join(dir, ".github", "workflows")]);
      writeFileSync(join(dir, ".github", "workflows", "evil.yml"), "on: push\n");
    });
    const gh = github();
    await assert.rejects(runLand(landCfg(w), landDeps(w, gh)), /may not change \.github\/workflows\/evil\.yml/);
    assert.ok(!gh.calls.some((c) => c[0] === "pat"));
  });

  it("refuses a checkout that is not at the tip prepare chose", async () => {
    const w = world((dir) => writeFileSync(join(dir, "draft.txt"), "numbered\n"));
    await assert.rejects(runLand(landCfg(w, { tip: "0".repeat(40) }), landDeps(w, github())), /not at 0{40}/);
  });

  it("logs a failed branch delete as a failure, and an already-gone branch as gone", async () => {
    for (const [status, expect] of [[403, /deleting .* failed/], [422, /already gone/]]) {
      const w = world(null);
      const gh = github({ lists: [[pr(4, `${PREFIX}1111111`)]] });
      gh.bot.deleteError = new GitHubError(`DELETE → ${status}`, status);
      const lines = [];
      await runLand(landCfg(w), { ...landDeps(w, gh), log: (l) => lines.push(l) });
      assert.match(lines.join("\n"), expect);
    }
  });
});

describe("auto-merge", () => {
  for (const state of ["clean", "unstable", "has_hooks"]) {
    it(`merges directly when GitHub refuses auto-merge on a PR in ${state} status`, async () => {
      const gh = github({ onGraphql: () => { throw new GitHubError(`graphql: Pull request Pull request is in ${state} status`, 200); } });
      assert.equal(await enableAutoMerge(gh.bot, REPO, pr(3, "x")), "merged");
      assert.ok(gh.calls.some((c) => c[1] === "PUT" && c[2] === `/repos/${REPO}/pulls/3/merge` && c[3].merge_method === "squash"));
    });
  }

  it("does not swallow any other refusal", async () => {
    const gh = github({ onGraphql: () => { throw new GitHubError("graphql: Resource not accessible by integration", 200); } });
    await assert.rejects(enableAutoMerge(gh.bot, REPO, pr(3, "x")), /not accessible/);
  });

  it("sends nothing to switch off a PR that never had auto-merge", async () => {
    const gh = github();
    assert.equal(await disableAutoMerge(gh.bot, REPO, pr(3, "x")), "none");
    assert.equal(gh.calls.length, 0);
  });
});

describe("the PAT never appears in a URL or a message", () => {
  it("rides as an http extraheader in git's env", () => {
    const env = authEnv("ghp_secret");
    assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
    assert.match(env.GIT_CONFIG_VALUE_0, /^AUTHORIZATION: basic /);
    assert.ok(!JSON.stringify(env).includes("ghp_secret"));
  });

  it("is redacted, raw or base64-encoded, from anything printed", () => {
    const b64 = Buffer.from("x-access-token:ghp_secret").toString("base64");
    assert.equal(redact(`fatal: ghp_secret and ${b64}`, ["ghp_secret"]), "fatal: *** and ***");
  });
});
