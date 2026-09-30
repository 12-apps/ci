// A single-job lane verdict is looked up FIRST and recorded LAST — and every
// step in between is gated on it.
//
// Three placements, each of which fails silently when broken:
//
//   - a lookup AFTER the install still "works": the job pays the install it
//     was meant to skip and the log still says the lane was skipped;
//   - a work step WITHOUT the gate still runs on a hit — lint or the build
//     executes, the job stays green, and the skip is a fiction in the summary;
//   - a record that is not the last step, or not gated on `success()`, makes a
//     claim before the job has finished earning it: a later step fails, the
//     key is saved anyway, and the next identical tree skips the failing lane.
//
// So the four jobs are asserted over the workflow text, and the action's own
// probe is pinned to `lookup-only`.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { jobBlocks } from "./matrix-zero-guard.test.mjs";

const WORKFLOWS = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFileSync(path.join(WORKFLOWS, file), "utf8");
const ACTION = readFileSync(path.join(WORKFLOWS, "../actions/lane-verdict/action.yml"), "utf8");

/** Every job that carries a lane verdict, and the input that turns it on. */
const JOBS = [
  { file: "monorepo-static.yml", job: "lint", lane: "lint", input: "lint-fingerprint-command" },
  { file: "monorepo-static.yml", job: "type-check", lane: "type-check", input: "type-check-fingerprint-command" },
  { file: "monorepo-tests.yml", job: "build", lane: "build", input: "build-fingerprint-command" },
  { file: "package-gates.yml", job: "gates", lane: "gates", input: "fingerprint-command" },
];

/** A job's steps as [{ head, block }], split on the 6-space `- ` that opens each. */
function steps(body) {
  const lines = body.split("\n");
  const starts = lines.map((l, i) => (/^ {6}- /.test(l) ? i : -1)).filter((i) => i !== -1);
  return starts.map((s, k) => ({ head: lines[s], block: lines.slice(s, k + 1 < starts.length ? starts[k + 1] : lines.length).join("\n") }));
}

for (const { file, job, lane, input } of JOBS) {
  const source = read(file);
  const body = Object.fromEntries(jobBlocks(source).map((j) => [j.name, j.body]))[job];

  test(`${file} declares ${input}, opt-in and empty by default`, () => {
    const block = new RegExp(`^      ${input}:\\n((?:(?:        .*|)\\n)+)`, "m").exec(source);
    assert.ok(block, `${input} is not declared — a caller passing it is a startup failure`);
    assert.match(block[1], /required: false/);
    assert.match(block[1], /default: ''/);
  });

  test(`${job}: the lookup is the step right after checkout, before any install`, () => {
    const all = steps(body);
    const checkout = all.findIndex((s) => /actions\/checkout@/.test(s.block));
    const lookup = all.findIndex((s) => /id: lane-verdict/.test(s.block));
    assert.notEqual(lookup, -1, `${job} has no lane-verdict lookup`);
    assert.equal(lookup, checkout + 1, "nothing but the checkout may run before the lookup");
    const setup = all.findIndex((s) => /pnpm\/action-setup@|actions\/setup-node@/.test(s.block));
    assert.ok(lookup < setup, "the lookup must precede the toolchain setup");
    assert.match(all[lookup].block, new RegExp(`if: \\$\\{\\{ inputs\\.${input} != '' && github\\.event_name == 'pull_request' \\}\\}`), "opt-in, and never off a pull request");
    assert.match(all[lookup].block, /uses: 12-apps\/ci\/\.github\/actions\/lane-verdict@v2/);
    assert.match(all[lookup].block, new RegExp(`lane: ${lane}\\n`));
    assert.match(all[lookup].block, new RegExp(`fingerprint-command: \\$\\{\\{ inputs\\.${input} \\}\\}`));
    assert.match(all[lookup].block, /key-material: \|\n\s+node=\$\{\{ inputs\.node-version \}\}/, "the Node version is part of how the lane runs");
    // E7/E8 (2026-09-30 audit): the same tree retargeted at another base
    // selects another `--affected` set; an engine fix must not inherit a
    // verdict the old logic earned; the runner image decides what ran.
    assert.match(all[lookup].block, /\n\s+base=\$\{\{ github\.event\.pull_request\.base\.sha \}\}\n/, "the base the lane selected against");
    assert.match(all[lookup].block, /\n\s+engine=\$\{\{ github\.job_workflow_sha \}\}\n/, "the engine revision that ran it");
    assert.match(all[lookup].block, /\n\s+runner=\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}(\n|$)/, "the runner it ran on");
    if (file === "monorepo-static.yml") {
      assert.match(all[lookup].block, /\n\s+stack-base=\$\{\{ needs\.changes\.outputs\.stack-base \}\}\n/, "mid-stack, `--affected` diffs against the stack base");
    }
  });

  test(`${job}: every step after the lookup is gated on the verdict, and the record is last`, () => {
    const all = steps(body);
    const lookup = all.findIndex((s) => /id: lane-verdict/.test(s.block));
    const after = all.slice(lookup + 1);
    const record = after.at(-1);
    assert.match(record.block, /name: Record the lane verdict/, "the record must be the LAST step of the job");
    assert.match(record.block, /mode: record/);
    assert.match(record.block, /if: \$\{\{ success\(\) && steps\.lane-verdict\.outputs\.key != '' && steps\.lane-verdict\.outputs\.hit != 'true' \}\}/, "record only from a job whose every step passed, only when a key exists, never after a hit");
    assert.match(record.block, /key: \$\{\{ steps\.lane-verdict\.outputs\.key \}\}/);
    const ungated = after.slice(0, -1).filter((s) => !/^        if: .*steps\.lane-verdict\.outputs\.hit != 'true'/m.test(s.block));
    assert.deepEqual(ungated.map((s) => s.head.trim()), [], `${job}: a step that runs on a hit makes the skip a fiction`);
  });

  test(`${job}: a step that already had a condition keeps it`, () => {
    // The gate is ADDED to a condition, never substituted for it: a turbo cache
    // save gated off pull requests must stay gated off pull requests.
    const all = steps(body);
    for (const s of all) {
      if (/actions\/cache\/save@/.test(s.block) && /turbo-/.test(s.block)) {
        assert.match(s.block, /if: \$\{\{ \(github\.event_name != 'pull_request'\) && steps\.lane-verdict\.outputs\.hit != 'true' \}\}/);
      }
    }
  });
}

test("the action probes with lookup-only and records only in record mode with a key", () => {
  assert.match(ACTION, /uses: actions\/cache\/restore@v4\n\s+with:\n\s+path: \.lane-verdict\/\$\{\{ inputs\.lane \}\}\n\s+key: \$\{\{ steps\.key\.outputs\.key \}\}\n\s+lookup-only: true/);
  assert.match(ACTION, /if: \$\{\{ inputs\.mode == 'lookup' && steps\.key\.outputs\.key != '' \}\}\n\s+uses: actions\/cache\/restore@v4/, "no key, no probe");
  const saves = [...ACTION.matchAll(/if: (.*)\n\s+uses: actions\/cache\/save@v4/g)].map((m) => m[1]);
  assert.deepEqual(saves, ["${{ inputs.mode == 'record' && inputs.key != '' }}"]);
  assert.match(ACTION, /hit:\n\s+description:.*\n\s+value: \$\{\{ steps\.report\.outputs\.hit \}\}/);
  assert.match(ACTION, /key:\n\s+description:.*\n\s+value: \$\{\{ steps\.key\.outputs\.key \}\}/);
});
