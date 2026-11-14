/**
 * `--fix`: it rewrites exactly what it would have reported as fixable, and
 * nothing else. The "nothing else" half is most of this file: a rewrite that
 * touched a property key, an import path, an enum value or a half-staged file
 * would break a build or lose somebody's work.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { applyFixes, shiftColumns } from "../lib/fixer.mjs";
import { git, glossary, repo, run, write } from "./helpers.mjs";

const ARGS = ["--config", "glossary.json"];
const TERMS = [
  { use: "motoboy", avoid: ["entregador", { word: "entregadores", use: "motoboys" }, { word: "entregadora", autofix: false }], autofix: true, reason: "Always motoboy." },
  { use: "caixa", avoid: ["PDV", { word: "PDVs", use: "caixas" }], autofix: true },
  { use: "entrega", avoid: ["delivery"] },
];
const read = (root, file) => readFileSync(join(root, file), "utf8");
const project = (files, options = {}) => repo({ "glossary.json": glossary({ terms: TERMS, ...options }), ...files });

test("--fix rewrites every fixable finding, keeps its case, names the file and exits 0", () => {
  const root = project({ "src/a.md": "O Entregador, o entregador e os ENTREGADORES.\nDois entregadores.\n", "src/clean.md": "nada\n" });
  const r = run(root, [...ARGS, "--fix"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, "fixed: src/a.md\n[terminology] 2 file(s) read, 3 line(s) judged, 0 finding(s), 4 fixed.\n");
  assert.equal(read(root, "src/a.md"), "O Motoboy, o motoboy e os MOTOBOYS.\nDois motoboys.\n");
  assert.equal(git(root, "status", "--porcelain"), " M src/a.md\n", "only that file changed, and only in the working tree");
});

test("what --fix may not rewrite stays a finding, and the exit is 1", () => {
  const root = project({ "src/a.md": "A entregadora e o entregador pedem delivery.\n" });
  const r = run(root, [...ARGS, "--fix"]);
  assert.equal(r.status, 1);
  assert.deepEqual(r.stdout.split("\n"), [
    "fixed: src/a.md",
    'src/a.md:1:3  "entregadora" → use "motoboy"  (Always motoboy.)',
    'src/a.md:1:33  "delivery" → use "entrega"',  // three columns left of where it was: "entregador" became "motoboy"
    "[terminology] 1 file(s) read, 1 line(s) judged, 2 finding(s), 1 fixed.",
    "",
  ]);
  assert.equal(read(root, "src/a.md"), "A entregadora e o motoboy pedem delivery.\n");
});

test("a bare lower-case one-word literal is reported and NOT rewritten by --fix", () => {
  const source = 'export const copy = {\n  ings: "entregadores",\n  word: (n) => (n === 1 ? "entregador" : "entregadores"),\n  title: "Entregadores",\n};\n';
  const root = project({ "src/copy.pt-BR.ts": source });
  const r = run(root, [...ARGS, "--fix"]);
  assert.equal(r.status, 1);
  assert.deepEqual(r.stdout.match(/^src\/copy\.pt-BR\.ts:\d+:\d+ {2}"\w+"/gm), [
    'src/copy.pt-BR.ts:2:10  "entregadores"',
    'src/copy.pt-BR.ts:3:28  "entregador"',
    'src/copy.pt-BR.ts:3:43  "entregadores"',
  ]);
  assert.equal(read(root, "src/copy.pt-BR.ts"), source.replace('"Entregadores"', '"Motoboys"'), "only the capitalised sentence was rewritten");
  assert.doesNotMatch(run(root, ARGS).stdout, /rewritten for you/, "and the report offers no fix for what is left");
});

test("a comparison operand and a case label are not judged, so --fix leaves them alone", () => {
  const source = [
    'if (kind === "entregador" || "entregador" !== other || a == "entregador" || b != "entregador") run();',
    'switch (kind) {\n  case "entregador":\n    break;\n}',
    "",
  ].join("\n");
  const root = project({ "src/logic.ts": source });
  const r = run(root, [...ARGS, "--fix"]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /0 finding\(s\), 0 fixed/);
  assert.equal(read(root, "src/logic.ts"), source);
});

test("a forbidden form the config writes with a capital letter is not case-mapped on a fix", () => {
  const root = project({ "src/a.md": "Abra o PDV. Abra o pdv. Abra o Pdv.\nTODOS OS PDVS E O ENTREGADOR.\n" });
  const r = run(root, [...ARGS, "--fix"]);
  assert.equal(r.status, 0, r.stdout);
  // `PDV` is an acronym: its capitals do not mean the sentence is upper case, so
  // the substitute is written as configured. `entregador` on the same line is mapped.
  assert.equal(read(root, "src/a.md"), "Abra o caixa. Abra o caixa. Abra o caixa.\nTODOS OS caixas E O MOTOBOY.\n");
});

test("--fix never touches a key, an import, a comment, a slug, an expression or a skipped line", () => {
  const source = [
    'import { entregador } from "./entregador";',
    "// O entregador, num comentário. terminology-allow-file: entregadora",
    "export const article = {",
    '  slug: "entregas-nenhum-entregador",',
    '  keywords: ["entregador", "Entregador sem escala"],',
    '  "entregador": "O Entregador chegou\\nentregador a caminho",',
    "  entregador: entregador.nome,",
    '  route: `/entregadores/${entregador.id}`,',
    "  body: `Para o entregador: ${entregador.count} entregador${plural} na rua.",
    "",
    "## Entregadores",
    "Fale com a entregadora.`,",
    "};",
    "",
  ].join("\n");
  const expected = source
    .replace("O Entregador chegou\\nentregador a caminho", "O Motoboy chegou\\nmotoboy a caminho")
    .replace("Para o entregador:", "Para o motoboy:")
    .replace("## Entregadores", "## Motoboys");
  const root = project({ "src/article.ts": source }, { skipLines: ["keywords:"] });
  const r = run(root, [...ARGS, "--fix"]);
  assert.equal(read(root, "src/article.ts"), expected);
  // Left: the word that runs into `${plural}`, which only a person can finish.
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^src\/article\.ts:9:46 {2}"entregador" → use "motoboy"/m);
  assert.match(r.stdout, /1 finding\(s\), 4 fixed/);
});

test("--fix is idempotent, and prints no file when there is nothing to rewrite", () => {
  const root = project({ "src/a.md": "o entregador\n" });
  assert.equal(run(root, [...ARGS, "--fix"]).status, 0);
  const again = run(root, [...ARGS, "--fix"]);
  assert.equal(again.status, 0);
  assert.equal(again.stdout, "[terminology] 1 file(s) read, 1 line(s) judged, 0 finding(s), 0 fixed.\n");
});

test("--base --fix rewrites the new lines only, for a term enforced on new lines", () => {
  const terms = [{ use: "motoboy", avoid: ["entregador"], autofix: true, enforce: "new" }];
  const root = repo({ "glossary.json": glossary({ terms }), "src/a.md": "O entregador antigo.\n" });
  write(root, { "src/a.md": "O entregador antigo.\nO entregador novo.\n", "src/fresh.md": "Um Entregador.\n" });
  const r = run(root, [...ARGS, "--base", "HEAD", "--fix"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^fixed: src\/a\.md\nfixed: src\/fresh\.md\n/);
  assert.equal(read(root, "src/a.md"), "O entregador antigo.\nO motoboy novo.\n");
  assert.equal(read(root, "src/fresh.md"), "Um Motoboy.\n");
});

test("--staged --fix rewrites a file whose working tree matches its index, for the hook to stage again", () => {
  const root = project({ "src/a.md": "linha\n" });
  write(root, { "src/a.md": "linha\nO entregador novo.\n" });
  git(root, "add", "src/a.md");
  const r = run(root, [...ARGS, "--staged", "--fix"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, "fixed: src/a.md\n[terminology] 1 file(s) read, 2 line(s) judged, 0 finding(s), 1 fixed.\n");
  assert.equal(read(root, "src/a.md"), "linha\nO motoboy novo.\n");
  assert.equal(git(root, "show", ":src/a.md"), "linha\nO entregador novo.\n", "the index is the caller's to update");

  // What a hook does with the `fixed:` lines, and what the commit then holds.
  for (const file of r.stdout.match(/^fixed: .+$/gm).map((line) => line.slice("fixed: ".length))) git(root, "add", "--", file);
  assert.equal(run(root, [...ARGS, "--staged"]).status, 0);
});

test("--staged --fix leaves a partially staged file alone: its findings stay, with the command to run by hand", () => {
  const root = project({ "src/a.md": "linha\n", "src/b.md": "linha\n" });
  write(root, { "src/a.md": "linha\nO entregador novo.\n", "src/b.md": "linha\nOutro entregador.\n" });
  git(root, "add", "-A");
  // `a.md` gets a further, unstaged edit: the index and the working tree now differ.
  const dirty = "linha\nO entregador novo.\nmais uma linha, ainda não preparada\n";
  write(root, { "src/a.md": dirty });

  const r = run(root, [...ARGS, "--staged", "--fix"]);
  assert.equal(r.status, 1);
  assert.equal(read(root, "src/a.md"), dirty, "not a byte of the half-staged file changed");
  assert.equal(read(root, "src/b.md"), "linha\nOutro motoboy.\n", "the fully staged one was rewritten");
  assert.deepEqual(r.stdout.split("\n").slice(0, 3), [
    "fixed: src/b.md",
    'src/a.md:2:3  "entregador" → use "motoboy"  (Always motoboy.)',
    "[terminology] 2 file(s) read, 4 line(s) judged, 1 finding(s), 1 fixed.",
  ]);
  assert.match(r.stdout, /\[terminology\] not rewritten, the file has unstaged changes: src\/a\.md\n {2}rewrite the working tree, then stage the corrected lines:\n {2}node \S*check\.mjs --config glossary\.json --base HEAD --fix\n$/);

  // The command it names does the job on the working tree.
  assert.equal(run(root, [...ARGS, "--base", "HEAD", "--fix"]).status, 0);
  assert.equal(read(root, "src/a.md"), dirty.replace("entregador", "motoboy"));
});

test("--staged --fix leaves alone a staged file that is gone from the working tree", () => {
  const root = project({ "src/a.md": "linha\n" });
  write(root, { "src/new.md": "O entregador.\n" });
  git(root, "add", "-A");
  rmSync(join(root, "src/new.md"));
  const r = run(root, [...ARGS, "--staged", "--fix"]);
  assert.equal(r.status, 1);
  assert.equal(existsSync(join(root, "src/new.md")), false, "the file is not written back");
  assert.match(r.stdout, /not rewritten, the file has unstaged changes: src\/new\.md/);
});

test("--fix leaves alone a file that is not valid UTF-8, and says so", () => {
  const root = project({ "src/a.md": "x\n" });
  // "entregador" followed by a Latin-1 e-acute: decoding and re-encoding would change the byte.
  const latin1 = Buffer.concat([Buffer.from("O entregador caf"), Buffer.from([0xe9]), Buffer.from("\n")]);
  writeFileSync(join(root, "src/a.md"), latin1);
  const r = run(root, [...ARGS, "--fix"]);
  assert.equal(r.status, 1);
  assert.deepEqual(readFileSync(join(root, "src/a.md")), latin1);
  assert.match(r.stdout, /^src\/a\.md:1:3 {2}"entregador"/m);
  assert.match(r.stdout, /\[terminology\] not rewritten, the file is not valid UTF-8: src\/a\.md/);
});

test("--fix rewrites nothing when a file could not be scanned", () => {
  const root = project({ "src/a.md": "o entregador\n", "src/view.tsx": "const a = \"Um entregador\";\nconst el = <p>d'água</p>;\n" });
  const r = run(root, [...ARGS, "--fix"]);
  assert.equal(r.status, 2);
  assert.equal(read(root, "src/a.md"), "o entregador\n");
  assert.doesNotMatch(r.stdout, /fixed:/);
});

test("applyFixes replaces each span, whatever the order and the change in length", () => {
  const text = "um entregador, dois entregadores, PDV";
  const findings = [
    { start: 34, end: 37, use: "caixa" },
    { start: 3, end: 13, use: "motoboy" },
    { start: 20, end: 32, use: "motoboys" },
  ];
  assert.equal(applyFixes(text, findings), "um motoboy, dois motoboys, caixa");
  assert.equal(applyFixes(text, []), text);
});

test("a finding left on a rewritten line is reported where it now stands", () => {
  const rewritten = [
    { line: 1, start: 3, found: "entregador", use: "motoboy" },
    { line: 2, start: 50, found: "PDV", use: "caixa" },
  ];
  const left = [
    { line: 1, start: 1, col: 2 },
    { line: 1, start: 20, col: 21 },
    { line: 2, start: 60, col: 11 },
    { line: 3, start: 90, col: 5 },
  ];
  shiftColumns(left, rewritten);
  assert.deepEqual(
    left.map((finding) => finding.col),
    [2, 18, 13, 5],
  );
});
