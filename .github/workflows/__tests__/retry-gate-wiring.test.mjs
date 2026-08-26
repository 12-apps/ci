import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The retry gate front-runs the static tier: it replays what the previous run
// of this branch already proved broken, and a non-zero exit is meant to stop
// lint, type-check, actionlint and — through this tier's result — every lane
// the consumer gates on it.
//
// That whole contract rests on ONE expression, repeated on three jobs, and it
// is the kind of expression that is wrong in only one direction:
//
//   needs: [changes, retry-gate]
//   if: !cancelled() && (retry-gate.result == 'success' || … == 'skipped') && …
//
// The gate is SKIPPED almost always — unconfigured, wrong event, or nothing to
// replay — and a skipped `needs:` skips its dependents by default. So the
// condition has to survive a skip, which is what pushes an author toward
// `always()` or `!cancelled()` on its own. Both of those are ALSO true for a
// FAILED dependency, and the tier then lints the very tree the gate just
// proved broken while reporting the gate's red separately. Nothing about that
// looks wrong in a diff: the gate is still red, the run is still red, and the
// only thing lost is the minutes the gate exists to save.
//
// The failure is therefore silent in the direction of doing MORE work, which
// no other check here would catch. Hence this one, asserted over the text.
//
// Dependency-free (node: builtins, raw-text scan), matching its neighbours:
// they run in self-test.yml's `action-scripts` job, which has no install step.

const STATIC_WORKFLOW = path.join(
  fileURLToPath(new URL("../", import.meta.url)),
  "monorepo-static.yml",
);

/** The jobs that must not start when the gate reproduced a failure. */
const GATED = ["lint", "type-check", "actionlint"];

/**
 * The `jobs:` blocks of a workflow, as `{ name, body }`.
 *
 * matrix-zero-guard.test.mjs exports an identical splitter, and importing it
 * would be the obvious move — but self-test.yml runs each file as its own
 * `node --test <file>` step, and importing a TEST file executes its tests too.
 * The other file's assertions would then be reported under this step's name,
 * so a failure there would be read as a failure here. Fourteen lines of text
 * splitting is the cheaper of the two.
 */
function jobBlocks(source) {
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
    body: lines.slice(line, i + 1 < heads.length ? heads[i + 1].line : lines.length).join("\n"),
  }));
}

const source = () => readFileSync(STATIC_WORKFLOW, "utf8");
const jobs = () => new Map(jobBlocks(source()).map((j) => [j.name, j]));

test("the retry gate is a job, bounded, and downstream of Detect Changes", () => {
  const gate = jobs().get("retry-gate");
  assert.ok(gate, "monorepo-static.yml defines no `retry-gate` job");
  assert.match(
    gate.body,
    /needs:\s*changes\b/,
    "the retry gate must run AFTER Detect Changes — it is what decides the tier runs at all",
  );
  assert.match(
    gate.body,
    /timeout-minutes:/,
    "the retry gate sits in front of the whole pipeline; an unbounded hang here stalls everything",
  );
});

test("the gate is opt-in, and pull-request only", () => {
  const gate = jobs().get("retry-gate");
  assert.match(
    gate.body,
    /inputs\.retry-gate-command != ''/,
    "an unconfigured consumer must skip the lane entirely, not run an empty command",
  );
  assert.match(
    gate.body,
    /github\.event_name == 'pull_request'/,
    "on push this tier IS the post-merge safety net, whose contract is to skip nothing",
  );
});

test("nothing in the gate installs a toolchain before the probe has spoken", () => {
  const gate = jobs().get("retry-gate");
  const lines = gate.body.split(/\r?\n/);
  const probeAt = lines.findIndex((l) => /id:\s*ledger/.test(l));
  assert.ok(probeAt !== -1, "the probe step must carry `id: ledger` so later steps can read it");

  // Every step that costs real time must be gated on the probe's answer —
  // that gating is the entire reason this lane is free on a green branch.
  for (const marker of [/pnpm\/action-setup/, /actions\/setup-node/, /pnpm install/]) {
    const at = lines.findIndex((l) => marker.test(l));
    assert.ok(at !== -1, `expected a step matching ${marker} in the retry gate`);
    assert.ok(at > probeAt, `the step matching ${marker} must come after the probe`);
    const window = lines.slice(Math.max(0, at - 6), at + 6).join("\n");
    assert.match(
      window,
      /steps\.ledger\.outputs\.any != 'false'/,
      `the step matching ${marker} must be gated on the probe — an ungated install ` +
        "costs every green push the toolchain this lane exists to avoid",
    );
  }
});

for (const name of GATED) {
  test(`${name} waits on the retry gate`, () => {
    const job = jobs().get(name);
    assert.ok(job, `monorepo-static.yml defines no \`${name}\` job`);
    assert.match(
      job.body,
      /needs:\s*\[\s*changes\s*,\s*retry-gate\s*\]/,
      `${name} must declare \`needs: [changes, retry-gate]\` — without the edge the gate ` +
        "cannot hold it back at all",
    );
  });

  test(`${name} runs when the gate is skipped, and not when it failed`, () => {
    const job = jobs().get(name);
    const condition = /if:[\s\S]*?(?=\n {4}[a-z-]+:|\n {4}steps:)/.exec(job.body)?.[0] ?? "";

    // Survives the common case: the gate almost never actually runs.
    assert.match(
      condition,
      /needs\.retry-gate\.result == 'skipped'/,
      `${name} must still run when the gate is SKIPPED — it is skipped on every green ` +
        "branch, and a bare `needs:` would skip this job with it",
    );
    // …without surviving the case the gate exists for.
    assert.match(
      condition,
      /needs\.retry-gate\.result == 'success'/,
      `${name} must test the gate's result by NAME; \`always()\`/\`!cancelled()\` alone are ` +
        "true for a failed gate too, which starts the tier on a tree already proved broken",
    );
    assert.doesNotMatch(
      condition,
      /always\(\)/,
      `${name} must not use always() — it runs the job on a FAILED gate, which is the one ` +
        "outcome this wiring exists to prevent",
    );
  });
}
