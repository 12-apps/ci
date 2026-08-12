#!/usr/bin/env node
/**
 * Self-tests for the fetch-base action's ladder. Run:
 *   node --test .github/actions/fetch-base/__tests__/fetch-base.test.mjs
 *
 * The centerpiece is the case the old `git fetch --depth=1 origin <base>` got
 * wrong, and it is deliberately built on a COMPLETE clone — because that is
 * what the affected lanes actually have (`actions/checkout` with
 * `fetch-depth: 0`) and what makes the old behaviour so counter-intuitive: the
 * repository already contained the merge base, and the fetch destroyed it.
 * `depth-1 fetch poisons a complete clone` proves that precondition directly,
 * so if git ever changes this behaviour the suite says so instead of quietly
 * testing nothing.
 *
 * Node builtins only — this runs before any install.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { fetchBaseAndResolve } from "../fetch-base.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const gitFails = (cwd, ...args) => {
  try {
    git(cwd, ...args);
    return false;
  } catch {
    return true;
  }
};

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "fetch-base@test.invalid");
  git(dir, "config", "user.name", "fetch-base test");
  git(dir, "config", "commit.gpgsign", "false");
  // github.com allows fetch-by-sha; local transports must be told to.
  git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  return dir;
}

function commit(dir, file, message) {
  writeFileSync(join(dir, file), `${file}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", message);
}

const TMP = mkdtempSync(join(tmpdir(), "fetch-base-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/**
 * An origin whose main advances by `advance` commits AFTER `feature` branches
 * off, so a merge base exists but is not either tip.
 */
function makeOrigin(name, { baseCommits = 5, advance = 10 } = {}) {
  const origin = initRepo(join(TMP, name));
  for (let i = 1; i <= baseCommits; i += 1) commit(origin, `base-${i}.txt`, `chore: base ${i}`);
  git(origin, "checkout", "-qb", "feature");
  commit(origin, "feature.txt", "feat: the branch's own work");
  git(origin, "checkout", "-q", "main");
  for (let i = 1; i <= advance; i += 1) commit(origin, `adv-${i}.txt`, `chore: advance ${i}`);
  return { origin, branchPoint: git(origin, "merge-base", "main", "feature") };
}

const cloneFull = (origin, dir) => {
  execFileSync("git", ["clone", "-q", "--branch", "feature", origin, dir], { stdio: "ignore" });
  return dir;
};

/**
 * A genuinely shallow clone. The `file://` URL is load-bearing: git IGNORES
 * `--depth` for a plain local path ("--depth is ignored in local clones"), so
 * a path-based clone here would silently produce a COMPLETE repo and the
 * shallow-recovery tests would assert nothing.
 */
const cloneShallow = (origin, dir) => {
  execFileSync(
    "git",
    ["clone", "-q", "--depth=1", "--branch", "feature", `file://${origin}`, dir],
    { stdio: "ignore" },
  );
  return dir;
};

// ── The precondition: the old command's damage, on a COMPLETE clone ─────────

test("depth-1 fetch poisons a complete clone (the bug being fixed)", () => {
  const { origin, branchPoint } = makeOrigin("poison-origin");
  const work = cloneFull(origin, join(TMP, "poison-work"));

  assert.equal(git(work, "rev-parse", "--is-shallow-repository"), "false");
  assert.equal(
    git(work, "merge-base", "origin/main", "HEAD"),
    branchPoint,
    "a complete clone already knows the branch point",
  );

  git(work, "fetch", "--no-tags", "--depth=1", "origin", "main");

  assert.equal(
    git(work, "rev-parse", "--is-shallow-repository"),
    "true",
    "the depth-1 fetch turned a complete repository shallow",
  );
  assert.ok(
    gitFails(work, "merge-base", "FETCH_HEAD", "HEAD"),
    "and destroyed the merge base it already had",
  );
});

// ── The fix ────────────────────────────────────────────────────────────────

test("keeps a complete clone complete and resolves the merge base", () => {
  const { origin, branchPoint } = makeOrigin("plain-origin");
  const work = cloneFull(origin, join(TMP, "plain-work"));

  const resolved = fetchBaseAndResolve("main", { cwd: work });

  assert.ok(resolved, "merge base must resolve");
  assert.equal(resolved.mergeBase, branchPoint);
  assert.equal(
    git(work, "rev-parse", "--is-shallow-repository"),
    "false",
    "the repository must NOT have been grafted shallow",
  );
  assert.equal(
    git(work, "rev-parse", "FETCH_HEAD"),
    git(origin, "rev-parse", "main"),
    "FETCH_HEAD must point at the base tip — callers diff against it",
  );
});

test("three-dot diff and turbo's range work after the fix", () => {
  const { origin } = makeOrigin("diff-origin");
  const work = cloneFull(origin, join(TMP, "diff-work"));

  const { mergeBase } = fetchBaseAndResolve("main", { cwd: work });

  // The exact commands the consuming lanes run.
  assert.equal(git(work, "diff", "--name-only", "FETCH_HEAD...HEAD"), "feature.txt");
  assert.equal(git(work, "diff", "--name-only", `${mergeBase}`, "HEAD"), "feature.txt");
});

test("recovers a checkout that was ALREADY shallow", () => {
  const { origin, branchPoint } = makeOrigin("shallow-origin", { baseCommits: 8, advance: 12 });
  const work = cloneShallow(origin, join(TMP, "shallow-work"));
  assert.equal(git(work, "rev-parse", "--is-shallow-repository"), "true");

  const resolved = fetchBaseAndResolve("main", { cwd: work });

  assert.ok(resolved, "the ladder must dig out of a genuinely shallow checkout");
  assert.equal(resolved.mergeBase, branchPoint);
  assert.equal(git(work, "diff", "--name-only", "FETCH_HEAD...HEAD"), "feature.txt");
});

test("a branch that diverged past any fixed depth still resolves", () => {
  // 120 commits of advance defeats the --depth=50 magic number that this
  // replaces; the ladder's first rung (64) does not cover it either, which is
  // the point of having rungs at all.
  const { origin, branchPoint } = makeOrigin("deep-origin", { baseCommits: 5, advance: 120 });
  const work = cloneShallow(origin, join(TMP, "deep-work"));
  assert.equal(git(work, "rev-parse", "--is-shallow-repository"), "true");

  const resolved = fetchBaseAndResolve("main", { cwd: work });

  assert.ok(resolved, "a deep divergence must still resolve");
  assert.equal(resolved.mergeBase, branchPoint);
});

test("returns null for unrelated histories rather than a bogus empty diff", () => {
  const { origin } = makeOrigin("unrelated-origin");
  const work = cloneFull(origin, join(TMP, "unrelated-work"));

  const orphan = initRepo(join(TMP, "unrelated-orphan"));
  commit(orphan, "orphan.txt", "chore: unrelated root");
  git(work, "remote", "add", "orphan", orphan);
  git(work, "fetch", "-q", "orphan", "main");

  assert.equal(fetchBaseAndResolve("orphan/main", { cwd: work }), null);
});
