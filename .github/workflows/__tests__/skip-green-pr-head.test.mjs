// FUT-4549: both test lanes hand affected-plan the PR HEAD as the commit its
// per-test input hashes read. Dropped, the hashes fall back to the merge
// commit and every merge to main that touches a lane global retires every
// skip-green proof on every open pull request (PR 4219: 2,127 unit + 608
// integration entries between runs 42026943166 and 42034252075).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { jobBlocks } from "./matrix-zero-guard.test.mjs";

const here = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(path.join(here, "monorepo-tests.yml"), "utf8");
const action = readFileSync(path.join(here, "../actions/affected-plan/action.yml"), "utf8");
const jobs = Object.fromEntries(jobBlocks(source).map((j) => [j.name, j.body]));

for (const lane of ["unit", "integration"]) {
  test(`${lane}-plan: affected-plan reads input blobs at the PR head`, () => {
    const at = jobs[`${lane}-plan`].indexOf("id: affected\n");
    assert.notEqual(at, -1);
    const step = jobs[`${lane}-plan`].slice(at, jobs[`${lane}-plan`].indexOf("\n      - name: ", at));
    assert.match(step, /inputs-ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  });
}

test("affected-plan declares inputs-ref and hands it to plan.mjs through the environment", () => {
  assert.match(action, /\n  inputs-ref:\n/);
  assert.match(action, /INPUTS_REF: \$\{\{ inputs\.inputs-ref \}\}/);
  assert.match(action, /--inputs-ref "\$INPUTS_REF"/);
});
