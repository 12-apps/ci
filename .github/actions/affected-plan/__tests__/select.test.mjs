/**
 * Selection guards — the propagation rule and, more importantly, every route
 * that must WIDEN.
 *
 * A selector has two failure modes and they are not symmetric. Running too much
 * costs minutes. Running too little produces a green check on untested code,
 * which is indistinguishable from a green check on tested code and is therefore
 * never noticed. So the widening paths (an unresolved import, an unparseable
 * declaration) get as much coverage here as the narrowing the whole thing
 * exists to do — and the one path that no longer widens, an UNCLASSIFIED file,
 * is pinned to stop the run in red rather than pass quietly.
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

test("an unresolved import widens the FILE that owns it, not the run", () => {
  // `broken.ts` imports something that does not exist, so what it depends on is
  // unknown and it must be assumed to depend on everything. That is a claim
  // about one file. Widening the whole run on it is equally safe and is how a
  // selector quietly stops selecting: one odd file disables narrowing for every
  // diff, and the only symptom is a slow lane.
  const { root, readBase } = scenario({
    head: {
      "src/entry.ts": "export const a = 2;\n",
      "src/broken.ts": 'import { gone } from "./does-not-exist";\nexport const x = gone;\n',
      "src/broken.test.ts": 'import { x } from "./broken";\nx;\n',
      "src/x.test.ts": 'import { a } from "./entry";\na;\n',
      "src/unrelated.ts": "export const u = 1;\n",
      "src/unrelated.test.ts": 'import { u } from "./unrelated";\nu;\n',
    },
    base: { "src/entry.ts": "export const a = 1;\n" },
  });
  const result = run({ repoRoot: root, changed: ["src/entry.ts"], readBase });

  assert.equal(result.mode, "narrowed", "one hole must not cost the whole suite");
  // The file with the hole runs, and so does the test that imports it —
  // conservative, because nobody can say what that edge reached.
  assert.ok(result.tests.includes("src/broken.test.ts"), result.tests.join(", "));
  // The genuinely affected test still runs...
  assert.ok(result.tests.includes("src/x.test.ts"), result.tests.join(", "));
  // ...and a test reaching neither is still dropped. That is the whole point:
  // the hole is bounded.
  assert.ok(!result.tests.includes("src/unrelated.test.ts"), result.tests.join(", "));
  assert.equal(result.stats.blindFiles, 1);
  assert.match(result.why, /imports cannot be resolved/);
});

test("a hole cannot resurrect `none` — nothing changed, nothing runs", () => {
  // The blind file is only ever a claim about REACHABILITY. With no changed
  // symbol anywhere there is nothing for it to have reached, and a lane that
  // ran it anyway would be paying for a graph defect on every green diff.
  const { root, readBase } = scenario({
    head: {
      "src/entry.ts": "export const a = 1;\n",
      "src/broken.ts": 'import { gone } from "./does-not-exist";\nexport const x = gone;\n',
      "src/broken.test.ts": 'import { x } from "./broken";\nx;\n',
    },
    base: { "src/entry.ts": "export const a = 1; // only a comment moved\n" },
  });
  const result = run({ repoRoot: root, changed: ["src/entry.ts"], readBase });
  assert.equal(result.mode, "none", result.why);
  assert.deepEqual(result.tests, []);
});

test("import syntax quoted INSIDE a string literal is not an edge", () => {
  // A suite that asserts on another file's source writes import syntax as data.
  // Read as code it is a dynamic import from the asserting file's own
  // directory, which does not exist — so it reported as an unresolved edge and,
  // before the fix above, made every plan in the consumer repo say `full`.
  const { root, readBase } = scenario({
    head: {
      "src/entry.ts": "export const a = 2;\n",
      "src/shell/lazy.ts": "export const lazy = 1;\n",
      "src/asserts-source.test.ts":
        'const chip = "x";\n' +
        'expect(chip).toContain(\'import("./lazy")\');\n' +
        "// eslint-disable-next-line\n" +
        'const also = `require(\"./lazy\")`;\n' +
        "also;\n",
      "src/x.test.ts": 'import { a } from "./entry";\na;\n',
    },
    base: { "src/entry.ts": "export const a = 1;\n" },
  });
  const result = run({ repoRoot: root, changed: ["src/entry.ts"], readBase });
  assert.equal(result.mode, "narrowed", result.why);
  assert.equal(result.stats.blindFiles, 0, "a quoted specifier is data, not an import");
  assert.deepEqual(result.tests, ["src/x.test.ts"]);
});

test("an unclassified path stops the plan instead of buying the whole suite", () => {
  const { root, readBase } = scenario({ head: { "src/x.test.ts": "" } });
  const result = run({
    repoRoot: root,
    changed: ["package.json"],
    readBase,
    isSource: (f) => f !== "package.json",
  });
  assert.equal(result.mode, "unclassified");
  assert.deepEqual(result.unclassified, ["package.json"]);
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
  assert.ok(["none", "narrowed"].includes(result.mode));
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

// --- hop two is narrowed too -----------------------------------------------
// Hop one was always symbol-precise; hop two marked the whole importer, and
// every hop after it inherited that. These pin the narrowing end to end and,
// more importantly, the routes where it must still widen.

test("an intermediate file only carries the change through the exports that see it", () => {
  // `middle.ts` binds the changed symbol but only ONE of its exports uses it.
  // The test that reaches `middle` through the other export cannot observe the
  // change, and before this narrowing it ran anyway.
  const { root, readBase } = scenario({
    head: {
      "src/dep.ts": "export function moved() {\n  return 2;\n}\nexport function stable() {\n  return 0;\n}\n",
      "src/middle.ts":
        'import { moved } from "./dep";\n' +
        "export const uses = () => moved();\n" +
        "export const clean = () => 7;\n",
      "src/hot.test.ts": 'import { uses } from "./middle";\nuses();\n',
      "src/cold.test.ts": 'import { clean } from "./middle";\nclean();\n',
    },
    base: { "src/dep.ts": "export function moved() {\n  return 1;\n}\nexport function stable() {\n  return 0;\n}\n" },
  });
  assert.deepEqual(run({ repoRoot: root, changed: ["src/dep.ts"], readBase }).tests, ["src/hot.test.ts"]);
});

test("a namespace import still widens — there is no name list to narrow with", () => {
  const { root, readBase } = scenario({
    head: {
      "src/dep.ts": "export function moved() {\n  return 2;\n}\n",
      "src/middle.ts": 'import * as dep from "./dep";\nexport const uses = () => dep.moved();\nexport const clean = () => 7;\n',
      "src/cold.test.ts": 'import { clean } from "./middle";\nclean();\n',
    },
    base: { "src/dep.ts": "export function moved() {\n  return 1;\n}\n" },
  });
  assert.deepEqual(run({ repoRoot: root, changed: ["src/dep.ts"], readBase }).tests, ["src/cold.test.ts"]);
});

test("an importer the bracketer cannot read widens rather than narrowing on a guess", () => {
  // A top-level side effect can touch anything, so no claim about which of this
  // file's exports see the change is available. Widening here is the whole
  // reason the narrowing is safe to trust everywhere else.
  const { root, readBase } = scenario({
    head: {
      "src/dep.ts": "export function moved() {\n  return 2;\n}\n",
      "src/middle.ts": 'import { moved } from "./dep";\nregisterEverything(moved);\nexport const clean = () => 7;\n',
      "src/cold.test.ts": 'import { clean } from "./middle";\nclean();\n',
    },
    base: { "src/dep.ts": "export function moved() {\n  return 1;\n}\n" },
  });
  assert.deepEqual(run({ repoRoot: root, changed: ["src/dep.ts"], readBase }).tests, ["src/cold.test.ts"]);
});

test("a barrel forwards only the name it forwards", () => {
  // `export { a } from "./left"` is a reference to left's `a` and nothing else,
  // so a change in `right` must not arrive through the line naming `left`.
  const { root, readBase } = scenario({
    head: {
      "src/left.ts": "export const a = 1;\n",
      "src/right.ts": "export const b = 2;\n",
      "src/barrel.ts": 'export { a } from "./left";\nexport { b } from "./right";\n',
      "src/left.test.ts": 'import { a } from "./barrel";\na;\n',
      "src/right.test.ts": 'import { b } from "./barrel";\nb;\n',
    },
    base: { "src/right.ts": "export const b = 1;\n" },
  });
  assert.deepEqual(run({ repoRoot: root, changed: ["src/right.ts"], readBase }).tests, ["src/right.test.ts"]);
});

// ── routing a codegen input ────────────────────────────────────────────────
// `full` is right for a lockfile and wrong for a Prisma schema. These pin the
// difference, and — the half that matters — pin that routing did not become a
// way to make untraceable paths quietly disappear.

test("a routed codegen input is traced through its entry instead of reporting full", () => {
  const { root, readBase } = scenario({
    head: {
      "src/client.ts": "export function db() { return 1; }\n",
      "src/uses-db.ts": 'import { db } from "./client";\nexport const x = db();\n',
      "src/uses-db.test.ts": 'import { x } from "./uses-db";\n',
      "src/elsewhere.test.ts": 'export const untouched = 1;\n',
    },
  });
  const result = run({
    repoRoot: root,
    readBase,
    changed: ["prisma/schema.prisma"],
    routeOf: (f) => (f === "prisma/schema.prisma" ? ["src/client.ts"] : []),
    isSource: (f) => /^src\/.*\.ts$/.test(f),
  });

  assert.equal(result.mode, "narrowed", "a routed path must be traced, not escalated");
  assert.deepEqual(result.tests, ["src/uses-db.test.ts"]);
  // The reviewer has to be able to see why a file nobody edited was seeded.
  assert.deepEqual(result.routes, { "src/client.ts": ["prisma/schema.prisma"] });
});

test("an UNROUTED, unclassified path stops the plan", () => {
  const { root, readBase } = scenario({ head: { "src/a.ts": "export const a = 1;\n" } });
  const result = run({
    repoRoot: root,
    readBase,
    changed: ["pnpm-lock.yaml"],
    routeOf: () => [],
    isSource: (f) => /^src\/.*\.ts$/.test(f),
  });
  assert.equal(result.mode, "unclassified");
  assert.deepEqual(result.unclassified, ["pnpm-lock.yaml"]);
});

test("routing one path does not hide an unclassified one in the same diff", () => {
  // The dangerous composition: a diff carrying BOTH a routed input and a real
  // untraceable path must still widen. Routing removes its own path from the
  // untraceable set and nothing else.
  const { root, readBase } = scenario({ head: { "src/client.ts": "export function db() { return 1; }\n" } });
  const result = run({
    repoRoot: root,
    readBase,
    changed: ["prisma/schema.prisma", "pnpm-lock.yaml"],
    routeOf: (f) => (f === "prisma/schema.prisma" ? ["src/client.ts"] : []),
    isSource: (f) => /^src\/.*\.ts$/.test(f),
  });
  assert.equal(result.mode, "unclassified");
  assert.deepEqual(result.unclassified, ["pnpm-lock.yaml"], "routing removes its own path and nothing else");
});

test("a routed entry is seeded as fully changed, not symbol-diffed away", () => {
  // The entry file's own bytes did not move, so a symbol diff over it finds
  // nothing. If routing were seeded before the byte-identical pruning, the
  // change would be pruned and the lane would run nothing — silently.
  const { root, readBase } = scenario({
    head: {
      "src/client.ts": "export function db() { return 1; }\n",
      "src/uses-db.test.ts": 'import { db } from "./client";\n',
    },
    base: { "src/client.ts": "export function db() { return 1; }\n" },
  });
  const result = run({
    repoRoot: root,
    readBase,
    changed: ["prisma/schema.prisma"],
    routeOf: (f) => (f === "prisma/schema.prisma" ? ["src/client.ts"] : []),
    isSource: (f) => /^src\/.*\.ts$/.test(f),
  });
  assert.equal(result.tests.length, 1, `expected the importer to run, got ${JSON.stringify(result.tests)}`);
});

test("a route to an entry outside the graph selects nothing and says so", () => {
  // A typo'd entry must not read as "nothing is affected". It selects no test,
  // and `routes` names the entry — so the plan is inspectable rather than
  // quietly empty.
  const { root, readBase } = scenario({ head: { "src/a.test.ts": "export const a = 1;\n" } });
  const result = run({
    repoRoot: root,
    readBase,
    changed: ["prisma/schema.prisma"],
    routeOf: () => ["src/does-not-exist.ts"],
    isSource: (f) => /^src\/.*\.ts$/.test(f),
  });
  assert.deepEqual(result.tests, []);
  assert.deepEqual(result.routes, { "src/does-not-exist.ts": ["prisma/schema.prisma"] });
});
