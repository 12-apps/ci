import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { jobsOf } from "./job-timeouts.test.mjs";
import { declaredInputs } from "./declared-inputs.test.mjs";

// FUT-4944 phase 2: every fleet job takes the same 4-core, ~14 GB slot, yet a
// middle class of jobs (the "M" class, measured 2026-11-10/11) averages about
// two cores: Gherkin (1.1 avg / 3.4 peak cores, shards up to 9.3 GiB), the RSC
// smoke, Static Gates, Lint, Retry Gate, E2E Reliability, Page Load, the
// storefront bundle budget, the image build and more. `medium-runner` lets a
// caller send exactly those of them that THIS repo defines to a pool of
// 2-vCPU slots (scripts/runner-host/README.md, "A medium pool"). Every other job keeps its runner, and a caller that passes nothing
// sees no change.
//
// The rest (Gherkin Journeys, Page Load Budget, Storefront Bundle Budget,
// Request Waves, Realtime Socket Smoke, CI Draft / CI Ready, the
// post-merge complexity job, the tap count) are jobs of the consumer's own
// workflows, so the consumer routes them itself.
//
// The list is exact in both directions: a job added here without a reason, or
// a heavy job (Unit, Integration, Type Check, Build, SPA E2E) or a light one
// that picks up the medium label by a copy-paste, fails below.

/** `<file>` → the jobs that read `medium-runner`, and nothing else in the file. */
export const MEDIUM_JOBS = new Map([
  // Lint: p95 4.0 cores and 4.4 GiB on 2026-11-10/11, so not the light class.
  ["monorepo-static.yml", ["lint", "retry-gate"]],
  ["quality.yml", ["static-gates", "e2e-reliability"]],
  ["nextjs-prod-smoke.yml", ["smoke"]],
  ["cd.yml", ["build-images"]],
  // A consumer's seed-order / Repository gates caller: p95 3.5 cores and
  // 3.4 GiB, about one core on average, so M rather than P (FUT-4944).
  ["package-gates.yml", ["gates"]],
]);

/** The operand a job of this workflow puts first, or "" when it has none. */
export const mediumOperand = (job, file) => (MEDIUM_JOBS.get(file)?.includes(job) ? "inputs.medium-runner || " : "");

/** The runs-on expression a job of these workflows carried before `medium-runner`. */
const todayOf = (source) =>
  declaredInputs(source)?.includes("runner")
    ? "inputs.runner || vars.CI_RUNNER || 'ubuntu-latest'"
    : "vars.CI_RUNNER || 'ubuntu-latest'";

