import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { git, isAncestor, mergeTree } from "../lib/git.mjs";
import { squashResolver } from "../lib/parents.mjs";
import {
  HEADER_MAX,
  commitRestack,
  culpritSquashes,
  planRestack,
  recipeOf,
  restackMessage,
  toolMade,
  trailersOf,
  virtualBase,
} from "../lib/restack.mjs";
import { CASES, PR_HEAD, buildCase, caseApi } from "./restack-world.mjs";

// The algorithm (lib/restack.mjs) over every scenario of restack-cases.json,
// each built with real git, with the parent found through a stubbed GitHub:
// `GET /pulls/{n}` for the `(#N)` fast path and `GET /commits/{sha}/pulls`
// for everything else — exactly the calls the bot and the probe make.

const worlds = [];
after(() => worlds.forEach((w) => w.cleanup()));

async function planFor(world, n, api = caseApi(world)) {
  const child = world.tipOf(world.case.prs[n].branch);
  const base = world.tipOf("main");
  const resolver = squashResolver({ api, repo: "o/r", cwd: world.dir, fetch: () => [], localRef: PR_HEAD });
  const merge = mergeTree(child, base, world.dir);
  if (merge.conflicted) {
    await resolver.prime(culpritSquashes({ base, child, files: merge.files, cwd: world.dir }));
  }
  const plan = planRestack({ child, base, cwd: world.dir, resolve: resolver.get, self: Number(n), merge });
  return { plan, child, base, merge, api };
}

function check(world, n, expect, { plan, child, base, merge }) {
  const where = `${world.case.name} #${n}`;
  assert.equal(merge.conflicted ? "conflicted" : "clean", expect.default, `${where}: default merge`);
  assert.equal(plan.status, expect.plan, `${where}: plan`);
  if (expect.parents) assert.deepEqual((plan.parents ?? []).map((p) => p.pr).sort((a, b) => a - b), expect.parents, `${where}: parents`);
  for (const [pr, lbl] of Object.entries(expect.pOld ?? {})) {
    assert.equal(plan.parents.find((p) => p.pr === Number(pr))?.pOld, world.labels.get(lbl), `${where}: pOld of #${pr} is ${lbl}`);
  }
  if (expect.residual) assert.deepEqual(plan.residual ?? [], expect.residual, `${where}: residual`);
  if (expect.tree) assert.equal(plan.tree, expect.tree, `${where}: tree`);
  for (const [pr, reason] of expect.skippedParents ?? []) {
    const s = plan.skipped.find((x) => x.pr === pr);
    assert.ok(s && s.reason.startsWith(reason), `${where}: parent #${pr} skipped as "${reason}…", got ${JSON.stringify(plan.skipped)}`);
  }
  if (expect.explicitBase) {
    const pOld = plan.parents[0].pOld;
    const { status } = git(["merge-tree", "--write-tree", "--name-only", `--merge-base=${pOld}`, child, base], { cwd: world.dir, ok: [0, 1] });
    assert.equal(status ? "conflicted" : "clean", expect.explicitBase, `${where}: the explicit-base merge`);
  }
  for (const [path, content] of Object.entries(expect.content ?? {})) {
    const tree = plan.status === "restack" ? plan.tree : merge.tree;
    assert.equal(world.git("cat-file", "-p", `${tree}:${path}`) + "\n", content, `${where}: ${path}`);
  }
}

for (const c of CASES) {
  test(`case "${c.name}": ${c.shape}`, async () => {
    const restackSteps = [];
    const world = buildCase(c, { onRestack: (n, plan, expect, at) => restackSteps.push({ n, plan, expect, at }) });
    worlds.push(world);
    for (const s of restackSteps) {
      check(world, s.n, s.expect, { plan: s.plan, child: s.at.child, base: s.at.base, merge: mergeTree(s.at.child, s.at.base, world.dir) });
    }
    for (const [n, expect] of Object.entries(c.expect)) check(world, n, expect, await planFor(world, n));
  });
}

test("a clean re-stack commits (child, main) with the trailers; Z is not in its history", async () => {
  const world = buildCase(CASES.find((c) => c.name === "clean re-stack"));
  worlds.push(world);
  const { plan, child, base } = await planFor(world, 2);
  const message = restackMessage({ base: "main", child: 2, parents: plan.parents });
  const commit = commitRestack({ tree: plan.tree, child, base, message, cwd: world.dir });
  const parents = world.git("rev-list", "--parents", "-n1", commit).split(" ").slice(1);
  assert.deepEqual(parents, [child, base]);
  assert.equal(world.git("rev-parse", `${commit}^{tree}`), mergeTree(child, plan.z, world.dir).tree);
  assert.ok(!isAncestor(plan.z, commit, world.dir), "Z is unreachable from the re-stack");
  const t = trailersOf(commit, world.dir);
  assert.deepEqual(t, { bases: [world.labels.get("p1")], parents: [1], redo: false });
  assert.ok(toolMade(t, plan.parents));
  assert.match(world.git("log", "-1", "--format=%an <%ae>", commit), /^github-actions\[bot\] </);
  // Z is a pure function of its inputs: the same plan names the same object.
  assert.equal(virtualBase({ base, pOlds: plan.parents.map((p) => p.pOld), cwd: world.dir }), plan.z);
});

