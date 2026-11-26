import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { declaredInputs } from "./declared-inputs.test.mjs";

// future-pay FUT-5641: CI experiments run in random buckets of the SAME days,
// instead of a week before a change against a week after it. Detect Changes
// assigns the bucket (the run id's last digit) and names the experiment the
// run is in; the consumer's jobs read `needs.<static>.outputs.experiment`.
// This pins the wiring: opt-in, first step, read-only, and exposed.

const source = readFileSync(new URL("../monorepo-static.yml", import.meta.url), "utf8");
const lines = source.split("\n");

function block(startRe, indent) {
  const i = lines.findIndex((l) => startRe.test(l));
  assert.notEqual(i, -1, `no line matches ${startRe}`);
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() && lines[j].search(/\S/) <= indent) break;
    out.push(lines[j]);
  }
  return out.join("\n");
}

test("both inputs are declared and default to off", () => {
  const names = declaredInputs(source);
  assert.ok(names.includes("experiments-file"));
  assert.ok(names.includes("experiments-off"));
  for (const name of ["experiments-file", "experiments-off"]) {
    assert.match(block(new RegExp(`^ {6}${name}:\\s*$`), 6), /default: ''/);
  }
});

test("the bucket is the first step of Detect Changes, and only when opted in", () => {
  const changes = block(/^ {2}changes:\s*$/, 2);
  const steps = [...changes.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1]);
  assert.equal(steps[0], "Experiment bucket");
  const step = changes.slice(changes.indexOf("- name: Experiment bucket"));
  assert.match(step, /if: \$\{\{ inputs\.experiments-file != '' \}\}/);
  assert.match(step, /uses: 12-apps\/ci\/\.github\/actions\/experiment-bucket@v2/);
  assert.match(step, /file: \$\{\{ inputs\.experiments-file \}\}/);
  assert.match(step, /off: \$\{\{ inputs\.experiments-off \}\}/);
});

test("Detect Changes may read the run (actions: read) and still cannot write", () => {
  const perms = block(/^ {4}permissions:\s*$/, 4);
  const changes = block(/^ {2}changes:\s*$/, 2);
  assert.ok(changes.includes(perms), "the first job-level permissions block belongs to changes");
  assert.match(perms, /actions: read/);
  assert.doesNotMatch(perms, /write/);
});

test("the experiment and its digit reach the caller", () => {
  assert.match(source, /experiment: \$\{\{ steps\.experiment\.outputs\.experiment \}\}/);
  assert.match(source, /experiment-digit: \$\{\{ steps\.experiment\.outputs\.digit \}\}/);
  assert.match(source, /value: \$\{\{ jobs\.changes\.outputs\.experiment \}\}/);
  assert.match(source, /value: \$\{\{ jobs\.changes\.outputs\.experiment-digit \}\}/);
});
