// skip-green must FILTER in the plan job, before the matrix is sized and before
// the plan artifact the shards download is uploaded; and RECORD in the verdict
// job, after the matrix, from a lane whose result is `success`.
//
// Both are placement rules and both fail silently when broken:
//
//   - a filter that runs after `affected-plan` uploaded its document rewrites
//     a file nobody runs — the shards download the unfiltered plan, every test
//     runs, and the log still says "skipped";
//   - a matrix sized from the UNFILTERED count boots shards for tests the
//     filtered plan no longer holds; sized without honouring a filtered zero,
//     it boots a shard to discover it has nothing to do;
//   - a record step gated on anything weaker than the lane's own `success`
//     writes a manifest a failed or cancelled run did not earn, and the next
//     push skips a test that was never green.
//
// Every rule below is asserted over the workflow text, per lane.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { jobBlocks } from "./matrix-zero-guard.test.mjs";

const source = readFileSync(path.join(fileURLToPath(new URL("../", import.meta.url)), "monorepo-tests.yml"), "utf8");
const jobs = Object.fromEntries(jobBlocks(source).map((j) => [j.name, j.body]));
const LANES = ["unit", "integration"];

test("both skip-green inputs are declared, opt-in and empty by default", () => {
  for (const name of ["skip-green", "skip-green-always-run"]) {
    // A folded description may hold blank lines; the block ends at the next
    // key indented like the input name itself.
    const block = new RegExp(`^      ${name}:\\n((?:(?:        .*|)\\n)+)`, "m").exec(source);
    assert.ok(block, `${name} is declared under workflow_call.inputs`);
    assert.match(block[1], /required: false/);
    assert.match(block[1], /default: ''/);
  }
});

