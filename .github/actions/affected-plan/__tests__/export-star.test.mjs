/**
 * `export * from` carries names, not a load-time effect (FUT-5471, gap 2).
 *
 * A star re-export binds no local name and runs no code of its own: what an
 * importer of the barrel can see through it is the target's changed exports,
 * and the target's load-time effect, which already crosses every runtime edge.
 * The barrel used to be unbracketable as a whole the moment it held one star
 * line, so ANY change reaching it — through the star or through a named
 * re-export beside it — marked every export of the barrel and added a module
 * effect: in a consumer, one changed export behind a package entry with one
 * `export *` reached every importer of the package (~1273 unit files).
 *
 * The counterexamples pin what must still widen: the target's own load-time
 * change, a namespace import of the barrel, `export * as ns`, and a step file
 * (bracketed calls), which keeps refusing to bracket a star line.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { declarationsOf } from "../lib/exports-dataflow.mjs";
import { selectAffected } from "../lib/select.mjs";

function scenario({ head, base = {} }) {
  const root = mkdtempSync(join(tmpdir(), "affected-star-"));
  for (const [path, body] of Object.entries(head)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return { root, readBase: (file) => base[file] ?? null };
}

const run = (options) =>
  selectAffected({ roots: ["src"], workspaceDirs: [], isTest: (f) => /\.test\.ts$/.test(f), ...options });

const MODEL = "export function alpha(): number {\n  return 1;\n}\nexport function beta(): number {\n  return 2;\n}\n";
const OTHER = "export function gamma(): number {\n  return 3;\n}\n";
const INDEX = `export * from "./model";
export { gamma } from "./other";

const registry = new Map<string, number>();

export function local(): number {
  return registry.size;
}
`;

const TESTS = {
  "src/alpha.test.ts": 'import { alpha } from "./index";\nalpha();\n',
  "src/beta.test.ts": 'import { beta } from "./index";\nbeta();\n',
  "src/gamma.test.ts": 'import { gamma } from "./index";\ngamma();\n',
  "src/local.test.ts": 'import { local } from "./index";\nlocal();\n',
};
const EVERY = ["src/alpha.test.ts", "src/beta.test.ts", "src/gamma.test.ts", "src/local.test.ts"];

function plan(changed, { head = {}, base = {} } = {}) {
  const files = { "src/model.ts": MODEL, "src/other.ts": OTHER, "src/index.ts": INDEX, ...TESTS, ...head };
  const { root, readBase } = scenario({ head: files, base: { "src/model.ts": MODEL, "src/other.ts": OTHER, "src/index.ts": INDEX, ...base } });
  return run({ repoRoot: root, changed, readBase });
}

test("a changed export behind `export *` reaches only the importers of that name", () => {
  const result = plan(["src/model.ts"], { head: { "src/model.ts": MODEL.replace("return 1;", "return 10;") } });
  assert.deepEqual(result.tests, ["src/alpha.test.ts"]);
  assert.deepEqual([...result.affected.get("src/index.ts")], ["alpha"]);
});

test("a named re-export beside a star line narrows too", () => {
  // The barrel used to be unbracketable as a whole; `gamma` never touches the star.
  const result = plan(["src/other.ts"], { head: { "src/other.ts": OTHER.replace("return 3;", "return 30;") } });
  assert.deepEqual(result.tests, ["src/gamma.test.ts"]);
});

test("the barrel's own declaration, edited, reaches only its importers", () => {
  const result = plan(["src/index.ts"], { head: { "src/index.ts": INDEX.replace("return registry.size;", "return registry.size + 1;") } });
  assert.deepEqual(result.tests, ["src/local.test.ts"]);
});

test("names travel through a chain of star barrels", () => {
  const result = plan(["src/model.ts"], {
    head: {
      "src/model.ts": MODEL.replace("return 2;", "return 20;"),
      "src/outer.ts": 'export * from "./index";\n',
      "src/outer-beta.test.ts": 'import { beta } from "./outer";\nbeta();\n',
      "src/outer-alpha.test.ts": 'import { alpha } from "./outer";\nalpha();\n',
    },
  });
  assert.deepEqual(result.tests, ["src/beta.test.ts", "src/outer-beta.test.ts"]);
});

test("COUNTEREXAMPLE: the target's load-time change still reaches every importer of the barrel", () => {
  const result = plan(["src/model.ts"], {
    head: { "src/model.ts": `${MODEL}globalThis.loaded = 2;\n` },
    base: { "src/model.ts": `${MODEL}globalThis.loaded = 1;\n` },
  });
  assert.deepEqual(result.tests, EVERY);
});

test("COUNTEREXAMPLE: a namespace import of the barrel is reached by any change behind it", () => {
  const result = plan(["src/model.ts"], {
    head: { "src/model.ts": MODEL.replace("return 1;", "return 10;"), "src/all.test.ts": 'import * as all from "./index";\nall;\n' },
  });
  assert.deepEqual(result.tests, ["src/all.test.ts", "src/alpha.test.ts"]);
});

test("COUNTEREXAMPLE: `export * as ns` keeps the wide reading", () => {
  const result = plan(["src/model.ts"], {
    head: {
      "src/model.ts": MODEL.replace("return 1;", "return 10;"),
      "src/ns.ts": 'export * as model from "./model";\n',
      "src/ns.test.ts": 'import { model } from "./ns";\nmodel.beta();\n',
    },
  });
  assert.ok(result.tests.includes("src/ns.test.ts"), result.tests.join(","));
});

test("COUNTEREXAMPLE: a step file (bracketed calls) with a star line stays unbracketable", () => {
  const steps = 'export * from "./more-steps";\nGiven("a thing", () => {});\n';
  assert.equal(declarationsOf(steps, { calls: ["Given"] }), null);
  assert.deepEqual(declarationsOf('export * from "./model";\nexport const x = 1;\n').map((d) => d.name), ["x"]);
});

test("COUNTEREXAMPLE: a star line removed or retargeted in an edited barrel reaches its names' importers", () => {
  // FUT-5471 review N4: the barrel's own re-export context changed.
  const removed = plan(["src/index.ts"], { head: { "src/index.ts": INDEX.replace('export * from "./model";\n', "") } });
  assert.ok(removed.tests.includes("src/alpha.test.ts") && removed.tests.includes("src/beta.test.ts"), removed.tests.join(","));
  const retargeted = plan(["src/index.ts"], {
    head: { "src/index.ts": INDEX.replace('"./model"', '"./model2"'), "src/model2.ts": MODEL },
  });
  assert.ok(retargeted.tests.includes("src/alpha.test.ts") && retargeted.tests.includes("src/beta.test.ts"), retargeted.tests.join(","));
});