test("the parent with no (#N) is found through GET /commits/{sha}/pulls", async () => {
  const world = buildCase(CASES.find((c) => c.name === "parent squash without a PR number"));
  worlds.push(world);
  const { plan, api } = await planFor(world, 2);
  assert.deepEqual(plan.parents.map((p) => p.pr), [1]);
  assert.ok(api.calls.some((c) => /\/commits\/[0-9a-f]+\/pulls$/.test(c)));
  assert.ok(!api.calls.some((c) => /\/pulls\/\d+$/.test(c)), "no (#N) to try first");
});

test("a (#N) naming another PR is checked, refused, and the API's answer used", async () => {
  const world = buildCase(CASES.find((c) => c.name === "parent squash naming the wrong PR"));
  worlds.push(world);
  const { plan, api } = await planFor(world, 2);
  assert.deepEqual(plan.parents.map((p) => p.pr), [1]);
  assert.ok(api.calls.includes("GET /repos/o/r/pulls/7"), "the fast path was tried");
  assert.ok(api.calls.some((c) => /\/commits\/[0-9a-f]+\/pulls$/.test(c)), "and the authority asked");
});

test("a (#N) that agrees is the fast path: no commits lookup", async () => {
  const world = buildCase(CASES.find((c) => c.name === "clean re-stack"));
  worlds.push(world);
  const { api } = await planFor(world, 2);
  assert.ok(api.calls.includes("GET /repos/o/r/pulls/1"));
  assert.ok(!api.calls.some((c) => /\/commits\/[0-9a-f]+\/pulls$/.test(c)));
});

test("an API failure maps the squash to no PR: not stacked, never an exception", async () => {
  const world = buildCase(CASES.find((c) => c.name === "parent squash without a PR number"));
  worlds.push(world);
  const api = caseApi(world);
  api.request = async () => {
    throw Object.assign(new Error("Server Error"), { status: 500 });
  };
  const { plan } = await planFor(world, 2, api);
  assert.equal(plan.status, "not-stacked");
});

test("the message passes the commit rules a consumer's commitlint runs", () => {
  const pOld = "a".repeat(40);
  const shapes = [
    { base: "main", child: 2519, parents: [{ pr: 2514, pOld }] },
    { base: "main", child: 99999, parents: [{ pr: 99998, pOld }] },
    { base: "main", child: 99999, parents: [{ pr: 99997, pOld }, { pr: 99998, pOld: "b".repeat(40) }] },
    { base: "main", child: 99999, parents: [1, 2, 3, 4, 5].map((i) => ({ pr: 99990 + i, pOld })) },
    { base: "a-very-long-default-branch-name-that-nobody-should-use", child: 99999, parents: [{ pr: 99998, pOld }] },
  ];
  for (const s of shapes) {
    for (const redo of [false, true]) {
      const msg = restackMessage({ ...s, redo });
      const [header, blank, ...rest] = msg.trimEnd().split("\n");
      assert.ok(header.length <= HEADER_MAX, `header ≤ 72: "${header}" (${header.length})`);
      assert.match(header, /^chore\(stack\): [a-z][^.]*[^.]$/, "type(scope): lower-case subject, no trailing period");
      assert.match(header, /^chore\(stack\): merge /, "imperative");
      assert.match(header, new RegExp(`\\(#${s.child}\\)$`), "the issue reference");
      assert.equal(blank, "");
      for (const l of rest) assert.ok(l.length <= 100, `body line ≤ 100: "${l}"`);
      assert.doesNotMatch(msg, /co-authored-by|generated (with|by)/i);
    }
  }
  assert.equal(
    restackMessage({ base: "main", child: 2519, parents: [{ pr: 2514, pOld }] }).split("\n")[0],
    "chore(stack): merge main after the squash of #2514 (#2519)",
  );
  assert.match(restackMessage({ base: "main", child: 3, parents: [{ pr: 1, pOld }], redo: true }), /\nRestack-Redo: yes\n$/);
});

test("toolMade: the trailers must name exactly this sync's parents and held heads", () => {
  const parents = [{ pr: 1, pOld: "a".repeat(40) }];
  assert.ok(toolMade({ bases: ["a".repeat(40)], parents: [1], redo: false }, parents));
  assert.ok(!toolMade({ bases: ["b".repeat(40)], parents: [1], redo: false }, parents), "another sync's pOld");
  assert.ok(!toolMade({ bases: ["a".repeat(40)], parents: [9], redo: false }, parents), "a parent not stacked here");
  assert.ok(!toolMade({ bases: [], parents: [], redo: false }, parents), "no trailers");
  assert.ok(!toolMade({ bases: ["a".repeat(40)], parents: [1], redo: false }, []), "not a stacked sync");
});

