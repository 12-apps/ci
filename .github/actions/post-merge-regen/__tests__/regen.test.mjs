/**
 * The regen run over a REAL throwaway repository (a bare `origin` and a clone)
 * and a stubbed GitHub that records every call. The git half is real because
 * the order of fetches and checkouts IS the behaviour: which tip gets
 * regenerated, and whether a run queued behind a merged regen sees it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { runRegen, scrubbedEnv } from "../regen.mjs";
import { branchFor, planStart, regenPrs } from "../lib/plan.mjs";

const REPO = "acme/app";
const PREFIX = "chore/post-merge-regen-";
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sh(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A bare origin with one commit on main, and a clone of it (the runner's checkout). */
function world() {
  const root = mkdtempSync(join(tmpdir(), "post-merge-regen-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  for (const dir of [seed]) {
    sh(dir, "config", "user.name", "Fixture");
    sh(dir, "config", "user.email", "fixture@example.invalid");
    sh(dir, "config", "commit.gpgsign", "false");
  }
  writeFileSync(join(seed, "draft.txt"), "draft\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-q", "-m", "seed");
  sh(seed, "remote", "add", "origin", origin);
  sh(seed, "push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", origin, work]);
  const advance = (file, text) => {
    writeFileSync(join(seed, file), text);
    sh(seed, "add", "-A");
    sh(seed, "commit", "-q", "-m", `touch ${file}`);
    sh(seed, "push", "-q", "origin", "main");
    return sh(seed, "rev-parse", "HEAD");
  };
  return { origin, work, advance, tip: () => sh(origin, "rev-parse", "main") };
}

