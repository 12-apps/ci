/**
 * A dynamic `import()` inside a function body belongs to that function, not to
 * its module's load (FUT-5471, gap 1).
 *
 * The call runs when the function runs. Reading it as a wildcard edge of the
 * whole file made every load-time initializer of the importer an observer of
 * the change (`initializationMayObserve("*")`), so a `new Map()` or a logger at
 * the top of the importer turned one changed export of the target into a
 * module-evaluation effect that crossed every importer of the importer. In a
 * consumer that was ~1245 unit and ~764 integration files, through a job module
 * every door imports only to enqueue.
 *
 * Each narrowing below has a counterexample that must still widen: a dynamic
 * import at the top level IS a load-time edge, and so is one inside a function
 * that load-time code calls.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseImports } from "../lib/modules.mjs";
import { selectAffected } from "../lib/select.mjs";

function scenario({ head, base = {} }) {
  const root = mkdtempSync(join(tmpdir(), "affected-dynamic-"));
  for (const [path, body] of Object.entries(head)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return { root, readBase: (file) => base[file] ?? null };
}

const run = (options) =>
  selectAffected({ roots: ["src"], workspaceDirs: [], isTest: (f) => /\.test\.ts$/.test(f), ...options });

const TARGET = "export function a(): number {\n  return 1;\n}\nexport function b(): number {\n  return 2;\n}\n";
const TARGET_A = TARGET.replace("return 1;", "return 10;");
const TARGET_B = TARGET.replace("return 2;", "return 20;");

/** The importer: a load-time initializer beside a function that imports lazily. */
const lazy = (body) => `const cache = new Map<string, number>();

export async function useTarget(): Promise<number> {
${body}
}

export function unrelated(): number {
  return 1;
}
`;

const TESTS = {
  "src/use-target.test.ts": 'import { useTarget } from "./lazy";\nuseTarget();\n',
  "src/unrelated.test.ts": 'import { unrelated } from "./lazy";\nunrelated();\n',
};

function plan(lazySource, targetHead, { extra = {}, targetBase = TARGET } = {}) {
  const { root, readBase } = scenario({
    head: { "src/target.ts": targetHead, "src/lazy.ts": lazySource, ...TESTS, ...extra },
    base: { "src/target.ts": targetBase },
  });
  return run({ repoRoot: root, changed: ["src/target.ts"], readBase });
}

test("an import() inside a function reaches only the readers of that function", () => {
  const result = plan(lazy('  const { a } = await import("./target");\n  return a() + cache.size;'), TARGET_A);
  assert.deepEqual(result.tests, ["src/use-target.test.ts"]);
  assert.deepEqual([...result.affected.get("src/lazy.ts")], ["useTarget"]);
});

test("an import() inside a function that reads only an unchanged name reaches nothing", () => {
  // Like `import { a } from "./target"` when only `b` moved.
  const result = plan(lazy('  const { a } = await import("./target");\n  return a() + cache.size;'), TARGET_B);
  assert.equal(result.mode, "none");
  assert.deepEqual(result.tests, []);
});

test("the target's own load-time change reaches the enclosing function, not the importer's load", () => {
  const base = `${TARGET}globalThis.seen = 1;\n`;
  const head = `${TARGET}globalThis.seen = 2;\n`;
  const result = plan(lazy('  const { a } = await import("./target");\n  return a() + cache.size;'), head, { targetBase: base });
  assert.deepEqual(result.tests, ["src/use-target.test.ts"]);
});

test("a namespace read inside the function still reaches the function on any change", () => {
  // `mod.b()` is not a name list this reader takes: any change to the target
  // reaches the function — but still only the function.
  const result = plan(lazy('  const mod = await import("./target");\n  return mod.b() + cache.size;'), TARGET_A);
  assert.deepEqual(result.tests, ["src/use-target.test.ts"]);
});

test("the `(await import())` member and `.then(({ … }) =>` forms are read as names too", () => {
  const member = plan(lazy('  return (await import("./target")).a() + cache.size;'), TARGET_B);
  assert.deepEqual(member.tests, [], "reads `a`, `b` moved");
  const then = plan(lazy('  return import("./target").then(({ b: other }) => other() + cache.size);'), TARGET_A);
  assert.deepEqual(then.tests, [], "reads `b`, `a` moved");
  const thenHit = plan(lazy('  return import("./target").then(({ a }) => a() + cache.size);'), TARGET_A);
  assert.deepEqual(thenHit.tests, ["src/use-target.test.ts"]);
});

test("COUNTEREXAMPLE: a top-level import() is a load-time edge — every importer runs", () => {
  const source = `import("./target");\n${lazy("  return cache.size;")}`;
  const result = plan(source, TARGET_A);
  assert.deepEqual(result.tests, ["src/unrelated.test.ts", "src/use-target.test.ts"]);
});

test("COUNTEREXAMPLE: a top-level destructuring import() of the changed name still widens", () => {
  const source = `const { a } = await import("./target");\n${lazy("  return a() + cache.size;")}`;
  const result = plan(source, TARGET_A);
  assert.deepEqual(result.tests, ["src/unrelated.test.ts", "src/use-target.test.ts"]);
});

