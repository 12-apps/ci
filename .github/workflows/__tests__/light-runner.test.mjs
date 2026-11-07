import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { jobsOf } from "./job-timeouts.test.mjs";
import { declaredInputs } from "./declared-inputs.test.mjs";

// FUT-4536: the short jobs a fleet runs (a plan, a verdict, Detect Changes, the
// upkeep probes) last seconds and install nothing, yet each one held a 4-core,
// 14 GB slot of an 8-vCPU spot host, and a burst of them launched hosts that
// booted for ~3 minutes to run a 20-second job. `light-runner` lets a caller
// send exactly those jobs to a pool of small hosts (scripts/runner-host/README.md,
// "A light pool"). Every other job keeps its runner, and a caller that passes
// nothing sees no change.
//
// Measured on future-pay's jobs of 2026-11-05 (usage lines read from the job
// logs): the plans average 0.84-1.1 cores with a working set of 0.67-1.5 GiB,
// Detect Changes 0.5-0.8 cores and 0.3 GiB, the probes under 1 core and 0.5 GiB.
//
// The list is exact in both directions: a job added here without a reason, or
// a heavy job (an install, a build, a test) that picks up the light label by a
// copy-paste, fails below.

/** `<file>` → the jobs that read `light-runner`, and nothing else in the file. */
export const LIGHT_JOBS = new Map([
  ["monorepo-static.yml", ["changes", "actionlint"]],
  ["monorepo-tests.yml", ["unit-plan", "unit-signal", "unit-verdict", "unit-green-shards", "integration-plan", "integration-signal", "integration-verdict", "integration-green-shards"]],
  ["cost-report.yml", ["report"]],
  ["conflict-overlap.yml", ["overlap"]],
  ["conflict-probe.yml", ["probe"]],
  // Never `generate`: it runs the CALLER's command, which may install or build.
  ["post-merge-regen.yml", ["prepare", "land"]],
]);

/** The runs-on expression a job of this workflow must carry. */
export function expectedRunner(source, job, file) {
  const fallback = declaredInputs(source)?.includes("runner")
    ? "inputs.runner || vars.CI_RUNNER || 'ubuntu-latest'"
    : "vars.CI_RUNNER || 'ubuntu-latest'";
  return `\${{ ${LIGHT_JOBS.get(file)?.includes(job) ? "inputs.light-runner || " : ""}${fallback} }}`;
}

/** Evaluates a runs-on expression as GitHub does: the first nonempty operand. */
export function choose(expression, values) {
  const inner = /^\$\{\{ (.*) \}\}$/.exec(expression)?.[1];
  assert.ok(inner, `not an expression: ${expression}`);
  for (const operand of inner.split(" || ")) {
    if (operand === "'ubuntu-latest'") return "ubuntu-latest";
    assert.ok(Object.hasOwn(values, operand), `unexpected operand ${operand}`);
    if (values[operand]) return values[operand];
  }
  return "";
}

const runnerOf = (source, name) => {
  const lines = source.split("\n");
  const at = lines.indexOf(`  ${name}:`);
  for (let i = at + 1; i < lines.length && !/^ {0,2}\S/.test(lines[i]); i += 1) {
    const m = /^ {4}runs-on:\s*(.+?)\s*$/.exec(lines[i]);
    if (m) return m[1];
  }
  return undefined;
};

for (const [file, light] of LIGHT_JOBS) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const jobs = jobsOf(source).filter((j) => j.definesRunner);

  test(`${file}: light-runner is an optional input that defaults to empty`, () => {
    assert.ok(declaredInputs(source)?.includes("light-runner"), "light-runner is declared");
    const block = /^ {6}light-runner:\n([\s\S]*?)(?=^ {6}\S|^ {4}\S)/m.exec(source)?.[1];
    assert.ok(block, "light-runner has its own block");
    assert.match(block, /^ {8}type: string$/m);
    assert.match(block, /^ {8}required: false$/m);
    assert.match(block, /^ {8}default: ''$/m);
  });

  test(`${file}: only ${light.join(", ")} read light-runner`, () => {
    for (const name of light) assert.ok(jobs.some((j) => j.name === name), `${file} has no job ${name}`);
    const reading = jobs.filter((j) => /inputs\.light-runner/.test(runnerOf(source, j.name) ?? "")).map((j) => j.name);
    assert.deepEqual(reading.sort(), [...light].sort());
    for (const j of jobs) assert.equal(runnerOf(source, j.name), expectedRunner(source, j.name, file), `${file}:${j.name}`);
  });

  test(`${file}: a caller that passes no light-runner runs every job where it runs today`, () => {
    const fleet = { "inputs.light-runner": "", "inputs.runner": "", "vars.CI_RUNNER": "future-pay-ci" };
    const hosted = { "inputs.light-runner": "", "inputs.runner": "", "vars.CI_RUNNER": "" };
    const pinned = { "inputs.light-runner": "", "inputs.runner": "ubuntu-latest", "vars.CI_RUNNER": "future-pay-ci" };
    const hasRunner = declaredInputs(source).includes("runner");
    for (const j of jobs) {
      const runsOn = runnerOf(source, j.name);
      assert.equal(choose(runsOn, fleet), "future-pay-ci", j.name);
      assert.equal(choose(runsOn, hosted), "ubuntu-latest", j.name);
      if (hasRunner) assert.equal(choose(runsOn, pinned), "ubuntu-latest", `${j.name}: a public caller's pin still wins`);
    }
  });

  test(`${file}: a light label moves the listed jobs and no other`, () => {
    const values = { "inputs.light-runner": "future-pay-ci-light", "inputs.runner": "", "vars.CI_RUNNER": "future-pay-ci" };
    const moved = jobs.filter((j) => choose(runnerOf(source, j.name), values) === "future-pay-ci-light").map((j) => j.name);
    assert.deepEqual(moved.sort(), [...light].sort());
  });
}

test("no workflow outside the list reads light-runner", () => {
  const files = readdirSync(new URL("../", import.meta.url)).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length >= 30, `the sweep reads the workflows directory, saw ${files.length}`);
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    // The input itself, read or declared; self-test.yml names the suite file, which is not.
    if (!LIGHT_JOBS.has(file)) assert.doesNotMatch(source, /inputs\.light-runner|^ {6}light-runner:/m, file);
  }
});

test("a heavy job given the light label is caught", () => {
  // The mutation the list exists to refuse: Unit Tests picking up the label.
  const file = "monorepo-tests.yml";
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const mutated = source.replace(
    /(^  unit-tests:\n(?:(?! {4}runs-on:).*\n)*? {4}runs-on: \$\{\{ )/m,
    "$1inputs.light-runner || ",
  );
  assert.notEqual(mutated, source);
  assert.notEqual(runnerOf(mutated, "unit-tests"), expectedRunner(mutated, "unit-tests", file));
});

test("the hosted self-test executes this suite", () => {
  const selfTest = readFileSync(new URL("../self-test.yml", import.meta.url), "utf8");
  assert.match(selfTest, /^        run: node --test \.github\/workflows\/__tests__\/light-runner\.test\.mjs$/m);
});
