/**
 * FUT-4433: `walkLiterals` (behind `canonical`, `changedDeclarations` and
 * `affectedExports`) must find a template literal's end by lexing each `${…}`
 * as code. Before the fix it closed the template at the first backtick it met,
 * so a backtick inside a string, a regex, a comment or a nested template ended
 * it early, the rest of the file was read with the wrong parity, and a
 * whitespace edit inside a LATER literal read as no change: the file seeded no
 * tests at all.
 *
 * The comment shapes cannot reach the walker end to end — every caller hands
 * it `stripComments` output, and `scan` already lexes substitutions — so they
 * are pinned on `canonical` directly; the end-to-end cases cover them anyway.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const LIB = new URL("../lib", import.meta.url).href;
const { selectAffected } = await import(`${LIB}/select.mjs`);
const { canonical } = await import(`${LIB}/exports-dataflow.mjs`);

const FILE = "src/basket.ts";
const TEST = "src/consumer.test.ts";
const TAIL = "export function open() { return MD; }\n";

function select(base, head) {
  const root = mkdtempSync(join(tmpdir(), "tpl-subst-"));
  const files = {
    [FILE]: head,
    "src/consumer.ts": 'import { open } from "./basket";\nexport const use = () => open();\n',
    [TEST]: 'import { use } from "./consumer";\nuse();\n',
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return selectAffected({
    repoRoot: root, roots: ["src"], workspaceDirs: [], changed: [FILE],
    readBase: (f) => (f === FILE ? base : null), isTest: (f) => /\.test\.ts$/.test(f),
  });
}

// Each shape takes the whitespace that sits inside a literal AFTER the
// substitution that used to close the template early.
const SHAPES = {
  "a backtick in a string": (s) => `export const MD = \`\${"\`"}x\` + "${s}";\n${TAIL}`,
  "a backtick in a regex": (s) => `export const MD = \`\${/\`/.source} a${s}b \`;\n${TAIL}`,
  "a backtick in a block comment": (s) => `export const MD = \`\${ /* \` */ 1} a${s}b \`;\n${TAIL}`,
  "a backtick in a line comment": (s) => `export const MD = \`\${1 // \`\n} a${s}b \`;\n${TAIL}`,
  "a nested template": (s) => `export const MD = \`<\${\`in${s}side\`}>\`;\n${TAIL}`,
};

for (const [label, shape] of Object.entries(SHAPES)) {
  test(`canonical: whitespace in a literal after ${label} is a change`, () => {
    assert.notEqual(canonical(shape(" ")), canonical(shape("  ")));
  });

  test(`end to end: whitespace in a literal after ${label} selects the consumer's test`, () => {
    const r = select(shape(" "), shape("  "));
    assert.ok(r.tests.includes(TEST), `selected: ${JSON.stringify(r.tests)} mode=${r.mode}`);
  });
}

// ── Negatives: whitespace OUTSIDE literals is still no change. ──

const OUTSIDE = {
  "a backtick in a string": (s) => `export const MD =${s}\`\${"\`"}x a b \`${s}+ " ";\n${TAIL}`,
  "a backtick in a regex": (s) => `export const MD =${s}\`\${/\`/.source} a b \`${s}+ " ";\n${TAIL}`,
  "a nested template": (s) => `export const MD =${s}\`<\${\`in side\`}>\`${s}+ " ";\n${TAIL}`,
};

for (const [label, shape] of Object.entries(OUTSIDE)) {
  test(`canonical: whitespace between tokens around ${label} is no change`, () => {
    assert.equal(canonical(shape(" ")), canonical(shape("   ")));
  });

  test(`end to end: whitespace between tokens around ${label} selects nothing`, () => {
    const r = select(shape(" "), shape("\n    "));
    assert.deepEqual(r.tests, [], `mode=${r.mode}`);
  });
}

test("end to end: a reindent of a plain declaration still selects nothing", () => {
  const shape = (s) => `export const MD = \`x\`;\nexport function open() {${s}return MD; }\n`;
  assert.deepEqual(select(shape(" "), shape("\n    ")).tests, []);
});

test("canonical: whitespace between tokens after a closed substitution is no change", () => {
  assert.equal(canonical('`${"`"}x`   +   y'), canonical('`${"`"}x` + y'));
});

test("canonical: a substitution's own text still compares verbatim", () => {
  // Unchanged behaviour: a substitution stays inside the literal, which can
  // only over-report a change.
  assert.notEqual(canonical("`${ a }`"), canonical("`${a}`"));
});

test("canonical: an unterminated template runs to the end of the text", () => {
  assert.notEqual(canonical("`${ `a  b"), canonical("`${ `a b"));
});

// ── Review round 1 (FUT-4433): division inside a substitution read as a regex. ──
// After a postfix `--`/`++`, or after a property spelled like a keyword
// (`.of`, `.in`, `.do`, `.new`), a `/` divides. Read as a regex, it swallowed
// the substitution's `}` and the template's backtick; a later `}` closed the
// substitution, the NEXT template's backtick ended this one, and that template's
// text was read as code with its whitespace collapsed: no test selected.
const DIVISIONS = {
  "a postfix --": "r.qty-- / 2",
  "a postfix ++": "r.qty++ / 2",
  "a property named of": "r.of / 2",
  "a property named in": "r.in / 12",
  "a property named do": "r.do / 2",
  "a property named new": "r.new / 2",
  // Review round 2: a property whose TAIL spells a keyword.
  "a property named min (ends in in)": "r.min / 2",
  "a property named knew (ends in new)": "r.knew / 2",
  "an optional property named min": "r?.min / 2",
  // Review round 3: a non-ASCII letter is part of the word, so `éin` is not `in`.
  "a property named éin": "r.éin / 2",
  "an identifier named ðin": "ðin / 2",
};
const loop = (div, s) =>
  "export function open(rows) {\n" +
  '  let out = "", total = 0;\n' +
  "  for (const r of rows) { out += `${" + div + "}`; total = out.length / 2; }\n" +
  "  return `R$" + s + "${total}`;\n" +
  "}\n";

for (const [label, div] of Object.entries(DIVISIONS)) {
  test(`canonical: whitespace in a later template after ${label} inside a substitution is a change`, () => {
    assert.notEqual(canonical(loop(div, " ")), canonical(loop(div, "  ")));
  });

  test(`end to end: whitespace in a later template after ${label} inside a substitution selects the test`, () => {
    const r = select(loop(div, " "), loop(div, "  "));
    assert.ok(r.tests.includes(TEST), `selected: ${JSON.stringify(r.tests)} mode=${r.mode}`);
  });
}

test("a regex after `(` inside a substitution is still skipped whole, backtick included", () => {
  const re = (s) => "export const MD = `${(/`/).source} a" + s + "b `;\n" + TAIL;
  assert.notEqual(canonical(re(" ")), canonical(re("  ")));
});
