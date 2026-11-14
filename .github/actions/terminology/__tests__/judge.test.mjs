/**
 * Matching and judging one file: whole words, the substitute's case, skipped
 * lines, new lines only, the two pragmas and the allowed phrases. Every rule
 * is shown both holding and letting the near miss through.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../lib/config.mjs";
import { judgeFile } from "../lib/judge.mjs";
import { buildMatcher, substituteFor } from "../lib/matcher.mjs";

const TERMS = [
  { use: "motoboy", avoid: ["entregador", { word: "entregadores", use: "motoboys" }, { word: "entregadora", autofix: false }], autofix: true, reason: "Always motoboy." },
  { use: "adicional", avoid: [{ word: "extras", use: "adicionais" }, { word: "um extra", use: "um adicional" }, "extra"], allow: ["horas extras", "Hora Extra"] },
  { use: "caixa", avoid: ["PDV", "frente de caixa"], autofix: true },
  { use: "insumo", avoid: ["matéria-prima"], autofix: true },
];

const termsOf = (terms) => parseConfig({ include: ["**"], terms }).config.terms;
const matcher = buildMatcher(termsOf(TERMS));

/** The findings of `text` as "line:col found→use", plus `*` when rewritable. */
function judge(text, { file = "notes.md", added = null, skipLines = [], terms = TERMS } = {}) {
  const result = judgeFile({ file, text, matcher: buildMatcher(termsOf(terms)), skipLines, added });
  assert.equal(result.error, null);
  return result.findings.map((f) => `${f.line}:${f.col} ${f.found}→${f.use}${f.fixable ? "*" : ""}`);
}

test("only whole words match: a letter, a digit or _ on either side is another word", () => {
  const found = (text) => matcher.find(text).map((m) => m.found);
  assert.deepEqual(found("o entregador chegou"), ["entregador"]);
  for (const near of ["entregadorzinho", "superentregador", "entregador2", "2entregador", "entregador_id", "_entregador", "entregadorá", "éentregador"])
    assert.deepEqual(found(near), [], near);
});

test("every other character is a boundary, a hyphen included", () => {
  const found = (text) => matcher.find(text).map((m) => m.found);
  assert.deepEqual(found("Ex-entregadores"), ["entregadores"]);
  assert.deepEqual(found("(entregador), **entregador**. entregador/entregador:entregador"), Array(5).fill("entregador"));
  assert.deepEqual(found("“entregador” — entregador…"), ["entregador", "entregador"]);
});

test("matching ignores case, and the plural is its own form", () => {
  assert.deepEqual(
    matcher.find("Entregador, ENTREGADORES e entregadora").map((m) => [m.found, m.form.use]),
    [
      ["Entregador", "motoboy"],
      ["ENTREGADORES", "motoboys"],
      ["entregadora", "motoboy"],
    ],
  );
});

test("a form may hold a space or a hyphen, and the longest form at a position wins", () => {
  assert.deepEqual(
    matcher.find("a frente de caixa pede matéria-prima e um extra").map((m) => m.found),
    ["frente de caixa", "matéria-prima", "um extra"],
  );
  // Not across a line break, and not as part of a longer hyphenated word's letters.
  assert.deepEqual(
    matcher.find("frente de\ncaixa, matéria-primas").map((m) => m.found),
    [],
  );
});

test("the substitute keeps the case of what it replaces", () => {
  const form = { word: "entregador", use: "motoboy" };
  assert.equal(substituteFor("entregador", form), "motoboy");
  assert.equal(substituteFor("Entregador", form), "Motoboy");
  assert.equal(substituteFor("ENTREGADOR", form), "MOTOBOY");
  assert.equal(substituteFor("eNTREGADOR", form), "motoboy", "anything else is written as the config writes it");
  assert.equal(substituteFor("Frente de caixa", { word: "frente de caixa", use: "caixa" }), "Caixa");
  assert.equal(substituteFor("Um Extra", { word: "um extra", use: "um adicional" }), "Um adicional");
  assert.equal(substituteFor("ENTREGADOR", { word: "entregador", use: "motoboy da loja" }), "MOTOBOY DA LOJA");
});