/** A stubbed GitHub: `open` PRs, and a log of every write. */
function github(open = []) {
  const calls = [];
  let next = 100;
  const bot = {
    async paginate(path) {
      calls.push(["bot", "GET", path]);
      return open;
    },
    async request(method, path, body) {
      calls.push(["bot", method, path, body]);
      return {};
    },
    async graphql(query, variables) {
      const op = /(enable|disable)PullRequestAutoMerge/.exec(query)[0];
      calls.push(["bot", "GRAPHQL", op, variables.id]);
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
  return { bot, pat, calls };
}

const pr = (number, ref, extra = {}) => ({ number, node_id: `PR_${number}`, head: { ref, repo: { full_name: REPO } }, auto_merge: null, ...extra });

function cfg(overrides = {}) {
  return {
    repo: REPO,
    base: "main",
    prefix: PREFIX,
    command: "true",
    title: "chore(docs): regenerate (FUT-1)",
    body: "Regenerated after the merge.",
    author: "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
    ...overrides,
  };
}

function deps(w, gh, runCommand) {
  return {
    bot: gh.bot,
    pat: gh.pat,
    git: (...args) => sh(w.work, ...args),
    pushUrl: w.origin,
    runCommand: runCommand ?? (() => {}),
  };
}

describe("plan", () => {
  it("names the branch after the tip it regenerates", () => {
    assert.equal(branchFor(PREFIX, "a".repeat(40)), `${PREFIX}aaaaaaa`);
    assert.throws(() => branchFor("", "a".repeat(40)), /branch-prefix is empty/);
    assert.throws(() => branchFor(PREFIX, "HEAD"), /not a commit sha/);
  });

  it("owns only same-repository heads under the prefix", () => {
    const open = [pr(1, `${PREFIX}aaaaaaa`), pr(2, "feat/x"), { ...pr(3, `${PREFIX}bbbbbbb`), head: { ref: `${PREFIX}bbbbbbb`, repo: { full_name: "fork/app" } } }];
    assert.deepEqual(regenPrs(open, { prefix: PREFIX, repo: REPO }).map((p) => p.number), [1]);
  });

  it("keeps a PR that already regenerates this tip, else marks every owned PR stale", () => {
    const tip = "c".repeat(40);
    const owned = [pr(1, `${PREFIX}aaaaaaa`), pr(2, `${PREFIX}ccccccc`)];
    assert.equal(planStart({ tip, prefix: PREFIX, owned }).keep.number, 2);
    const regen = planStart({ tip, prefix: PREFIX, owned: [owned[0]] });
    assert.equal(regen.kind, "regen");
    assert.deepEqual(regen.stale.map((p) => p.number), [1]);
  });
});

describe("runRegen", () => {
  it("regenerates the LIVE tip, not the one the run was started for", async () => {
    const w = world();
    const eventSha = w.tip();
    const live = w.advance("other.txt", "landed after the event\n");
    assert.notEqual(eventSha, live);
    const gh = github();
    const res = await runRegen(cfg(), deps(w, gh, () => writeFileSync(join(w.work, "draft.txt"), "numbered\n")));
    assert.equal(res.action, "opened");
    assert.equal(res.branch, branchFor(PREFIX, live));
    // The pushed branch sits on the live tip and carries the regenerated file.
    assert.equal(sh(w.origin, "rev-parse", `${res.branch}^`), live);
    assert.equal(sh(w.origin, "show", `${res.branch}:draft.txt`), "numbered");
  });

  it("opens the PR with the PAT and enables auto-merge with GITHUB_TOKEN", async () => {
    const w = world();
    const gh = github();
    await runRegen(cfg(), deps(w, gh, () => writeFileSync(join(w.work, "draft.txt"), "numbered\n")));
    const opened = gh.calls.find((c) => c[1] === "POST" && c[2] === `/repos/${REPO}/pulls`);
    assert.equal(opened[0], "pat", "a PR opened with GITHUB_TOKEN never gets its pull_request runs");
    assert.equal(opened[3].draft, false);
    assert.equal(opened[3].title, cfg().title);
    const enabled = gh.calls.find((c) => c[2] === "enablePullRequestAutoMerge");
    assert.equal(enabled[0], "bot", "a merge enabled by the PAT would start a deploy");
    assert.equal(sh(w.origin, "log", "-1", "--format=%an|%s", branchFor(PREFIX, w.tip())), "github-actions[bot]|chore(docs): regenerate (FUT-1)");
  });

  it("turns auto-merge off on stale regen PRs BEFORE fetching again, then closes them", async () => {
    const w = world();
    const stale = pr(7, `${PREFIX}0000000`, { auto_merge: { merge_method: "squash" } });
    const gh = github([stale]);
    const order = [];
    const d = deps(w, gh, () => writeFileSync(join(w.work, "draft.txt"), "numbered\n"));
    const git = d.git;
    d.git = (...args) => {
      if (args.includes("fetch")) order.push("fetch");
      return git(...args);
    };
    const graphql = gh.bot.graphql;
    gh.bot.graphql = async (q, v) => {
      order.push(/disable/.test(q) ? "disable" : "enable");
      return graphql(q, v);
    };
    await runRegen(cfg(), d);
    assert.deepEqual(order.slice(0, 3), ["fetch", "disable", "fetch"]);
    assert.ok(gh.calls.some((c) => c[1] === "PATCH" && c[2] === `/repos/${REPO}/pulls/7` && c[3].state === "closed"));
    assert.ok(gh.calls.some((c) => c[1] === "DELETE" && c[2] === `/repos/${REPO}/git/refs/heads/${PREFIX}0000000`));
  });

  it("keeps and re-arms a PR that already regenerates this tip, and changes nothing else", async () => {
    const w = world();
    const current = pr(9, branchFor(PREFIX, w.tip()));
    const gh = github([current]);
    let ran = false;
    const res = await runRegen(cfg(), deps(w, gh, () => (ran = true)));
    assert.deepEqual(res, { action: "kept", pr: 9 });
    assert.equal(ran, false);
    assert.deepEqual(gh.calls.filter((c) => c[1] !== "GET").map((c) => c.slice(0, 3)), [["bot", "GRAPHQL", "enablePullRequestAutoMerge"]]);
  });

  it("with nothing to regenerate, opens nothing and closes the stale PRs", async () => {
    const w = world();
    const gh = github([pr(4, `${PREFIX}1111111`)]);
    const res = await runRegen(cfg(), deps(w, gh));
    assert.deepEqual(res, { action: "none" });
    assert.ok(!gh.calls.some((c) => c[0] === "pat"));
    assert.ok(gh.calls.some((c) => c[1] === "PATCH" && c[2] === `/repos/${REPO}/pulls/4`));
  });

  it("merges directly when GitHub refuses auto-merge on an already-clean PR", async () => {
    const w = world();
    const gh = github();
    gh.bot.graphql = async () => {
      throw new Error("graphql: Pull request is in clean status");
    };
    await runRegen(cfg(), deps(w, gh, () => writeFileSync(join(w.work, "draft.txt"), "numbered\n")));
    assert.ok(gh.calls.some((c) => c[0] === "bot" && c[1] === "PUT" && /\/pulls\/\d+\/merge$/.test(c[2]) && c[3].merge_method === "squash"));
  });

  it("fails, and pushes nothing, when the command fails", async () => {
    const w = world();
    const gh = github();
    await assert.rejects(
      runRegen(cfg(), deps(w, gh, () => {
        throw new Error("post-merge-regen: the command exited 1");
      })),
      /exited 1/,
    );
    assert.ok(!gh.calls.some((c) => c[0] === "pat"));
    assert.equal(sh(w.origin, "branch", "--list", `${PREFIX}*`), "");
  });

  it("refuses a malformed commit author before touching anything", async () => {
    const w = world();
    const gh = github();
    await assert.rejects(runRegen(cfg({ author: "nobody" }), deps(w, gh)), /Name <email>/);
    assert.equal(gh.calls.length, 0);
  });
});

describe("scrubbedEnv", () => {
  it("never hands a token to the consumer's command", () => {
    const env = scrubbedEnv({ PATH: "/bin", GITHUB_TOKEN: "t", PR_TOKEN: "p", GH_TOKEN: "g", HOME: "/root" });
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH"]);
  });

  it("the action passes the command's env through it (regen.mjs)", () => {
    const source = readFileSync(new URL("../regen.mjs", import.meta.url), "utf8");
    assert.match(source, /env: scrubbedEnv\(env\)/);
  });
});
