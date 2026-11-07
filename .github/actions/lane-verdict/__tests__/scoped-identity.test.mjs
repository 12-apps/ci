// FUT-4550: the skip-green manifest key reads the identity of only what ONE
// workflow executes. An engine change OUTSIDE it keeps every manifest; a
// change to anything the lane runs — the workflow, an action it names, an
// action THAT names, a module one of them imports from another action —
// retires them. Anything unresolvable yields no identity at all.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { executionIdentity, implementationHash, laneImplementationFiles, laneImplementationHash } from "../provenance.mjs";

const root = mkdtempSync(join(tmpdir(), "scoped-identity-"));
after(() => rmSync(root, { recursive: true, force: true }));
const central = join(root, "central");
const put = (path, body) => {
  mkdirSync(dirname(join(central, path)), { recursive: true });
  writeFileSync(join(central, path), body);
};
const files = {
  ".github/workflows/tests.yml": "jobs:\n  t:\n    steps:\n      - uses: 12-apps/ci/.github/actions/alpha@v2\n      - uses: 12-apps/ci/.github/actions/beta@v2\n",
  ".github/workflows/deploy.yml": "jobs:\n  d:\n    steps:\n      - uses: 12-apps/ci/.github/actions/epsilon@v2\n",
  ".github/actions/alpha/action.yml": "runs:\n  using: composite\n",
  ".github/actions/alpha/run.mjs": 'import { shared } from "../delta/lib/shared.mjs";\n// an example in a comment: import x from "./not-here.mjs";\nexport const run = shared;\n',
  ".github/actions/alpha/README.md": "docs\n",
  ".github/actions/alpha/__tests__/run.test.mjs": "test\n",
  ".github/actions/beta/action.yml": "runs:\n  steps:\n    - uses: 12-apps/ci/.github/actions/gamma@v2\n",
  ".github/actions/gamma/action.yml": "runs:\n  using: composite\n",
  ".github/actions/gamma/step.sh": "echo gamma\n",
  ".github/actions/delta/action.yml": "runs:\n  using: composite\n",
  ".github/actions/delta/lib/shared.mjs": "export const shared = 1;\n",
  ".github/actions/epsilon/action.yml": "runs:\n  using: composite\n",
  ".github/actions/epsilon/deploy.mjs": "deploy\n",
};
for (const [path, body] of Object.entries(files)) put(path, body);
const scoped = () => laneImplementationHash("tests.yml", central);
const touch = (path, body, check) => {
  const before = files[path];
  put(path, body);
  try {
    check();
  } finally {
    put(path, before);
  }
};

test("the scope is the workflow, the actions it names transitively, and their cross-action imports — minus tests and docs", () => {
  assert.deepEqual(laneImplementationFiles("tests.yml", central), [
    ".github/actions/alpha/action.yml",
    ".github/actions/alpha/run.mjs",
    ".github/actions/beta/action.yml",
    ".github/actions/delta/action.yml",
    ".github/actions/delta/lib/shared.mjs",
    ".github/actions/gamma/action.yml",
    ".github/actions/gamma/step.sh",
    ".github/workflows/tests.yml",
  ]);
});

test("an engine change OUTSIDE the lane keeps the scoped identity (the whole-engine one moves)", () => {
  const before = scoped();
  const whole = implementationHash(central);
  for (const [path, body] of [
    [".github/workflows/deploy.yml", "jobs: {}\n"],
    [".github/actions/epsilon/deploy.mjs", "deploy v2\n"],
    [".github/actions/alpha/README.md", "new docs\n"],
    [".github/actions/alpha/__tests__/run.test.mjs", "new test\n"],
  ]) {
    touch(path, body, () => {
      assert.equal(scoped(), before, `${path}: outside what the lane runs`);
      assert.notEqual(implementationHash(central), whole, `${path}: the whole-engine identity still moves`);
    });
  }
});

