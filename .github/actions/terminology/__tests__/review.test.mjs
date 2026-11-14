/**
 * Cases a review found green that should not have been: a rewrite that broke
 * the literal it wrote into, a literal the scanner stepped over, a run that
 * judged nothing and passed, and the shapes real files have (a wrapped
 * `keywords:` value, CRLF, a byte order mark).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { parseConfig } from "../lib/config.mjs";
import { git, glossary, repo, run, write } from "./helpers.mjs";

const ARGS = ["--config", "glossary.json"];
const read = (root, file) => readFileSync(join(root, file), "utf8");
const BOM = String.fromCharCode(0xfeff);

test("a substitute holding a quote, a backtick, a backslash or ${ is reported in code and never rewritten", () => {
  const terms = [
    { use: "copo d'água", avoid: ["copo dagua"], autofix: true },
    { use: 'item "à parte"', avoid: ["item avulso"], autofix: true },
    { use: "a`b", avoid: ["crase"], autofix: true },
    { use: "preço ${x}", avoid: ["cifra"], autofix: true },
    { use: "a\\b", avoid: ["barra"], autofix: true },
  ];
  const source = "export const a = 'Um copo dagua aqui';\nexport const b = \"Um item avulso\";\nexport const c = `Uma crase, uma cifra e uma barra`;\n";
  const root = repo({ "glossary.json": glossary({ terms }), "src/q.ts": source, "src/q.md": "Um copo dagua aqui\n" });
  const r = run(root, [...ARGS, "--fix"]);
  assert.equal(r.status, 1);
  assert.equal(read(root, "src/q.ts"), source, "not a byte of the code file changed");
  assert.equal(r.stdout.match(/^src\/q\.ts:\d+:\d+ /gm).length, 5);
  // Plain text has no literal to break: there the same substitute is written.
  assert.equal(read(root, "src/q.md"), "Um copo d'água aqui\n");
  assert.match(r.stdout, /^fixed: src\/q\.md$/m);
  assert.doesNotMatch(r.stdout, /^fixed: src\/q\.ts$/m);
  // And the tree still scans.
  assert.equal(run(root, ARGS).status, 1);
});

test("a literal between two JSX closing tags on one line is judged", () => {
  const first = 'export const A = () => <p><b>x</b> <Chip label="Entregador um" /> fim</p>;\n';
  const second = 'export const B = () => <p><b>Ola</b> <i title="Entregador dois">y</i></p>;\n';
  const root = repo({ "glossary.json": glossary(), "src/jsx1.tsx": first, "src/jsx2.tsx": second });
  const r = run(root, ARGS);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^src/jsx1\\.tsx:1:${first.indexOf("Entregador") + 1} {2}"Entregador" → use "Motoboy"`, "m"));
  assert.match(r.stdout, new RegExp(`^src/jsx2\\.tsx:1:${second.indexOf("Entregador") + 1} {2}"Entregador" → use "Motoboy"`, "m"));
});

test("a term whose paths match no file in scope is exit 2, in a whole-tree and a --base run", () => {
  const terms = [{ use: "motoboy", avoid: ["entregador"], paths: ["scr/**"] }];
  const root = repo({ "glossary.json": glossary({ terms }), "src/a.ts": 'export const a = "Entregador velho";\n' });
  for (const mode of [[], ["--base", "main"]]) {
    const r = run(root, [...ARGS, ...mode]);
    assert.equal(r.status, 2, mode.join(" "));
    assert.match(r.stderr, /terminology: the paths of 1 term\(s\) match no file in scope \(motoboy: scr\/\*\*\): they would never be judged/);
    assert.equal(r.stdout, "");
  }
  // One term off is enough, even beside one that is judged.
  const mixed = glossary({ terms: [...terms, { use: "caixa", avoid: ["PDV"] }] });
  assert.equal(run(repo({ "glossary.json": mixed, "src/a.ts": "x\n" }), ARGS).status, 2);
  // Paths that do reach a file pass.
  const reached = glossary({ terms: [{ use: "motoboy", avoid: ["entregador"], paths: ["src/**"] }] });
  assert.equal(run(repo({ "glossary.json": reached, "src/a.ts": "x\n" }), ARGS).status, 0);
});

test("under --staged a term whose paths reach no staged file is not an error", () => {
  const terms = [{ use: "motoboy", avoid: ["entregador"], paths: ["src/client/**"] }];
  const root = repo({ "glossary.json": glossary({ terms }), "src/client/a.md": "x\n", "src/admin/b.md": "x\n" });
  write(root, { "src/admin/b.md": "x\ny\n" });
  git(root, "add", "-A");
  assert.equal(run(root, [...ARGS, "--staged"]).status, 0);
});

test("a skipped line also skips the deeper-indented lines directly below it", () => {
  const source = [
    "export const copy = {",
    "  entregas: {",
    "    keywords:",
    '      "entrega, taxa do entregador, delivery",',
    '    label: "Fale com o entregador",',
    "  },",
    "  keywords: [",
    '    "Entregador sem escala",',
    "",
    '    "entregadores",',
    "  ],",
    '  title: "Os entregadores",',
    "};",
    "",
  ].join("\n");
  const root = repo({ "glossary.json": glossary({ skipLines: ["keywords:"] }), "src/copy.ts": source });
  const r = run(root, [...ARGS, "--fix"]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(read(root, "src/copy.ts"), source.replace("Fale com o entregador", "Fale com o motoboy").replace("Os entregadores", "Os motoboys"));
  // 14 lines, 6 of them skipped: the two keys, their three value lines and the blank one between.
  assert.match(r.stdout, /1 file\(s\) read, 7 line\(s\) judged, 0 finding\(s\), 2 fixed/);

  // Without the prefix every one of them is judged.
  const judged = run(repo({ "glossary.json": glossary(), "src/copy.ts": source }), ARGS);
  assert.equal(judged.stdout.match(/^src\/copy\.ts:/gm).length, 5);
});

test("a substitute that holds a forbidden form, its own or another term's, is a config error", () => {
  const problems = (terms) => parseConfig({ include: ["**"], terms }).problems;
  assert.deepEqual(problems([{ use: "adicional", avoid: [{ word: "extra", use: "item extra" }] }]), [
    'terms[0].avoid[0]: the substitute "item extra" holds the forbidden "extra" (terms[0].avoid[0]): a fix would never settle',
  ]);
  assert.match(
    problems([
      { use: "sacola", avoid: ["bolsa"] },
      { use: "carrinho", avoid: ["Sacola"] },
    ])[0],
    /^terms\[0\]\.avoid\[0\]: the substitute "sacola" holds the forbidden "sacola" \(terms\[1\]\.avoid\[0\]\)/,
  );
  // Part of a longer word is not the forbidden form.
  assert.deepEqual(problems([{ use: "extraordinário", avoid: ["extra"] }]), []);
  const r = run(repo({ "glossary.json": glossary({ terms: [{ use: "o motoboy", avoid: ["motoboy da casa", "o"] }] }), "src/a.md": "x\n" }), ARGS);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /a fix would never settle/);
});

test("a finding line never starts a workflow command, whatever the file is called", () => {
  const root = repo({ "glossary.json": glossary({ include: ["**/*.md"] }), "::notice::pwn.md": "o entregador\n" });
  for (const extra of [[], ["--fix"]]) {
    const r = run(root, [...ARGS, ...extra], { GITHUB_ACTIONS: "true" });
    const commands = r.stdout.split("\n").filter((line) => line.startsWith("::"));
    assert.equal(commands.every((line) => line.startsWith("::error file=%3A%3Anotice%3A%3Apwn.md,")), true, r.stdout);
    assert.match(r.stdout, extra.length ? /^fixed: \.\/::notice::pwn\.md$/m : /^\.\/::notice::pwn\.md:1:3 {2}"entregador"/m);
  }
});

