/**
 * `lint-command`: a caller may lint what a pull request changed (FUT-4552).
 *
 * future-pay measured `Static / Lint` at 2.3% of its fleet's job-minutes
 * (median 137 s, 107 jobs a day on 2026-11-05). A one-file edit under
 * `apps/web` paid ~40 s of its dependencies' lint (turbo's `^lint`) and ~50 s
 * of the whole `web` package. Its lint rules are syntactic, so a file's verdict
 * depends on its own text and the toolchain: the caller can lint the changed
 * files and fall back to the whole tree itself.
 *
 * Every regression here is green, so each is pinned by RUNNING the Lint step's
 * own script under bash with a stub `pnpm` on PATH:
 *   - the input defaults to empty, and empty keeps `turbo run lint --affected`;
 *   - the command runs only on a pull request with a resolved base;
 *   - off a pull request the lane lints everything and never reads the input;
 *   - the command's exit status is the lane's (a red lint stays red);
 *   - the command reaches the script through `env:`, never as program text;
 *   - the verdict key moves with the command.
 *
 * Node builtins only — the self-test lane runs before any install.
 *
 * Usage: node --test .github/workflows/__tests__/lint-command.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WORKFLOWS = fileURLToPath(new URL("../", import.meta.url));
const STATIC = readFileSync(join(WORKFLOWS, "monorepo-static.yml"), "utf8");

/** The `lint:` job's body, up to the next top-level job. */
function lintJob() {
  const m = /\n {2}lint:\n([\s\S]*?)\n {2}[a-z-]+:\n/.exec(STATIC);
  assert.ok(m, "monorepo-static.yml has no lint job");
  return m[1];
}

/** A step block of the lint job, from its `- name: <name>` to the next step. */
function step(name) {
  const body = lintJob();
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l === `      - name: ${name}`);
  assert.notEqual(start, -1, `the lint job has no "${name}" step`);
  let end = start + 1;
  while (end < lines.length && !/^ {6}- /.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

/** The literal `run: |` script of a step block, dedented. */
function runScript(block) {
  const lines = block.split("\n");
  const at = lines.findIndex((l) => /^ {8}run: \|$/.test(l));
  assert.notEqual(at, -1, "the step has no `run: |` block");
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

/** Runs the Lint step's script with a stub pnpm that records its argv. */
function runLint({ event, base, command, pnpmExit = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), "lint-command-"));
  const calls = join(dir, "calls");
  writeFileSync(join(dir, "pnpm"), `#!/bin/sh\necho "pnpm $*" >> "${calls}"\nexit ${pnpmExit}\n`);
  chmodSync(join(dir, "pnpm"), 0o755);
  const script = runScript(step("Lint"));
  const result = spawnSync("bash", ["-e", "-c", script], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_EVENT_NAME: event,
      SELECTION_BASE: base,
      LINT_COMMAND: command,
      PR_HEAD_SHA: "abc123",
      CALLS: calls,
    },
  });
  let recorded = "";
  try {
    recorded = readFileSync(calls, "utf8");
  } catch {
    recorded = "";
  }
  return { status: result.status, calls: recorded.trim().split("\n").filter(Boolean), stdout: result.stdout };
}

test("lint-command is declared, optional, and empty by default", () => {
  const m = /\n {6}lint-command:\n((?: {8}.*\n| {10}.*\n)+)/.exec(STATIC);
  assert.ok(m, "lint-command is not declared — a caller passing it is a startup_failure");
  assert.match(m[1], /^\s+type: string$/m);
  assert.match(m[1], /^\s+required: false$/m);
  assert.match(m[1], /^\s+default: ''$/m, "a non-empty default would change every consumer's lint");
});

test("the command reaches the Lint script through env, never as program text", () => {
  const block = step("Lint");
  assert.match(block, /^ {10}LINT_COMMAND: \$\{\{ inputs\.lint-command \}\}$/m);
  assert.match(block, /^ {10}PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}$/m);
  assert.doesNotMatch(runScript(block), /\$\{\{/, "the run script interpolates an expression");
});

test("empty: a pull request still lints --affected, as before", () => {
  const r = runLint({ event: "pull_request", base: "deadbeef", command: "" });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, ["pnpm turbo run lint --affected"]);
});

test("set: a pull request with a base runs the caller's command and not turbo", () => {
  const r = runLint({ event: "pull_request", base: "deadbeef", command: 'pnpm lint-changed --head "$PR_HEAD_SHA" --base "$SELECTION_BASE"' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, ["pnpm lint-changed --head abc123 --base deadbeef"]);
});

test("set: the command's failure is the lane's failure", () => {
  const r = runLint({ event: "pull_request", base: "deadbeef", command: "pnpm lint-changed", pnpmExit: 1 });
  assert.notEqual(r.status, 0, "a red changed-files lint must fail the step");
  const exit3 = runLint({ event: "pull_request", base: "deadbeef", command: "exit 3" });
  assert.notEqual(exit3.status, 0, "a non-zero shell exit must fail the step through the tee pipeline");
});

test("set: a pull request with NO resolved base lints the whole tree", () => {
  const r = runLint({ event: "pull_request", base: "", command: "pnpm lint-changed" });
  assert.deepEqual(r.calls, ["pnpm turbo run lint"]);
});

for (const event of ["push", "schedule", "workflow_dispatch", "merge_group"]) {
  test(`set: a ${event} run lints the whole tree and never reads the command`, () => {
    const r = runLint({ event, base: "deadbeef", command: "pnpm lint-changed" });
    assert.equal(r.status, 0);
    assert.deepEqual(r.calls, ["pnpm turbo run lint"]);
  });
}

test("the lint verdict key moves with the command", () => {
  const block = step("Look up a recorded lane verdict");
  assert.match(block, /^ {12}lint-command=\$\{\{ inputs\.lint-command \}\}$/m, "a verdict recorded under one command would be reused under another");
});
