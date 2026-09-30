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

test("an unreadable config is `full`, never a silent narrow — and full has a POSITIVE matrix", () => {
  const { root, base } = repo({ "src/a.ts": "export const a = 1;\n" }, { "src/a.ts": "export const a = 2;\n" });
  writeFileSync(join(root, ".affected-plan.json"), "{ not json");
  const { code, document, emitted } = plan(root, base);
  assert.equal(code, 0, "the action reports its verdict through `mode`, not an exit code");
  assert.equal(document.mode, "full");
  // E1: `full` carries no test list by construction, and reading the empty
  // list before the mode gave the full suite ZERO shards — the log said
  // "running the FULL suite" while the matrix was off (since #84).
  assert.equal(emitted["shard-total"], "4", "full means every shard, --max-shards of them");
  assert.equal(emitted.shards, "[1,2,3,4]");
  assert.equal(document.counts.shardTotal, 4);
});

test("E1: a lane the config does not declare is `full` with a positive matrix too", () => {
  const { root, base } = repo({ "src/a.ts": "export const a = 1;\n" }, { "src/a.ts": "export const a = 2;\n" });
  writeFileSync(join(root, ".affected-plan.json"), JSON.stringify({ ...CONFIG, lanes: {} }));
  const { code, document, emitted } = plan(root, base);
  assert.equal(code, 0);
  assert.equal(document.mode, "full");
  assert.equal(emitted["shard-total"], "4");
  assert.notEqual(emitted.shards, "[]");
});

test("F3a: a change to a lane-global input alone selects every known lane test", () => {
  // `src/setup.ts` is what the runner loads before every test (setupFiles).
  // Nothing imports it, so a walk of the import graph selects nothing for it;
  // the consumer declared it a global precisely because every verdict can
  // turn on it.
  const config = { ...CONFIG, lanes: { unit: { ...CONFIG.lanes.unit, skipGreen: { globals: [String.raw`^src/setup\.ts$`] } } } };
  const { root, base } = repo(
    { "src/setup.ts": "globalThis.__v = 1;\n", "src/a.ts": "export const a = 1;\n", "src/a.test.ts": 'import { a } from "./a";\n' },
    { "src/setup.ts": "globalThis.__v = 2;\n" },
  );
  writeFileSync(join(root, ".affected-plan.json"), JSON.stringify(config));
  const { code, document, emitted } = plan(root, base);
  assert.equal(code, 0);
  assert.equal(document.mode, "narrowed", document.why);
  assert.deepEqual(document.tests, ["src/a.test.ts"]);
  assert.match(document.why, /runner global inputs/);
  assert.equal(emitted["shard-total"], "1");
  // A global that IS routed keeps its route's narrower answer.
  const routed = { ...config, routes: [{ match: String.raw`^src/setup\.ts$`, entry: ["src/a.ts"] }] };
  writeFileSync(join(root, ".affected-plan.json"), JSON.stringify(routed));
  const narrowed = plan(root, base);
  assert.equal(narrowed.document.mode, "narrowed", narrowed.document.why);
  assert.deepEqual(narrowed.document.tests, ["src/a.test.ts"]);
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

test("F3b: a module global outside the lane's roots is graphed, so the lane keeps its hashes", () => {
  // The integration lane's globals include runner scripts under `scripts/`,
  // which is not one of its roots. Without graphing them the lane would hold
  // no bounded hash at all — every test null, nothing ever skippable.
  const config = {
    ...CONFIG,
    sourceRoots: ["src", "tools"],
    // The rewritten config is committed with the helper below; it is noise here.
    ignore: String.raw`\.md$|^\.affected-plan\.json$`,
    lanes: { unit: { ...CONFIG.lanes.unit, skipGreen: { globals: [String.raw`^tools/runner\.ts$`] } } },
  };
  const { root, base } = repo(
    {
      "tools/runner.ts": 'import { helper } from "./helper";\nhelper();\n',
      "tools/helper.ts": "export const helper = () => 1;\n",
      "src/a.ts": "export const a = 1;\n",
      "src/a.test.ts": 'import { a } from "./a";\n',
    },
    { "src/a.ts": "export const a = 2;\n" },
  );
  writeFileSync(join(root, ".affected-plan.json"), JSON.stringify(config));
  const first = plan(root, base);
  assert.equal(first.document.mode, "narrowed", first.document.why);
  assert.ok(first.document.inputs["src/a.test.ts"], `hashed: ${JSON.stringify(first.document.inputs)} ${first.err}`);
  // A change to the helper the runner imports selects no test by import — and
  // it runs before every one of them, so every known test is selected.
  const git = (...args) => spawnSync("git", args, { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "tools/helper.ts"), "export const helper = () => 2;\n");
  git("add", "tools/helper.ts"); // not -A: the first plan's outputs sit in the tree
  git("commit", "-qm", "helper");
  const second = plan(root, base);
  assert.equal(second.document.mode, "narrowed", second.document.why);
  assert.deepEqual(second.document.tests, ["src/a.test.ts"]);
  assert.match(second.document.why, /tools\/helper\.ts/);
});

test("E6: an unchecked opaqueImports declaration cannot authorize blind reuse", () => {
  const files = {
    "src/registry.ts": "export const load = (f) => import(f);\n",
    "src/a.ts": 'import { load } from "./registry";\nexport const a = load;\n',
    "src/a.test.ts": 'import { a } from "./a";\n',
    "src/b.ts": "export const b = 1;\n",
    "src/b.test.ts": 'import { b } from "./b";\n',
  };
  const skip = { skipGreen: { globals: [] } };
  const blindConfig = { ...CONFIG, lanes: { unit: { ...CONFIG.lanes.unit, ...skip } } };
  const { root, base } = repo(files, { "src/b.ts": "export const b = 2;\n" });
  writeFileSync(join(root, ".affected-plan.json"), JSON.stringify(blindConfig));
  const blind = plan(root, base);
  assert.deepEqual(blind.document.tests, ["src/a.test.ts", "src/b.test.ts"], "a.test runs: its closure holds a file whose imports are unknown");
  assert.equal(blind.document.inputs["src/a.test.ts"], null, "and it is never skippable");
  assert.ok(blind.document.inputs["src/b.test.ts"]);
  const vouched = { ...blindConfig, opaqueImports: [{ match: String.raw`^src/registry\.ts$`, why: "a route carries every file it loads" }] };
  writeFileSync(join(root, ".affected-plan.json"), JSON.stringify(vouched));
  const ok = plan(root, base);
  assert.deepEqual(ok.document.tests, ["src/a.test.ts", "src/b.test.ts"]);
  assert.equal(ok.document.inputs["src/a.test.ts"], null);
});