/** A developer's clone of the case with the child checked out, and the recipe pasted into bash. */
function devClone(world, child) {
  const dev = mkdtempSync(join(tmpdir(), "restack-dev-"));
  worlds.push({ cleanup: () => rmSync(dev, { recursive: true, force: true }) });
  git(["clone", "-q", "--no-checkout", world.dir, dev], { env: DEV });
  git(["checkout", "-q", "-b", "c", child], { cwd: dev });
  return dev;
}
const DEV = { GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.invalid", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.invalid" };
const paste = (dev, lines) => spawnSync("bash", ["-c", lines.join("\n")], { cwd: dev, env: { ...process.env, ...DEV }, encoding: "utf8" });

test("the recipe a developer runs, run for real, makes the tool's merge: same tree, parents, trailers", async () => {
  const world = buildCase(CASES.find((c) => c.name === "clean re-stack"));
  worlds.push(world);
  const { plan, child, base } = await planFor(world, 2);
  const lines = recipeOf({ base: "main", parents: plan.parents, child: 2 });
  assert.ok(!lines.join("\n").includes(plan.parents[0].pOld), "the held head is computed, never printed");
  world.git("update-ref", "refs/pull/1/head", world.tipOf("p"));
  const dev = devClone(world, child);
  const res = paste(dev, lines);
  assert.equal(res.status, 0, res.stderr);
  const head = git(["rev-parse", "HEAD"], { cwd: dev }).out.trim();
  assert.deepEqual(git(["rev-list", "--parents", "-n1", head], { cwd: dev }).out.trim().split(" ").slice(1), [child, base]);
  assert.equal(git(["rev-parse", "HEAD^{tree}"], { cwd: dev }).out.trim(), plan.tree);
  assert.ok(toolMade(trailersOf(head, dev), plan.parents), "the report accepts it as the tool's merge");
  assert.equal(git(["log", "-1", "--format=%s", head], { cwd: dev }).out.trim(), "chore(stack): merge main after the squash of #1 (#2)");
});

test("the recipe is fail-fast: a failing step exits non-zero and commits nothing", async () => {
  const world = buildCase(CASES.find((c) => c.name === "clean re-stack"));
  worlds.push(world);
  const { plan, child } = await planFor(world, 2);
  const lines = recipeOf({ base: "main", parents: plan.parents, child: 2 });
  const untouched = (dev, why) => {
    assert.equal(git(["rev-parse", "HEAD"], { cwd: dev }).out.trim(), child, `${why}: no commit`);
    assert.equal(git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: dev, ok: [0, 1] }).status, 1, `${why}: no merge left behind`);
  };
  // refs/pull/1/head is not published: the fetch fails, nothing after it runs.
  const noRef = devClone(world, child);
  const a = paste(noRef, lines);
  assert.notEqual(a.status, 0, "exits non-zero");
  assert.doesNotMatch(a.stderr, /restack: /, "it stops at the failed fetch, before any later step runs");
  untouched(noRef, "no refs/pull");
  // The fetch works, but the branch holds no commit of the parent's head.
  world.git("update-ref", "refs/pull/1/head", world.tipOf("main"));
  const noHeld = devClone(world, child);
  const b = paste(noHeld, lines);
  assert.notEqual(b.status, 0);
  assert.match(b.stderr, /restack: this branch holds no commit of #1/);
  untouched(noHeld, "empty held head");
  // A dirty worktree: git refuses the merge, and MERGE_HEAD is never written.
  world.git("update-ref", "refs/pull/1/head", world.tipOf("p"));
  const dirty = devClone(world, child);
  writeFileSync(join(dirty, "README.md"), "uncommitted\n");
  const c = paste(dirty, lines);
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /restack: the merge did not start/);
  untouched(dirty, "dirty worktree");
  // The developer's own merge of main is already in progress: the recipe
  // refuses to start, and its commit line never commits that merge.
  const pending = devClone(world, child);
  git(["merge", "-q", "--no-ff", "--no-commit", "-s", "ours", "origin/main"], { cwd: pending, env: DEV });
  const d = paste(pending, lines);
  assert.notEqual(d.status, 0);
  assert.equal(git(["rev-parse", "HEAD"], { cwd: pending }).out.trim(), child, "the pending merge is not committed");
  assert.equal(git(["rev-parse", "MERGE_HEAD"], { cwd: pending }).out.trim(), git(["rev-parse", "origin/main"], { cwd: pending }).out.trim());
});

test("two parents: with only one held head in Z, the other parent's code still conflicts", async () => {
  const world = buildCase(CASES.find((c) => c.name === "two parents"));
  worlds.push(world);
  const { plan, child, base } = await planFor(world, 2);
  assert.equal(plan.status, "restack");
  const onlyP = virtualBase({ base, pOlds: [world.labels.get("p1")], cwd: world.dir });
  assert.deepEqual(mergeTree(child, onlyP, world.dir).files, ["b.txt"]);
});
