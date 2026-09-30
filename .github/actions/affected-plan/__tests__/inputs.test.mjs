// A test's input hash must move on everything its verdict can depend on, and
// on nothing else.
//
// Both directions are asserted, and the dangerous one gets more cases. A hash
// that moves too easily costs a skip that could have happened — visible as
// minutes. A hash that fails to move lets a test be skipped on a tree where it
// would fail, which is a green check on untested code and looks exactly like
// success. So: the test file, a direct import, a transitive import, a global
// input (the lockfile), a mode change, and a deletion must each move it; an
// unrelated file, a type-only import's target and a docs file must not; a test
// whose closure reaches an unresolvable import gets no hash at all.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { closureOf, testInputs, treeIndex } from "../lib/inputs.mjs";
import { buildGraph, listSourceFiles } from "../lib/modules.mjs";

const TMP = mkdtempSync(join(tmpdir(), "test-inputs-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repo(name, files) {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.test");
  git(dir, "config", "user.name", "T");
  git(dir, "config", "commit.gpgsign", "false");
  commit(dir, files, "base");
  return dir;
}

function commit(dir, files, message) {
  for (const [path, body] of Object.entries(files)) {
    if (body === null) {
      git(dir, "rm", "-q", "--", path);
      continue;
    }
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
    git(dir, "add", "--", path);
  }
  git(dir, "commit", "-qm", message);
}

const GLOBALS = [/^pnpm-lock\.yaml$/, /^src\/setup\.ts$/];

/** The hash of every test in `dir` at HEAD, over the graph the selection would walk. */
function hashes(dir) {
  const files = listSourceFiles(dir, ["src"]);
  const { edges, unresolved } = buildGraph(dir, files, { packages: new Map(), aliases: [] });
  const tests = files.filter((f) => /\.test\.ts$/.test(f)).sort();
  return testInputs({ tests, edges, blind: [...new Set(unresolved.map((u) => u.file))], globals: GLOBALS, tree: treeIndex(dir) });
}

const BASE = {
  "src/a.ts": 'import { b } from "./b";\nexport const a = () => b() + 1;\n',
  "src/b.ts": "export const b = () => 1;\n",
  "src/c.ts": "export const c = 3;\n",
  "src/types.ts": "export interface Shape { x: number }\n",
  "src/a.test.ts": 'import { a } from "./a";\nimport type { Shape } from "./types";\na();\n',
  "src/c.test.ts": 'import { c } from "./c";\nc;\n',
  "src/setup.ts": "export const setup = 1;\n",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "README.md": "# hi\n",
};

test("the closure is the transitive VALUE import set, the test included", () => {
  const dir = repo("closure", BASE);
  const files = listSourceFiles(dir, ["src"]);
  const { edges } = buildGraph(dir, files, { packages: new Map(), aliases: [] });
  const { files: closure, blind } = closureOf("src/a.test.ts", edges, new Set());
  assert.deepEqual([...closure].sort(), ["src/a.test.ts", "src/a.ts", "src/b.ts"]);
  assert.equal(blind, false, "every import resolved");
});

// ── must move ───────────────────────────────────────────────────────────────

test("editing the test file moves its hash and no other", () => {
  const dir = repo("edit-test", BASE);
  const before = hashes(dir).inputs;
  commit(dir, { "src/a.test.ts": `${BASE["src/a.test.ts"]}// more\n` }, "edit test");
  const after_ = hashes(dir).inputs;
  assert.notEqual(after_["src/a.test.ts"], before["src/a.test.ts"]);
  assert.equal(after_["src/c.test.ts"], before["src/c.test.ts"], "c's inputs did not move");
});

test("editing a TRANSITIVE dependency moves the hash", () => {
  const dir = repo("edit-transitive", BASE);
  const before = hashes(dir).inputs;
  commit(dir, { "src/b.ts": "export const b = () => 2;\n" }, "edit b");
  const after_ = hashes(dir).inputs;
  assert.notEqual(after_["src/a.test.ts"], before["src/a.test.ts"], "a.test → a → b: two hops away, still an input");
  assert.equal(after_["src/c.test.ts"], before["src/c.test.ts"]);
});

