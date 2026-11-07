// FUT-4548: a shard records what IT passed; a lane that failed or was
// cancelled merges those records post-matrix. Every rule here is a placement
// or a gate, and each one fails silently when broken:
//
//   - a shard record gated on anything weaker than its own test step's
//     `success` names a failed test as green, and the next push skips it;
//   - a shard record that ignores the single-shard zero-test guard records a
//     shard that ran nothing;
//   - a merge job that also runs on a GREEN lane races the verdict job for the
//     same run-scoped key; one that reads another attempt's artifacts merges a
//     record this attempt did not earn;
//   - a merge job that writes the lane verdict turns "some shards passed" into
//     "this tree passed".
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { jobBlocks } from "./matrix-zero-guard.test.mjs";

const source = readFileSync(path.join(fileURLToPath(new URL("../", import.meta.url)), "monorepo-tests.yml"), "utf8");
const jobs = Object.fromEntries(jobBlocks(source).map((j) => [j.name, j.body]));
const STEP = { unit: "unit", integration: "integration" };

/** The text of the step named `name` inside a job body, up to the next step. */
function step(body, name) {
  const at = body.indexOf(`- name: ${name}\n`);
  assert.notEqual(at, -1, `missing step: ${name}`);
  const next = body.indexOf("\n      - name: ", at + 1);
  return body.slice(at, next === -1 ? undefined : next);
}

for (const lane of ["unit", "integration"]) {
  const shards = jobs[`${lane}-tests`];
  const merge = jobs[`${lane}-green-shards`];

  test(`${lane}-tests: a shard records after its OWN test step succeeded or failed, and is told which`, () => {
    const s = step(shards, "Record what this shard proved");
    assert.match(s, new RegExp(`\\(steps\\.${STEP[lane]}\\.outcome == 'success' \\|\\| steps\\.${STEP[lane]}\\.outcome == 'failure'\\)`), "a green shard records, a red one evicts");
    assert.match(
      s,
      new RegExp(`outcome: \\$\\{\\{ steps\\.${lane}-signal-guard\\.outcome == 'failure' && 'no-signal' \\|\\| steps\\.${STEP[lane]}\\.outcome \\}\\}`),
      "the script is told the outcome, and a guard that failed turns a green step into no claim",
    );
    assert.match(s, /mode: shard/);
    assert.match(s, new RegExp(`skip-green-key != ''`), "only when skip-green is on for this run");
    assert.match(s, /leg: \$\{\{ steps\.leg\.outputs\.file \}\}/, "the leg list is what the shard ran");
    assert.match(s, /head-sha: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
    // A red shard reads the lane log the test step tees, before trusting clean rows.
    assert.match(s, new RegExp(`log: ${lane}\\.log\\n`));
    assert.match(shards, new RegExp(`2>&1 \\| tee ${lane}\\.log`));
    // The guard the gate reads must be the single-shard zero-test guard.
    assert.match(shards, new RegExp(`- name: Verify the ${lane} lane executed at least one test\\n\\s+id: ${lane}-signal-guard\\n`));
  });

  test(`${lane}-tests: the shard record is uploaded per attempt and per shard, only when written`, () => {
    const s = step(shards, "Upload this shard's green record");
    assert.match(s, /if: \$\{\{ always\(\) && steps\.green-shard\.outputs\.written == 'true' \}\}/);
    assert.match(s, new RegExp(`name: skip-green-${lane}-a\\$\\{\\{ github\\.run_attempt \\}\\}-s\\$\\{\\{ matrix\\.shard \\}\\}`));
    // The record lives in a dot-directory, which upload-artifact skips by default.
    assert.match(s, /include-hidden-files: true/);
    // Skip-green bookkeeping never fails a shard.
    assert.match(s, /continue-on-error: true/);
    assert.match(step(shards, "Record what this shard proved"), /continue-on-error: true/);
  });

  test(`${lane}-green-shards: runs only for a FAILED or CANCELLED lane, after the matrix, on a pull request`, () => {
    assert.ok(merge, `${lane}-green-shards exists`);
    assert.match(merge, new RegExp(`needs: \\[${lane}-plan, ${lane}-tests\\]`));
    assert.match(merge, new RegExp(`\\(needs\\.${lane}-tests\\.result == 'failure' \\|\\| needs\\.${lane}-tests\\.result == 'cancelled'\\)`));
    assert.doesNotMatch(merge, new RegExp(`needs\\.${lane}-tests\\.result == 'success'`), "a green lane is the verdict job's; two writers race one key");
    assert.match(merge, /github\.event_name == 'pull_request'/);
    assert.match(merge, new RegExp(`needs\\.${lane}-plan\\.result == 'success'`));
  });

  test(`${lane}-green-shards: merges THIS attempt's shard records into the run-scoped manifest, and writes no lane verdict`, () => {
    assert.match(merge, new RegExp(`pattern: skip-green-${lane}-a\\$\\{\\{ github\\.run_attempt \\}\\}-\\*`));
    const rec = step(merge, "Merge the green shards into the manifest");
    assert.match(rec, /mode: record/);
    assert.match(rec, /shard-records: \.skip-green-shards/);
    assert.match(rec, new RegExp(`shard-total: \\$\\{\\{ needs\\.${lane}-plan\\.outputs\\.count \\}\\}`), "a silent shard's leg is evicted by index");
    assert.match(rec, new RegExp(`lane-result: \\$\\{\\{ needs\\.${lane}-tests\\.result \\}\\}`));
    assert.match(rec, new RegExp(`plan: \\.affected-plan/affected-plan\\.${lane}\\.json`));
    assert.match(step(merge, "Save the green manifest"), /if: \$\{\{ steps\.record\.outputs\.recorded == 'true' \}\}/);
    assert.match(
      merge,
      new RegExp(`key: green-${lane}-\\$\\{\\{ needs\\.${lane}-plan\\.outputs\\.skip-green-key \\}\\}-pr\\$\\{\\{ github\\.event\\.pull_request\\.number \\}\\}-\\$\\{\\{ github\\.run_id \\}\\}`),
    );
    assert.doesNotMatch(merge, new RegExp(`${lane}-lane-|lane-verdict`), "the tree verdict is never written from a lane that did not pass");
  });

  test(`${lane}-verdict: still success-only, and records only what the shards' JUnit showed (FUT-4563)`, () => {
    const verdict = jobs[`${lane}-verdict`];
    assert.match(verdict, new RegExp(`needs\\.${lane}-tests\\.result == 'success'`));
    assert.match(verdict, new RegExp(`pattern: skip-green-${lane}-a\\$\\{\\{ github\\.run_attempt \\}\\}-\\*`));
    assert.match(step(verdict, "Record the green tests"), /shard-records: \.skip-green-shards/, "never the plan's whole list");
  });

  test(`${lane}-tests: the shard record reads the lane's JUnit reports`, () => {
    assert.match(step(shards, "Record what this shard proved"), new RegExp(`reports: \\$\\{\\{ inputs\\.${lane}-junit-reports \\}\\}`));
  });
}