/** Evaluates a runs-on expression as GitHub does: the first nonempty operand. */
function choose(expression, values) {
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

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

for (const [file, medium] of MEDIUM_JOBS) {
  const source = read(file);
  const jobs = jobsOf(source).filter((j) => j.definesRunner);

  test(`${file}: medium-runner is an optional input that defaults to empty`, () => {
    assert.ok(declaredInputs(source)?.includes("medium-runner"), "medium-runner is declared");
    const block = /^ {6}medium-runner:\n([\s\S]*?)(?=^ {6}\S|^ {4}\S)/m.exec(source)?.[1];
    assert.ok(block, "medium-runner has its own block");
    assert.match(block, /^ {8}type: string$/m);
    assert.match(block, /^ {8}required: false$/m);
    assert.match(block, /^ {8}default: ''$/m);
  });

  test(`${file}: only ${medium.join(", ")} read medium-runner`, () => {
    for (const name of medium) assert.ok(jobs.some((j) => j.name === name), `${file} has no job ${name}`);
    const reading = jobs.filter((j) => /inputs\.medium-runner/.test(runnerOf(source, j.name) ?? "")).map((j) => j.name);
    assert.deepEqual(reading.sort(), [...medium].sort());
    for (const j of jobs) {
      // A light job (light-runner.test.mjs pins which) keeps its light operand, and no medium one.
      const light = /^\$\{\{ inputs\.light-runner \|\| /.test(runnerOf(source, j.name)) ? "inputs.light-runner || " : "";
      assert.equal(runnerOf(source, j.name), `\${{ ${light}${mediumOperand(j.name, file)}${todayOf(source)} }}`, `${file}:${j.name}`);
    }
  });

  test(`${file}: an empty medium-runner yields exactly today's expression`, () => {
    for (const name of medium) {
      const runsOn = runnerOf(source, name);
      assert.ok(runsOn.startsWith("${{ inputs.medium-runner || "), `${name} reads medium-runner first`);
      // Stripping the operand gives back the expression the job had before it.
      assert.equal(runsOn.replace("inputs.medium-runner || ", ""), `\${{ ${todayOf(source)} }}`, name);
    }
    for (const vars of ["future-pay-ci", ""]) {
      for (const j of jobs) {
        const values = { "inputs.light-runner": "", "inputs.medium-runner": "", "inputs.runner": "", "vars.CI_RUNNER": vars };
        const today = `\${{ ${todayOf(source)} }}`;
        assert.equal(choose(runnerOf(source, j.name), values), choose(today, values), `${j.name} with CI_RUNNER='${vars}'`);
      }
    }
  });

  test(`${file}: a medium label moves the listed jobs and no other`, () => {
    const values = { "inputs.light-runner": "", "inputs.medium-runner": "future-pay-ci-medium", "inputs.runner": "", "vars.CI_RUNNER": "future-pay-ci" };
    const moved = jobs.filter((j) => choose(runnerOf(source, j.name), values) === "future-pay-ci-medium").map((j) => j.name);
    assert.deepEqual(moved.sort(), [...medium].sort());
  });
}

test("no workflow outside the list reads or declares medium-runner", () => {
  const files = readdirSync(new URL("../", import.meta.url)).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length >= 30, `the sweep reads the workflows directory, saw ${files.length}`);
  for (const file of files) {
    if (!MEDIUM_JOBS.has(file)) assert.doesNotMatch(read(file), /inputs\.medium-runner|^ {6}medium-runner:/m, file);
  }
});

test("no job reads both the light and the medium label", () => {
  for (const file of readdirSync(new URL("../", import.meta.url)).filter((f) => /\.ya?ml$/.test(f))) {
    assert.doesNotMatch(read(file), /^ {4}runs-on: .*inputs\.light-runner.*inputs\.medium-runner|^ {4}runs-on: .*inputs\.medium-runner.*inputs\.light-runner/m, file);
  }
});

/** Prepends the medium operand to one job's runs-on, as a copy-paste would. */
const giveMedium = (source, job) =>
  source.replace(new RegExp(`(^  ${job}:\\n(?:(?! {4}runs-on:).*\\n)*? {4}runs-on: \\$\\{\\{ )`, "m"), "$1inputs.medium-runner || ");

test("a heavy (G) job given the medium label is caught", () => {
  // Unit Tests, Type Check, Build: the G class, which keeps the 4-core slot.
  for (const [file, job] of [["monorepo-tests.yml", "unit-tests"], ["monorepo-static.yml", "type-check"], ["monorepo-tests.yml", "build"]]) {
    const source = read(file);
    const mutated = giveMedium(source, job);
    assert.notEqual(mutated, source, `${file}:${job} was mutated`);
    assert.match(runnerOf(mutated, job), /inputs\.medium-runner/);
    assert.notEqual(runnerOf(mutated, job), `\${{ ${mediumOperand(job, file)}${todayOf(mutated)} }}`, `${file}:${job}`);
  }
});

test("a light job given the medium label is caught", () => {
  const file = "monorepo-static.yml";
  const source = read(file);
  const mutated = giveMedium(source, "changes");
  assert.notEqual(mutated, source);
  assert.match(runnerOf(mutated, "changes"), /^\$\{\{ inputs\.medium-runner \|\| inputs\.light-runner/);
  // The sweep above refuses it in any file, MEDIUM_JOBS or not.
  assert.match(mutated, /^ {4}runs-on: .*inputs\.medium-runner.*inputs\.light-runner/m);
});

test("a medium job that loses the label, or an M-file job that gains it, is caught", () => {
  const source = read("cd.yml");
  const lost = source.replace("inputs.medium-runner || vars.CI_RUNNER", "vars.CI_RUNNER");
  assert.notEqual(lost, source);
  assert.equal(runnerOf(lost, "build-images"), "${{ vars.CI_RUNNER || 'ubuntu-latest' }}");
  assert.notEqual(runnerOf(lost, "build-images"), `\${{ ${mediumOperand("build-images", "cd.yml")}${todayOf(lost)} }}`);
  const gained = giveMedium(source, "build-static");
  assert.notEqual(runnerOf(gained, "build-static"), `\${{ ${mediumOperand("build-static", "cd.yml")}${todayOf(gained)} }}`);
});

test("the hosted self-test executes this suite", () => {
  const selfTest = read("self-test.yml");
  assert.match(selfTest, /^        run: node --test \.github\/workflows\/__tests__\/medium-runner\.test\.mjs$/m);
});
