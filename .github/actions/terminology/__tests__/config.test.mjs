/**
 * The glossary file: what a valid one becomes, and every way one is refused.
 *
 * Strictness is the point of this half. A config that is quietly accepted with
 * a typo in it is a rule that is off, and the gate would go on passing.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { listTerms, loadConfig, parseConfig } from "../lib/config.mjs";
import { globMatcher, globToRegExp } from "../lib/globs.mjs";
import { glossary, repo, run } from "./helpers.mjs";

const VALID = {
  include: ["apps/*/src/**/*pt-BR*.ts"],
  exclude: ["**/__tests__/**"],
  skipLines: ["keywords:"],
  terms: [
    {
      use: "motoboy",
      definition: "Quem leva o pedido.",
      search: ["entregador", "courier"],
      avoid: ["entregador", { word: "entregadores", use: "motoboys" }, { word: "entregadora", autofix: false }],
      autofix: true,
      enforce: "new",
      reason: "Always motoboy.",
    },
    { use: "adicional", avoid: [{ word: "extras", use: "adicionais" }], allow: ["horas extras"], paths: ["apps/client/**"] },
    { use: "ficha técnica", definition: "A composição de um produto." },
  ],
};

/** The problems of VALID with one change applied to a deep copy. */
function problemsWith(change) {
  const raw = structuredClone(VALID);
  change(raw);
  return parseConfig(raw).problems;
}

test("a valid glossary parses, with every default filled in", () => {
  const { config, problems } = parseConfig(VALID);
  assert.deepEqual(problems, []);
  const [motoboy, adicional, ficha] = config.terms;
  assert.deepEqual(
    motoboy.avoid.map(({ word, use, autofix }) => ({ word, use, autofix })),
    [
      { word: "entregador", use: "motoboy", autofix: true },
      { word: "entregadores", use: "motoboys", autofix: true },
      { word: "entregadora", use: "motoboy", autofix: false },
    ],
  );
  assert.equal(motoboy.enforce, "new");
  assert.equal(adicional.enforce, "all", "enforce defaults to all");
  assert.equal(adicional.autofix, false, "autofix defaults to false");
  assert.equal(adicional.avoid[0].autofix, false);
  assert.deepEqual(ficha.avoid, [], "a definition-only term forbids nothing");
});

test("a term's paths narrow it inside the scope", () => {
  const { config } = parseConfig(VALID);
  assert.equal(config.terms[1].inPaths("apps/client/src/cart.pt-BR.ts"), true);
  assert.equal(config.terms[1].inPaths("apps/admin/src/cart.pt-BR.ts"), false);
  assert.equal(config.terms[0].inPaths("apps/admin/src/cart.pt-BR.ts"), true, "no paths: everywhere in scope");
});

test("an unknown key is an error at every level, so a typo cannot switch a rule off", () => {
  assert.match(problemsWith((c) => (c.inclde = []))[0], /^config: unknown key "inclde" \(allowed: include, exclude, skipLines, terms\)$/);
  assert.match(problemsWith((c) => (c.terms[0].autofx = true))[0], /^terms\[0\]: unknown key "autofx"/);
  assert.match(problemsWith((c) => (c.terms[0].avoid[1].autofx = true))[0], /^terms\[0\]\.avoid\[1\]: unknown key "autofx" \(allowed: word, use, autofix\)$/);
});

test("include and terms are required and non-empty", () => {
  assert.match(problemsWith((c) => delete c.include)[0], /^include: is required/);
  assert.match(problemsWith((c) => (c.include = []))[0], /^include: is required/);
  assert.match(problemsWith((c) => delete c.terms)[0], /^terms: is required/);
  assert.match(problemsWith((c) => (c.terms = []))[0], /^terms: is required/);
});

test("a term needs a canonical word, and either forbidden words or a definition", () => {
  assert.match(problemsWith((c) => delete c.terms[0].use)[0], /^terms\[0\]\.use: is required/);
  assert.match(problemsWith((c) => (c.terms[2] = { use: "ficha técnica" }))[0], /^terms\[2\]: needs "avoid" \(the forbidden words\) or "definition"/);
  assert.match(problemsWith((c) => (c.terms[0].avoid = []))[0], /^terms\[0\]\.avoid: must be a non-empty list/);
  assert.deepEqual(problemsWith((c) => delete c.terms[0].definition), [], "a term with avoid needs no definition");
});

test("a forbidden word belongs to one rule, whatever its case", () => {
  assert.match(
    problemsWith((c) => c.terms[1].avoid.push("Entregador"))[0],
    /^terms\[1\]\.avoid\[1\]: "Entregador" is already forbidden by terms\[0\]\.avoid\[0\]$/,
  );
  assert.match(problemsWith((c) => c.terms[0].avoid.push("entregador"))[0], /already forbidden by terms\[0\]\.avoid\[0\]/);
});

test("a forbidden word equal to its own substitute is refused", () => {
  assert.match(problemsWith((c) => c.terms[0].avoid.push("Motoboy"))[0], /^terms\[0\]\.avoid\[3\]: "Motoboy" is its own substitute/);
  assert.match(problemsWith((c) => c.terms[0].avoid.push({ word: "motoca", use: "MOTOCA" }))[0], /"motoca" is its own substitute/);
});

