// FUT-4549: the identity skip-green keys on reads the CALLER's workflows at
// the pull request HEAD, not at the merge commit the checkout holds. A
// `ci.yml` change on main must not retire a PR's per-test proofs (future-pay
// #4398: main's #4395 moved the key from c9895b55… to 77996150… with v2 still);
// the PR's own workflow change must.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { executionIdentity } from "../provenance.mjs";

const root = mkdtempSync(join(tmpdir(), "head-identity-"));
after(() => rmSync(root, { recursive: true, force: true }));
const central = join(root, "central");
mkdirSync(join(central, ".github/actions/x"), { recursive: true });
mkdirSync(join(central, ".github/workflows"), { recursive: true });
writeFileSync(join(central, ".github/actions/x/a.mjs"), "x\n");
writeFileSync(join(central, ".github/workflows/w.yml"), "w\n");
const caller = join(root, "caller");
mkdirSync(join(caller, ".github/workflows"), { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: caller, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git("init", "-q");
git("config", "user.name", "Fixture");
git("config", "user.email", "fixture@example.invalid");
const commit = (file, body, msg) => {
  writeFileSync(join(caller, file), body);
  git("add", ".");
  git("commit", "-qm", msg);
  return git("rev-parse", "HEAD");
};
const options = { sourceRoot: central, consumerRoot: caller, env: {}, nodeVersion: "v24.1.0", platform: "linux", arch: "x64" };
const id = (over = {}) => executionIdentity({ ...options, ...over });

const base = commit(".github/workflows/ci.yml", "on: pull_request # v1\n", "base");
const pr = commit("src.txt", "pr change\n", "pr");
const mergeOf = (mainSha, prSha) => git("commit-tree", git("merge-tree", "--write-tree", mainSha, prSha), "-p", mainSha, "-p", prSha, "-m", "merge");

test("a ci.yml change on main moves the merge-commit identity, but not the PR-head one", () => {
  git("checkout", "-q", "--detach", mergeOf(base, pr));
  const before = { merge: id(), head: id({ consumerRef: pr }) };
  git("checkout", "-q", "--detach", base);
  const main2 = commit(".github/workflows/ci.yml", "on: pull_request # v2, a main-only workflow change\n", "main");
  git("checkout", "-q", "--detach", mergeOf(main2, pr));
  assert.notEqual(id(), before.merge, "the checkout (merge commit) identity moves — what retired every manifest");
  assert.equal(id({ consumerRef: pr }), before.head, "read at the PR head, the main-only change retires nothing");
});

test("counterexample: the PR's OWN workflow change moves the PR-head identity", () => {
  git("checkout", "-q", "--detach", pr);
  const before = id({ consumerRef: pr });
  const pr2 = commit(".github/workflows/ci.yml", "on: pull_request # the PR edits its workflow\n", "pr2");
  assert.notEqual(id({ consumerRef: pr2 }), before);
});

test("the default is the checkout, and a ref that is not HEAD or a sha is refused", () => {
  assert.equal(id(), id({ consumerRef: "HEAD" }));
  assert.throws(() => id({ consumerRef: "main; rm -rf /" }), /not HEAD or a sha/);
  assert.throws(() => id({ consumerRef: "f".repeat(40) }), "an unknown commit has no workflows to read");
});