test("COUNTEREXAMPLE: a function that load-time code calls is a load-time edge", () => {
  const called = `${lazy('  const { a } = await import("./target");\n  return a() + cache.size;')}void useTarget();\n`;
  assert.deepEqual(plan(called, TARGET_A).tests, ["src/unrelated.test.ts", "src/use-target.test.ts"]);
  // Handed to a call at load: the callee may run it then, so it widens too.
  const handed = `${lazy('  const { a } = await import("./target");\n  return a() + cache.size;')}export const job = register({ run: () => useTarget() });\n`;
  const result = plan(handed, TARGET_A, { extra: { "src/register.ts": "export const register = (x: unknown) => x;\n" } });
  assert.deepEqual(result.tests, ["src/unrelated.test.ts", "src/use-target.test.ts"]);
});

test("COUNTEREXAMPLE: an import() inside a non-inert initializer keeps the old wide reading", () => {
  // `defineJob({ handle: async () => … import() … })` runs `defineJob` at load,
  // and nothing here proves it does not call the handler then.
  const source = `${lazy("  return cache.size;")}export const job = defineJob({ handle: async () => (await import("./target")).a() });\nfunction defineJob<T>(x: T): T {\n  return x;\n}\n`;
  const result = plan(source, TARGET_A);
  assert.deepEqual(result.tests, ["src/unrelated.test.ts", "src/use-target.test.ts"]);
});

test("parseImports records the names a dynamic import reads, and nothing when it cannot tell", () => {
  const reads = (code) => parseImports(code).find((r) => r.dynamic)?.reads;
  assert.deepEqual(reads('async function f() {\n  const { a, b: c, d = 1 } = await import("./x");\n}\n'), ["a", "b", "d"]);
  assert.deepEqual(reads('async function f() {\n  return (await import("./x")).a();\n}\n'), ["a"]);
  assert.deepEqual(reads('const f = () => import("./x").then(({ a }) => a);\n'), ["a"]);
  assert.equal(reads('async function f() {\n  return wrap(await import("./x")).a;\n}\n'), undefined, "wrap() was handed the whole module");
  assert.equal(reads('async function f() {\n  const { ...rest } = await import("./x");\n}\n'), undefined);
  assert.equal(reads('async function f() {\n  const { default: X } = await import("./x");\n}\n'), undefined);
  assert.equal(reads('async function f() {\n  const { a } = await import("./x").then((m) => m);\n}\n'), undefined);
  assert.equal(reads('async function f() {\n  const mod = await import("./x");\n}\n'), undefined);
  assert.equal(reads('async function f() {\n  const { a } = await import("./x")\n  (go)();\n}\n'), undefined, "no `;`: ASI may join the next line");
  // Every dynamic record stays a wildcard: callers that know nothing of `reads` keep the old reading.
  assert.equal(parseImports('async function f() {\n  const { a } = await import("./x");\n}\n')[0].wildcard, true);
});

test("an import() inside a function exported under an alias reaches the importers of the alias", () => {
  // FUT-5471 review B1: the scoped hop marked the LOCAL name, and no importer binds `load`.
  const go = { "src/go.test.ts": 'import { go } from "./aliased";\ngo();\n' };
  const fn = 'async function load(): Promise<number> {\n  const { a } = await import("./target");\n  return a();\n}\nexport { load as go };\n';
  assert.ok(plan(lazy("  return cache.size;"), TARGET_A, { extra: { "src/aliased.ts": fn, ...go } }).tests.includes("src/go.test.ts"));
  const arrow = 'const load = async (): Promise<number> => {\n  const { a } = await import("./target");\n  return a();\n};\nexport { load as go };\n';
  assert.ok(plan(lazy("  return cache.size;"), TARGET_A, { extra: { "src/aliased.ts": arrow, ...go } }).tests.includes("src/go.test.ts"));
  const multiline = `${fn.replace("export { load as go };\n", "export {\n  load as go,\n};\n")}`;
  assert.ok(plan(lazy("  return cache.size;"), TARGET_A, { extra: { "src/aliased.ts": multiline, ...go } }).tests.includes("src/go.test.ts"));
});

test("a STATIC import used in an aliased function reaches the importers of the alias too", () => {
  // The same defect, older than FUT-5471: the ordinary hop lost the alias as well.
  const source = 'import { a } from "./target";\nfunction load(): number {\n  return a();\n}\nexport { load as go };\n';
  const result = plan(lazy("  return cache.size;"), TARGET_A, {
    extra: { "src/aliased.ts": source, "src/go.test.ts": 'import { go } from "./aliased";\ngo();\n' },
  });
  assert.ok(result.tests.includes("src/go.test.ts"), result.tests.join(","));
  // An imported binding re-exported under another name, with no declaration behind it.
  const passOn = plan(lazy("  return cache.size;"), TARGET_A, {
    extra: {
      "src/pass-on.ts": 'import { a } from "./target";\nexport { a as renamed };\nexport const other = () => 1;\n',
      "src/renamed.test.ts": 'import { renamed } from "./pass-on";\nrenamed();\n',
      "src/other.test.ts": 'import { other } from "./pass-on";\nother();\n',
    },
  });
  assert.ok(passOn.tests.includes("src/renamed.test.ts"), passOn.tests.join(","));
  assert.equal(passOn.tests.includes("src/other.test.ts"), false);
});
