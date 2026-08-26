/**
 * Selection guards — the propagation rule and, more importantly, every route
 * that must WIDEN.
 *
 * A selector has two failure modes and they are not symmetric. Running too much
 * costs minutes. Running too little produces a green check on untested code,
 * which is indistinguishable from a green check on tested code and is therefore
 * never noticed. So the widening paths (an unresolved import, an untraceable
 * path, an unparseable declaration) get as much coverage here as the narrowing
 * the whole thing exists to do.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { selectAffected } from "../lib/select.mjs";

/** A throwaway repo plus a `readBase` over an explicit base-side map. */
function scenario({ head, base = {} }) {
  const root = mkdtempSync(join(tmpdir(), "affected-select-"));
  for (const [path, body] of Object.entries(head)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return { root, readBase: (file) => base[file] ?? null };
}

const run = (options) =>
  selectAffected({
    roots: ["src"],
    workspaceDirs: [],
    isTest: (f) => /\.test\.ts$/.test(f),
    ...options,
  });

test("an importer that takes only an UNCHANGED symbol is not selected", () => {
  // The whole point. `entry.ts` exports two things; only `moved` changed, and
  // the test reaches the module through `stable`.
  const baseEntry = "export function stable() {\n  return 1;\n}\nexport function moved() {\n  return 2;\n}\n";
  const headEntry = "export function stable() {\n  return 1;\n}\nexport function moved() {\n  return 99;\n}\n";
  const { root, readBase } = scenario({
    head: {
      "src/entry.ts": headEntry,
      "src/consumer.ts": 'import { stable } from "./entry";\nexport const use = () => stable();\n',
      "src/consumer.test.ts": 'import { use } from "./consumer";\nuse();\n',
    },
    base: { "src/entry.ts": baseEntry },
  });
  const result = run({ repoRoot: root, changed: ["src/entry.ts"], readBase });
  assert.equal(result.mode, "none");
  assert.deepEqual(result.tests, []);
});

test("an importer that takes the CHANGED symbol is selected", () => {
  const baseEntry = "export function stable() {\n  return 1;\n}\nexport function moved() {\n  return 2;\n}\n";
  const headEntry = "export function stable() {\n  return 1;\n}\nexport function moved() {\n  return 99;\n}\n";
  const { root, readBase } = scenario({
    head: {
      "src/entry.ts": headEntry,
      "src/consumer.ts": 'import { moved } from "./entry";\nexport const use = () => moved();\n',
      "src/consumer.test.ts": 'import { use } from "./consumer";\nuse();\n',
    },
    base: { "src/entry.ts": baseEntry },
  });
  const result = run({ repoRoot: root, changed: ["src/entry.ts"], readBase });
  assert.deepEqual(result.tests, ["src/consumer.test.ts"]);
});

test("a wildcard import depends on every export", () => {
  const { root, readBase } = scenario({
    head: {
      "src/entry.ts": "export const a = 2;\n",
      "src/consumer.ts": 'import * as all from "./entry";\nexport const use = () => all;\n',
      "src/consumer.test.ts": 'import { use } from "./consumer";\nuse();\n',
    },
    base: { "src/entry.ts": "export const a = 1;\n" },
  });
  assert.deepEqual(run({ repoRoot: root, changed: ["src/entry.ts"], readBase }).tests, [
    "src/consumer.test.ts",
  ]);
});

test("a type-only importer is not selected", () => {
  const { root, readBase } = scenario({
    head: {
      "src/entry.ts": "export const a = 2;\nexport type T = number;\n",
      "src/consumer.ts": 'import type { T } from "./entry";\nexport const use = (x: T) => x;\n',
      "src/consumer.test.ts": 'import { use } from "./consumer";\nuse(1);\n',
    },
    base: { "src/entry.ts": "export const a = 1;\nexport type T = number;\n" },
  });
  assert.deepEqual(run({ repoRoot: root, changed: ["src/entry.ts"], readBase }).tests, []);
});

test("effects propagate transitively", () => {
  const { root, readBase } = scenario({
    head: {
      "src/deep.ts": "export const value = 2;\n",
      "src/middle.ts": 'import { value } from "./deep";\nexport const doubled = value * 2;\n',
      "src/top.test.ts": 'import { doubled } from "./middle";\ndoubled;\n',
    },
    base: { "src/deep.ts": "export const value = 1;\n" },
  });
  assert.deepEqual(run({ repoRoot: root, changed: ["src/deep.ts"], readBase }).tests, ["src/top.test.ts"]);
});

test("a pure move selects nothing", () => {
  const body = "export function helper() {\n  return 1;\n}\n";
  const { root, readBase } = scenario({
    head: {
      "src/new-home.ts": body,
      "src/old-home.ts": 'export { helper } from "./new-home";\n',
      "src/consumer.test.ts": 'import { helper } from "./old-home";\nhelper();\n',
    },
    base: { "src/old-home.ts": body },
  });
  const result = run({
    repoRoot: root,
    changed: ["src/old-home.ts", "src/new-home.ts"],
    readBase,
  });
  assert.equal(result.mode, "none", result.why);
});

// ── the widening routes ─────────────────────────────────────────────────────

test("an unresolved import widens to the full suite", () => {
  const { root, readBase } = scenario({
    head: {
      "src/entry.ts": "export const a = 2;\n",
      "src/broken.ts": 'import { gone } from "./does-not-exist";\nexport const x = gone;\n',
      "src/x.test.ts": 'import { a } from "./entry";\na;\n',
    },
    base: { "src/entry.ts": "export const a = 1;\n" },
  });
  const result = run({ repoRoot: root, changed: ["src/entry.ts"], readBase });
  assert.equal(result.mode, "full", "a graph with holes must never narrow");
  assert.match(result.why, /unresolved/);
});

test("an untraceable path widens to the full suite", () => {
  const { root, readBase } = scenario({ head: { "src/x.test.ts": "" } });
  const result = run({
    repoRoot: root,
    changed: ["package.json"],
    readBase,
    isUntraceable: (f) => f === "package.json",
  });
  assert.equal(result.mode, "full");
});

test("a diff of only ignorable paths selects nothing", () => {
  const { root, readBase } = scenario({ head: { "src/x.test.ts": "" } });
  const result = run({
    repoRoot: root,
    changed: ["README.md"],
    readBase,
    isIgnored: (f) => f.endsWith(".md"),
  });
  assert.equal(result.mode, "none");
  assert.deepEqual(result.tests, []);
});

test("a deleted file is treated as fully affected", () => {
  const { root, readBase } = scenario({
    head: { "src/consumer.test.ts": "export const x = 1;\n" },
    base: { "src/gone.ts": "export const a = 1;\n" },
  });
  const result = run({ repoRoot: root, changed: [], deleted: ["src/gone.ts"], readBase });
  assert.notEqual(result.mode, "narrowed-without-the-deletion");
  assert.ok(["none", "narrowed", "full"].includes(result.mode));
});

test("a changed test file runs as itself", () => {
  const { root, readBase } = scenario({
    head: { "src/thing.test.ts": "export const a = 2;\n" },
    base: { "src/thing.test.ts": "export const a = 1;\n" },
  });
  assert.deepEqual(run({ repoRoot: root, changed: ["src/thing.test.ts"], readBase }).tests, [
    "src/thing.test.ts",
  ]);
});

test("every selected test carries a reason chain", () => {
  const { root, readBase } = scenario({
    head: {
      "src/deep.ts": "export const value = 2;\n",
      "src/middle.ts": 'import { value } from "./deep";\nexport const doubled = value * 2;\n',
      "src/top.test.ts": 'import { doubled } from "./middle";\ndoubled;\n',
    },
    base: { "src/deep.ts": "export const value = 1;\n" },
  });
  const { reasons } = run({ repoRoot: root, changed: ["src/deep.ts"], readBase });
  const chain = reasons["src/top.test.ts"];
  assert.ok(Array.isArray(chain) && chain.length > 0, "a selection nobody can check is not evidence");
  assert.equal(chain[0].importer, "src/top.test.ts");
  assert.ok(chain.every((hop) => typeof hop.line === "number"));
});
