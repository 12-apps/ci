/**
 * The composite action: its inputs, and its one step RUN the way the runner
 * runs it. A wiring mistake here is green in the worst way: a step that calls
 * the script without the base would skip every term enforced on new lines, or
 * fail every pull request, and neither shows up in the script's own tests.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ACTION_DIR, cleanEnv, glossary, repo, write } from "./helpers.mjs";

const source = readFileSync(join(ACTION_DIR, "action.yml"), "utf8");
const lines = source.split("\n");

/** The step's `run: |` script, dedented, and the lines of the step around it. */
function step() {
  const at = lines.findIndex((line) => /^\s+run: \|$/.test(line));
  assert.notEqual(at, -1, "action.yml has no `run: |` block");
  const indent = lines[at].indexOf("run:");
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && line.length - line.trimStart().length <= indent) break;
    body.push(line.slice(indent + 2));
  }
  return { body: body.join("\n"), head: lines.slice(lines.indexOf("runs:"), at).join("\n") };
}

/** Run the step's script as the runner does: bash with errexit and pipefail, values in the environment. */
function runStep(root, values) {
  return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step().body], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv({ GITHUB_ACTION_PATH: ACTION_DIR, ...values }),
  });
}

const NEW_TERM = [{ use: "motoboy", avoid: ["entregador"], enforce: "new" }];

test("the inputs are config (required), base-ref and working-directory, with safe defaults", () => {
  const inputs = source.slice(source.indexOf("\ninputs:"), source.indexOf("\nruns:"));
  assert.deepEqual(inputs.match(/^ {2}[\w-]+(?=:$)/gm).map((name) => name.trim()), ["config", "base-ref", "working-directory"]);
  // Each input's own lines: from its name to the next input's.
  const block = (name) => inputs.split(/\n {2}(?=[\w-]+:\n)/).find((text) => text.startsWith(`${name}:`));
  assert.match(block("config"), /required: true/);
  assert.match(block("base-ref"), /required: false\n\s+default: ''/);
  assert.match(block("working-directory"), /required: false\n\s+default: '\.'/);
});

test("every input reaches the script through env, never interpolated into the run body", () => {
  const { body, head } = step();
  assert.doesNotMatch(body, /\$\{\{/, "an expression in the body is the value pasted in as program text");
  assert.match(head, /^\s+CONFIG: \$\{\{ inputs\.config \}\}$/m);
  assert.match(head, /^\s+BASE_REF: \$\{\{ inputs\.base-ref \}\}$/m);
  assert.match(head, /^\s+working-directory: \$\{\{ inputs\.working-directory \}\}$/m);
  assert.match(body, /node "\$GITHUB_ACTION_PATH\/check\.mjs" "\$\{args\[@\]\}"/);
});

test("the action neither checks out nor fetches: the caller provides the history", () => {
  assert.doesNotMatch(source, /^\s+(- )?uses:/m);
  assert.doesNotMatch(step().body, /git (fetch|checkout|clone)/);
  assert.match(source, /The action neither checks\s+out nor fetches/);
});

test("the step fails a tree with a forbidden word and passes a clean one", () => {
  const dirty = repo({ "docs/glossary.json": glossary(), "src/a.md": "o entregador\n" });
  const failed = runStep(dirty, { CONFIG: "docs/glossary.json", BASE_REF: "" });
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stdout, /^src\/a\.md:1:3 {2}"entregador" → use "motoboy"/);

  const clean = repo({ "docs/glossary.json": glossary(), "src/a.md": "o motoboy\n" });
  const passed = runStep(clean, { CONFIG: "docs/glossary.json", BASE_REF: "" });
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
});

test("with base-ref the step judges the new lines; without it a new-lines term fails the step", () => {
  const root = repo({ "glossary.json": glossary({ terms: NEW_TERM }), "src/a.md": "o entregador antigo\n" });
  assert.equal(runStep(root, { CONFIG: "glossary.json", BASE_REF: "main" }).status, 0, "old debt passes");

  write(root, { "src/a.md": "o entregador antigo\no entregador novo\n" });
  const added = runStep(root, { CONFIG: "glossary.json", BASE_REF: "main" });
  assert.equal(added.status, 1);
  assert.match(added.stdout, /^src\/a\.md:2:3 /);

  const noBase = runStep(root, { CONFIG: "glossary.json", BASE_REF: "" });
  assert.equal(noBase.status, 2, "never a silent pass");
  assert.match(noBase.stderr, /enforced on new lines only \(motoboy\): pass --base <ref> or --staged/);
});

test("a base the checkout does not hold fails the step", () => {
  const root = repo({ "glossary.json": glossary({ terms: NEW_TERM }), "src/a.md": "x\n" });
  const r = runStep(root, { CONFIG: "glossary.json", BASE_REF: "origin/main" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--base origin\/main does not resolve to a commit/);
});

test("the hosted self-test runs this suite, and the docs name the action where a consumer looks", () => {
  const repoFile = (path) => readFileSync(join(ACTION_DIR, "..", "..", "..", path), "utf8");
  assert.match(repoFile(".github/workflows/self-test.yml"), /^\s+run: node --test \.github\/actions\/terminology\/__tests__\/\*\.test\.mjs$/m);
  const uses = /uses: 12-apps\/ci\/\.github\/actions\/terminology@v\d+\n\s+with:\n\s+config: /;
  assert.match(readFileSync(join(ACTION_DIR, "README.md"), "utf8"), uses);
  assert.match(repoFile("CONSUMING.md"), /^# Consuming the Terminology check$/m);
  assert.match(repoFile("CONSUMING.md"), uses);
  assert.match(repoFile("README.md"), /^\| `\.github\/actions\/terminology` \|/m);
});

test("an input is data: a value shaped like shell does not run", () => {
  const root = repo({ "glossary.json": glossary(), "src/a.md": "x\n" });
  const r = runStep(root, { CONFIG: '$(touch pwned-config); "; touch pwned-config-2; "', BASE_REF: "$(touch pwned-base)" });
  assert.equal(r.status, 2);
  for (const name of ["pwned-config", "pwned-config-2", "pwned-base"]) assert.equal(existsSync(join(root, name)), false, name);
});
