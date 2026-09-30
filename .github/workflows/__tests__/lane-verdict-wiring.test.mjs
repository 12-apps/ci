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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// ── the tree fingerprint's IDENTITY (2026-09-30 audit: E2, E7, E8, E9) ────────

/** The `Key this lane's verdict`-style step of a plan job: from `id: fingerprint` to the next step. */
const fingerprintStep = (lane) => {
  const plan = jobs[`${lane}-plan`];
  const at = plan.indexOf("id: fingerprint");
  assert.notEqual(at, -1, `${lane}-plan has no fingerprint step`);
  const rest = plan.slice(at);
  const next = rest.indexOf("\n      - ", 1);
  return next === -1 ? rest : rest.slice(0, next);
};

test("E2: each lane's fingerprint key folds ITS OWN setup command, not the unit lane's", () => {
  // The integration key read `inputs.pre-test-command` — the unit setup — so a
  // change to `pre-integration-command` alone inherited the old verdict.
  assert.match(fingerprintStep("unit"), /LANE_PRE: \$\{\{ inputs\.pre-test-command \}\}/);
  assert.match(fingerprintStep("integration"), /LANE_PRE: \$\{\{ inputs\.pre-integration-command \}\}/);
  assert.doesNotMatch(fingerprintStep("integration"), /pre-test-command/);
});

for (const lane of LANES) {
  test(`${lane}: the fingerprint key carries the base, the engine revision, the runner and a schema epoch`, () => {
    const step = fingerprintStep(lane);
    assert.match(step, /BASE_SHA: \$\{\{ steps\.base\.outputs\.base-sha \}\}/, "E7: key the actual fetched base");
    assert.match(step, /MERGE_BASE: \$\{\{ steps\.base\.outputs\.merge-base \}\}/, "same trees with different ancestry select differently");
    assert.match(step, /EXECUTION_ID: \$\{\{ steps\.execution\.outputs\.execution-identity \}\}/, "E8: central sources and actual Node/runner/image identity");
    assert.match(jobs[`${lane}-plan`], /id: execution[\s\S]*?uses: 12-apps\/ci\/\.github\/actions\/lane-verdict@v2[\s\S]*?mode: identity/, "the identity is produced by the central action");
    assert.match(step, /printf '%s\\0' ci-lane-v2/, "the epoch that retires every incomplete previous key");
    // …and every one of them is IN the hash, not merely declared.
    // String slicing, not one regex over the whole step: a nested quantifier
    // over the continuation lines backtracks exponentially (CodeQL flagged the
    // first draft), and the shape here is fixed enough to cut by anchors.
    const from = step.indexOf("lane=\"$(printf '");
    assert.notEqual(from, -1, `${lane}: the key printf was not found`);
    const to = step.indexOf("| sha256sum", from);
    assert.notEqual(to, -1, `${lane}: the key printf is not piped to sha256sum`);
    const segment = step.slice(from, to);
    const format = /printf '([^']*)'/.exec(segment)[1];
    const vars = [...segment.matchAll(/"\$([A-Z_]+)"/g)].map((m) => m[1]);
    assert.equal(format, "%s\\0", "printf repeats this NUL-delimited format for every argument");
    for (const v of ["EXECUTION_ID", "LANE_NODE", "LANE_PRE", "LANE_CMD", "FP_CMD", "BASE_SHA", "MERGE_BASE", "STACK_BASE_SHA", "LANE_VARS", "PLAN_CMD", "PLAN_CONFIG"]) {
      assert.ok(vars.includes(v), `${lane}: ${v} is declared but not hashed`);
    }
  });

  test(`${lane}: E9 — the consumer's fingerprint shell runs under pipefail and the empty digest is refused`, () => {
    const step = fingerprintStep(lane);
    assert.match(step, /fp="\$\(bash -e -o pipefail -c "\$FP_CMD"\)" \|\| fp=""/, "pipeline and early-command failures must fail the command");
    assert.match(step, /e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/, "sha256 of empty input, refused by value");
    assert.match(step, /hashed EMPTY input/);
  });

  test(`${lane}: E9 — the actual fingerprint script refuses every known empty digest`, () => {
    const script = fingerprintStep(lane).split("        run: |\n")[1].split("\n")
      .filter((line) => line.startsWith("          ")).map((line) => line.slice(10)).join("\n");
    const dir = mkdtempSync(path.join(tmpdir(), "empty-lane-fingerprint-"));
    const output = path.join(dir, "outputs");
    try {
      const fingerprints = ["a".repeat(64), ...["md5", "sha1", "sha256", "sha512"]
        .flatMap((algorithm) => { const digest = createHash(algorithm).update("").digest("hex"); return [digest, digest.toUpperCase()]; })];
      for (const fingerprint of fingerprints) {
        writeFileSync(output, "");
        const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
          cwd: dir, encoding: "utf8", env: { ...process.env,
            GITHUB_OUTPUT: output, EXECUTION_ID: "b".repeat(64), LANE_NODE: "24.19.0",
            BASE_SHA: "c".repeat(40), MERGE_BASE: "c".repeat(40), STACK_BASE_SHA: "",
            PLAN_CONFIG: "", PLAN_CMD: "", LANE_PRE: "true", LANE_CMD: "node tests.mjs", LANE_VARS: "{}",
            FP_CMD: `printf '%s' '${fingerprint}'`,
          },
        });
        assert.equal(result.status, 0, result.stderr);
        const emitted = readFileSync(output, "utf8").trim();
        if (fingerprint === fingerprints[0]) assert.match(emitted, /^value=[0-9a-f]{16}-a{64}$/);
        else assert.equal(emitted, "value=", fingerprint);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
