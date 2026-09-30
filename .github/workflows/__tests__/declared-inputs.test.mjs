// Every `inputs.<name>` a reusable workflow reads must be an input it declares.
//
// GitHub does not report the mismatch in either direction, and both directions
// are bad in ways that look like nothing:
//
//   - INSIDE the engine, an expression over an undeclared input evaluates to
//     empty. A step gated on `inputs.x != ''` never runs, an env var fed from it
//     is blank, and the workflow is green with a feature that cannot be turned
//     on. `monorepo-tests.yml` read `inputs.integration-fingerprint-command` in
//     its Integration Plan job for weeks without declaring it, so the integration
//     lane's verdict reuse was dead code, and its key folded in
//     `inputs.integration-test-command` — a name that never existed — instead of
//     `integration-command`.
//
//   - FOR A CALLER, passing that input is a STARTUP FAILURE for the whole run:
//     no job is created, there is no log, and the check is not red — the run is
//     simply `startup_failure` (12-apps/future-pay run 36641143797, which turned
//     the input on believing the engine's own `if:` that it existed).
//
// So the rule is asserted over the text of every workflow that declares
// `workflow_call`: the set of names read is a subset of the set declared.
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const WORKFLOWS = fileURLToPath(new URL("../", import.meta.url));

/** The `inputs:` block under `on.workflow_call`, as the list of names it declares. */
export function declaredInputs(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => /^\s+workflow_call:\s*$/.test(l));
  if (start === -1) return null;
  const callIndent = lines[start].search(/\S/);
  const names = [];
  let inInputs = false;
  let inputsIndent = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.search(/\S/);
    if (indent <= callIndent) break; // left the workflow_call block
    if (!inInputs) {
      if (/^\s+inputs:\s*$/.test(line) && indent === callIndent + 2) {
        inInputs = true;
        inputsIndent = indent;
      }
      continue;
    }
    if (indent <= inputsIndent) break; // left the inputs block (secrets:, outputs:)
    const name = /^\s+([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (name && indent === inputsIndent + 2) names.push(name[1]);
  }
  return names;
}

/**
 * Every `inputs.<name>` the workflow's text reads, deduplicated.
 *
 * `inputs.` must stand on its own: a file name such as
 * `declared-inputs.test.mjs` in a description is not a reference, and `\b`
 * alone would read it as `inputs.test`.
 */
export function referencedInputs(source) {
  return [...new Set([...source.matchAll(/(?<![\w-])inputs\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]))];
}

const reusable = readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ file: f, source: readFileSync(path.join(WORKFLOWS, f), "utf8") }))
  .filter((w) => /^\s+workflow_call:/m.test(w.source));

test("the sweep finds the reusable workflows it exists for", () => {
  const names = reusable.map((w) => w.file);
  assert.ok(names.includes("monorepo-tests.yml"), "monorepo-tests.yml declares workflow_call");
  assert.ok(names.length >= 5, `expected several reusable workflows, found ${names.length}`);
});

test("the parser reads a declaration block and stops at its end", () => {
  const sample = [
    "on:",
    "  workflow_call:",
    "    inputs:",
    "      alpha:",
    "        type: string",
    "      beta-2:",
    "        description: >-",
    "          nested: colon lines must not count, and declared-inputs.test.mjs",
    "          names a file, not an input",
    "        type: string",
    "    secrets:",
    "      gamma:",
    "        required: false",
    "jobs:",
    "  x:",
    "    steps:",
    "      - run: echo ${{ inputs.alpha }} ${{ inputs.beta-2 }} ${{ inputs.delta }}",
  ].join("\n");
  assert.deepEqual(declaredInputs(sample), ["alpha", "beta-2"]);
  assert.deepEqual(referencedInputs(sample).sort(), ["alpha", "beta-2", "delta"]);
});

for (const { file, source } of reusable) {
  test(`${file}: every inputs.<name> it reads is an input it declares`, () => {
    const declared = declaredInputs(source);
    assert.ok(declared, `${file} has no workflow_call inputs block the parser can read`);
    const undeclared = referencedInputs(source).filter((n) => !declared.includes(n));
    assert.deepEqual(
      undeclared,
      [],
      `${file} reads ${undeclared.join(", ")} but never declares it — dead inside the engine, ` +
        "a startup failure for any caller that passes it",
    );
  });
}
