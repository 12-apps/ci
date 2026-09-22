import { strict as assert } from "node:assert";
import { test } from "node:test";

import { jobsOf, workflowFiles } from "./job-timeouts.test.mjs";

// Every job a REUSABLE workflow defines takes its runner from the caller.
//
// A consumer cannot choose where these jobs run: `runs-on` is rejected on a
// job that calls a reusable workflow, exactly like `timeout-minutes` (see
// job-timeouts.test.mjs). So a label hard-coded here is a label no consumer can
// move — and on a private repo that label is the bill. future-pay paid ~$30 a
// day in GitHub-hosted minutes (September 2026), nearly all of it in jobs these
// workflows define, while a self-hosted runner is billed nothing per minute.
//
// The switch is the CALLER's configuration variable: a called workflow reads
// `vars` from the caller's repository, not from this one, so
//
//   runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
//
// runs on GitHub's image for every consumer that sets nothing (no behaviour
// change on upgrade), and on the consumer's own fleet the moment it sets
// `CI_RUNNER` — with no `with:` to thread through a dozen call sites, and one
// variable to delete to fall back if that fleet goes down.
//
// Raw-text scan, dependency-free, like the rest of this folder.

const SELECTED = "${{ vars.CI_RUNNER || 'ubuntu-latest' }}";

/**
 * Jobs that must stay on GitHub's image, each with the reason. A new entry
 * needs a reason a reviewer can check; "it failed on self-hosted" is not one
 * until someone has said what the image has that the fleet lacks.
 */
const PINNED = new Map([
  ["expo-apk.yml:apk", "gradle needs the Android SDK ubuntu-latest ships preinstalled"],
]);

const isReusable = (source) => /^ {2}workflow_call:/m.test(source);

/** `runs-on:` at the job's own indent, verbatim. */
function runnerOf(source, jobName) {
  const lines = source.split("\n");
  const at = lines.findIndex((l) => l === `  ${jobName}:` || l.startsWith(`  ${jobName}:`));
  for (let i = at + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i]) || /^\S/.test(lines[i])) break;
    const m = /^ {4}runs-on:\s*(.+?)\s*$/.exec(lines[i]);
    if (m) return m[1];
  }
  return undefined;
}

const jobs = workflowFiles()
  .filter(([, source]) => isReusable(source))
  .flatMap(([file, source]) =>
    jobsOf(source)
      .filter((job) => job.definesRunner)
      .map((job) => ({ file, name: job.name, line: job.line, runsOn: runnerOf(source, job.name) })),
  );

test("the sweep sees the reusable workflows' jobs", () => {
  // Zero jobs would mean zero hard-coded runners, a clean estate reported by
  // a parser that stopped parsing.
  assert.ok(jobs.length >= 30, `expected the sweep to see the reusable jobs, saw ${jobs.length}`);
  assert.ok(
    jobs.some((j) => j.file === "monorepo-tests.yml" && j.runsOn !== undefined),
    "the sweep read no runs-on from monorepo-tests.yml",
  );
});

test("every reusable job runs where the caller's CI_RUNNER says", () => {
  const wrong = jobs
    .filter((j) => !PINNED.has(`${j.file}:${j.name}`))
    .filter((j) => j.runsOn !== SELECTED)
    .map((j) => `${j.file}:${j.line} ${j.name} runs-on: ${j.runsOn}`);

  assert.deepEqual(
    wrong,
    [],
    "a consumer cannot override runs-on on a `uses:` job, so a label written here\n" +
      `is one no caller can move off a billed runner. Use exactly\n  runs-on: ${SELECTED}\n` +
      "or add the job to PINNED with the reason it needs GitHub's image:\n  " +
      wrong.join("\n  "),
  );
});

test("a pinned job is pinned for a reason that still exists", () => {
  // A stale entry would silently exempt whatever job next takes that name.
  const stale = [...PINNED.keys()].filter((key) => {
    const job = jobs.find((j) => `${j.file}:${j.name}` === key);
    return !job || job.runsOn === SELECTED;
  });
  assert.deepEqual(stale, [], `PINNED lists jobs that no longer need it: ${stale.join(", ")}`);
});

test("the fallback keeps every consumer that sets nothing on ubuntu-latest", () => {
  // The expression is the whole compatibility story: `||` yields the literal
  // when the variable is unset OR empty, so a consumer upgrading `@v2` without
  // touching its settings sees no change at all.
  assert.match(SELECTED, /\|\| 'ubuntu-latest' \}\}$/);
});
