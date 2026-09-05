import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Every job defined in this repo must carry `timeout-minutes`.
//
// A job without one runs to GitHub's six-hour default, and a hang is then
// indistinguishable from work: the check never resolves, auto-merge waits on
// it, and nothing anywhere says which of the two it is. The incident that
// produced the convention was a consumer's `Gherkin Journeys` sitting 2h11m in
// an apt step whose normal cost is 0.2 min, with twenty-three other checks
// green — the only way to tell it from a slow lane was pulling per-step timings
// out of the Actions API by hand.
//
// This repo is where that gap had to be closed. A CONSUMER cannot bound these
// jobs: `timeout-minutes` is rejected on a job that calls a reusable workflow,
// which actionlint states exactly —
//
//   when a reusable workflow is called with "uses", "timeout-minutes" is not
//   available. only following keys are allowed: "name", "uses", "with",
//   "secrets", "needs", "if", and "permissions"
//
// — so the bound has to be declared HERE, on the jobs these workflows define.
// A consumer's own guard can only ever cover the jobs it owns and then state
// the rest as a known gap, which is what future-pay's ci.yml did in prose.
//
// The SECOND assertion is that mirror image: a `uses:` job must NOT carry the
// key, because GitHub rejects the whole run at startup rather than ignoring it.
// So "just bound everything" is an edit that takes CI offline, and both halves
// are asserted so neither direction can be got wrong silently.
//
// Dependency-free on purpose (node: builtins, raw-text scan rather than a YAML
// parse), matching the other tests in this folder: they run in self-test.yml's
// `action-scripts` job, which deliberately has no install step.

const WORKFLOWS = path.join(fileURLToPath(new URL("../", import.meta.url)));

/**
 * A timeout tight enough to trip a slow-but-working run converts a rare
 * infrastructure stall into routine flakiness, which is strictly worse than the
 * hang it was meant to catch. Nothing here has any business finishing in under
 * ten minutes, so a bound below it is a mistake rather than a tuning choice.
 */
const FLOOR = 10;

/** Every `<name>.yml` in .github/workflows, as [name, source]. */
export function workflowFiles() {
  return readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, readFileSync(path.join(WORKFLOWS, f), "utf8")]);
}

/**
 * The `default:` of a `workflow_call` input, or undefined. Used to resolve a
 * bound written as `${{ inputs.x }}` back to a number — without this, such a
 * bound reads as NaN and every numeric assertion below passes vacuously, which
 * is the silent direction.
 */
export function inputDefault(source, name) {
  const block = new RegExp(
    String.raw`^ {6}${name}:\s*$([\s\S]*?)^ {0,6}\S`,
    "m",
  ).exec(source);
  return block ? /^ {8}default:\s*(\S+)\s*$/m.exec(block[1])?.[1] : undefined;
}

/**
 * The jobs of one workflow: a job key is the one thing indented exactly two
 * spaces under `jobs:`, and its body is everything more-indented that follows.
 * `runs-on:`/`uses:`/`timeout-minutes:` are read at the job's OWN indent (four
 * spaces) — a `uses:` nested under `steps:` is deeper and must not count, or
 * every job with an action step would read as a reusable call.
 */
