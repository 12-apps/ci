/**
 * Keyed catalogs (lib/catalogs.mjs): a copy pack's edit reaches only the code
 * that reads the keys it moved — and every shape that cannot be proven to be a
 * plain key read widens back to the ordinary analysis.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { changedKeys, inertValue, keyedUse, passesKeysThrough } from "../lib/catalogs.mjs";
import { parseImports } from "../lib/modules.mjs";
import { selectAffected } from "../lib/select.mjs";

const record = (source, spec) => parseImports(source).find((r) => r.spec === spec);

test("inert values: literals, plain templates, arrows, and nests of them", () => {
  for (const value of ['"a, b"', "'x'", "`plain`", "42", "true", "(n) => `${n} itens`", "(a, b) => (a ? `${a}` : b)", '["a", "b"]', '{ one: "a", other: (n) => `${n}` }'])
    assert.ok(inertValue(value), value);
  for (const value of ["`${REASON}`", "REASON", "build()", '"a" + b', "(n) => n, other", '{ ...BASE }', '{ [k]: "a" }'])
    assert.ok(!inertValue(value), value);
});

const PACK = (sentence) =>
  'import type { Copy } from "./copy.shared";\n\n' +
  "export const EN_COPY: Copy = {\n" +
  `  tillAlreadyOpen: "${sentence}",\n` +
  "  operatorBusy: (name) =>\n    name ? `${name} is open.` : \"A till is open.\",\n" +
  '  "quoted-key": "q",\n' +
  "};\n";

test("changedKeys names the entries that moved", () => {
  assert.deepEqual([...changedKeys(PACK("Open."), PACK("Already open."))], ["tillAlreadyOpen"]);
  assert.deepEqual([...changedKeys(PACK("Open."), PACK("Open."))], []);
  const added = PACK("Open.").replace("};", '  fresh: "new",\n};');
  assert.deepEqual([...changedKeys(PACK("Open."), added)], ["fresh"]);
  const frozen = (s) => s.replace("};", "} as const satisfies Copy;");
  assert.deepEqual([...changedKeys(frozen(PACK("a")), frozen(PACK("b")))], ["tillAlreadyOpen"]);
});

test("changedKeys widens on anything but inert entry edits", () => {
  const base = PACK("Open.");
  const cases = {
    "an import": base.replace("import type", 'import { x } from "./x";\nimport type'),
    "a substitution": base.replace('"Open."', "`${REASON}`"),
    "a spread": base.replace("{\n", "{\n  ...BASE,\n"),
    "a duplicate key": base.replace("};", '  tillAlreadyOpen: "again",\n};'),
    "a new declaration": `${base}export const other = 1;\n`,
    "a function": base.replace("export const", "export function f() { return 1; }\nexport const"),
    "the type annotation": base.replace(": Copy =", ": Other ="),
  };
  for (const [label, head] of Object.entries(cases)) assert.equal(changedKeys(base, head), null, label);
  assert.equal(changedKeys(null, base), null, "a new file");
});

const KEYS = new Set(["tillAlreadyOpen"]);
const SPEC = "./copy";
const use = (body) => {
  const source = `import { tillRefusal } from "${SPEC}";\n${body}`;
  return keyedUse(source, record(source, SPEC), KEYS);
};

test("keyedUse finds the declarations reading a changed key", () => {
  assert.deepEqual([...use("export function a() {\n  return tillRefusal().tillAlreadyOpen;\n}\nexport function b() {\n  return tillRefusal().operatorBusy(1);\n}\n")], ["a"]);
  assert.deepEqual([...use("export function a() {\n  const copy = tillRefusal();\n  return { x: copy.tillAlreadyOpen, y: copy?.other };\n}\n")], ["a"]);
  assert.deepEqual([...use("export function a() {\n  const { tillAlreadyOpen, other: o } = tillRefusal();\n  return tillAlreadyOpen;\n}\n")], ["a"]);
  assert.deepEqual([...use("export function a() {\n  return `${tillRefusal().tillAlreadyOpen}!`;\n}\n")], ["a"]);
  assert.deepEqual([...use("export function b() {\n  return tillRefusal().operatorBusy;\n}\n")], [], "reads only another key");
  assert.equal(use('describe("x", () => {\n  expect(tillRefusal().tillAlreadyOpen).toBe("a");\n});\n'), "*", "a test file reading it");
  assert.deepEqual([...use('describe("x", () => {\n  expect(tillRefusal().other).toBe("a");\n});\n')], [], "a test file reading another key");
});

test("keyedUse widens on every use that is not a plain key read", () => {
  const cases = {
    "passed to a function": "export function a() {\n  return render(tillRefusal());\n}\n",
    "indexed": "export function a(k) {\n  return tillRefusal()[k];\n}\n",
    "spread": "export function a() {\n  return { ...tillRefusal() };\n}\n",
    "returned": "export function a() {\n  return tillRefusal();\n}\n",
    "an alias passed on": "export function a() {\n  const copy = tillRefusal();\n  return render(copy);\n}\n",
    "a rest pattern": "export function a() {\n  const { ...all } = tillRefusal();\n  return all;\n}\n",
    "re-exported": "export { tillRefusal };\n",
    "a default export": "export default tillRefusal;\n",
    "Object.keys in a test": "describe(\"x\", () => {\n  Object.keys(tillRefusal());\n});\n",
  };
  for (const [label, body] of Object.entries(cases)) assert.equal(use(body), null, label);
  const namespace = 'import * as copy from "./copy";\nexport const a = () => copy.tillRefusal().tillAlreadyOpen;\n';
  assert.equal(keyedUse(namespace, record(namespace, SPEC), KEYS), null, "a namespace import");
});

test("passesKeysThrough: a spread or a locale value hands the keys on; a member read does not", () => {
  const spread = 'import { EN_A } from "./a";\nexport const EN: Copy = {\n  ...EN_A,\n  b: "b",\n};\n';
  assert.ok(passesKeysThrough(spread, record(spread, "./a")));
  const locale = 'import { EN_A } from "./a";\nconst PACK = {\n  "pt-BR": PT_A,\n  "en-US": EN_A,\n} as const;\nexport function copy() {\n  return pick(PACK);\n}\n';
  assert.ok(passesKeysThrough(locale, record(locale, "./a")));
  const renamed = 'import { EN_A } from "./a";\nexport const EN = {\n  open: EN_A.tillAlreadyOpen,\n};\n';
  assert.ok(!passesKeysThrough(renamed, record(renamed, "./a")));
  // Under an identifier key a reader could write HOLDER.en.tillAlreadyOpen.
  const nested = 'import { EN_A } from "./a";\nexport const HOLDER = {\n  en: EN_A,\n};\n';
  assert.ok(!passesKeysThrough(nested, record(nested, "./a")));
  const quotedIdent = 'import { EN_A } from "./a";\nexport const HOLDER = {\n  "en": EN_A,\n};\n';
  assert.ok(!passesKeysThrough(quotedIdent, record(quotedIdent, "./a")));
});

/** A throwaway repo plus a `readBase` over an explicit base-side map. */
function scenario({ head, base = {} }) {
  const root = mkdtempSync(join(tmpdir(), "affected-catalogs-"));
  for (const [path, body] of Object.entries(head)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return { root, readBase: (file) => base[file] ?? null };
}

// The consumer's shape: a locale pair, an accessor that picks one, two helpers
// that each read one sentence, and a route per helper.
function tillApp(overrides = {}) {
  const pack = (open) => `export const EN_TILL = {\n  tillAlreadyOpen: "${open}",\n  tillNotOpen: "No till.",\n};\n`;
  return scenario({
    head: {
      "src/copy/till.en-US.ts": pack("Open already."),
      "src/copy/till.pt-BR.ts": 'export const PT_TILL = {\n  tillAlreadyOpen: "Aberto.",\n  tillNotOpen: "Sem caixa.",\n};\n',
      "src/copy/till.ts":
        'import { EN_TILL } from "./till.en-US";\nimport { PT_TILL } from "./till.pt-BR";\n' +
        'const PACK = {\n  "pt-BR": PT_TILL,\n  "en-US": EN_TILL,\n} as const;\n' +
        "export function tillRefusal() {\n  return PACK[locale()];\n}\n",
      "src/open.ts": 'import { tillRefusal } from "./copy/till";\nexport function refuseOpen() {\n  return tillRefusal().tillAlreadyOpen;\n}\n',
      "src/close.ts": 'import { tillRefusal } from "./copy/till";\nexport function refuseClose() {\n  const copy = tillRefusal();\n  return copy.tillNotOpen;\n}\n',
      "src/open.test.ts": 'import { refuseOpen } from "./open";\nrefuseOpen();\n',
      "src/close.test.ts": 'import { refuseClose } from "./close";\nrefuseClose();\n',
      ...overrides,
    },
    base: { "src/copy/till.en-US.ts": pack("Already open.") },
  });
}

const select = (options) =>
  selectAffected({ roots: ["src"], workspaceDirs: [], isTest: (f) => /\.test\.ts$/.test(f), ...options });
const isCatalog = (f) => /^src\/copy\//.test(f);

test("a reworded sentence reaches only the code reading its key", () => {
  const { root, readBase } = tillApp();
  const result = select({ repoRoot: root, changed: ["src/copy/till.en-US.ts"], readBase, isCatalog });
  assert.deepEqual(result.tests, ["src/open.test.ts"]);
  assert.deepEqual(result.symbols["src/copy/till.en-US.ts"], [".tillAlreadyOpen"]);
  assert.deepEqual(result.reasons["src/open.test.ts"].map((hop) => hop.importer), ["src/open.test.ts", "src/open.ts", "src/copy/till.ts"]);
});

test("without isCatalog the pack is an initialization effect: every reader runs", () => {
  const { root, readBase } = tillApp();
  const result = select({ repoRoot: root, changed: ["src/copy/till.en-US.ts"], readBase });
  assert.deepEqual(result.tests, ["src/close.test.ts", "src/open.test.ts"]);
});

test("a reader that passes the pack on widens to the ordinary walk", () => {
  const { root, readBase } = tillApp({
    "src/close.ts": 'import { tillRefusal } from "./copy/till";\nexport function refuseClose() {\n  return render(tillRefusal());\n}\n',
  });
  const result = select({ repoRoot: root, changed: ["src/copy/till.en-US.ts"], readBase, isCatalog });
  assert.deepEqual(result.tests, ["src/close.test.ts", "src/open.test.ts"]);
});

test("a catalog that renames a key does not pass keys through", () => {
  const { root, readBase } = tillApp({
    "src/copy/till.ts":
      'import { EN_TILL } from "./till.en-US";\nexport function tillRefusal() {\n  return { tillNotOpen: EN_TILL.tillAlreadyOpen };\n}\n',
  });
  const result = select({ repoRoot: root, changed: ["src/copy/till.en-US.ts"], readBase, isCatalog });
  assert.ok(result.tests.includes("src/close.test.ts"), "the renamed key's reader runs");
});

test("an edit the key diff cannot bracket takes the ordinary path", () => {
  const { root, readBase } = tillApp({
    "src/copy/till.en-US.ts": 'const REASON = "r";\nexport const EN_TILL = {\n  tillAlreadyOpen: `${REASON}`,\n  tillNotOpen: "No till.",\n};\n',
  });
  const result = select({
    repoRoot: root,
    changed: ["src/copy/till.en-US.ts"],
    readBase: (f) => (f === "src/copy/till.en-US.ts" ? 'const REASON = "r";\nexport const EN_TILL = {\n  tillAlreadyOpen: "Open.",\n  tillNotOpen: "No till.",\n};\n' : readBase(f)),
    isCatalog,
  });
  assert.deepEqual(result.tests, ["src/close.test.ts", "src/open.test.ts"]);
});

test("a catalog also reached by an ordinary change carries everything", () => {
  const { root, readBase } = tillApp({
    "src/locale.ts": "export const locale = () => \"en-US\";\n",
    "src/copy/till.ts":
      'import { EN_TILL } from "./till.en-US";\nimport { locale } from "../locale";\n' +
      'const PACK = {\n  "en-US": EN_TILL,\n} as const;\n' +
      "export function tillRefusal() {\n  return PACK[locale()];\n}\n",
  });
  const result = select({
    repoRoot: root,
    changed: ["src/copy/till.en-US.ts", "src/locale.ts"],
    readBase: (f) => (f === "src/locale.ts" ? "export const locale = () => \"pt-BR\";\n" : readBase(f)),
    isCatalog,
  });
  assert.deepEqual(result.tests, ["src/close.test.ts", "src/open.test.ts"]);
});