test("every field is typed: definition and search are validated even though nothing reads them", () => {
  const wrong = [
    [(c) => (c.terms[0].definition = 3), /^terms\[0\]\.definition: must be a non-empty string$/],
    [(c) => (c.terms[0].search = "entregador"), /^terms\[0\]\.search: must be a list of non-empty strings$/],
    [(c) => (c.terms[0].autofix = "yes"), /^terms\[0\]\.autofix: must be true or false$/],
    [(c) => (c.terms[0].avoid[1].autofix = 1), /^terms\[0\]\.avoid\[1\]\.autofix: must be true or false$/],
    [(c) => (c.terms[0].enforce = "added"), /^terms\[0\]\.enforce: must be "all" or "new"$/],
    [(c) => (c.terms[1].allow = [""]), /^terms\[1\]\.allow: must be a list of non-empty strings$/],
    [(c) => (c.terms[1].paths = []), /^terms\[1\]\.paths: is empty/],
    [(c) => (c.terms[0].reason = "two\nlines"), /^terms\[0\]\.reason: must be one line of text$/],
    [(c) => (c.terms[0].avoid[0] = 7), /^terms\[0\]\.avoid\[0\]: must be a string or \{ "word", "use"\?, "autofix"\? \}$/],
    [(c) => (c.terms[0].avoid[0] = " entregador"), /^terms\[0\]\.avoid\[0\]: must be a non-empty word or phrase on one line$/],
    [(c) => (c.terms[0].avoid[1].use = ""), /^terms\[0\]\.avoid\[1\]\.use: must be a non-empty string$/],
    [(c) => (c.terms[0] = "motoboy"), /^terms\[0\]: must be an object$/],
    [(c) => (c.exclude = "x"), /^exclude: must be a list of non-empty strings$/],
    [(c) => (c.skipLines = [1]), /^skipLines: must be a list of non-empty strings$/],
  ];
  for (const [change, message] of wrong) {
    const problems = problemsWith(change);
    assert.equal(problems.length >= 1, true, String(message));
    assert.match(problems.join("\n"), message);
  }
  assert.deepEqual(parseConfig([]).problems, ["the config must be a JSON object"]);
});

test("a file that is missing or is not JSON is a config problem, not a crash", () => {
  assert.match(loadConfig("/nonexistent/glossary.json").problems[0], /^cannot read the config: /);
});

test("--list prints the terms as JSON, defaults included, and reads no file", () => {
  const root = repo({ "glossary.json": JSON.stringify(VALID) }, { commit: false });
  const r = run(root, ["--config", "glossary.json", "--list"]);
  assert.equal(r.status, 0, r.stderr);
  const listed = JSON.parse(r.stdout);
  assert.deepEqual(listed, listTerms(parseConfig(VALID).config));
  assert.deepEqual(listed.terms[2], {
    use: "ficha técnica",
    definition: "A composição de um produto.",
    search: [],
    avoid: [],
    autofix: false,
    enforce: "all",
    allow: [],
    paths: [],
    reason: "",
  });
  assert.deepEqual(listed.terms[0].search, ["entregador", "courier"]);
});

test("a config problem is exit 2 with every problem named, for --list too", () => {
  const broken = glossary({ terms: [{ use: "motoboy", avoid: ["entregador"], autofx: true }, { use: "caixa" }] });
  const root = repo({ "glossary.json": broken, "src/a.txt": "entregador\n" });
  for (const extra of [[], ["--list"]]) {
    const r = run(root, ["--config", "glossary.json", ...extra]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /terminology: glossary\.json: terms\[0\]: unknown key "autofx"/);
    assert.match(r.stderr, /terminology: glossary\.json: terms\[1\]: needs "avoid"/);
    assert.equal(r.stdout, "");
  }
  const missing = run(root, ["--config", "nope.json"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /terminology: nope\.json: cannot read the config/);
});

test("a glob reads ** as any depth and * as one segment", () => {
  const glob = globToRegExp("apps/*/src/**/*pt-BR*.ts");
  assert.equal(glob.test("apps/admin/src/copy.pt-BR.ts"), true);
  assert.equal(glob.test("apps/admin/src/pages/deep/er/copy.pt-BR.ts"), true);
  assert.equal(glob.test("apps/admin/extra/src/copy.pt-BR.ts"), false, "* does not cross a slash");
  assert.equal(glob.test("apps/admin/src/copy.en.ts"), false);
  assert.equal(globToRegExp("docs/**").test("docs/a/b.md"), true);
  assert.equal(globToRegExp("docs/**").test("docsx/a.md"), false);
});

test("a glob is never compiled as a regex: its other characters are literal", () => {
  // As a regex this would be a syntax error, or match `srcXa.ts`.
  assert.equal(globToRegExp("src/(a.ts").test("src/(a.ts"), true);
  assert.equal(globToRegExp("src.a.ts").test("srcXa.ts"), false);
  const any = globMatcher(["a/*.md", "b/**"]);
  assert.equal(any("b/c/d.txt"), true);
  assert.equal(any("c/d.txt"), false);
  assert.equal(globMatcher([])("anything"), false);
});
