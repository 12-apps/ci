/**
 * The CLI's contract with the workflow that calls it: the plan FILE and the
 * step OUTPUTS must describe the same run.
 *
 * The outputs size a matrix and the file is the artifact a reviewer opens
 * afterwards to ask what a narrowed lane actually covered. If those two
 * disagree, the disagreement is invisible — both halves are internally
 * consistent and the job is green either way. The case that bites is "nothing
 * to run": the matrix is expanded before any runner exists, so a `1` there
 * boots a machine to pay a checkout, an install and a setup before exiting 0,
 * and a `1` recorded in the artifact is a record of a run that did not happen.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "plan.mjs");

const CONFIG = {
  workspaces: [],
  ignore: String.raw`\.md$`,
  sourceRoots: ["src"],
  lanes: { unit: { roots: ["src"], test: String.raw`\.test\.ts$` } },
};

/** A throwaway git repo with one base commit and one head commit. */
function repo(files, changes) {
  const root = mkdtempSync(join(tmpdir(), "affected-plan-cli-"));
  const git = (...args) => spawnSync("git", args, { cwd: root, stdio: "ignore" });
  const put = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  put(".affected-plan.json", JSON.stringify(CONFIG));
  for (const [path, body] of Object.entries(files)) put(path, body);
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  for (const [path, body] of Object.entries(changes)) put(path, body);
  git("add", "-A");
  git("commit", "-qm", "head");
  return { root, base };
}

/** Run the CLI and read back BOTH halves: the plan file and the step outputs. */
function plan(root, base) {
  const outputs = join(root, "outputs.txt");
  writeFileSync(outputs, "");
  const result = spawnSync(
    "node",
    [CLI, "--lane", "unit", "--base", base, "--config", ".affected-plan.json",
      "--out", "plan.json", "--max-shards", "4", "--min-tests-per-shard", "40"],
    { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: "" } },
  );
  const document = JSON.parse(readFileSync(join(root, "plan.json"), "utf8"));
  const emitted = Object.fromEntries(
    readFileSync(outputs, "utf8").split("\n").filter(Boolean).map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
  return { code: result.status, document, emitted, err: result.stderr };
}

test("nothing to run is an EMPTY matrix, in the outputs and in the artifact", () => {
  // A docs-only diff: the ignore rule drops it, so no symbol changed.
  const { root, base } = repo(
    { "src/a.ts": "export const a = 1;\n", "src/a.test.ts": "import { a } from './a';\n", "README.md": "one\n" },
    { "README.md": "two\n" },
  );
  const { code, document, emitted } = plan(root, base);
  assert.equal(code, 0);
  assert.equal(document.mode, "none");
  assert.equal(emitted.shards, "[]");
  assert.equal(emitted["shard-total"], "0");
  assert.equal(emitted.count, "0");
  // The half that used to disagree: the artifact recorded one shard beside an
  // empty matrix, so the record said a shard ran and the run said none did.
  assert.equal(document.counts.shardTotal, 0, "the artifact must record the empty matrix too");
});

test("a narrowed plan names its tests and sizes the matrix from them", () => {
  const { root, base } = repo(
    {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
      "src/a.test.ts": "import { a } from './a';\n",
      "src/b.test.ts": "import { b } from './b';\n",
    },
    { "src/a.ts": "export const a = 2;\n" },
  );
  const { document, emitted } = plan(root, base);
  assert.equal(document.mode, "narrowed");
  assert.deepEqual(document.tests, ["src/a.test.ts"], "only the test reaching the changed symbol");
  // Two files is far below `min-tests-per-shard`, so one runner is the answer —
  // every shard pays a full setup.
  assert.equal(emitted["shard-total"], "1");
  assert.equal(emitted.shards, "[1]");
  assert.equal(document.counts.shardTotal, 1);
});

