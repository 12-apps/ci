// FUT-4549: per-test input hashes read the PULL REQUEST HEAD's blobs, not the
// merge commit's. A merge to main the PR did not make — a lockfile bump,
// another PR's code in this test's closure — must not retire the PR's proof;
// the PR's OWN change to any input must. Membership is still the checkout's:
// a file only main has is left out, a file git does not track at all still
// leaves the test with no hash.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { INPUTS_VERSION, testInputs } from "../lib/inputs.mjs";

const T = "src/a.test.mjs";
const edges = new Map([[T, [{ target: "src/a.mjs" }]], ["src/a.mjs", [{ target: "src/shared.mjs" }]]]);
const merge = new Map([[T, "100644 t1"], ["src/a.mjs", "100644 a1"], ["src/shared.mjs", "100644 s-main"], ["pnpm-lock.yaml", "100644 lock-main"]]);
const head = new Map([[T, "100644 t1"], ["src/a.mjs", "100644 a1"], ["src/shared.mjs", "100644 s-old"], ["pnpm-lock.yaml", "100644 lock-old"]]);
const hash = (over = {}) => testInputs({ tests: [T], edges, globals: [/^pnpm-lock\.yaml$/], tree: merge, hashTree: head, ...over }).inputs[T];

test("the version names the construction: v2 manifests (merge-tree blobs) are retired", () => {
  assert.equal(INPUTS_VERSION, "test-inputs-v3");
});

test("blobs come from the PR head: main moving a closure file or a global leaves the hash alone", () => {
  const before = hash();
  const mainMoved = new Map([...merge, ["src/shared.mjs", "100644 s-main-2"], ["pnpm-lock.yaml", "100644 lock-main-2"]]);
  assert.equal(hash({ tree: mainMoved }), before, "a merge to main the PR did not make retires nothing");
  // Control: hashing the merge tree (the old construction) DID move.
  assert.notEqual(hash({ tree: mainMoved, hashTree: mainMoved }), hash({ hashTree: merge }));
});

test("counterexample: the PR's own change to any input moves the hash", () => {
  const before = hash();
  for (const [file, blob] of [[T, "100644 t2"], ["src/a.mjs", "100644 a2"], ["src/shared.mjs", "100644 s-pr"], ["pnpm-lock.yaml", "100644 lock-pr"]]) {
    assert.notEqual(hash({ hashTree: new Map([...head, [file, blob]]) }), before, `${file} changed at the PR head`);
  }
});

test("a file only main has is left out; a file git does not track at all still means no hash", () => {
  const mainOnly = new Map(head);
  mainOnly.delete("src/shared.mjs");
  const report = testInputs({ tests: [T], edges, globals: [], tree: merge, hashTree: mainOnly });
  assert.match(String(report.inputs[T]), /^[0-9a-f]{64}$/);
  assert.equal(report.stats.mainOnly, 1);
  const untracked = new Map(merge);
  untracked.delete("src/shared.mjs");
  assert.equal(testInputs({ tests: [T], edges, globals: [], tree: untracked, hashTree: head }).inputs[T], null, "not tracked by the checkout: no bounded claim");
});

test("without a hashTree (off a pull request) the checkout's own blobs are read, as before", () => {
  assert.equal(
    testInputs({ tests: [T], edges, globals: [], tree: merge }).inputs[T],
    testInputs({ tests: [T], edges, globals: [], tree: merge, hashTree: merge }).inputs[T],
  );
});

// ── end to end: plan.mjs on real merge commits ───────────────────────────────

const root = mkdtempSync(join(tmpdir(), "inputs-pr-head-"));
after(() => rmSync(root, { recursive: true, force: true }));
const CLI = fileURLToPath(new URL("../plan.mjs", import.meta.url));