test("a capitalised configured form is not case-mapped: an acronym's capitals say nothing about the sentence", () => {
  const form = { word: "PDV", use: "caixa" };
  for (const found of ["PDV", "pdv", "Pdv"]) assert.equal(substituteFor(found, form), "caixa", found);
  assert.deepEqual(judge("Abra o PDV. O pdv fechou.\n"), ["1:8 PDV→caixa*", "1:15 pdv→caixa*"]);
});

test("a plain-text file is judged on every line, with line and column", () => {
  assert.deepEqual(judge("# Entregador\n\nO entregador leva.\nSem nada aqui.\n  entregadores e entregadora\n"), [
    "1:3 Entregador→Motoboy*",
    "3:3 entregador→motoboy*",
    "5:3 entregadores→motoboys*",
    "5:18 entregadora→motoboy",
  ]);
  assert.deepEqual(judge("Sem palavra proibida.\n"), []);
});

test("a code file is judged on its literals only", () => {
  const source = [
    `import { entregador } from "./entregador";`,
    `// o entregador, num comentário`,
    `/* entregador */ const entregador = { entregador: "Entregador a caminho", "entregador": 1 };`,
    "const body = `Linha um.\nO entregador chegou.`;",
    "",
  ].join("\n");
  assert.deepEqual(judge(source, { file: "copy.pt-BR.ts" }), ["3:52 Entregador→Motoboy*", "5:3 entregador→motoboy*"]);
  // The same bytes as plain text: every occurrence.
  assert.equal(judge(source, { file: "copy.txt" }).length, 9);
  for (const file of ["a.ts", "a.tsx", "a.js", "a.jsx", "a.mjs", "a.cjs"]) assert.deepEqual(judge(`// entregador\n`, { file }), [], file);
  for (const file of ["a.md", "a.json", "a.yml", "a.tsv", "ts"]) assert.equal(judge(`// entregador\n`, { file }).length, 1, file);
});

test("a word after an escape sequence is whole, and the column is the source column", () => {
  assert.deepEqual(judge(String.raw`const s = "Sem motoboy.\nentregador a caminho\tentregador";` + "\n", { file: "a.ts" }), [
    "1:26 entregador→motoboy*",
    "1:48 entregador→motoboy*",
  ]);
});

test("a match that touches a template expression is reported and never rewritten", () => {
  assert.deepEqual(judge("const s = `${n} entregador${n === 1 ? \"\" : \"es\"} e ${a}entregador, entregador aqui`;\n", { file: "a.ts" }), [
    "1:17 entregador→motoboy",
    "1:56 entregador→motoboy",
    "1:68 entregador→motoboy*",
  ]);
});

test("skipLines: a line whose trimmed text starts with a prefix is never judged", () => {
  const source = `export const article = {\n  keywords: ["entregador", "delivery"],\n  title: "O entregador",\n};\n`;
  assert.deepEqual(judge(source, { file: "a.ts", skipLines: ["keywords:"] }), ["3:13 entregador→motoboy*"]);
  assert.deepEqual(judge(source, { file: "a.ts" }), ["2:15 entregador→motoboy", "3:13 entregador→motoboy*"], "without the prefix the line is judged");
  // The prefix must start the line: one that only contains it is judged.
  assert.deepEqual(judge(`const keywords: string[] = ["Um entregador"];\n`, { file: "a.ts", skipLines: ["keywords:"] }), ["1:33 entregador→motoboy*"]);
  assert.deepEqual(judge("keywords: entregador\nentregador\n", { skipLines: ["keywords:"] }), ["2:1 entregador→motoboy*"]);
});

test("a term enforced on new lines is judged only on the added lines", () => {
  const terms = [
    { use: "motoboy", avoid: ["entregador"], enforce: "new" },
    { use: "caixa", avoid: ["PDV"], enforce: "all" },
  ];
  const text = "entregador PDV\nentregador PDV\nentregador PDV\n";
  assert.deepEqual(judge(text, { terms, added: new Set([2]) }), ["1:12 PDV→caixa", "2:1 entregador→motoboy", "2:12 PDV→caixa", "3:12 PDV→caixa"]);
  assert.deepEqual(judge(text, { terms, added: new Set() }), ["1:12 PDV→caixa", "2:12 PDV→caixa", "3:12 PDV→caixa"]);
  assert.equal(judge(text, { terms, added: null }).length, 6, "null: every line counts as added");
});

