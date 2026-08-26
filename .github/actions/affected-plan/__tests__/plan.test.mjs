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
  untraceable: String.raw`^(?!src/).*`,
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

test("an untraceable path widens to full, and full takes the whole ceiling", () => {
  const { root, base } = repo(
    { "src/a.ts": "export const a = 1;\n", "src/a.test.ts": "import { a } from './a';\n", "build/x.ts": "1\n" },
    { "build/x.ts": "2\n" },
  );
  const { document, emitted } = plan(root, base);
  assert.equal(document.mode, "full");
  assert.equal(emitted["shard-total"], "4");
  assert.equal(document.counts.shardTotal, 4);
});

test("an unreadable config is `full`, never a silent narrow", () => {
  const { root, base } = repo({ "src/a.ts": "export const a = 1;\n" }, { "src/a.ts": "export const a = 2;\n" });
  writeFileSync(join(root, ".affected-plan.json"), "{ not json");
  const { code, document } = plan(root, base);
  assert.equal(code, 0, "the action reports its verdict through `mode`, not an exit code");
  assert.equal(document.mode, "full");
});
