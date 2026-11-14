/**
 * Which literals of a code file are judged: the sentences, never the code
 * wearing quotes. Each rule is shown skipping what it should and judging the
 * near miss beside it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { GAP, HIDDEN_LETTER, judgedRegions, maskEscapes } from "../lib/literals.mjs";
import { scan } from "../lib/scanner.mjs";

/** The judged text of `source`, in order; `!` marks a region that may be rewritten. */
const judged = (source) => {
  const { literals, error } = scan(source);
  assert.equal(error, null);
  return judgedRegions(source, literals).map((region) => `${region.fixable ? "!" : ""}${region.text}`);
};

test("a module specifier is never judged, in any of its spellings", () => {
  const source = [
    `import { a } from "../entregador novo";`,
    `import "entregador novo";`,
    `export { b } from "entregador novo";`,
    `export * from 'entregador novo';`,
    `const c = await import("entregador novo");`,
    `const d = require("entregador novo");`,
    "const e = import(`entregador novo`);",
    `declare module "entregador novo";`,
  ].join("\n");
  assert.deepEqual(judged(source), []);
});

test("a call that is not an import is judged, and so is a value named from", () => {
  assert.deepEqual(judged(`t("entregador novo"); Array.from("entregador novo"); const from = "entregador novo";`), [
    "!entregador novo",
    "!entregador novo",
    "!entregador novo",
  ]);
});

test("a quoted property key is never judged; its value is", () => {
  assert.deepEqual(judged(`const copy = { "Entregador novo": "Entregador novo", b: 1, "Outro entregador": "x y" };`), ["!Entregador novo", "!x y"]);
  assert.deepEqual(judged(`type T = { "Entregador novo"?: string };`), []);
});

test("the middle arm of a ternary is followed by a colon and is not a key", () => {
  assert.deepEqual(judged(`const label = late ? "Entregador atrasado" : "Entregador a caminho";`), ["!Entregador atrasado", "!Entregador a caminho"]);
  assert.deepEqual(judged(`const copy = { label: late ? "Entregador atrasado" : "No prazo" };`), ["!Entregador atrasado", "!No prazo"]);
});

test("a slug or a path is skipped: lower-case with a separator or a digit", () => {
  const slugs = ["delivery_zone", "entregador-card", "/entregadores/novo", "entregador.svg", "app:entregador", "#entregador", "entregador2", "a@b"];
  for (const slug of slugs) assert.deepEqual(judged(`x = "${slug}";`), [], slug);
  assert.deepEqual(judged("x = `/entregadores/${id}/editar`;"), [], "a template whose text is all path is a path");
});

test("the near misses of a slug are judged: a capital, a space, an accent", () => {
  assert.deepEqual(judged(`x = "Ex-entregadores";`), ["!Ex-entregadores"]);
  assert.deepEqual(judged(`x = "entregador novo";`), ["!entregador novo"]);
  assert.deepEqual(judged(`x = "matéria-prima";`), ["!matéria-prima"]);
  assert.deepEqual(judged("x = `entregadores/${id} a caminho`;"), ["!entregadores/", "! a caminho"]);
});

test("a bare lower-case word is judged but marked as never rewritten", () => {
  assert.deepEqual(judged(`const copy = { ings: "ingredientes", icon: "delivery" };`), ["ingredientes", "delivery"]);
  assert.deepEqual(judged(`const word = n === 1 ? "entregador" : "entregadores";`), ["entregador", "entregadores"]);
  assert.deepEqual(judged("x = `entregador`;"), ["entregador"]);
  // A capital makes it copy: judged and fixable.
  assert.deepEqual(judged(`x = "Delivery"; y = "ENTREGADOR";`), ["!Delivery", "!ENTREGADOR"]);
});

test("a comparison operand and a case label are not judged", () => {
  const source = [
    `if (kind === "entregador") a();`,
    `if (kind !== "entregador") a();`,
    `if (kind == "entregador") a();`,
    `if (kind != "entregador") a();`,
    `if ("entregador" === kind) a();`,
    `if ("entregador" != kind) a();`,
    `switch (kind) { case "entregador": a(); }`,
  ].join("\n");
  assert.deepEqual(judged(source), []);
});

test("a comparison or a case label with real copy in it is still judged", () => {
  assert.deepEqual(judged(`if (label === "Entregador") a(); switch (label) { case "Sem entregador": b(); }`), ["!Entregador", "!Sem entregador"]);
  // An assignment and an arrow are not comparisons.
  assert.deepEqual(judged(`let word = "entregador"; const f = () => "entregador";`), ["entregador", "entregador"]);
});

test("the expressions of a template are code; the literals inside one are judged on their own", () => {
  const source = "const s = `Sem ${entregador} na ${n === 1 ? \"entregador\" : \"Entregadores novos\"} hoje`;";
  assert.deepEqual(judged(source), ["!Sem ", "! na ", "! hoje", "entregador", "!Entregadores novos"]);
});

test("a region records the expression that touches it", () => {
  const source = "x = `entregador${plural} e ${n} entregador`;";
  const { literals } = scan(source);
  assert.deepEqual(
    judgedRegions(source, literals).map(({ text, afterExpr, beforeExpr }) => [text, afterExpr, beforeExpr]),
    [
      ["entregador", false, true],
      [" e ", true, true],
      [" entregador", true, false],
    ],
  );
});

test("an escape sequence is blanked in place, so the word after \\n is whole", () => {
  assert.equal(maskEscapes(String.raw`Linha\nentregador\t"x\"`), `Linha${GAP}${GAP}entregador${GAP}${GAP}"x${GAP}${GAP}`);
  assert.equal(maskEscapes("no escapes"), "no escapes");
  // An escaped LETTER is part of the word beside it.
  assert.equal(maskEscapes(String.raw`entregador\u00e9`), `entregador${HIDDEN_LETTER.repeat(6)}`);
  assert.equal(maskEscapes(String.raw`\x41bc \u{1F600}`), `${HIDDEN_LETTER.repeat(4)}bc ${GAP.repeat(9)}`);
  // A line continuation keeps its newline, so line numbers hold.
  assert.equal(maskEscapes("a\\\nb"), `a${GAP}\nb`);
  const source = String.raw`x = "Sem motoboy.\nentregador a caminho";`;
  assert.equal(judgedRegions(source, scan(source).literals)[0].text.length, String.raw`Sem motoboy.\nentregador a caminho`.length);
});