test("a pragma's word list ends where the list ends, so a reason may follow it", () => {
  const source = [
    'const a = "entregador"; // terminology-allow: entregador (the marketplace\'s own word)',
    "/* terminology-allow-file: um extra, entregadora -- quoted from the contract */",
    'const b = "A entregadora pede um extra e um entregador";',
    'const c = "entregadores"; // terminology-allow: entregadores.',
    "",
  ].join("\n");
  const r = run(repo({ "glossary.json": glossary({ terms: [{ use: "motoboy", avoid: ["entregador", "entregadora", "entregadores", "um extra"] }] }), "src/a.ts": source }), ARGS);
  assert.equal(r.status, 1);
  assert.deepEqual(r.stdout.match(/^src\/a\.ts:\d+:\d+ {2}"[^"]+"/gm), ['src/a.ts:3:45  "entregador"']);
});

test("CRLF line endings: the positions are right and --fix keeps every line ending", () => {
  const source = 'export const a = "x";\r\nexport const b = "O entregador";\r\n// terminology-allow: entregadores\r\nexport const c = "entregadores e Entregador";\r\n';
  const root = repo({ "glossary.json": glossary(), "src/a.ts": source, "src/a.md": "linha\r\no entregador\r\n" });
  const r = run(root, ARGS);
  assert.deepEqual(r.stdout.match(/^src\/a\.\w+:\d+:\d+ /gm), ["src/a.md:2:3 ", "src/a.ts:2:21 ", "src/a.ts:4:34 "]);
  assert.match(r.stdout, /2 file\(s\) read, 6 line\(s\) judged/);
  assert.equal(run(root, [...ARGS, "--fix"]).status, 0);
  assert.equal(read(root, "src/a.ts"), source.replace("O entregador", "O motoboy").replace("e Entregador", "e Motoboy"));
  assert.equal(read(root, "src/a.md"), "linha\r\no motoboy\r\n");
});

test("a byte order mark: the file scans, the column ignores it, and --fix keeps it", () => {
  const root = repo({ "glossary.json": glossary(), "src/a.md": `${BOM}entregador aqui\n`, "src/b.ts": `${BOM}export const a = "Entregador";\n` });
  const r = run(root, ARGS);
  assert.deepEqual(r.stdout.match(/^src\/\w\.\w+:\d+:\d+ /gm), ["src/a.md:1:1 ", "src/b.ts:1:19 "]);
  assert.equal(run(root, [...ARGS, "--fix"]).status, 0);
  assert.equal(read(root, "src/a.md"), `${BOM}motoboy aqui\n`);
  assert.equal(read(root, "src/b.ts"), `${BOM}export const a = "Motoboy";\n`);
});

test("the job summary escapes a backslash before a pipe, so a term cannot break out of its cell", async () => {
  const { stepSummary } = await import("../lib/report.mjs");
  const table = stepSummary({ terms: [{ use: "a\\|b" }], left: [], fixed: [], summary: "done" });
  assert.ok(table.includes("| a\\\\\\|b | 0 | 0 |"), table);
});
