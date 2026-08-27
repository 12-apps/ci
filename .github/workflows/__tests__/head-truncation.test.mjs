import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// No shell step in this repo may truncate a pipeline with `head`.
//
// `head` closes its input the moment it has the lines it wants. The producer
// upstream then writes into a closed pipe, takes SIGPIPE (or an EPIPE write
// error, which is what jq does), and exits non-zero. `shell: bash` on GitHub
// Actions is `bash --noprofile --norc -eo pipefail {0}` — pipefail is ON, and a
// composite action cannot opt out, since every `run:` in one is REQUIRED to
// declare a shell. So the step's exit status becomes the dead producer's.
//
// That makes `| head` a bug whose trigger is the SIZE OF THE DATA. Under the
// limit the pipe is never closed early and the step passes; over it, the step
// fails. Nothing about the diff, the config or the log says which side you are
// on — the log shows the truncated output, correct as far as it goes, followed
// by an error from a command that had already done its job.
//
//   jq: error: writing output failed: Broken pipe
//   ##[error]Process completed with exit code 2.
//
// Measured on future-pay#1216: `affected-plan`'s job-summary step wrote the
// selected tests with `jq -r '.tests[] | …' "$PLAN" | head -100`. A plan of
// 100 tests or fewer summarised fine. The PR selected more, so `Tests / Unit
// Plan` went red — with a correctly computed plan sitting on disk and a
// summary that had already been written. Every downstream lane was gated on
// that job, so the whole tier skipped on a formatting step.
//
// The fix is to bound the data at the SOURCE, where the producer knows it is
// done and exits 0: `jq '.tests[:100][]'`, `first(…)`, `awk 'NR<=100'`,
// `sed -n '1,100p'` — or `head` with the producer's output already in a
// variable, where there is no pipe to break.
//
// `tail` is deliberately not swept. It has to read to end-of-stream to know
// which lines are last, so it never closes the pipe early and the failure mode
// does not exist. Sweeping it would flag `sort -V | tail -1` in
// release-version.yml, which is correct code.
//
// Dependency-free (node: builtins, raw-text scan), matching this folder: these
// run in self-test.yml's `action-scripts` job, which has no install step.

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** Directories holding nothing this repo executes. */
const SKIP = new Set(["node_modules", ".git"]);

/** Every file under `dir` whose name satisfies `keep`. */
function filesWhere(keep, dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesWhere(keep, full);
    return entry.isFile() && keep(entry.name) ? [full] : [];
  });
}

/**
 * Every workflow and action definition — everything with `run:` steps in it.
 *
 * Both directories, because the composite actions are where pipefail is
 * unavoidable and where the measured failure actually happened.
 */
const yamlFiles = () =>
  [".github/workflows", ".github/actions"].flatMap((dir) =>
    filesWhere((n) => /\.ya?ml$/.test(n), path.join(REPO, dir)),
  );

/**
 * Lines in `source` that pipe into `head`.
 *
 * Comments are skipped: this file's own fix is documented with the broken form
 * quoted in a comment, and so is the one in `affected-plan`. A rule that could
 * not tell an explanation from an instruction would make explaining it
 * impossible — the same carve-out `major-pin-refs` makes for prose.
 */
export function headTruncations(source) {
  const hits = [];
  source.split("\n").forEach((line, index) => {
    if (line.trimStart().startsWith("#")) return;
    if (/\|\s*head\b/.test(line)) hits.push({ line: index + 1, text: line.trim() });
  });
  return hits;
}

test("no step truncates a pipeline with `head`", () => {
  const offenders = yamlFiles().flatMap((file) =>
    headTruncations(readFileSync(file, "utf8")).map(
      ({ line, text }) => `${path.relative(REPO, file)}:${line}  ${text}`,
    ),
  );

  assert.deepEqual(
    offenders,
    [],
    "`| head` under `set -o pipefail` kills the producer with EPIPE and fails " +
      "the step once the data crosses the limit. Bound it at the source " +
      "instead (jq '.[:N][]', first(…), awk 'NR<=N', sed -n '1,Np'):\n" +
      offenders.join("\n"),
  );
});

test("the sweep reads the files it claims to", () => {
  const files = yamlFiles();
  assert.ok(files.length > 0, "no workflow or action YAML found");
  assert.ok(
    files.some((f) => f.includes("actions/affected-plan")),
    "affected-plan — the action the measured failure came from — is not swept",
  );
});

test("a truncating pipe is detected, and a comment about one is not", () => {
  assert.deepEqual(
    headTruncations("  run: jq -r '.tests[]' plan.json | head -100"),
    [{ line: 1, text: "run: jq -r '.tests[]' plan.json | head -100" }],
  );
  assert.deepEqual(headTruncations("  # never write `| head -100` here"), []);
  assert.deepEqual(headTruncations("  run: sort -V | tail -1"), []);
  assert.deepEqual(headTruncations("  run: jq -r '.tests[:100][]' plan.json"), []);
});
