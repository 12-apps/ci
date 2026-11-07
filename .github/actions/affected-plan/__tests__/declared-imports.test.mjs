// FUT-4564: `lanes.<lane>.declaredImports` lets a consumer declare what ONE
// computed `import()` loads. Undeclared, it is a blind dependency and every
// test reaching its file has no hash (future-pay: 889 unit tests behind
// `engine-import.ts:59`). The declaration must be explicit and narrow, and
// these are its counterexamples:
//   - a second computed import in the same file is NOT covered;
//   - a declaration whose call site moved, or whose argument changed, or whose
//     target is missing, FAILS the plan rather than answering for other code;
//   - with no declaration, nothing changes: the file stays blind.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { testInputs } from "../lib/inputs.mjs";
import { buildGraph, callArgument, checkDeclaredImports, parseImports } from "../lib/modules.mjs";

const root = mkdtempSync(join(tmpdir(), "declared-imports-"));
after(() => rmSync(root, { recursive: true, force: true }));
const CLI = fileURLToPath(new URL("../plan.mjs", import.meta.url));

const put = (repo, path, body) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
};
const LOADER = [
  "export function load(url) {",
  "  return import(/* @vite-ignore */ url);",
  "}",
  'export const engine = () => import("./engine");',
  "",
].join("\n");
const fixture = (name, loader = LOADER) => {
  const repo = join(root, name);
  put(repo, "src/engine.mjs", "export const run = () => 1;\n");
  put(repo, "src/loader.mjs", loader);
  put(repo, "src/a.test.mjs", 'import { load } from "./loader.mjs";\nconsole.log(load);\n');
  return repo;
};
const DECL = { file: "src/loader.mjs", line: 2, expression: "url", targets: ["src/engine.mjs"] };

test("the argument text is what a declaration names: comments and whitespace dropped", () => {
  assert.deepEqual(parseImports(LOADER).filter((i) => i.unbounded).map((i) => [i.line, i.expression]), [[2, "url"]]);
  const src = "import( /* x */ pathToFileURL(join(root, e.file)).href // y\n)";
  assert.equal(callArgument(src, src.indexOf("(") + 1), "pathToFileURL(join(root, e.file)).href");
  assert.equal(callArgument("import(never closed", 7), null);
});

test("undeclared, the computed import stays blind; declared, it is an edge to exactly its target", () => {
  const repo = fixture("graph");
  const files = ["src/a.test.mjs", "src/loader.mjs", "src/engine.mjs"];
  const blind = buildGraph(repo, files);
  assert.deepEqual(blind.unresolved.map((u) => [u.file, u.line]), [["src/loader.mjs", 2]]);
  const seen = buildGraph(repo, files, { declaredImports: [DECL] });
  assert.deepEqual(seen.unresolved, []);
  const edge = seen.edges.get("src/loader.mjs").find((e) => e.declared);
  assert.deepEqual([edge.target, edge.terminal, edge.line], ["src/engine.mjs", true, 2]);
});

test("counterexample: a SECOND computed import in the declared file is not covered — it stays blind", () => {
  const repo = fixture("second", `${LOADER}export const other = (p) => import(p);\n`);
  const files = ["src/a.test.mjs", "src/loader.mjs", "src/engine.mjs"];
  const { unresolved } = buildGraph(repo, files, { declaredImports: [DECL] });
  assert.deepEqual(unresolved.map((u) => [u.file, u.line]), [["src/loader.mjs", 5]]);
});

test("counterexample: a declaration that no longer matches its call site, or names a missing target, is refused", () => {
  const repo = fixture("check");
  assert.deepEqual(checkDeclaredImports(repo, [DECL]), []);
  assert.deepEqual(checkDeclaredImports(repo, undefined), []);
  const moved = checkDeclaredImports(repo, [{ ...DECL, line: 3 }]);
  assert.match(moved[0], /no computed import `url` at src\/loader\.mjs:3 \(computed imports there: 2: url\)/);
  assert.match(checkDeclaredImports(repo, [{ ...DECL, expression: "other" }])[0], /no computed import `other`/);
  assert.match(checkDeclaredImports(repo, [{ ...DECL, targets: ["src/gone.mjs"] }])[0], /target src\/gone\.mjs does not exist/);
  assert.match(checkDeclaredImports(repo, [{ file: "src/loader.mjs", line: 2 }])[0], /needs \{ file, line, expression, targets/);
  assert.match(checkDeclaredImports(repo, [{ ...DECL, targets: [] }])[0], /needs/);
  assert.match(checkDeclaredImports(repo, [DECL, DECL])[0], /twice/);
  assert.match(checkDeclaredImports(repo, "nope")[0], /must be an array/);
  // The call moves down one line: the same declaration is now stale.
  put(repo, "src/loader.mjs", `// a new first line\n${LOADER}`);
  assert.equal(checkDeclaredImports(repo, [DECL]).length, 1);
});

test("a test reaching a declared computed import gets a hash; undeclared, it gets none", () => {
  const repo = fixture("inputs");
  const files = ["src/a.test.mjs", "src/loader.mjs", "src/engine.mjs"];
  const tree = new Map(files.map((f, i) => [f, `100644 ${i}`]));
  const hashOf = (declaredImports) => {
    const g = buildGraph(repo, files, { declaredImports });
    return testInputs({ tests: ["src/a.test.mjs"], edges: g.edges, blind: g.unresolved.map((u) => u.file), tree }).inputs["src/a.test.mjs"];
  };
  assert.equal(hashOf([]), null);
  const h = hashOf([DECL]);
  assert.match(String(h), /^[0-9a-f]{64}$/);
  // The declared target is an input: its change moves the hash.
  tree.set("src/engine.mjs", "100644 changed");
  assert.notEqual(hashOf([DECL]), h);
});

test("plan.mjs: a declared import un-blinds the test; a stale declaration fails the plan loudly", () => {
  const repo = fixture("cli");
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const config = (declaredImports) => JSON.stringify({
    workspaces: [], sourceRoots: ["src"],
    lanes: { unit: { roots: ["src"], test: "\\.test\\.mjs$", ignore: "^\\.affected-plan\\.json$", skipGreen: { globals: [] }, ...(declaredImports ? { declaredImports } : {}) } },
  });
  put(repo, ".affected-plan.json", config(null));
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  put(repo, "src/engine.mjs", "export const run = () => 2;\n");
  const plan = (declaredImports) => {
    put(repo, ".affected-plan.json", config(declaredImports));
    git("add", ".");
    git("commit", "-qm", "change", "--allow-empty");
    const r = spawnSync(process.execPath, [CLI, "--lane", "unit", "--base", base, "--out", join(root, "cli-plan.json")], {
      cwd: repo, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: "" },
    });
    return { code: r.status, stderr: r.stderr, plan: r.status === 0 ? JSON.parse(readFileSync(join(root, "cli-plan.json"), "utf8")) : null };
  };
  const undeclared = plan(null);
  assert.equal(undeclared.code, 0, undeclared.stderr);
  assert.equal(undeclared.plan.inputs?.["src/a.test.mjs"] ?? null, null, "blind: no hash");
  const declared = plan([DECL]);
  assert.equal(declared.code, 0, declared.stderr);
  assert.match(String(declared.plan.inputs["src/a.test.mjs"]), /^[0-9a-f]{64}$/);
  const stale = plan([{ ...DECL, line: 1 }]);
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /::error::affected-plan \(unit\): 1 declaredImports problem/);
});
