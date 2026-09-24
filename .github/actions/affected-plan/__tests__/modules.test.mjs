/**
 * Graph-layer guards.
 *
 * Every case here fails in the SAME direction if it regresses: an edge is
 * dropped, the graph goes quiet about a dependency, and a lane narrows past
 * the test that would have caught the bug. That failure is invisible — a green
 * run that skipped the right test looks exactly like a green run that passed
 * it — so these are not stylistic assertions. Two of them (`./surface` and
 * `./routes.generated`) are regressions that actually shipped during
 * development and were caught only by running the selector against a real
 * repository.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bindingsOf,
  buildGraph,
  isTypeOnlyClause,
  parseImports,
  resolveSpecifier,
  scan,
  stripComments,
} from "../lib/modules.mjs";

/** A throwaway repo with the given `path: contents` map. */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "affected-plan-"));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

test("an extensionless relative import is a module, not an asset", () => {
  // `./surface` has a dot in its `./` prefix. Reading that as an extension
  // classified it as an unknown asset and dropped the edge — silently, and in
  // the narrowing direction.
  const root = fixture({ "pkg/surface.ts": "export const a = 1;\n", "pkg/index.ts": "" });
  const resolved = resolveSpecifier(root, "./surface", "pkg/index.ts", {});
  assert.equal(resolved.file, "pkg/surface.ts");
  assert.notEqual(resolved.asset, true);
});

test("a dotted NAME is not an extension", () => {
  // `../routes.generated` resolves to `routes.generated.ts`. Treating
  // `.generated` as a file type dropped the edge from a generated route table
  // to every route in it.
  const root = fixture({ "server/routes.generated.ts": "export const routes = [];\n" });
  const resolved = resolveSpecifier(root, "./routes.generated", "server/x.ts", {});
  assert.equal(resolved.file, "server/routes.generated.ts");
});

test("an unknown extension resolves as a module rather than being ignored", () => {
  const root = fixture({ "a/thing.weird.ts": "export const x = 1;\n" });
  const resolved = resolveSpecifier(root, "./thing.weird", "a/b.ts", {});
  assert.equal(resolved.file, "a/thing.weird.ts");
});

test("a missing relative module is reported, never dropped", () => {
  const root = fixture({ "a/b.ts": "" });
  const resolved = resolveSpecifier(root, "./nope", "a/b.ts", {});
  assert.equal(resolved.file, null);
  assert.notEqual(resolved.asset, true, "must not be excused as an asset");
  assert.equal(resolved.external, false, "must not be excused as a package");
});

test("recognised assets may miss quietly; JSON may not", () => {
  const root = fixture({ "a/b.ts": "" });
  assert.equal(resolveSpecifier(root, "./logo.svg", "a/b.ts", {}).asset, true);
  assert.equal(resolveSpecifier(root, "./styles.css", "a/b.ts", {}).asset, true);
  const json = resolveSpecifier(root, "./data.json", "a/b.ts", {});
  assert.notEqual(json.asset, true, "a JSON import is a module whose contents matter");
});

test("a query suffix selects a transform, not a different module", () => {
  const root = fixture({ "app/index.html": "<html></html>", "app/x.ts": "" });
  assert.equal(resolveSpecifier(root, "./index.html?raw", "app/x.ts", {}).file, "app/index.html");
});

test("type-only imports are not edges, mixed clauses are", () => {
  assert.equal(isTypeOnlyClause(" type { A } "), true);
  assert.equal(isTypeOnlyClause(" { type A, type B } "), true);
  assert.equal(isTypeOnlyClause(" { type A, b } "), false, "`b` survives the transform");
  assert.equal(isTypeOnlyClause(" Thing, { type A } "), false, "a default binding is a value");
});

test("bindings name what an importer can observe; wildcards take everything", () => {
  assert.deepEqual(bindingsOf(" { a, b as c } ").names, ["a", "b"]);
  assert.equal(bindingsOf(" * as ns ").wildcard, true);
  assert.equal(bindingsOf(" Thing ").wildcard, true, "a default import is opaque here");
});

test("an import inside a comment is prose, not a dependency", () => {
  // A docblock explaining a dynamic `import("./x")` fabricated an unresolvable
  // edge, which forced whole lanes to the full suite.
  const source = ['/** register() calls import("./ghost") itself. */', 'import { a } from "./real";'].join("\n");
  const specs = parseImports(source).map((i) => i.spec);
  assert.deepEqual(specs, ["./real"]);
});

