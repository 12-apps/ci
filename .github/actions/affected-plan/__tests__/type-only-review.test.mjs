// Runtime edits the round-2 review of the type-only re-land (FUT-3586) found
// reported as `typeOnly` with no test selected. Each changes what a test can
// observe, so the consumer's test must stay selected.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { typeOnlyEdit } from "../lib/module-context.mjs";
import { selectAffected } from "../lib/select.mjs";
import { affectedExports } from "../lib/symbols.mjs";

const CONSUMER = 'import { open } from "./basket";\nexport const use = () => open();\n';

/** `src/basket.<ext>` changes from `base` to `head`; a test reaches it through the consumer. */
function select(base, head, { consumer = CONSUMER, ext = "ts" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "affected-type-only-review-"));
  const file = `src/basket.${ext}`;
  const files = { [file]: head, "src/consumer.ts": consumer, "src/consumer.test.ts": 'import { use } from "./consumer";\nuse();\n' };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return selectAffected({
    repoRoot: root,
    changed: [file],
    readBase: (f) => (f === file ? base : null),
    roots: ["src"],
    workspaceDirs: [],
    isTest: (f) => /\.test\.ts$/.test(f),
  });
}

const wide = (result, why) =>
  assert.deepEqual(result.tests, ["src/consumer.test.ts"], `${why}; typeOnly=${JSON.stringify(result.typeOnly)}`);

const S = (m) => `export interface S {\n  kind: ${m};\n}\nexport const EMPTY: S = { kind: "a" };\nexport function open(s: S = EMPTY) {\n  return s;\n}\n`;

test("B1: an importer that reads the edited file through `?raw` sees the type edit", () => {
  wide(select(S('"a"'), S('"a" | "b"'), { consumer: 'import text from "./basket.ts?raw";\nexport const use = () => text;\n' }), "?raw");
  wide(select(S('"a"'), S('"a" | "b"'), { consumer: 'import href from "./basket.ts?url";\nexport const use = () => href;\n' }), "?url");
  const glob = 'const files = import.meta.glob("./basket.ts", { query: "?raw", import: "default", eager: true });\nexport const use = () => files;\n';
  wide(select(S('"a"'), S('"a" | "b"'), { consumer: glob }), "a `?raw` glob");
});

test("B2: a backtick inside a template substitution cannot hide whitespace in a later string", () => {
  const shapes = ['`${"`"}x`', "`${/`/.source}x`", "`${ /* ` */ 1}x`", "`${1 // `\n}x`"];
  for (const template of shapes) {
    const file = (m, pad) => `export type K = ${m};\nexport const MD = ${template} + "${pad}";\nexport function open(k?: K) {\n  return MD;\n}\n`;
    const [base, head] = [file("1", " "), file("1 | 2", "  ")];
    assert.equal(typeOnlyEdit(base, head, affectedExports(base, head)), false, template);
    wide(select(base, head), `string whitespace after ${template}`);
  }
});

test("B3: a .tsx file is never type-only, even where its JSX parses as TypeScript", () => {
  const file = (k, t) => `export type K = ${k}\nconst i = 1\nexport const el = <a>(b: K) => b // ${t}\n  </a>/i\nexport function open(): K {\n  return el as K\n}\n`;
  wide(select(file(1, "hello"), file(2, "goodbye"), { ext: "tsx" }), "JSX text read as a comment");
  wide(select(S('"a"'), S('"a" | "b"'), { ext: "tsx" }), "a plain interface edit in a .tsx file");
});

test("B4: a decorated file is never type-only (emitDecoratorMetadata reads the annotation)", () => {
  const file = (t) => `export type Id = ${t};\nfunction Col(): PropertyDecorator { return () => {}; }\nexport class Row {\n  @Col() id!: Id;\n}\nexport function open() {\n  return Row;\n}\n`;
  wide(select(file("number"), file("string")), "design:type follows the alias");
});

test("any `@` refuses, even in a string or a comment: only the raw text is trusted", () => {
  const file = (m) => `// see @types/node\nexport interface S {\n  kind: ${m};\n}\nexport const MAIL = "a@b.test";\nexport function open(s?: S) {\n  return s ?? MAIL;\n}\n`;
  wide(select(file('"a"'), file('"a" | "b"')), "an `@` the masking would call a literal");
});

// Round 3: the two round-2 fixes the review found incomplete.

test("R2-1: a computed dynamic import holding a query turns type-only off for the plan", () => {
  const consumers = [
    "export const use = (n: string) => import(`./${n}.ts?raw`);\n",
    'export const use = (n: string) => import("./" + n + ".ts?raw");\n',
    "export const use = () => import(`./basket.ts?raw`);\n",
    "export const use = (n: string) => import(\n  `./${n}.ts` +\n    \"?raw\"\n);\n",
  ];
  for (const consumer of consumers) {
    const result = select(S('"a"'), S('"a" | "b"'), { consumer });
    wide(result, consumer);
    assert.match(result.typeOnlyOff ?? "", /^src\/consumer\.ts:1 — a computed import/, consumer);
  }
});

test("R2-1: a computed import with no query leaves type-only narrowing on", () => {
  const consumer = 'import { open } from "./basket";\nexport const use = (n: string) => open() || import(`./${n}.ts`);\n';
  const file = (m) => `export interface S {\n  kind: ${m};\n}\nexport function open(s?: S) {\n  return s;\n}\n`;
  const result = select(file('"a"'), file('"a" | "b"'), { consumer });
  assert.equal(result.typeOnlyOff, undefined);
  assert.deepEqual(result.typeOnly, ["src/basket.ts"]);
});

test("R2-2: a decorator the masking reads as a regex after `z++ /` still refuses", () => {
  const cls = (t) => `export type Id = ${t};\nfunction Col(): PropertyDecorator { return () => {}; }\nlet z = 1\nexport class Row {\n  w = z++ / 2; @Col() id!: Id; v = z / 1\n}\nexport function open() {\n  return Row;\n}\n`;
  wide(select(cls("number"), cls("string")), "decorator hidden by a misread regex");
});