for (const lane of LANES) {
  const plan = jobs[`${lane}-plan`];
  const verdict = jobs[`${lane}-verdict`];

  test(`${lane}-plan: the plan is not uploaded by affected-plan when skip-green is on`, () => {
    assert.match(plan, /upload-artifact: \$\{\{ inputs\.skip-green == '' \}\}/, "affected-plan must leave the upload to the filter path");
  });

  test(`${lane}-plan: restore → filter → upload, in that order, and all after affected-plan`, () => {
    const at = (needle) => {
      const i = plan.indexOf(needle);
      assert.notEqual(i, -1, `${lane}-plan is missing: ${needle}`);
      return i;
    };
    const affected = at("id: affected");
    const restore = at("- name: Restore the green manifest");
    const filter = at("id: skipgreen");
    const upload = at("- name: Upload the filtered plan");
    const size = at("- name: Compute the shard list");
    assert.ok(affected < restore && restore < filter && filter < upload && upload < size, "order: affected-plan, restore, filter, upload, then size the matrix");
  });

  test(`${lane}-plan: the manifest is restored by a per-PR, per-lane-key PREFIX`, () => {
    assert.match(
      plan,
      new RegExp(`restore-keys: \\|\\n\\s+green-${lane}-\\$\\{\\{ steps\\.skip-green-key\\.outputs\\.value \\}\\}-pr\\$\\{\\{ github\\.event\\.pull_request\\.number \\}\\}-\\n`),
      "the newest manifest of THIS pull request, for a lane run THIS way",
    );
  });

  test(`${lane}-plan: skip-green is never active off a pull request`, () => {
    assert.match(plan, /id: skip-green-key\n\s+if: \$\{\{ inputs\.skip-green != '' && inputs\.affected-plan-config != '' && github\.event_name == 'pull_request' \}\}/);
  });

  test(`${lane}-plan: the matrix is sized from the FILTERED plan, zero included`, () => {
    assert.match(plan, /SKIP_GREEN_FILTERED: \$\{\{ steps\.skipgreen\.outputs\.filtered \}\}/);
    assert.match(plan, /SKIP_GREEN_ASKED: \$\{\{ steps\.skipgreen\.outputs\.shard-total \}\}/);
    assert.match(
      plan,
      /if \[ "\$\{SKIP_GREEN_FILTERED:-\}" = "true" \] && \[\[ "\$\{SKIP_GREEN_ASKED:-\}" =~ \^\[0-9\]\+\$ \]\]; then\n\s+PLAN_ASKED="\$SKIP_GREEN_ASKED"/,
      "a bash decision, not an expression `||`, so a filtered 0 is honoured",
    );
  });

  test(`${lane}-plan: the filter reads the same policy and always-run list the caller set`, () => {
    assert.match(plan, /policy: \$\{\{ inputs\.skip-green \}\}/);
    assert.match(plan, /always-run: \$\{\{ inputs\.skip-green-always-run \}\}/);
    assert.match(plan, new RegExp(`skip-green-key: \\$\\{\\{ steps\\.skip-green-key\\.outputs\\.value \\}\\}`), "the key is an output for the verdict job");
  });

  test(`${lane}-verdict: records only from a lane whose result is success, after the matrix`, () => {
    assert.match(verdict, new RegExp(`needs\\.${lane}-tests\\.result == 'success'`), "the job itself is gated on the lane passing");
    assert.match(verdict, new RegExp(`lane-result: \\$\\{\\{ needs\\.${lane}-tests\\.result \\}\\}`), "and the record step is told the result, so it can refuse on its own");
    assert.match(verdict, new RegExp(`needs: \\[${lane}-plan, ${lane}-tests, ${lane}-signal\\]`));
    assert.match(verdict, /mode: record/);
  });

  test(`${lane}-verdict: the manifest is saved only when something was recorded, under the run-scoped key`, () => {
    assert.match(verdict, /- name: Save the green manifest\n\s+if: \$\{\{ steps\.record\.outputs\.recorded == 'true' \}\}/);
    assert.match(
      verdict,
      new RegExp(`key: green-${lane}-\\$\\{\\{ needs\\.${lane}-plan\\.outputs\\.skip-green-key \\}\\}-pr\\$\\{\\{ github\\.event\\.pull_request\\.number \\}\\}-\\$\\{\\{ github\\.run_id \\}\\}`),
    );
  });

  test(`${lane}-verdict: the record reads the plan the shards RAN (the filtered artifact) and names the PR head`, () => {
    assert.match(verdict, new RegExp(`name: affected-plan-${lane}\\n\\s+path: \\.affected-plan`));
    assert.match(verdict, new RegExp(`plan: \\.affected-plan/affected-plan\\.${lane}\\.json`));
    assert.match(verdict, /head-sha: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/, "the skip line names a commit a human can find, not the merge ref");
  });

  test(`${lane}-verdict: still runs for skip-green alone, and the fingerprint steps stand down without a fingerprint`, () => {
    assert.match(verdict, new RegExp(`\\(needs\\.${lane}-plan\\.outputs\\.fingerprint != '' \\|\\| needs\\.${lane}-plan\\.outputs\\.skip-green-key != ''\\)`));
    assert.match(verdict, new RegExp(`- name: Note what passed\\n\\s+if: \\$\\{\\{ needs\\.${lane}-plan\\.outputs\\.fingerprint != '' \\}\\}`));
    assert.match(verdict, new RegExp(`- name: Save the lane verdict\\n\\s+if: \\$\\{\\{ needs\\.${lane}-plan\\.outputs\\.fingerprint != '' \\}\\}`));
  });
}

// Every output a workflow reads off a composite action must be one the action
// DECLARES. An undeclared one is not an error anywhere: the expression reads
// as empty, and a bash `if` on it silently takes the other branch. Measured on
// future-pay run 36672278601: `skip-green` wrote `filtered=true` to
// GITHUB_OUTPUT, the action had no `filtered:` under `outputs:`, and the plan
// job saw `SKIP_GREEN_FILTERED:` empty — an enforce that dropped a test still
// sized its matrix from the unfiltered count.
for (const [action, stepId] of [["skip-green", "skipgreen"], ["lane-verdict", "lane-verdict"]]) {
  test(`every steps.${stepId}.outputs.* the workflows read is declared by the ${action} action`, () => {
    const actionYml = readFileSync(path.join(WORKFLOWS, `../actions/${action}/action.yml`), "utf8");
    const declared = new Set([...actionYml.slice(actionYml.indexOf("\noutputs:"), actionYml.indexOf("\nruns:")).matchAll(/^  ([a-z][a-z-]*):\s*$/gm)].map((m) => m[1]));
    const used = new Set();
    for (const file of ["monorepo-tests.yml", "monorepo-static.yml", "package-gates.yml"]) {
      for (const m of read(file).matchAll(new RegExp(`steps\\.${stepId}\\.outputs\\.([a-z][a-z-]*)`, "g"))) used.add(m[1]);
    }
    assert.ok(used.size > 0, `no workflow reads ${stepId} outputs — the sweep is aimed wrong`);
    assert.deepEqual([...used].filter((o) => !declared.has(o)), [], `read by a workflow, declared by no action output — reads as EMPTY at run time`);
  });
}