test("comment stripping preserves strings and line numbers", () => {
  const source = ['const url = "https://x/y";', "// gone", "const z = 1;"].join("\n");
  const stripped = stripComments(source);
  assert.match(stripped, /https:\/\/x\/y/, "a URL is not a comment");
  assert.equal(stripped.split("\n").length, 3, "line count must survive");
});

test("reported line numbers point at the real line", () => {
  const source = ["", "/* a", "   block */", 'import { a } from "./x";'].join("\n");
  const [record] = parseImports(source);
  assert.equal(record.line, 4);
  assert.match(record.text, /import \{ a \}/);
});

test("a workspace package falls back to source when exports point at unbuilt dist", () => {
  const root = fixture({
    "packages/db/package.json": JSON.stringify({ name: "@repo/db", exports: { ".": "./dist/index.js" } }),
    "packages/db/src/index.ts": "export const client = 1;\n",
  });
  const packages = new Map([["@repo/db", { dir: "packages/db", exports: { ".": "./dist/index.js" } }]]);
  const resolved = resolveSpecifier(root, "@repo/db", "apps/web/x.ts", { packages });
  assert.equal(resolved.file, "packages/db/src/index.ts");
});

test("buildGraph reports unresolved modules so the caller can widen", () => {
  const root = fixture({ "a/b.ts": 'import { x } from "./missing";\n' });
  const { edges, unresolved } = buildGraph(root, ["a/b.ts"], { packages: new Map() });
  assert.equal(edges.get("a/b.ts").length, 0);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].spec, "./missing");
});

test("a published package is external, not a hole in the graph", () => {
  const root = fixture({ "a/b.ts": 'import React from "react";\n' });
  const { unresolved } = buildGraph(root, ["a/b.ts"], { packages: new Map() });
  assert.deepEqual(unresolved, []);
});

// --- regex literals -----------------------------------------------------------

test("a quote inside a regex literal does not open a string", () => {
  // The apostrophe in "fridge's" used to open a string that never closed:
  // every comment after it survived, every import after it was masked away.
  const src = 'Given(/^"(.+)" is on the fridge\'s shelf$/, go);\n// a comment\nconst later = () => import("./later");\n';
  const { code, masked } = scan(src);
  assert.ok(!code.includes("a comment"), "the comment after the regex is stripped");
  assert.ok(masked.includes("import("), "the import after the regex is still visible");
  assert.equal(code.length, masked.length);
});

test("a slash that divides is not a regex", () => {
  const src = "const half = total / 2; // note\nconst r = a / b / c;\n";
  assert.equal(scan(src).code, "const half = total / 2; \nconst r = a / b / c;\n");
});

test("a JSX closing tag is not a regex: later strings and imports stay aligned", () => {
  const src = [
    'export const Help = () => <p><b>Ajuda</b> <a href="/ajuda">abrir</a></p>;',
    'export const API = "https://api.example/v1"; // note',
    'const Page = lazyRoute(async () => ({ default: (await import("./page")).Page }));',
  ].join("\n");
  const code = stripComments(src);
  assert.ok(code.includes('"https://api.example/v1";'), "the URL string survives whole");
  assert.ok(!code.includes("// note"));
  assert.ok(parseImports(src).some((r) => r.spec === "./page"), "the dynamic import is still found");
});

test("a self-closing tag after `}` is JSX, not a regex", () => {
  const src = 'export const Help = () => <p><Icon size={16} /> <a href="/ajuda">Ajuda</a></p>;\nexport const API = "https://api.example/v1"; // note\n';
  const code = stripComments(src);
  assert.ok(code.includes('"https://api.example/v1";'));
  assert.ok(!code.includes("// note"));
});

test("a regex whose reading leaves the line consistent wins over a division", () => {
  // One apostrophe inside the regex: read as a division, the rest of the line
  // would sit inside a string.
  const src = "Given(/^\"(.+)\" is on the fridge's shelf$/, go); // c\n";
  assert.equal(stripComments(src), "Given(/^\"(.+)\" is on the fridge's shelf$/, go); \n");
});