test("editing a GLOBAL input (the lockfile) moves every hash in the lane", () => {
  const dir = repo("edit-lockfile", BASE);
  const before = hashes(dir).inputs;
  commit(dir, { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n# bumped\n" }, "bump");
  const after_ = hashes(dir).inputs;
  assert.notEqual(after_["src/a.test.ts"], before["src/a.test.ts"]);
  assert.notEqual(after_["src/c.test.ts"], before["src/c.test.ts"], "a dependency bump can change what any test imports");
});

test("editing a declared setup file moves every hash, though nothing imports it", () => {
  const dir = repo("edit-setup", BASE);
  const before = hashes(dir).inputs;
  commit(dir, { "src/setup.ts": "export const setup = 2;\n" }, "setup");
  const after_ = hashes(dir).inputs;
  assert.notEqual(after_["src/c.test.ts"], before["src/c.test.ts"], "a runner reads its setup file by path, not by import");
});

test("a mode change alone moves the hash", () => {
  const dir = repo("chmod", BASE);
  const before = hashes(dir).inputs;
  chmodSync(join(dir, "src/b.ts"), 0o755);
  git(dir, "add", "--chmod=+x", "--", "src/b.ts");
  git(dir, "commit", "-qm", "chmod");
  assert.notEqual(hashes(dir).inputs["src/a.test.ts"], before["src/a.test.ts"]);
});

test("a NEW import in the closure moves the hash", () => {
  const dir = repo("new-import", BASE);
  const before = hashes(dir).inputs;
  commit(dir, { "src/b.ts": 'import { c } from "./c";\nexport const b = () => c;\n' }, "b imports c");
  assert.notEqual(hashes(dir).inputs["src/a.test.ts"], before["src/a.test.ts"]);
});

// ── must NOT move ───────────────────────────────────────────────────────────

test("an unrelated source file, a type-only import's target and a docs file do not move the hash", () => {
  const dir = repo("unrelated", BASE);
  const before = hashes(dir).inputs;
  commit(
    dir,
    {
      "src/c.ts": "export const c = 4;\n",
      "src/types.ts": "export interface Shape { x: number; y: number }\n",
      "README.md": "# changed\n",
    },
    "unrelated",
  );
  const after_ = hashes(dir).inputs;
  assert.equal(after_["src/a.test.ts"], before["src/a.test.ts"], "a.test does not reach c, and a type import is erased");
  assert.notEqual(after_["src/c.test.ts"], before["src/c.test.ts"], "c.test does reach c");
});

test("the same tree hashes the same across two independently built repos", () => {
  const a = hashes(repo("twin-a", BASE)).inputs;
  const b = hashes(repo("twin-b", BASE)).inputs;
  assert.deepEqual(a, b, "content only — never commit shas, history or paths on disk");
});

// ── never a hash ────────────────────────────────────────────────────────────

test("a test whose closure reaches an unresolvable import gets null, never a hash", () => {
  const dir = repo("blind", { ...BASE, "src/b.ts": 'import { gone } from "./missing";\nexport const b = () => gone;\n' });
  const { inputs, stats } = hashes(dir);
  assert.equal(inputs["src/a.test.ts"], null, "a → b → ./missing: no bounded set of inputs");
  assert.match(String(inputs["src/c.test.ts"]), /^[0-9a-f]{64}$/, "c is unaffected by a's hole");
  assert.equal(stats.unbounded, 1);
});

test("a closure file the tree does not track yields null", () => {
  const dir = repo("untracked", BASE);
  // Present on disk, so the graph sees it, but never committed.
  writeFileSync(join(dir, "src/b.ts"), 'import { d } from "./d";\nexport const b = () => d;\n');
  writeFileSync(join(dir, "src/d.ts"), "export const d = 1;\n");
  const { inputs } = hashes(dir);
  assert.equal(inputs["src/a.test.ts"], null, "an untracked file is not a stable input");
});

test("a global that matches no tracked path contributes nothing, and says so in the stats", () => {
  const dir = repo("no-global", BASE);
  const files = listSourceFiles(dir, ["src"]);
  const { edges } = buildGraph(dir, files, { packages: new Map(), aliases: [] });
  const { stats } = testInputs({ tests: ["src/c.test.ts"], edges, globals: [/^nope\.json$/], tree: treeIndex(dir) });
  assert.equal(stats.globals, 0, "the consumer's own tests must pin each real global as moving the hash");
});

// ── Routed inputs: a file a suite reads off disk ────────────────────────────
// The plan config routes a committed file no module imports to the suite that
// reads it with `readFileSync` (a manifest, a YAML, a ledger). Selection sees
// it through the route; the closure never does — so without this the suite
// would be skipped on the tree that changed the very file it asserts over.

const ROUTED = {
  ...BASE,
  "public/manifest.webmanifest": '{"id":"/"}\n',
  "src/manifest.test.ts": 'import { readFileSync } from "node:fs";\nreadFileSync("public/manifest.webmanifest");\n',
};
const ROUTES = [{ match: /^public\/manifest\.webmanifest$/, entries: ["src/manifest.test.ts"] }];

function routedHashes(dir) {
  const files = listSourceFiles(dir, ["src"]);
  const { edges, unresolved } = buildGraph(dir, files, { packages: new Map(), aliases: [] });
  const tests = files.filter((f) => /\.test\.ts$/.test(f)).sort();
  return testInputs({ tests, edges, blind: [...new Set(unresolved.map((u) => u.file))], globals: GLOBALS, routes: ROUTES, tree: treeIndex(dir) }).inputs;
}

test("a routed file moves the hash of the suite it is routed to — and of no other", () => {
  const dir = repo("routed", ROUTED);
  const before = routedHashes(dir);
  commit(dir, { "public/manifest.webmanifest": '{"id":"/app"}\n' }, "manifest");
  const after = routedHashes(dir);
  assert.notEqual(after["src/manifest.test.ts"], before["src/manifest.test.ts"], "the suite reads the file — it is an input");
  assert.equal(after["src/a.test.ts"], before["src/a.test.ts"], "a suite the route does not name is untouched");
  assert.equal(after["src/c.test.ts"], before["src/c.test.ts"]);
});

test("a route whose entry is only REACHED by the suite (through an import) still counts", () => {
  const dir = repo("routed-via", {
    ...ROUTED,
    "src/reads.ts": 'import { readFileSync } from "node:fs";\nexport const read = () => readFileSync("public/manifest.webmanifest");\n',
    "src/via.test.ts": 'import { read } from "./reads";\nread();\n',
  });
  const routes = [{ match: /^public\/manifest\.webmanifest$/, entries: ["src/reads.ts"] }];
  const files = listSourceFiles(dir, ["src"]);
  const graph = buildGraph(dir, files, { packages: new Map(), aliases: [] });
  const tests = files.filter((f) => /\.test\.ts$/.test(f)).sort();
  const run = () => testInputs({ tests, edges: graph.edges, blind: [], globals: GLOBALS, routes, tree: treeIndex(dir) }).inputs;
  const before = run();
  commit(dir, { "public/manifest.webmanifest": '{"id":"/x"}\n' }, "manifest");
  const after = run();
  assert.notEqual(after["src/via.test.ts"], before["src/via.test.ts"], "the reader is in the closure, so what it reads is an input");
  assert.equal(after["src/a.test.ts"], before["src/a.test.ts"]);
});

test("routes without a static entry, or matching nothing tracked, change no hash", () => {
  const dir = repo("routed-none", ROUTED);
  const plain = routedHashes(dir);
  const files = listSourceFiles(dir, ["src"]);
  const { edges } = buildGraph(dir, files, { packages: new Map(), aliases: [] });
  const tests = files.filter((f) => /\.test\.ts$/.test(f)).sort();
  const withNoise = testInputs({
    tests, edges, blind: [], globals: GLOBALS, tree: treeIndex(dir),
    routes: [...ROUTES, { match: /^nowhere\//, entries: ["src/a.test.ts"] }, { match: /^src\//, entries: [] }, { command: "x" }],
  }).inputs;
  assert.deepEqual(withNoise, plain);
});

// ── F3b: a module global carries its own imports ──────────────────────────────

test("F3b: a helper the setup file imports moves every hash, though no test imports it", () => {
  const dir = repo("global-closure", {
    "src/setup.ts": 'import { client } from "./query-client";\nbeforeEach(() => client.clear());\n',
    "src/query-client.ts": "export const client = { clear() {} };\n",
    "src/a.ts": "export const a = 1;\n",
    "src/a.test.ts": 'import { a } from "./a";\n',
    "src/b.test.ts": "export {};\n",
  });
  const before = hashes(dir);
  assert.ok(before.inputs["src/a.test.ts"] && before.inputs["src/b.test.ts"], "both hashed");
  commit(dir, { "src/query-client.ts": "export const client = { clear() { throw new Error('x'); } };\n" }, "helper");
  const after = hashes(dir);
  assert.notEqual(after.inputs["src/a.test.ts"], before.inputs["src/a.test.ts"], "the setup runs the helper before every case");
  assert.notEqual(after.inputs["src/b.test.ts"], before.inputs["src/b.test.ts"]);
  // Report the complete global dependency closure that the hashes include.
  assert.deepEqual(after.globalFiles, ["src/query-client.ts", "src/setup.ts"]);
});

test("F3b: a module global the graph does not hold, or whose closure is blind, withholds EVERY hash", () => {
  const outside = repo("global-outside", {
    "tests/setup.ts": "globalThis.x = 1;\n",
    "src/a.test.ts": "export {};\n",
  });
  const files = listSourceFiles(outside, ["src"]);
  const { edges } = buildGraph(outside, files, { packages: new Map(), aliases: [] });
  const report = testInputs({ tests: ["src/a.test.ts"], edges, globals: [/^tests\/setup\.ts$/], tree: treeIndex(outside) });
  assert.equal(report.inputs["src/a.test.ts"], null);
  assert.match(report.stats.globalsUnbounded, /graph does not hold/);

  const blind = repo("global-blind", {
    "src/setup.ts": 'import "./missing";\n',
    "src/a.test.ts": "export {};\n",
  });
  const b = hashes(blind);
  assert.equal(b.inputs["src/a.test.ts"], null);
  assert.match(b.stats.globalsUnbounded, /did not resolve/);
});