test("plan.mjs --inputs-ref: a main-only lockfile move keeps the hash; the PR's own lockfile change does not", () => {
  const cwd = join(root, "repo");
  mkdirSync(join(cwd, "src"), { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (name, body) => writeFileSync(join(cwd, name), body);
  const commit = (msg) => { git("add", "."); git("commit", "-qm", msg); return git("rev-parse", "HEAD"); };
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  write(".affected-plan.json", JSON.stringify({
    workspaces: [], sourceRoots: ["src"],
    lanes: { unit: { roots: ["src"], test: "\\.test\\.mjs$", skipGreen: { globals: ["^pnpm-lock\\.yaml$"] } } },
  }));
  const lock = (top, bottom) => `top: ${top}\n${Array.from({ length: 8 }, (_, i) => `pad${i}: 0`).join("\n")}\nbottom: ${bottom}\n`;
  write("pnpm-lock.yaml", lock(1, 1));
  write("src/a.mjs", "export function a() { return 1; }\n");
  write("src/a.test.mjs", "import { a } from './a.mjs';\nconsole.log(a());\n");
  const c0 = commit("main 0");
  // The PR changes a's body: it selects a.test.mjs.
  write("src/a.mjs", "export function a() { return 2; }\n");
  const p1 = commit("pr 1");
  // Main moves only the lockfile.
  git("checkout", "-q", "--detach", c0);
  write("pnpm-lock.yaml", lock(2, 1));
  const c1 = commit("main 1");
  const mergeOf = (mainSha, prSha) => git("commit-tree", git("merge-tree", "--write-tree", mainSha, prSha), "-p", mainSha, "-p", prSha, "-m", "merge");
  const plan = (mergeSha, mainSha, ref) => {
    git("checkout", "-q", "--detach", mergeSha);
    execFileSync(process.execPath, [CLI, "--lane", "unit", "--base", mainSha, "--out", join(root, "plan.json"), ...(ref ? ["--inputs-ref", ref] : [])], {
      cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GITHUB_EVENT_NAME: "" },
    });
    return JSON.parse(readFileSync(join(root, "plan.json"), "utf8"));
  };
  const first = plan(mergeOf(c0, p1), c0, p1);
  assert.equal(first.mode, "narrowed");
  assert.deepEqual(first.tests, ["src/a.test.mjs"]);
  const h1 = first.inputs["src/a.test.mjs"];
  assert.match(String(h1), /^[0-9a-f]{64}$/);

  const second = plan(mergeOf(c1, p1), c1, p1);
  assert.equal(second.inputs["src/a.test.mjs"], h1, "main's lockfile bump retires nothing");
  // Control: the merge tree (no --inputs-ref) DOES move with main's lockfile.
  assert.notEqual(plan(mergeOf(c1, p1), c1, "").inputs["src/a.test.mjs"], plan(mergeOf(c0, p1), c0, "").inputs["src/a.test.mjs"]);

  // Counterexample: the PR's OWN lockfile change. Either the plan widens (a
  // global changed) and filters nothing, or the hash moves; never a reuse.
  git("checkout", "-q", "--detach", p1);
  write("pnpm-lock.yaml", lock(1, 3));
  const p2 = commit("pr 2");
  // (Here the plan refuses outright: a changed path no rule maps fails it.)
  let third = null;
  try {
    third = plan(mergeOf(c1, p2), c1, p2);
  } catch (error) {
    assert.match(String(error.stderr ?? error.message), /match no rule|global/, "refused, not reused");
  }
  if (third) assert.ok(third.mode !== "narrowed" || third.inputs?.["src/a.test.mjs"] !== h1, `the PR's lockfile change must not keep the hash (mode ${third.mode})`);
  // And the PR's own change to the test's closure moves the hash on a narrowed plan.
  git("checkout", "-q", "--detach", p1);
  write("src/a.mjs", "export function a() { return 3; }\n");
  const p3 = commit("pr 3");
  const fourth = plan(mergeOf(c1, p3), c1, p3);
  assert.equal(fourth.mode, "narrowed");
  assert.notEqual(fourth.inputs["src/a.test.mjs"], h1, "the PR's own edit to a's body re-runs a.test");
});
