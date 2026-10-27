/**
 * Counterexamples for keyed catalogs: each test asserts the CORRECT selection
 * (the test whose verdict can change IS selected). A failing assertion here is a
 * confirmed false negative of lib/catalogs.mjs + lib/select.mjs.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const LIB = new URL("../lib", import.meta.url).href;
const { selectAffected } = await import(`${LIB}/select.mjs`);
const { changedKeys, passesKeysThrough } = await import(`${LIB}/catalogs.mjs`);
const { parseImports } = await import(`${LIB}/modules.mjs`);

function scenario({ head, base = {} }) {
  const root = mkdtempSync(join(tmpdir(), "keyed-cx-"));
  for (const [path, body] of Object.entries(head)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return { root, readBase: (file) => (file in base ? base[file] : head[file] ?? null) };
}
const isCatalog = (f) => /^src\/copy\//.test(f);
function run(head, base, changed, extra = {}) {
  const { root, readBase } = scenario({ head, base });
  return selectAffected({
    repoRoot: root, roots: ["src"], workspaceDirs: [], changed, readBase,
    isTest: (f) => /\.test\.ts$/.test(f), isCatalog, ...extra,
  });
}
const PACK = (open) => `export const EN_TILL = {\n  tillAlreadyOpen: "${open}",\n  tillNotOpen: "No till.",\n};\n`;
const ACCESSOR =
  'import { EN_TILL } from "./till.en-US";\n' +
  'const PACK = {\n  "en-US": EN_TILL,\n} as const;\n' +
  "export function tillRefusal() {\n  return PACK[locale()];\n}\n";

// ── 1. A non-catalog barrel `export { x } from "./catalog"` (future-pay's
// lib/api/errors.ts and lib/api/handler.ts re-export `refusal` exactly so).
test("CX1 barrel re-export of an accessor drops every consumer behind it", () => {
  const head = {
    "src/copy/till.en-US.ts": PACK("Open already."),
    "src/copy/till.ts": ACCESSOR,
    "src/errors.ts":
      'import { tillRefusal } from "./copy/till";\nexport { tillRefusal } from "./copy/till";\n' +
      "export class ApiError extends Error {}\nexport function denied() {\n  return tillRefusal().tillNotOpen;\n}\n",
    "src/surface.ts": 'import { tillRefusal } from "./errors";\nexport function refuseOpen() {\n  return tillRefusal().tillAlreadyOpen;\n}\n',
    "src/surface.test.ts": 'import { refuseOpen } from "./surface";\nrefuseOpen();\n',
  };
  const r = run(head, { "src/copy/till.en-US.ts": PACK("Already open.") }, ["src/copy/till.en-US.ts"]);
  assert.ok(r.tests.includes("src/surface.test.ts"), `selected: ${JSON.stringify(r.tests)}`);
});

test("CX1b pure barrel (no own import) also drops consumers", () => {
  const head = {
    "src/copy/till.en-US.ts": PACK("Open already."),
    "src/copy/till.ts": ACCESSOR,
    "src/index.ts": 'export { tillRefusal } from "./copy/till";\nexport const VERSION = 1;\n',
    "src/surface.ts": 'import { tillRefusal } from "./index";\nexport function refuseOpen() {\n  return tillRefusal().tillAlreadyOpen;\n}\n',
    "src/surface.test.ts": 'import { refuseOpen } from "./surface";\nrefuseOpen();\n',
  };
  const r = run(head, { "src/copy/till.en-US.ts": PACK("Already open.") }, ["src/copy/till.en-US.ts"]);
  assert.ok(r.tests.includes("src/surface.test.ts"), `selected: ${JSON.stringify(r.tests)}`);
});

// ── 2. A top-level alias: the alias's uses are only searched inside the
// declaration that binds it.
test("CX2 top-level alias read by another declaration", () => {
  const head = {
    "src/copy/till.en-US.ts": PACK("Open already."),
    "src/open.ts": 'import { EN_TILL } from "./copy/till.en-US";\nconst COPY = EN_TILL;\nexport function refuseOpen() {\n  return COPY.tillAlreadyOpen;\n}\n',
    "src/open.test.ts": 'import { refuseOpen } from "./open";\nrefuseOpen();\n',
  };
  const r = run(head, { "src/copy/till.en-US.ts": PACK("Already open.") }, ["src/copy/till.en-US.ts"]);
  assert.ok(r.tests.includes("src/open.test.ts"), `selected: ${JSON.stringify(r.tests)}`);
});

test("CX2b exported top-level alias", () => {
  const head = {
    "src/copy/till.en-US.ts": PACK("Open already."),
    "src/alias.ts": 'import { EN_TILL } from "./copy/till.en-US";\nexport const COPY = EN_TILL;\n',
    "src/alias.test.ts": 'import { COPY } from "./alias";\nexpect(COPY.tillAlreadyOpen).toBe("Open already.");\n',
  };
  const r = run(head, { "src/copy/till.en-US.ts": PACK("Already open.") }, ["src/copy/till.en-US.ts"]);
  assert.ok(r.tests.includes("src/alias.test.ts"), `selected: ${JSON.stringify(r.tests)}`);
});

// ── 3. Reordering entries: changedKeys compares values per key and the spread
// LIST, never positions, and answers an empty set — the file is not even seeded.
test("CX3 moving a key across a spread changes its value, yet nothing is selected", () => {
  const base = 'import { BASE } from "./base";\nexport const EN = {\n  tillAlreadyOpen: "Override.",\n  ...BASE,\n};\n';
  const head = base.replace('  tillAlreadyOpen: "Override.",\n  ...BASE,\n', '  ...BASE,\n  tillAlreadyOpen: "Override.",\n');
  // Either answer is sound: the moved key, or null (the ordinary path).
  const keys = changedKeys(base, head);
  assert.ok(keys === null || keys.has("tillAlreadyOpen"), `changedKeys answer: ${keys && [...keys]}`);
});

test("CX3b plain key reorder changes Object.keys order; changedKeys says nothing moved", () => {
  const base = 'export const EN = {\n  a: "1",\n  b: "2",\n};\n';
  const head = 'export const EN = {\n  b: "2",\n  a: "1",\n};\n';
  const r = run(
    {
      "src/copy/en.ts": head,
      "src/order.test.ts": 'import { EN } from "./copy/en";\nexpect(Object.keys(EN)).toEqual(["a", "b"]);\n',
    },
    { "src/copy/en.ts": base },
    ["src/copy/en.ts"],
  );
  assert.ok(r.tests.includes("src/order.test.ts"), `selected: ${JSON.stringify(r.tests)} mode=${r.mode}`);
});

// ── 4. The local export list is not a declaration: adding/removing/renaming
// `export { EN }` leaves every declaration's text unchanged.
test("CX4 removing `export { EN }` breaks importers, yet nothing is selected", () => {
  const body = 'const EN = {\n  tillAlreadyOpen: "Open.",\n};\n';
  const base = `${body}export { EN };\n`;
  const head = `${body}export { EN as EN_US };\n`;
  assert.equal(changedKeys(base, head), null, `changedKeys answered ${JSON.stringify(changedKeys(base, head) && [...changedKeys(base, head)])}`);
});

// ── 5. A reference between declarations of the catalog itself: changedKeys
// reports the inner object's keys, but readers read the OUTER key.
test("CX5 a pack nested under an identifier key in the same file", () => {
  const pack = (s) => `const TILL = {\n  alreadyOpen: "${s}",\n};\nexport const EN = {\n  till: TILL,\n  other: "x",\n};\n`;
  const r = run(
    {
      "src/copy/en.ts": pack("Open already."),
      "src/open.ts": 'import { EN } from "./copy/en";\nexport const refuseOpen = () => EN.till.alreadyOpen;\n',
      "src/open.test.ts": 'import { refuseOpen } from "./open";\nrefuseOpen();\n',
    },
    { "src/copy/en.ts": pack("Already open.") },
    ["src/copy/en.ts"],
  );
  assert.ok(r.tests.includes("src/open.test.ts"), `selected: ${JSON.stringify(r.tests)} symbols=${JSON.stringify(r.symbols)}`);
});

test("CX5b an arrow entry that reads a sibling key", () => {
  const pack = (s) => `export const EN = {\n  shop: "${s}",\n  welcome: (n) => \`\${EN.shop}, \${n}\`,\n};\n`;
  const r = run(
    {
      "src/copy/en.ts": pack("Loja"),
      "src/hello.ts": 'import { EN } from "./copy/en";\nexport const hello = () => EN.welcome("Ana");\n',
      "src/hello.test.ts": 'import { hello } from "./hello";\nexpect(hello()).toBe("Loja, Ana");\n',
    },
    { "src/copy/en.ts": pack("Shop") },
    ["src/copy/en.ts"],
  );
  assert.ok(r.tests.includes("src/hello.test.ts"), `selected: ${JSON.stringify(r.tests)}`);
});

test("CX5c removing a key the catalog reads at module scope throws on import; other readers skipped", () => {
  const base = 'export const EN = {\n  a: "x",\n  b: "y",\n};\nexport const A_LENGTH = EN.a.length;\n';
  const head = 'export const EN = {\n  b: "y",\n};\nexport const A_LENGTH = EN.a.length;\n';
  const r = run(
    {
      "src/copy/en.ts": head,
      "src/b.ts": 'import { EN } from "./copy/en";\nexport const readB = () => EN.b;\n',
      "src/b.test.ts": 'import { readB } from "./b";\nreadB();\n',
    },
    { "src/copy/en.ts": base },
    ["src/copy/en.ts"],
  );
  assert.ok(r.tests.includes("src/b.test.ts"), `selected: ${JSON.stringify(r.tests)}`);
});

// ── 6. passesKeysThrough accepts ANY `...PACK`, wherever the spread sits — so
// the `{ en: PACK }` hazard it refuses comes straight back as `{ en: { ...PACK } }`.
test("CX6 a holder spreading the pack under an identifier key passes keys through", () => {
  const src = 'import { EN_TILL } from "./till.en-US";\nexport const HOLDER = {\n  en: { ...EN_TILL },\n};\n';
  const record = parseImports(src).find((r) => r.spec === "./till.en-US");
  assert.equal(passesKeysThrough(src, record), false, "passesKeysThrough should refuse");
});

test("CX6b end to end: HOLDER.en.key reader is not selected", () => {
  const r = run(
    {
      "src/copy/till.en-US.ts": PACK("Open already."),
      "src/copy/holder.ts": 'import { EN_TILL } from "./till.en-US";\nexport const HOLDER = {\n  en: { ...EN_TILL },\n};\n',
      "src/open.ts": 'import { HOLDER } from "./copy/holder";\nexport const refuseOpen = () => HOLDER.en.tillAlreadyOpen;\n',
      "src/open.test.ts": 'import { refuseOpen } from "./open";\nrefuseOpen();\n',
    },
    { "src/copy/till.en-US.ts": PACK("Already open.") },
    ["src/copy/till.en-US.ts"],
  );
  assert.ok(r.tests.includes("src/open.test.ts"), `selected: ${JSON.stringify(r.tests)}`);
});

test("CX6c a spread inside a non-literal context (Object.values) passes keys through", () => {
  const r = run(
    {
      "src/copy/till.en-US.ts": PACK("Open already."),
      "src/copy/list.ts": 'import { EN_TILL } from "./till.en-US";\nexport const ALL = Object.values({ ...EN_TILL });\n',
      "src/list.test.ts": 'import { ALL } from "./copy/list";\nexpect(ALL.length).toBe(2);\nexpect(ALL.join("|")).toBe("Open already.|No till.");\n',
    },
    { "src/copy/till.en-US.ts": PACK("Already open.") },
    ["src/copy/till.en-US.ts"],
  );
  assert.ok(r.tests.includes("src/list.test.ts"), `selected: ${JSON.stringify(r.tests)}`);
});

// ── 7. keysRead credits only the FIRST member after the binding (or its call),
// so an accessor reached through a member is read as that member's name.
test("CX7 accessor object: copy.till().key is read as key `till`", () => {
  const r = run(
    {
      "src/copy/till.en-US.ts": PACK("Open already."),
      "src/copy/index.ts":
        'import { EN_TILL } from "./till.en-US";\nconst PACK = {\n  "en-US": EN_TILL,\n} as const;\n' +
        "export const copy = {\n  till: () => PACK[locale()],\n};\n",
      "src/open.ts": 'import { copy } from "./copy/index";\nexport const refuseOpen = () => copy.till().tillAlreadyOpen;\n',
      "src/open.test.ts": 'import { refuseOpen } from "./open";\nrefuseOpen();\n',
    },
    { "src/copy/till.en-US.ts": PACK("Already open.") },
    ["src/copy/till.en-US.ts"],
  );
  assert.ok(r.tests.includes("src/open.test.ts"), `selected: ${JSON.stringify(r.tests)}`);
});

// ── 8. canonical() collapses newlines in code, and a newline after `return`
// is semantic (ASI).
test("CX8 `return\\n value` in an arrow body is read as no change", () => {
  const base = 'export const EN = {\n  f: () => {\n    return "x";\n  },\n};\n';
  const head = 'export const EN = {\n  f: () => {\n    return\n      "x";\n  },\n};\n';
  const keys = changedKeys(base, head);
  assert.ok(keys === null || keys.has("f"), `changedKeys answered ${JSON.stringify(keys && [...keys])}`);
});

// ── 9. `__proto__` is not a key a reader reads; it supplies inherited keys.
test("CX9 editing __proto__'s value is reported as key `__proto__` only", () => {
  const base = 'export const EN = {\n  __proto__: { a: "x" },\n  b: "y",\n};\n';
  const head = 'export const EN = {\n  __proto__: { a: "z" },\n  b: "y",\n};\n';
  const r = run(
    {
      "src/copy/en.ts": head,
      "src/a.ts": 'import { EN } from "./copy/en";\nexport const readA = () => EN.a;\n',
      "src/a.test.ts": 'import { readA } from "./a";\nreadA();\n',
    },
    { "src/copy/en.ts": base },
    ["src/copy/en.ts"],
  );
  assert.ok(r.tests.includes("src/a.test.ts"), `selected: ${JSON.stringify(r.tests)}`);
});

// End-to-end forms of CX3 / CX4.
test("CX3c end to end: key moved across a spread", () => {
  const base = 'import { BASE } from "./base";\nexport const EN = {\n  tillAlreadyOpen: "Override.",\n  ...BASE,\n};\n';
  const head = 'import { BASE } from "./base";\nexport const EN = {\n  ...BASE,\n  tillAlreadyOpen: "Override.",\n};\n';
  const r = run(
    {
      "src/copy/base.ts": 'export const BASE = {\n  tillAlreadyOpen: "Base.",\n};\n',
      "src/copy/en.ts": head,
      "src/open.ts": 'import { EN } from "./copy/en";\nexport const refuseOpen = () => EN.tillAlreadyOpen;\n',
      "src/open.test.ts": 'import { refuseOpen } from "./open";\nexpect(refuseOpen()).toBe("Base.");\n',
    },
    { "src/copy/en.ts": base },
    ["src/copy/en.ts"],
  );
  assert.ok(r.tests.includes("src/open.test.ts"), `selected: ${JSON.stringify(r.tests)} mode=${r.mode}`);
});

test("CX4b end to end: export renamed through the local export list", () => {
  const body = 'const EN = {\n  tillAlreadyOpen: "Open.",\n};\n';
  const r = run(
    {
      "src/copy/en.ts": `${body}export { EN as EN_US };\n`,
      "src/open.ts": 'import { EN } from "./copy/en";\nexport const refuseOpen = () => EN.tillAlreadyOpen;\n',
      "src/open.test.ts": 'import { refuseOpen } from "./open";\nrefuseOpen();\n',
    },
    { "src/copy/en.ts": `${body}export { EN };\n` },
    ["src/copy/en.ts"],
  );
  assert.ok(r.tests.includes("src/open.test.ts"), `selected: ${JSON.stringify(r.tests)} mode=${r.mode}`);
});
