import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// A job whose matrix comes from a plan job's output MUST carry an `if:` that
// reads that same plan job.
//
// The reason is a platform behaviour this repo believed the opposite of for
// months, in three separate comments: an EMPTY matrix vector does not skip a
// job. GitHub refuses to create it — `Matrix vector 'shard' does not contain
// any values` — and the whole run ends in error. A caller that aggregates
// `needs.tests.result` then goes red with no failing test anywhere and no
// failing job to open, which is the worst diagnostic shape available: every
// job that exists is green.
//
// Measured on 12-apps/future-pay run 32978511016. `Tests / Integration Tests`
// was never created; all 30 jobs that were created passed or skipped; only
// `CI Success` was red, on `RESULTS: success failure …` where the `failure` is
// the reusable workflow itself.
//
// The fix is one `if:` per matrix job, and an `if:` is exactly the kind of line
// a new lane is copied without. So the rule is asserted over the text rather
// than remembered: a matrix built from `needs.<job>.outputs.<x>` obliges an
// `if:` mentioning `needs.<job>.outputs`.

const WORKFLOWS = path.join(fileURLToPath(new URL("../", import.meta.url)));

/** The `jobs:` blocks of a workflow, as `{ name, body }` with 1-based lines. */
export function jobBlocks(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) return [];
  const heads = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(lines[i]);
    if (m) heads.push({ name: m[1], line: i });
  }
  return heads.map(({ name, line }, i) => ({
    name,
    line: line + 1,
    body: lines.slice(line, i + 1 < heads.length ? heads[i + 1].line : lines.length).join("\n"),
  }));
}

/**
 * The plan jobs a job's MATRIX depends on. Only `matrix:` vectors count — a
 * `needs.x.outputs.y` in a step's env is not what GitHub expands into jobs.
 */
export function matrixPlanJobs(body) {
  const lines = body.split(/\r?\n/);
  const found = new Set();
  let inMatrix = false;
  let indent = 0;
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    const m = /^(\s*)matrix:\s*$/.exec(line);
    if (m) { inMatrix = true; indent = m[1].length; continue; }
    if (!inMatrix) continue;
    // The block ends at the first line indented no deeper than `matrix:`.
    if (line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) <= indent) { inMatrix = false; continue; }
    for (const ref of line.matchAll(/needs\.([A-Za-z_][\w-]*)\.outputs\./g)) found.add(ref[1]);
  }
  return [...found];
}

/** A job's `if:` expression — plain, folded or literal — as one string. */
export function jobIf(body) {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^ {4}if:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[1] && !/^[>|][-+]?$/.test(m[1].trim())) return m[1];
    const out = [];
    for (let j = i + 1; j < lines.length && (!lines[j].trim() || /^ {6}/.test(lines[j])); j += 1) {
      if (!/^\s*#/.test(lines[j])) out.push(lines[j].trim());
    }
    return out.join(" ");
  }
  return null;
}

// --- the detector must actually detect -------------------------------------
// Every one of these pins the SILENT direction: a parser that stopped seeing
// matrices, or stopped seeing `if:`, reports a clean estate and passes.

test("matrixPlanJobs finds the plan job behind a matrix vector", () => {
  const body = [
    "  unit-tests:",
    "    needs: unit-plan",
    "    strategy:",
    "      matrix:",
    "        shard: ${{ fromJson(needs.unit-plan.outputs.shards) }}",
    "    steps:",
    "      - run: echo hi",
  ].join("\n");
  assert.deepEqual(matrixPlanJobs(body), ["unit-plan"]);
});

test("matrixPlanJobs ignores plan outputs used outside the matrix", () => {
  const body = [
    "  unit-tests:",
    "    steps:",
    "      - run: echo hi",
    "        env:",
    "          COUNT: ${{ needs.unit-plan.outputs.count }}",
  ].join("\n");
  assert.deepEqual(matrixPlanJobs(body), []);
});

test("matrixPlanJobs stops at the end of the matrix block", () => {
  const body = [
    "  a:",
    "    strategy:",
    "      matrix:",
    "        shard: ${{ fromJson(needs.p.outputs.shards) }}",
    "    steps:",
    "      - run: echo ${{ needs.q.outputs.count }}",
  ].join("\n");
  assert.deepEqual(matrixPlanJobs(body), ["p"]);
});

test("jobIf reads the plain, folded and literal forms", () => {
  assert.equal(jobIf("  a:\n    if: ${{ x != '0' }}\n"), "${{ x != '0' }}");
  assert.match(jobIf("  a:\n    if: >-\n      ${{ inputs.go\n          && x != '0' }}\n"), /x != '0'/);
  assert.equal(jobIf("  a:\n    runs-on: ubuntu-latest\n"), null);
});

test("jobBlocks splits a workflow into its jobs", () => {
  const src = "jobs:\n  one:\n    runs-on: x\n  two:\n    runs-on: y\n";
  assert.deepEqual(jobBlocks(src).map((j) => j.name), ["one", "two"]);
});

// --- the sweep -------------------------------------------------------------

test("every matrix built from a plan output carries a guard on that plan", () => {
  const offenders = [];

  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const source = readFileSync(path.join(WORKFLOWS, file), "utf8");
    for (const job of jobBlocks(source)) {
      const plans = matrixPlanJobs(job.body);
      if (plans.length === 0) continue;
      const condition = jobIf(job.body) ?? "";
      for (const plan of plans) {
        if (condition.includes(`needs.${plan}.outputs`)) continue;
        offenders.push(`${file}:${job.line}  ${job.name} — matrix from ${plan}, no guard reading it`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "A plan job that reports no work emits an EMPTY matrix vector, and GitHub\n" +
      "refuses to create such a job — the run errors instead of skipping the\n" +
      "lane. Guard the job on the plan's own count, e.g.\n" +
      "  if: ${{ needs.<plan>.outputs.count != '0' }}\n  " +
      offenders.join("\n  "),
  );
});

test("the sweep actually reads the lanes it exists for", () => {
  // The direction that fails silently: a parser that matched nothing reports
  // zero offenders and passes. These two jobs are the reason the rule exists,
  // so the sweep has to be able to see them.
  const source = readFileSync(path.join(WORKFLOWS, "monorepo-tests.yml"), "utf8");
  const guarded = jobBlocks(source)
    .filter((j) => matrixPlanJobs(j.body).length > 0)
    .map((j) => j.name);

  assert.ok(guarded.includes("unit-tests"), `saw ${JSON.stringify(guarded)}`);
  assert.ok(guarded.includes("integration-tests"), `saw ${JSON.stringify(guarded)}`);
});
