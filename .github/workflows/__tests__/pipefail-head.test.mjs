import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// No `run:` block that sets `pipefail` may pipe a producer into `head`.
//
// `head` exits as soon as it has its N lines and closes the pipe. The producer
// upstream is then killed by SIGPIPE and exits 141, and `pipefail` promotes
// that to the exit status of the whole pipeline — so the step fails. Under
// `set -e`, the job fails with it.
//
// What makes this worth a sweep rather than one fixed line is WHEN it fires.
// The pipeline succeeds for every input short enough that `head` never closes
// the pipe early, which is every input anyone tests with. It fails only once
// the producer has MORE than N lines to print — so the step works until the
// day there is a lot to say, and then breaks on exactly the runs that had the
// most to report.
//
// Measured: `affected-plan`'s summary step (`jq … | head -100`) failed the plan
// job for a pull request whose unit lane selected 627 test files. The plan had
// already been computed and written correctly; only the summary blew up, and
// every lane gated on the plan was skipped because of it.
//
// The fix is never to add `|| true` — that hides a real failure of the producer
// too. Slice in the producer instead (`jq '.tests[:100][]'`), which needs no
// second process and so has no pipe to break.
//
// Scope, stated plainly: this is a lexical sweep for the `head` shape, not a
// general SIGPIPE analysis. That is the shape that has actually bitten here,
// and a checker that tried to reason about every producer's buffering would be
// one nobody could act on.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Every workflow and composite-action YAML this repo ships. */
function yamlFiles() {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git") continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.ya?ml$/.test(name)) found.push(full);
    }
  };
  walk(path.join(ROOT, ".github"));
  return found;
}

/**
 * The `run:` blocks of one YAML file, as raw text.
 *
 * Indentation-based rather than YAML-parsed, deliberately: this test must not
 * depend on a YAML library to check a property about shell, and a `run:` block
 * is unambiguous — everything indented deeper than the key, until something is
 * not.
 */
export function runBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const start = /^(\s*)-?\s*run:\s*[|>]?[-+]?\s*$/.exec(lines[i]);
    if (!start) continue;
    const indent = start[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() !== "" && (line.length - line.trimStart().length) <= indent) break;
      body.push(line);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

/** Does this shell set `pipefail`, and pipe something into `head`? */
export function pipefailHeadOffences(block) {
  if (!/set\s+-[a-z]*o\s+pipefail|set\s+-o\s+pipefail/.test(block)) return [];
  return block
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .filter((line) => /\|\s*head\b/.test(line))
    .map((line) => line.trim());
}

test("no pipefail shell pipes into `head`", () => {
  const offences = [];
  for (const file of yamlFiles()) {
    for (const block of runBlocks(readFileSync(file, "utf8"))) {
      for (const line of pipefailHeadOffences(block)) {
        offences.push(`${path.relative(ROOT, file)}: ${line}`);
      }
    }
  }
  assert.deepEqual(
    offences,
    [],
    `a \`head\` closing the pipe kills its producer with SIGPIPE, which pipefail turns into a failed step — ` +
      `slice in the producer instead:\n  ${offences.join("\n  ")}`,
  );
});

test("the sweep sees the shape it is looking for", () => {
  // The half that matters. A detector that stopped matching would report a
  // clean repo forever — the same silent-green failure the sweep exists to
  // prevent, one level up.
  const offending = ["set -euo pipefail", 'jq -r ".tests[]" "$PLAN" | head -100'].join("\n");
  assert.deepEqual(pipefailHeadOffences(offending), ['jq -r ".tests[]" "$PLAN" | head -100']);

  // Without pipefail the pipeline reports `head`'s own status, so it is sound.
  assert.deepEqual(pipefailHeadOffences('jq -r ".tests[]" "$PLAN" | head -100'), []);

  // A mention inside a comment is not a pipeline.
  assert.deepEqual(
    pipefailHeadOffences(["set -euo pipefail", "# never write `jq … | head -100` here"].join("\n")),
    [],
  );

  // And the block extractor has to find a block at all.
  const yaml = ["    - name: x", "      run: |", "        set -euo pipefail", "        a | head -3", "    - name: y"].join("\n");
  assert.equal(runBlocks(yaml).length, 1);
  assert.deepEqual(pipefailHeadOffences(runBlocks(yaml)[0]), ["a | head -3"]);
});
