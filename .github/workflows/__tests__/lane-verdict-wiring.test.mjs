// The lane verdict must be looked up BEFORE the matrix, and recorded AFTER it.
//
// Both halves are placement rules, and each fixes a distinct failure that the
// obvious placement — a step inside the shard — produces:
//
//   - LOOKUP. A step inside the matrix cannot stop the matrix. The plan sized
//     the lane, GitHub created every one of those jobs, and each paid a
//     checkout, a fingerprint and a cache probe (~16s, billed as a whole
//     minute) before discovering it had nothing to do — four jobs per lane,
//     eight across the two, on every push whose tree an earlier run had already
//     passed. The machinery to avoid it already existed one layer up:
//     `count=0` empties the matrix and no job is created at all.
//
//   - RECORD. A shard cannot make a LANE-level claim. The zero-test guard
//     asserts the MERGED total across shards, so a run whose signal job failed
//     would still have recorded every green shard, and the next identical tree
//     would skip straight past the guard on those records. That is why the
//     per-shard record stands itself down whenever the guard is armed on a
//     sharded lane — the skip and the guard were mutually exclusive until the
//     record moved past the matrix.
//
// Both are the kind of line a new lane is copied without, and both fail
// SILENTLY: a lookup in the wrong place still works, it just bills for jobs
// that do nothing; a record in the wrong place still works, it just makes a
// claim it did not earn. So they are asserted over the text.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { jobBlocks } from "./matrix-zero-guard.test.mjs";

const TESTS_WORKFLOW = path.join(
  fileURLToPath(new URL("../", import.meta.url)),
  "monorepo-tests.yml",
);
const source = readFileSync(TESTS_WORKFLOW, "utf8");
const jobs = Object.fromEntries(jobBlocks(source).map((j) => [j.name, j.body]));
const LANES = ["unit", "integration"];

test("the sweep reads the lanes it exists for", () => {
  // The guard against a rename emptying this file quietly.
  for (const lane of LANES) {
    for (const suffix of ["plan", "tests", "verdict"]) {
      assert.ok(jobs[`${lane}-${suffix}`], `${lane}-${suffix} is missing from monorepo-tests.yml`);
    }
  }
});

test("the verdict is looked up in the PLAN job, never inside the matrix", () => {
  for (const lane of LANES) {
    assert.match(
      jobs[`${lane}-plan`],
      new RegExp(`key: ${lane}-lane-\\$\\{\\{ steps\\.fingerprint\\.outputs\\.value \\}\\}`),
      `${lane}-plan must look up the lane verdict`,
    );
    assert.match(
      jobs[`${lane}-plan`],
      /lookup-only: true/,
      `${lane}-plan must not download the entry — its existence is the message`,
    );
    // The matrix job may keep its own per-shard mechanism, but it must never be
    // the thing that decides whether shards exist: by the time it runs, they do.
    assert.doesNotMatch(
      jobs[`${lane}-tests`],
      new RegExp(`key: ${lane}-lane-`),
      `${lane}-tests must not read the LANE verdict — a shard cannot stop the matrix`,
    );
  }
});

test("a hit empties the matrix rather than skipping a step", () => {
  for (const lane of LANES) {
    const plan = jobs[`${lane}-plan`];
    assert.match(plan, /VERDICT_HIT: \$\{\{ steps\.verdict\.outputs\.cache-hit \}\}/);
    assert.match(
      plan,
      /if \[ "\$VERDICT_HIT" = "true" \]; then[\s\S]*?COUNT=0/,
      `${lane}-plan must force COUNT=0 on a hit`,
    );
    // And the guard that turns COUNT=0 into "no job" has to still be there —
    // an empty matrix VECTOR is a run-level error, not a skip.
    assert.match(jobs[`${lane}-tests`], new RegExp(`needs\\.${lane}-plan\\.outputs\\.count != '0'`));
  }
});

test("the lane key excludes the shard count, or the skip misses what it exists for", () => {
  // A lane-level verdict says "every test this lane selects for this tree
  // passed", which is true however the set was sliced. Including the count
  // would make a plan that sizes 2 today unable to reuse a run that sized 4
  // yesterday — precisely the repeat push the mechanism is for.
  for (const lane of LANES) {
    const key = /lane="\$\(printf '[^']*'[\s\S]*?sha256sum/.exec(jobs[`${lane}-plan`]);
    assert.ok(key, `${lane}-plan computes no lane key`);
    assert.doesNotMatch(key[0], /SHARD|COUNT/, `${lane}'s lane key must not carry the shard count`);
  }
});

test("the record is post-matrix and only ever made by a run that earned it", () => {
  for (const lane of LANES) {
    const verdict = jobs[`${lane}-verdict`];
    // After BOTH the matrix and the signal job: the signal is what asserts the
    // merged total ran a test, so a lane that proved nothing must record nothing.
    assert.match(
      verdict,
      new RegExp(`needs: \\[${lane}-plan, ${lane}-tests, ${lane}-signal\\]`),
      `${lane}-verdict must wait on the matrix and the signal`,
    );
    assert.match(verdict, new RegExp(`needs\\.${lane}-tests\\.result == 'success'`));
    assert.match(verdict, new RegExp(`needs\\.${lane}-signal\\.result != 'failure'`));
    // `!cancelled()` rather than `always()`: a cancelled run has proved nothing,
    // and the recommended caller cancels in-progress PR runs on every push.
    assert.match(verdict, /!cancelled\(\)/);
    assert.doesNotMatch(verdict, /always\(\)/);
    // PR-only. The push run is the post-merge safety net; it skips nothing.
    assert.match(verdict, /github\.event_name == 'pull_request'/);
  }
});

test("the recorder saves the key the plan looked up, rather than computing its own", () => {
  // Two computations of one key are two things that can disagree, and a
  // recorder writing a DIFFERENT key from the one the next run reads is a skip
  // that silently never happens — green, and simply never faster.
  for (const lane of LANES) {
    assert.match(
      jobs[`${lane}-plan`],
      /fingerprint: \$\{\{ steps\.fingerprint\.outputs\.value \}\}/,
      `${lane}-plan must publish its fingerprint`,
    );
    assert.match(
      jobs[`${lane}-verdict`],
      new RegExp(`key: ${lane}-lane-\\$\\{\\{ needs\\.${lane}-plan\\.outputs\\.fingerprint \\}\\}`),
      `${lane}-verdict must save the plan's key`,
    );
    assert.doesNotMatch(
      jobs[`${lane}-verdict`],
      /sha256sum/,
      `${lane}-verdict must not recompute the key`,
    );
  }
});

test("an unusable fingerprint disables the mechanism instead of guessing", () => {
  for (const lane of LANES) {
    const plan = jobs[`${lane}-plan`];
    // The lookup and the record are both conditional on a non-empty value, and
    // the compute step falls through to empty on every failure path.
    assert.match(plan, /if: \$\{\{ steps\.fingerprint\.outputs\.value != '' \}\}/);
    assert.match(plan, /echo "value=" >> "\$GITHUB_OUTPUT"/);
    assert.doesNotMatch(plan.split("id: fingerprint")[1].split("- name:")[1] ?? "", /set -e\b/);
    assert.match(
      jobs[`${lane}-verdict`],
      new RegExp(`needs\\.${lane}-plan\\.outputs\\.fingerprint != ''`),
    );
  }
});
