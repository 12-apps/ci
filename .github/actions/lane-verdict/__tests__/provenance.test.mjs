import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { executionIdentity, implementationHash, VERDICT_SCHEMA } from "../provenance.mjs";

const root = mkdtempSync(join(tmpdir(), "verdict-provenance-"));
after(() => rmSync(root, { recursive: true, force: true }));
const central = join(root, "central");
const caller = join(root, "caller");
for (const path of [join(central, ".github/actions/gates"), join(central, ".github/workflows"), join(caller, ".github/workflows")]) mkdirSync(path, { recursive: true });
writeFileSync(join(central, ".github/actions/gates/run.mjs"), "old implementation\n");
writeFileSync(join(central, ".github/workflows/test.yml"), "old workflow\n");
writeFileSync(join(caller, ".github/workflows/ci.yml"), "env: first\n");
const git = (...args) => execFileSync("git", args, { cwd: caller, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
const commit = () => { git("add", "."); git("commit", "--allow-empty", "-qm", "fixture"); };
commit();
const options = { sourceRoot: central, consumerRoot: caller, env: {}, nodeVersion: "v24.1.0", platform: "linux", arch: "x64" };
const identity = (override = {}) => executionIdentity({ ...options, ...override });

test("the explicit schema invalidates the pre-fix success-cache era", () => {
  assert.equal(VERDICT_SCHEMA, "ci-verdict-v2");
});

test("source changes under mutable @v2 invalidate identity without changing consumer files", () => {
  const before = identity();
  const action = join(central, ".github/actions/gates/run.mjs");
  writeFileSync(action, "strict implementation\n");
  assert.notEqual(identity(), before);
  writeFileSync(action, "old implementation\n");
  assert.equal(identity(), before);
  chmodSync(action, 0o755);
  assert.notEqual(identity(), before, "central executable modes are implementation inputs too");
  chmodSync(action, 0o644);
  assert.equal(identity(), before);
  const workflow = join(central, ".github/workflows/test.yml");
  writeFileSync(workflow, "stricter workflow\n");
  assert.notEqual(identity(), before);
  writeFileSync(workflow, "old workflow\n");
});

test("runtime changes move identity, while run ids and head commit ids do not", () => {
  const before = identity();
  for (const override of [
    { nodeVersion: "v24.2.0" }, { platform: "darwin" }, { arch: "arm64" },
    ...["RUNNER_OS", "RUNNER_ARCH", "RUNNER_ENVIRONMENT", "ImageOS", "ImageVersion"].map((name) => ({ env: { [name]: "changed" } })),
  ]) assert.notEqual(identity(override), before, JSON.stringify(override));
  assert.equal(identity({ env: { GITHUB_RUN_ID: "123", GITHUB_SHA: "x", GITHUB_WORKFLOW_SHA: "y" } }), before);
});

test("same caller workflow blobs at a new commit reuse identity; changed workflow env does not", () => {
  const before = identity();
  writeFileSync(join(caller, "README.md"), "docs-only push\n"); commit();
  assert.equal(identity(), before);
  writeFileSync(join(caller, ".github/workflows/ci.yml"), "env: second\n"); commit();
  assert.notEqual(identity(), before);
});

test("missing implementation or consumer Git data cannot yield an identity", () => {
  assert.throws(() => implementationHash(join(root, "missing")));
  assert.throws(() => identity({ consumerRoot: central }));
});