test("terminology-allow keeps the named words on its own line and the next one", () => {
  const source = [
    `const a = "entregador"; // terminology-allow: entregador`,
    `// terminology-allow: entregadores, um extra`,
    `const b = "Os entregadores pedem um extra e o entregador";`,
    `const c = "entregadores";`,
    "",
  ].join("\n");
  assert.deepEqual(judge(source, { file: "a.ts" }), ["3:47 entregador→motoboy*", "4:12 entregadores→motoboys"]);
});

test("terminology-allow-file keeps the named words in the whole file, and only those", () => {
  const source = "/* terminology-allow-file: Entregador */\nexport const body = `O entregador\nleva os entregadores.`;\n";
  assert.deepEqual(judge(source, { file: "a.ts" }), ["3:9 entregadores→motoboys*"]);
});

test("in a code file a pragma counts only in a comment", () => {
  const source = 'const a = "terminology-allow: entregador, e o entregador";\nconst b = "terminology-allow-file: entregador";\nconst c = "Um entregador";\n';
  assert.deepEqual(judge(source, { file: "a.ts" }), ["1:31 entregador→motoboy*", "1:47 entregador→motoboy*", "2:36 entregador→motoboy*", "3:15 entregador→motoboy*"]);
});

test("in a plain-text file a pragma is read from the line itself", () => {
  const text = "<!-- terminology-allow: entregador -->\nO entregador antigo.\nO entregador novo.\n";
  assert.deepEqual(judge(text), ["3:3 entregador→motoboy*"]);
  assert.deepEqual(judge("O entregador.\n\n<!-- terminology-allow-file: entregador -->\n"), []);
});

test("a match inside an allowed phrase on its line stands; outside it is a finding", () => {
  assert.deepEqual(judge("Paga horas extras e HORAS EXTRAS, e cobra extras.\n"), ["1:43 extras→adicionais"]);
  assert.deepEqual(judge("Uma Hora extra.\nextra\n"), ["2:1 extra→adicional"]);
  // The phrase allows only its own term's words.
  assert.deepEqual(judge("horas extras do entregador\n"), ["1:17 entregador→motoboy*"]);
});

test("lines judged: the whole file for an all term, the added lines for new terms, never a skipped line", () => {
  const lines = (text, options = {}) =>
    judgeFile({ file: "a.md", text, matcher: buildMatcher(termsOf(options.terms ?? TERMS)), skipLines: options.skipLines ?? [], added: options.added ?? null }).lines;
  assert.equal(lines("um\ndois\ntrês\n"), 3);
  assert.equal(lines("um\ndois\ntrês"), 3, "a last line with no newline is a line");
  assert.equal(lines(""), 0);
  assert.equal(lines("um\nkeywords: x\ntrês\n", { skipLines: ["keywords:"] }), 2);
  const fresh = [{ use: "motoboy", avoid: ["entregador"], enforce: "new" }];
  assert.equal(lines("um\ndois\ntrês\n", { terms: fresh, added: new Set([2, 3]) }), 2);
  assert.equal(lines("um\ndois\ntrês\n", { terms: fresh, added: new Set() }), 0);
});

test("a code file the scanner cannot follow is an error with its line, and no finding", () => {
  const result = judgeFile({ file: "a.tsx", text: `const a = "entregador";\nconst el = <p>d'água</p>;\n`, matcher, skipLines: [], added: null });
  assert.deepEqual(result.error, { line: 2, message: "a string literal is never closed on its line" });
  assert.deepEqual(result.findings, []);
  // The same construct in a file with no forbidden word at all needs no scan, so it passes.
  assert.equal(judgeFile({ file: "a.tsx", text: `const el = <p>d'água</p>;\n`, matcher, skipLines: [], added: null }).error, null);
});