export function jobsOf(source) {
  const lines = source.split("\n");
  const start = lines.indexOf("jobs:");
  if (start === -1) return [];

  const jobs = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[^\s#]/.test(lines[i])) break;
    // `[ \t]*(?:#.*)?$` rather than `\s*$`: a trailing comment on a job key
    // (`  deploy:   # the vendor adapter`) otherwise fails to match, so no job
    // record is created and every following line is appended to the PREVIOUS
    // job — handing it that job's `timeout-minutes` and hiding an unbounded job
    // from this sweep. Found by an adversarial pass in FUT-1276.
    const key = /^ {2}([A-Za-z0-9_-]+):[ \t]*(?:#.*)?$/.exec(lines[i]);
    if (key) jobs.push({ name: key[1], line: i + 1, body: [] });
    else if (jobs.length > 0) jobs.at(-1).body.push(lines[i]);
  }

  return jobs.map((job) => {
    const raw = job.body.find((l) => /^ {4}timeout-minutes:/.test(l))?.split(":").slice(1).join(":").trim();
    const ref = raw && /inputs\.([A-Za-z0-9_-]+)/.exec(raw);
    return {
      name: job.name,
      line: job.line,
      definesRunner: job.body.some((l) => /^ {4}runs-on:/.test(l)),
      callsReusable: job.body.some((l) => /^ {4}uses:/.test(l)),
      timeout: raw,
      // An overridable bound is judged by the default a consumer gets.
      minutes: raw === undefined ? undefined : Number(ref ? inputDefault(source, ref[1]) : raw),
    };
  });
}

const all = workflowFiles().flatMap(([file, source]) =>
  jobsOf(source).map((job) => ({ ...job, file })),
);

// --- the parser must actually parse ----------------------------------------
// The whole sweep fails silently if this stops seeing jobs: zero jobs means
// zero unbounded jobs, and the gate reports a clean estate. That is exactly
// what a gate is worth nothing for, so it is pinned first.

test("the sweep sees this repo's workflows and their jobs", () => {
  assert.ok(all.length >= 40, `expected the sweep to see this repo's jobs, saw ${all.length}`);
  assert.ok(
    all.some((j) => j.file === "monorepo-tests.yml" && j.name === "unit-tests"),
    "the sweep did not find monorepo-tests.yml's unit-tests job, so it is not reading job bodies",
  );
  assert.ok(
    all.some((j) => j.callsReusable && !j.definesRunner),
    "the sweep found no reusable-call job, so the second assertion below is vacuous",
  );
});

test("inputDefault resolves an overridable bound to a number", () => {
  const src = [
    "    inputs:",
    "      e2e-timeout-minutes:",
    "        description: 'x'",
    "        type: number",
    "        required: false",
    "        default: 60",
    "      other:",
  ].join("\n");
  assert.equal(inputDefault(src, "e2e-timeout-minutes"), "60");
  assert.equal(inputDefault(src, "absent"), undefined);
});

// --- the sweep -------------------------------------------------------------

test("every job defined in this repo is bound by timeout-minutes", () => {
  const unbounded = all
    .filter((job) => job.definesRunner && !job.timeout)
    .map((job) => `${job.file}:${job.line} ${job.name}`);

  assert.deepEqual(
    unbounded,
    [],
    "these jobs would run to GitHub's six-hour default, where a hang is\n" +
      "indistinguishable from work. A consumer cannot bound them — the key is\n" +
      "rejected on a `uses:` job — so it has to happen here:\n  " +
      unbounded.join("\n  "),
  );
});

test("a job that calls a reusable workflow carries no timeout-minutes", () => {
  // GitHub rejects the key there, so this is not style — it is the difference
  // between CI running and CI refusing to start.
  const rejected = all
    .filter((job) => job.callsReusable && !job.definesRunner && job.timeout)
    .map((job) => `${job.file}:${job.line} ${job.name}`);

  assert.deepEqual(
    rejected,
    [],
    "GitHub refuses timeout-minutes on a `uses:` job; bound it on the jobs the\n" +
      "called workflow defines instead:\n  " +
      rejected.join("\n  "),
  );
});

test("every bound resolves to a number with headroom over the lane it covers", () => {
  // Catches three things at once: a typo'd bound, an `${{ inputs.x }}`
  // referencing an input that was never declared (which GitHub resolves to
  // empty and treats as no bound at all), and a bound tight enough to make a
  // slow run look like a hang.
  const wrong = all
    .filter((job) => job.timeout !== undefined)
    .filter((job) => !Number.isFinite(job.minutes) || job.minutes < FLOOR)
    .map((job) => `${job.file}:${job.line} ${job.name}=${job.timeout} (resolved: ${job.minutes})`);

  assert.deepEqual(
    wrong,
    [],
    `every bound must resolve to at least ${FLOOR} minutes. A non-numeric result means the\n` +
      "expression references an input this workflow does not declare — GitHub resolves that\n" +
      "to empty, which is no bound at all:\n  " +
      wrong.join("\n  "),
  );
});
