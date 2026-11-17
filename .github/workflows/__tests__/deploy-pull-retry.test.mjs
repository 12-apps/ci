import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The DigitalOcean deploy RETRIES its image pull (FUT-4848).
//
// One `docker compose pull` fetches every image at once, and a single
// `failed to copy: … connection reset by peer` mid-layer used to fail the
// whole deploy. A fresh deploy could not build on the failed one either: the
// script prunes every unused image first, so each deploy started every new
// layer from zero. In 12-apps/future-pay that failed five production deploys
// in a row on 2026-11-17, while QA pulled the same images cleanly.
//
// The loop is taken out of the workflow and RUN, with `doppler` faked to fail
// a given number of times, so what is pinned is what the box would do.

const ROOT = path.join(fileURLToPath(new URL("../../../", import.meta.url)));
const WORKFLOW = readFileSync(path.join(ROOT, ".github/workflows/deploy-digitalocean.yml"), "utf8");

/** The retry block, from its attempt count to the loop's `done`, de-indented. */
function retryBlock() {
  const lines = WORKFLOW.split("\n");
  const start = lines.findIndex((l) => /^\s*pull_attempts=\d+\s*$/.test(l));
  assert.notEqual(start, -1, "the deploy no longer sets pull_attempts: the pull is not retried");
  const indent = lines[start].match(/^\s*/)[0];
  const end = lines.findIndex((l, i) => i > start && l === `${indent}done`);
  assert.notEqual(end, -1, "the retry loop has no closing `done` at its own indent");
  return lines
    .slice(start, end + 1)
    .map((l) => l.slice(indent.length))
    .join("\n");
}

/** Runs the block with `doppler` failing `failures` times; returns the exit code and the pull count. */
function run(failures) {
  const script = `
set -euo pipefail
pulls=0
doppler() { pulls=$((pulls + 1)); [ "$pulls" -gt ${failures} ]; }
sleep() { :; }
${retryBlock()}
echo "PULLS=$pulls"
`;
  const out = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  const pulls = Number((out.stdout.match(/PULLS=(\d+)/) ?? [])[1] ?? -1);
  return { status: out.status, pulls, stderr: out.stderr, stdout: out.stdout };
}

test("a clean pull runs once", () => {
  const r = run(0);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.pulls, 1);
});

test("resets mid-pull are retried until a pull completes", () => {
  const r = run(3);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.pulls, 4);
  assert.match(r.stdout, /attempt 3 of \d+/);
});

test("a registry that stays down still fails the deploy, after the last attempt", () => {
  const attempts = Number(retryBlock().match(/pull_attempts=(\d+)/)[1]);
  assert.ok(attempts >= 3 && attempts <= 10, `pull_attempts=${attempts} should be bounded and more than a retry or two`);
  const r = run(99);
  assert.notEqual(r.status, 0, "an endless failure must not deploy");
  assert.equal(r.pulls, -1, "nothing after the loop may run when every attempt failed");
  assert.match(r.stderr, new RegExp(`pull failed ${attempts} times`));
});

test("no other bare compose pull bypasses the loop", () => {
  // Commands only: a comment is prose, and an `echo` names the pull in its message.
  const pulls = WORKFLOW.split("\n").filter((l) => !/^\s*(#|echo\b)/.test(l) && /docker compose[^\n]*\bpull\b/.test(l));
  assert.equal(pulls.length, 1, `expected the one retried pull, found:\n${pulls.join("\n")}`);
  assert.match(pulls[0], /^\s*if doppler run -- docker compose --profile tools pull; then\s*$/);
});