test("counterexample: a change to anything the lane RUNS retires the scoped identity", () => {
  const before = scoped();
  for (const [path, body] of [
    [".github/workflows/tests.yml", `${files[".github/workflows/tests.yml"]}# changed\n`],
    [".github/actions/alpha/run.mjs", `${files[".github/actions/alpha/run.mjs"]}// changed\n`],
    [".github/actions/alpha/action.yml", "runs:\n  using: node24\n"],
    [".github/actions/gamma/step.sh", "echo changed\n"],
    [".github/actions/delta/lib/shared.mjs", "export const shared = 2;\n"],
  ]) {
    touch(path, body, () => assert.notEqual(scoped(), before, `${path} is part of the lane`));
  }
  assert.equal(scoped(), before);
});

test("anything unresolvable yields no identity, never a narrower one", () => {
  assert.throws(() => laneImplementationHash("missing.yml", central), /missing/);
  assert.throws(() => laneImplementationHash("../tests.yml", central), /not a workflow file name/);
  touch(".github/workflows/tests.yml", "steps:\n  - uses: 12-apps/ci/.github/actions/nowhere@v2\n", () => {
    assert.throws(scoped, /lane action missing: nowhere/);
  });
  touch(".github/actions/alpha/run.mjs", 'import "../../../../outside.mjs";\n', () => {
    assert.throws(scoped, /imports outside the engine|missing/);
  });
  touch(".github/actions/alpha/run.mjs", 'import { x } from "../delta/lib/gone.mjs";\n', () => {
    assert.throws(scoped, /missing/);
  });
});

test("executionIdentity with a workflow is the scoped one, and differs from the whole-engine identity", () => {
  const caller = join(root, "caller");
  mkdirSync(join(caller, ".github/workflows"), { recursive: true });
  writeFileSync(join(caller, ".github/workflows/ci.yml"), "on: pull_request\n");
  const git = (...args) => execFileSync("git", args, { cwd: caller, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "--allow-empty", "-qm", "f");
  git("add", ".");
  git("-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "-qm", "f");
  const options = { sourceRoot: central, consumerRoot: caller, env: {}, nodeVersion: "v24.1.0", platform: "linux", arch: "x64" };
  const scopedId = executionIdentity({ ...options, workflow: "tests.yml" });
  assert.notEqual(scopedId, executionIdentity(options));
  touch(".github/workflows/deploy.yml", "jobs: {}\n", () => assert.equal(executionIdentity({ ...options, workflow: "tests.yml" }), scopedId));
});

test("the real engine: monorepo-tests.yml's scope holds what its lanes run, and not what they do not", () => {
  const scope = laneImplementationFiles("monorepo-tests.yml");
  for (const file of [
    ".github/workflows/monorepo-tests.yml",
    ".github/actions/skip-green/filter.mjs",
    ".github/actions/skip-green/record.mjs",
    ".github/actions/affected-plan/lib/inputs.mjs",
    ".github/actions/affected-plan/plan.mjs",
    ".github/actions/lane-verdict/provenance.mjs",
    ".github/actions/fetch-base/action.yml",
  ]) assert.ok(scope.includes(file), `${file} is run by the test lanes`);
  for (const file of scope) {
    assert.doesNotMatch(file, /__tests__\/|\.md$/i, file);
    assert.doesNotMatch(file, /^\.github\/workflows\/(?!monorepo-tests\.yml$)/, `${file}: another workflow`);
  }
  assert.ok(!scope.some((f) => f.startsWith(".github/actions/conflict-monitor/")), "an action the lanes never call");
});

test("FUT-4549 + FUT-4550: the scoped identity also reads the caller's workflows at the consumer ref", () => {
  const caller = join(root, "caller-ref");
  mkdirSync(join(caller, ".github/workflows"), { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: caller, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  writeFileSync(join(caller, ".github/workflows/ci.yml"), "v1\n");
  git("add", ".");
  git("-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "-qm", "head");
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(caller, ".github/workflows/ci.yml"), "v2 (main moved it)\n");
  git("add", ".");
  git("-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "-qm", "merge-ish");
  const options = { sourceRoot: central, consumerRoot: caller, env: {}, nodeVersion: "v24.1.0", platform: "linux", arch: "x64", workflow: "tests.yml" };
  const atHead = executionIdentity({ ...options, consumerRef: head });
  assert.notEqual(executionIdentity(options), atHead, "the checkout's workflows differ");
  assert.equal(executionIdentity({ ...options, consumerRef: head }), atHead);
});
