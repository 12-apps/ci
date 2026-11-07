// FUT-4550: each test lane's green-manifest key reads the identity SCOPED to
// monorepo-tests.yml, while the tree fingerprint keeps the whole-engine one.
// Swap either and the failure is silent: a key on the whole engine is retired
// by every unrelated `@v2` move; a fingerprint on the scoped one would reuse a
// lane verdict across engine changes nobody reviewed for that.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { jobBlocks } from "./matrix-zero-guard.test.mjs";

const here = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(path.join(here, "monorepo-tests.yml"), "utf8");
const action = readFileSync(path.join(here, "../actions/lane-verdict/action.yml"), "utf8");
const jobs = Object.fromEntries(jobBlocks(source).map((j) => [j.name, j.body]));

const stepOf = (body, name) => {
  const at = body.indexOf(`- name: ${name}\n`);
  assert.notEqual(at, -1, `missing step: ${name}`);
  const next = body.indexOf("\n      - name: ", at + 1);
  return body.slice(at, next === -1 ? undefined : next);
};

for (const lane of ["unit", "integration"]) {
  const plan = jobs[`${lane}-plan`];
  test(`${lane}-plan: the identity step scopes to monorepo-tests.yml`, () => {
    assert.match(stepOf(plan, "Identify the CI implementation and runtime"), /scope-workflow: monorepo-tests\.yml(\n|$)/);
  });
  test(`${lane}-plan: the green-manifest key reads the SCOPED identity, the fingerprint the whole one`, () => {
    assert.match(stepOf(plan, "Key the green manifest to how this lane runs"), /EXECUTION_ID: \$\{\{ steps\.execution\.outputs\.scoped-identity \}\}/);
    const fingerprint = stepOf(plan, "Fingerprint the test-relevant tree");
    assert.match(fingerprint, /EXECUTION_ID: \$\{\{ steps\.execution\.outputs\.execution-identity \}\}/);
    assert.doesNotMatch(fingerprint, /scoped-identity/);
  });
}

test("lane-verdict declares the scoped-identity output and the scope-workflow input", () => {
  assert.match(action, /\n  scoped-identity:\n/);
  assert.match(action, /\n  scope-workflow:\n/);
  assert.match(action, /SCOPE_WORKFLOW: \$\{\{ inputs\.scope-workflow \}\}/);
});
