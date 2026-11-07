// FUT-4564: a declared computed import may load only an INSTALLED package's
// files (`external`), as future-pay's card-editor test harness does with
// @12-apps/ui's lazy chunks (apps/admin/…/card-editor-harness.tsx:873). It
// adds no edge and leaves nothing blind, so it is sound only when the lockfile
// stands for the package's bytes. Counterexamples:
//   - the lane's skipGreen.globals do not cover the lockfile → refused;
//   - the package is not a dependency of the declaring file's workspace → refused;
//   - an entry with both targets and external, or neither → refused;
//   - an external entry still matches ONE call site, never another.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { testInputs } from "../lib/inputs.mjs";
import { buildGraph, checkDeclaredImports } from "../lib/modules.mjs";

const root = mkdtempSync(join(tmpdir(), "declared-external-"));
after(() => rmSync(root, { recursive: true, force: true }));
const put = (repo, path, body) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
};
const HARNESS = 'export const load = (dir, file) => import(/* @vite-ignore */ path.join(dir, file));\n';
const repo = join(root, "repo");
put(repo, "pnpm-lock.yaml", "lockfileVersion: 9\n");
put(repo, "apps/admin/package.json", JSON.stringify({ name: "admin", devDependencies: { "@12-apps/ui": "6.100.0" } }));
put(repo, "apps/admin/src/__tests__/harness.tsx", HARNESS);
put(repo, "apps/admin/src/__tests__/a.test.tsx", 'import { load } from "./harness.tsx";\nconsole.log(load);\n');
const DECL = { file: "apps/admin/src/__tests__/harness.tsx", line: 1, expression: "path.join(dir, file)", external: "@12-apps/ui" };
const LOCK = [/^pnpm-lock\.yaml$/];

test("an external declaration is accepted with the lockfile a global and the package a workspace dependency", () => {
  assert.deepEqual(checkDeclaredImports(repo, [DECL], { globals: LOCK }), []);
});

test("counterexample: refused when the lane's globals do not cover the lockfile", () => {
  const [problem] = checkDeclaredImports(repo, [DECL], { globals: [/^package\.json$/] });
  assert.match(problem, /unsound here — the lane's skipGreen\.globals do not cover pnpm-lock\.yaml/);
  assert.equal(checkDeclaredImports(repo, [DECL]).length, 1, "no globals at all: refused too");
});

test("counterexample: refused when the package is not a dependency of the declaring workspace", () => {
  const [problem] = checkDeclaredImports(repo, [{ ...DECL, external: "left-pad" }], { globals: LOCK });
  assert.match(problem, /left-pad is not a dependency of apps\/admin\/package\.json/);
  assert.match(checkDeclaredImports(repo, [{ ...DECL, external: "Not A Name" }], { globals: LOCK }).join(" "), /not a package name/);
});

test("counterexample: exactly one of targets or external", () => {
  assert.match(checkDeclaredImports(repo, [{ ...DECL, targets: ["apps/admin/package.json"] }], { globals: LOCK })[0], /exactly one of/);
  const { external: _e, ...neither } = DECL;
  assert.match(checkDeclaredImports(repo, [neither], { globals: LOCK })[0], /exactly one of/);
});

test("declared external: the call is no longer blind and adds no edge; another computed import stays blind", () => {
  const files = ["apps/admin/src/__tests__/a.test.tsx", "apps/admin/src/__tests__/harness.tsx"];
  assert.equal(buildGraph(repo, files).unresolved.length, 1);
  const g = buildGraph(repo, files, { declaredImports: [DECL] });
  assert.deepEqual(g.unresolved, []);
  assert.deepEqual(g.edges.get("apps/admin/src/__tests__/harness.tsx"), [], "no edge: the package's files are not repo inputs");
  const tree = new Map([...files, "pnpm-lock.yaml"].map((f, i) => [f, `100644 ${i}`]));
  const hash = (t) => testInputs({ tests: [files[0]], edges: g.edges, blind: [], globals: LOCK, tree: t }).inputs[files[0]];
  const h = hash(tree);
  assert.match(String(h), /^[0-9a-f]{64}$/);
  assert.notEqual(hash(new Map([...tree, ["pnpm-lock.yaml", "100644 bumped"]])), h, "a package bump moves the hash through the lockfile");
  put(repo, "apps/admin/src/__tests__/harness.tsx", `${HARNESS}export const other = (p) => import(p);\n`);
  assert.deepEqual(buildGraph(repo, files, { declaredImports: [DECL] }).unresolved.map((u) => u.line), [2]);
  put(repo, "apps/admin/src/__tests__/harness.tsx", HARNESS);
});
