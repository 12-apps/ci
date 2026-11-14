/**
 * The CLI over a whole tree, in throwaway repositories: what a finding looks
 * like, the three exit statuses, and every way a run refuses to pass having
 * read nothing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { ANNOTATION_LIMIT, errorAnnotation, findingAnnotation, fixCommand } from "../lib/report.mjs";
import { CHECK, glossary, repo, run, scratch, write } from "./helpers.mjs";

const ARGS = ["--config", "glossary.json"];

test("a tree with no forbidden word passes and says what it read", () => {
  const root = repo({ "glossary.json": glossary(), "src/a.md": "O motoboy chegou.\nTudo certo.\n", "src/b.pt-BR.ts": 'export const a = "Motoboy";\n' });
  const r = run(root, ARGS);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, "[terminology] 2 file(s) read, 3 line(s) judged, 0 finding(s), 0 fixed.\n");
});

test("a finding names the file, the line, the column, the word, its substitute and the reason", () => {
  const root = repo({ "glossary.json": glossary(), "src/copy.pt-BR.ts": 'export const copy = {\n  late: "O Entregador atrasou",\n};\n' });
  const r = run(root, ARGS);
  assert.equal(r.status, 1);
  const lines = r.stdout.split("\n");
  assert.equal(lines[0], 'src/copy.pt-BR.ts:2:12  "Entregador" → use "Motoboy"  (Always motoboy.)');
  assert.equal(lines[1], "[terminology] 1 file(s) read, 3 line(s) judged, 1 finding(s), 0 fixed.");
  assert.doesNotMatch(r.stdout, /::error/, "no annotation outside GitHub Actions");
});

test("the last lines name the fix command when a finding can be rewritten, and only then", () => {
  const files = { "src/a.md": "entregador\n" };
  const root = repo({ "glossary.json": glossary(), ...files });
  const fixable = run(root, ARGS);
  const [hint, command] = fixable.stdout.trimEnd().split("\n").slice(-2);
  assert.equal(hint, "[terminology] 1 of them can be rewritten for you:");
  assert.match(command, /^ {2}node \S*check\.mjs --config glossary\.json --fix$/);
  assert.equal(resolve(root, command.trim().split(" ")[1]), CHECK, "the path is this script, as typed from where the run stood");

  const manual = run(repo({ "glossary.json": glossary({ terms: [{ use: "motoboy", avoid: ["entregador"] }] }), ...files }), ARGS);
  assert.equal(manual.status, 1);
  assert.doesNotMatch(manual.stdout, /rewritten for you|--fix/);
  assert.equal(manual.stdout.split("\n")[0], 'src/a.md:1:1  "entregador" → use "motoboy"', "a term with no reason prints none");
});

test("the fix command repeats the call it came from", () => {
  assert.equal(fixCommand({ script: "ci/check.mjs", config: "docs/glossary.json", root: null, mode: ["--base", "origin/main"] }), "node ci/check.mjs --config docs/glossary.json --base origin/main --fix");
  assert.equal(fixCommand({ script: "my ci/check.mjs", config: "it's.json", root: "a b", mode: ["--staged"] }), "node 'my ci/check.mjs' --config 'it'\\''s.json' --root 'a b' --staged --fix");
  assert.equal(fixCommand({ script: "<ci>/x/check.mjs", config: "g.json", root: null, mode: [] }), "node <ci>/x/check.mjs --config g.json --fix");
});

test("only tracked files inside include and outside exclude are read", () => {
  const root = repo({
    "glossary.json": glossary({ include: ["src/**", "docs/*.md"], exclude: ["**/__tests__/**", "src/legacy/**"] }),
    "src/ok.md": "limpo\n",
    "src/__tests__/a.md": "entregador\n",
    "src/legacy/deep/b.md": "entregador\n",
    "docs/deep/c.md": "entregador\n",
    "other/d.md": "entregador\n",
  });
  write(root, { "src/untracked.md": "entregador\n" });
  const r = run(root, ARGS);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^\[terminology\] 1 file\(s\) read, 1 line\(s\) judged, 0 finding\(s\)/);
});

test("a term's paths narrow it inside the scope", () => {
  const terms = [{ use: "carrinho", avoid: ["sacola"], paths: ["src/client/**"] }];
  const root = repo({ "glossary.json": glossary({ terms }), "src/client/a.md": "sacola\n", "src/admin/b.md": "sacola\n" });
  const r = run(root, ARGS);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^src\/client\/a\.md:1:1 {2}"sacola" → use "carrinho"\n\[terminology\] 1 file\(s\) read/);
});

test("a definition-only term is never judged", () => {
  const terms = [{ use: "motoboy", avoid: ["entregador"] }, { use: "receita", definition: "O faturamento." }];
  const r = run(repo({ "glossary.json": glossary({ terms }), "src/a.md": "a receita do dia\n" }), ARGS);
  assert.equal(r.status, 0, r.stdout);
});

test("include globs that match no tracked file are exit 2, judged for the list as a whole", () => {
  const files = { "src/a.md": "limpo\n" };
  const none = run(repo({ "glossary.json": glossary({ include: ["nothing/**", "also/none/*.md"] }), ...files }), ARGS);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /terminology: the include globs match no tracked file \(nothing\/\*\*, also\/none\/\*\.md\): the check would pass having read nothing/);
  // One glob of the list matching is enough: the other is not an error on its own.
  assert.equal(run(repo({ "glossary.json": glossary({ include: ["nothing/**", "src/**"] }), ...files }), ARGS).status, 0);
});

test("a scope that excludes everything it includes is exit 2 as well", () => {
  const r = run(repo({ "glossary.json": glossary({ exclude: ["src/**"] }), "src/a.md": "entregador\n" }), ARGS);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /every file the include globs match is excluded/);
});

test("a glossary that forbids nothing is exit 2, not a pass", () => {
  const r = run(repo({ "glossary.json": glossary({ terms: [{ use: "receita", definition: "O faturamento." }] }), "src/a.md": "x\n" }), ARGS);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no term has an avoid list: the check would pass having judged nothing/);
});

test("a term enforced on new lines with no diff to read them from is exit 2, never a silent pass", () => {
  const terms = [{ use: "motoboy", avoid: ["entregador"], enforce: "new" }, { use: "caixa", avoid: ["PDV"] }];
  const r = run(repo({ "glossary.json": glossary({ terms }), "src/a.md": "limpo\n" }), ARGS);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /terminology: 1 term\(s\) are enforced on new lines only \(motoboy\): pass --base <ref> or --staged/);
  assert.equal(r.stdout, "");
});

test("a wrong call is exit 2 with the usage", () => {
  const root = repo({ "glossary.json": glossary(), "src/a.md": "limpo\n" });
  const cases = [
    [[], /--config is required/],
    [["--config"], /--config needs a value/],
    [[...ARGS, "--base", ""], /--base needs a value/],
    [[...ARGS, "--nope"], /unknown option --nope/],
    [[...ARGS, "src/a.md"], /file arguments are read only with --staged/],
    [[...ARGS, "--base", "HEAD", "--staged"], /--base and --staged are two different diffs/],
  ];
  for (const [args, message] of cases) {
    const r = run(root, args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, message);
  }
  assert.match(run(root, []).stderr, /usage: node check\.mjs --config/);
});

test("outside a git repository is exit 2: there is no tracked file to read", () => {
  const root = scratch();
  write(root, { "glossary.json": glossary(), "src/a.md": "entregador\n" });
  const r = run(root, ARGS);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /terminology: cannot list the files of .*not a git repository/);
});

test("a code file the scanner cannot follow is exit 2 naming the file and the line", () => {
  const root = repo({ "glossary.json": glossary(), "src/ok.ts": 'export const a = "entregador novo";\n', "src/view.tsx": `const label = "entregador novo";\nconst el = <p>copo d'água</p>;\n` });
  const r = run(root, ARGS);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /terminology: could not scan src\/view\.tsx:2: a string literal is never closed on its line\. The file is read as code and nothing in it was judged/);
  assert.doesNotMatch(r.stdout, /finding/, "no verdict is printed for a run that could not read a file");
});

test("--root checks another directory, and the config path is relative to it", () => {
  const root = repo({ "glossary.json": glossary(), "src/a.md": "entregador\n" });
  const r = run(scratch(), ["--root", root, ...ARGS]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^src\/a\.md:1:1 /);
  assert.match(r.stdout, new RegExp(`--config glossary\\.json --root ${root} --fix`));
});

test("under GitHub Actions each finding is an error annotation with its position", () => {
  const root = repo({ "glossary.json": glossary({ terms: [{ use: "motoboy", avoid: ["entregador"], reason: "100% motoboy, sempre: veja o glossário" }] }), "src/a, b.md": "\n  o entregador\n" });
  const r = run(root, ARGS, { GITHUB_ACTIONS: "true" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^src\/a, b\.md:2:5 {2}"entregador" → use "motoboy" {2}\(100% motoboy, sempre: veja o glossário\)$/m);
  // `%` is escaped in the message; `:` and `,` only in a property.
  assert.match(r.stdout, /^::error file=src\/a%2C b\.md,line=2,col=5,title=Terminology::"entregador" → use "motoboy" \(100%25 motoboy, sempre: veja o glossário\)$/m);
});

test("annotation text is escaped: %, CR and LF everywhere, : and , in properties", () => {
  const finding = { file: "a:b,c%.md", line: 3, col: 7, found: "x%\r\ny", use: "z", term: { reason: "" } };
  assert.equal(findingAnnotation(finding, "apps/web/"), '::error file=apps/web/a%3Ab%2Cc%25.md,line=3,col=7,title=Terminology::"x%25%0D%0Ay" → use "z"');
  assert.equal(errorAnnotation("bad: 50%\nnext", { file: "g,1.json", line: 2 }), "::error file=g%2C1.json,line=2,title=Terminology::bad: 50%25%0Anext");
  assert.equal(errorAnnotation("plain"), "::error title=Terminology::plain");
});

test("annotations stop at the limit and the summary counts the rest", () => {
  const many = Array.from({ length: ANNOTATION_LIMIT + 12 }, (_, i) => `linha ${i} entregador`).join("\n");
  const r = run(repo({ "glossary.json": glossary(), "src/a.md": `${many}\n` }), ARGS, { GITHUB_ACTIONS: "true" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout.match(/^::error /gm).length, ANNOTATION_LIMIT);
  assert.equal(r.stdout.match(/^src\/a\.md:\d+:\d+ /gm).length, ANNOTATION_LIMIT + 12, "every finding is still listed");
  assert.match(r.stdout, /42 finding\(s\), 0 fixed\. Annotations stop at 30: 12 more finding\(s\) are only in the list above\./);
  // The fix command names the engine copy: the runner's own path means nothing to a reader.
  assert.match(r.stdout, /node <ci>\/\.github\/actions\/terminology\/check\.mjs --config glossary\.json --fix$/m);

  const few = run(repo({ "glossary.json": glossary(), "src/a.md": "entregador\n" }), ARGS, { GITHUB_ACTIONS: "true" });
  assert.equal(few.stdout.match(/^::error /gm).length, 1);
  assert.doesNotMatch(few.stdout, /Annotations stop/);
});

test("annotation paths are from the repository root when a subdirectory is checked", () => {
  const root = repo({ "web/glossary.json": glossary(), "web/src/a.md": "entregador\n", "src/outside.md": "entregador\n" });
  const r = run(join(root, "web"), ARGS, { GITHUB_ACTIONS: "true" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^src\/a\.md:1:1 /m, "the finding line is relative to the checked directory");
  assert.match(r.stdout, /^::error file=web\/src\/a\.md,line=1,col=1,/m);
  assert.match(r.stdout, /1 file\(s\) read/, "only files under the checked directory");
});

test("a config or scan problem is annotated too, and stays exit 2", () => {
  const broken = run(repo({ "glossary.json": glossary({ nope: 1 }), "src/a.md": "x\n" }), ARGS, { GITHUB_ACTIONS: "true" });
  assert.equal(broken.status, 2);
  assert.match(broken.stdout, /^::error file=glossary\.json,title=Terminology::glossary\.json: config: unknown key "nope"/m);
  const unscannable = run(repo({ "glossary.json": glossary(), "src/v.jsx": "const el = <p>o entregador d'água</p>;\n" }), ARGS, { GITHUB_ACTIONS: "true" });
  assert.equal(unscannable.status, 2);
  assert.match(unscannable.stdout, /^::error file=src\/v\.jsx,line=1,title=Terminology::could not scan src\/v\.jsx:1/m);
});

test("the job summary gets a table: term, findings, fixed", () => {
  const terms = [
    { use: "motoboy", avoid: ["entregador"], autofix: true },
    { use: "caixa", avoid: ["PDV"] },
    { use: "a|b", avoid: ["c"] },
    { use: "receita", definition: "O faturamento." },
  ];
  const root = repo({ "glossary.json": glossary({ terms }), "src/a.md": "entregador e entregador no PDV\n" });
  const summary = join(scratch(), "summary.md");
  const r = run(root, [...ARGS, "--fix"], { GITHUB_STEP_SUMMARY: summary });
  assert.equal(r.status, 1);
  assert.equal(
    readFileSync(summary, "utf8"),
    [
      "### Terminology",
      "",
      "| term | findings | fixed |",
      "| --- | ---: | ---: |",
      "| motoboy | 0 | 2 |",
      "| caixa | 1 | 0 |",
      "| a\\|b | 0 | 0 |",
      "",
      "[terminology] 1 file(s) read, 1 line(s) judged, 1 finding(s), 2 fixed.",
      "",
    ].join("\n"),
  );
  // Without the variable the file is left as it was.
  assert.equal(run(root, ARGS).status, 1);
  assert.equal(readFileSync(summary, "utf8").match(/### Terminology/g).length, 1);
});