test("an unclassified path fails the action and names the file", () => {
  // The behaviour this replaced: `build/x.ts` used to buy the entire suite,
  // silently and greenly. Now the run stops and a human adds one rule.
  const { root, base } = repo(
    { "src/a.ts": "export const a = 1;\n", "src/a.test.ts": "import { a } from './a';\n", "build/x.ts": "1\n" },
    { "build/x.ts": "2\n" },
  );
  const { code, document } = plan(root, base);
  assert.equal(code, 1, "an unclassified path must stop the plan job");
  assert.equal(document.mode, "unclassified");
  assert.deepEqual(document.unclassified, ["build/x.ts"]);
  // The document still lands, so the artifact carries EVERY offending path
  // rather than the handful the log message had room for.
  assert.equal(document.counts.shardTotal, 0);
});

test("a classified non-source path is ignored, and the lane still narrows", () => {
  const { root, base } = repo(
    { "src/a.ts": "export const a = 1;\n", "src/a.test.ts": "import { a } from './a';\n", "notes.md": "x\n" },
    { "notes.md": "y\n" },
  );
  const { code, document } = plan(root, base);
  assert.equal(code, 0);
  assert.equal(document.mode, "none", "an ignored-only diff selects nothing and costs no runner");
  assert.equal(document.counts.shardTotal, 0);
});

test("an unreadable config is `full`, never a silent narrow", () => {
  const { root, base } = repo({ "src/a.ts": "export const a = 1;\n" }, { "src/a.ts": "export const a = 2;\n" });
  writeFileSync(join(root, ".affected-plan.json"), "{ not json");
  const { code, document } = plan(root, base);
  assert.equal(code, 0, "the action reports its verdict through `mode`, not an exit code");
  assert.equal(document.mode, "full");
});

test("a command route expands a path the config cannot name", () => {
  // A catalog bump's entry is whichever source imports the bumped package —
  // knowable only by reading the diff, so the repo supplies a command.
  const { root, base } = repo(
    {
      "src/lib.ts": "export const lib = 1;\n",
      "src/lib.test.ts": "import { lib } from './lib';\n",
      "route.sh": "#!/bin/sh\necho src/lib.ts\n",
      "pnpm-lock.yaml": "a\n",
    },
    { "pnpm-lock.yaml": "b\n" },
  );
  writeFileSync(
    join(root, ".affected-plan.json"),
    JSON.stringify({ ...CONFIG, routes: [{ match: String.raw`^pnpm-lock\.yaml$`, command: "sh route.sh" }] }),
  );
  const { code, document } = plan(root, base);
  assert.equal(code, 0, "a routed lockfile must not stop the run");
  assert.equal(document.mode, "narrowed");
  assert.deepEqual(document.tests, ["src/lib.test.ts"]);
  assert.deepEqual(document.routes, { "src/lib.ts": ["pnpm-lock.yaml"] });
});

test("a route command that prints nothing leaves the path UNCLASSIFIED", () => {
  // The failure this must never take: a silent empty would skip exactly the
  // tests the bump was meant to reach, and report success doing it.
  const { root, base } = repo(
    { "src/a.ts": "export const a = 1;\n", "route.sh": "#!/bin/sh\nexit 0\n", "pnpm-lock.yaml": "a\n" },
    { "pnpm-lock.yaml": "b\n" },
  );
  writeFileSync(
    join(root, ".affected-plan.json"),
    JSON.stringify({ ...CONFIG, routes: [{ match: String.raw`^pnpm-lock\.yaml$`, command: "sh route.sh" }] }),
  );
  const { code, document } = plan(root, base);
  assert.equal(code, 1);
  assert.deepEqual(document.unclassified, ["pnpm-lock.yaml"]);
});

test("a route command that FAILS leaves the path unclassified too", () => {
  const { root, base } = repo(
    { "src/a.ts": "export const a = 1;\n", "pnpm-lock.yaml": "a\n" },
    { "pnpm-lock.yaml": "b\n" },
  );
  writeFileSync(
    join(root, ".affected-plan.json"),
    JSON.stringify({ ...CONFIG, routes: [{ match: String.raw`^pnpm-lock\.yaml$`, command: "exit 7" }] }),
  );
  const { code, document } = plan(root, base);
  assert.equal(code, 1, "a broken router must stop the run, never quietly select nothing");
  assert.deepEqual(document.unclassified, ["pnpm-lock.yaml"]);
});
