import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// A reusable workflow may not reference an action by a RELATIVE path.
//
// `uses: ./.github/actions/foo` resolves against the CALLER's checkout, not
// against the repository holding the workflow file. Inside this repo those are
// the same directory, so the reference reads as correct here and works in every
// self-test — and then dies for the consumer, which has no such folder. That is
// the failure this file exists to catch: green at home, broken only once
// somebody depends on it.
//
// It is not hypothetical. package-gates.yml shipped with exactly this line and
// the defect was invisible until a consuming repo called it. Every other action
// reference in this repo already carries its full `12-apps/ci/...@v1` path, so
// the rule codifies the convention the repo was already keeping by hand.
//
// A STANDALONE workflow (pr-commits.yml, self-test.yml) is deliberately out of
// scope: it runs in this repo, where `./` means what it says.

const WORKFLOWS = path.join(
  fileURLToPath(new URL("../", import.meta.url)),
);

/** Does this workflow expose itself to other repositories? */
export function declaresWorkflowCall(source) {
  return /^\s{2,}workflow_call:/m.test(source);
}

/**
 * Every `uses:` in `source` whose target is a relative path, with its 1-based
 * line number. Quoted and unquoted forms both count; a `#` comment does not.
 */
export function relativeUses(source) {
  const found = [];
  source.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const m = line.match(/^\s*(?:-\s*)?uses:\s*["']?(\.\/\S*?)["']?\s*(?:#.*)?$/);
    if (m) found.push({ line: i + 1, ref: m[1] });
  });
  return found;
}

// --- the detector must actually detect -----------------------------------
// A sweep that stopped recognising `./` would report a clean estate, invite no
// fix, and never be red at any point. These pin it in both directions.

test("relativeUses finds a relative action reference", () => {
  const refs = relativeUses("      - name: Run gates\n        uses: ./.github/actions/package-gates\n");
  assert.deepEqual(refs, [{ line: 2, ref: "./.github/actions/package-gates" }]);
});

test("relativeUses finds the bare `- uses:` and quoted forms", () => {
  assert.equal(relativeUses("      - uses: ./a\n").length, 1);
  assert.equal(relativeUses('      - uses: "./b"\n').length, 1);
  assert.equal(relativeUses("      - uses: './c'\n").length, 1);
});

test("relativeUses ignores full paths and commented-out lines", () => {
  const src = [
    "        uses: 12-apps/ci/.github/actions/fetch-base@v1",
    "        uses: actions/checkout@v4",
    "        # uses: ./.github/actions/nope",
  ].join("\n");
  assert.deepEqual(relativeUses(src), []);
});

test("declaresWorkflowCall separates reusable from standalone", () => {
  assert.equal(declaresWorkflowCall("on:\n  workflow_call:\n    inputs:\n"), true);
  assert.equal(declaresWorkflowCall("on:\n  pull_request:\n"), false);
});

// --- the sweep -------------------------------------------------------------

test("no reusable workflow references an action by a relative path", () => {
  const offenders = [];

  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const source = readFileSync(path.join(WORKFLOWS, file), "utf8");
    if (!declaresWorkflowCall(source)) continue;
    for (const { line, ref } of relativeUses(source)) {
      offenders.push(`${file}:${line}  uses: ${ref}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "A reusable workflow resolves a relative `uses:` against the CALLER's\n" +
      "checkout, so these work here and break for every consuming repo.\n" +
      "Spell them in full — `12-apps/ci/.github/actions/<name>@v1`:\n  " +
      offenders.join("\n  "),
  );
});

test("the sweep actually reads this repo's reusable workflows", () => {
  // Guards the direction that fails silently: a glob that matched nothing, or a
  // `workflow_call` detector that recognised nothing, reports zero offenders
  // and passes. If this repo ever stops shipping reusable workflows, this test
  // is the one that must be deleted deliberately.
  const reusable = readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .filter((f) => declaresWorkflowCall(readFileSync(path.join(WORKFLOWS, f), "utf8")));

  assert.ok(
    reusable.length >= 10,
    `expected the sweep to see this repo's reusable workflows, saw ${reusable.length}`,
  );
  assert.ok(reusable.includes("package-gates.yml"));
});
