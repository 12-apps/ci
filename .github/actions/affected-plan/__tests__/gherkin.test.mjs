/**
 * Gherkin selection — step DEFINITIONS, not step files, decide which features
 * run; and every gap in reading a pattern widens instead of dropping a feature.
 *
 * The narrowing is the point (one step file used to mean its whole project),
 * so the widening cases carry as much weight here: a pattern built at run
 * time, a step file with a hook, a `new RegExp` over something that is not a
 * constant. Each of those must still select every feature it might serve.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { changedDeclarations, declarationsOf } from "../lib/exports-dataflow.mjs";
import { cucumberMatcher, featureStepTexts, gherkinFeatures, stepDefinitions } from "../lib/gherkin.mjs";
import { selectAffected } from "../lib/select.mjs";

const CALLS = ["Given", "When", "Then"];

/** A throwaway repo. */
function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "affected-gherkin-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const PROJECT = { steps: "steps", features: "features" };

// --- bracketing -------------------------------------------------------------

test("a top-level step call brackets as its own declaration, never exported", () => {
  const src = ['import { buyers } from "./buyers";', 'Given("a buyer", () => {', "  buyers();", "});", 'When(/^she pays$/, () => {});'].join("\n");
  const decls = declarationsOf(src, { calls: CALLS });
  assert.deepEqual(
    decls.map((d) => [d.name, d.call, d.exported]),
    [
      ["Given@0", true, false],
      ["When@1", true, false],
    ],
  );
});

test("without `calls` a step call is still a side effect — the file widens", () => {
  assert.equal(declarationsOf('Given("a buyer", () => {});'), null);
});

test("an edit inside one step body changes that step and nothing else", () => {
  const base = ['Given("a buyer", () => {', "  one();", "});", 'When("she pays", () => {', "  two();", "});"].join("\n");
  const head = base.replace("two()", "three()");
  assert.deepEqual([...changedDeclarations(base, head, { calls: CALLS })], ["When@1"]);
});

test("an edit to a shared helper changes every step that uses it", () => {
  const base = ["const helper = () => 1;", 'Given("a", () => helper());', 'When("b", () => 2);'].join("\n");
  const head = base.replace("() => 1", "() => 9");
  assert.deepEqual([...changedDeclarations(base, head, { calls: CALLS })], ["Given@0"]);
});

test("a comment-only edit changes no step", () => {
  const base = ['Given("a", () => {', "  one();", "});"].join("\n");
  const head = ['// why', 'Given("a", () => {', "  one(); // still one", "});"].join("\n");
  assert.deepEqual([...changedDeclarations(base, head, { calls: CALLS })], []);
});

test("a hook or any other module-level statement cannot be bracketed", () => {
  const src = ['Before(async () => {', "  reset();", "});", 'Given("a", () => {});'].join("\n");
  assert.equal(changedDeclarations(src, src.replace("reset", "wipe"), { calls: CALLS }), null);
});

// --- patterns ---------------------------------------------------------------

test("a Cucumber expression matches its step line with arguments", () => {
  assert.ok(cucumberMatcher("she buys {int} of {string}").test('she buys 2 of "Empada"'));
  assert.ok(cucumberMatcher("the cart holds {int} item(s)").test("the cart holds 1 item"));
  assert.ok(!cucumberMatcher("she buys {int}").test("she buys two"));
});

test("patterns are read from strings, regex literals and RegExp over constants", () => {
  const src = [
    'const THEY = "(?:she|he|they)";',
    "const PICKS = new RegExp(`^${THEY} picks \"(.+)\"$`);",
    'Given("a buyer named {string}", () => {});',
    "When(/^she pays with (\\w+)$/, () => {});",
    "Then(new RegExp(`^${THEY} sees the receipt$`), () => {});",
    "When(PICKS, () => {});",
    'When(new RegExp(`^${THEY} opens ${"(?:her|his|their)"} favourites$`), () => {});',
  ].join("\n");
  const defs = stepDefinitions(src, CALLS);
  assert.equal(defs.length, 5);
  assert.ok(defs[4].matcher.test("she opens her favourites"));
  assert.ok(defs.every((d) => d.matcher), "every pattern resolves");
  assert.ok(defs[0].matcher.test('a buyer named "Olívia"'));
  assert.ok(defs[1].matcher.test("she pays with pix"));
  assert.ok(defs[2].matcher.test("they sees the receipt"));
  assert.ok(defs[3].matcher.test('he picks "Empada"'));
});

test("a pattern built at run time is unresolved, not guessed", () => {
  const src = ['const SHAPES = new Map([["a", 1]]);', 'const DESCRIBED = new RegExp(`^a store that (${[...SHAPES.keys()].join("|")})$`);', "Given(DESCRIBED, () => {});"].join("\n");
  assert.equal(stepDefinitions(src, CALLS)[0].matcher, null);
});

test("a Feature's description is prose, even when a line starts with When", () => {
  const text = ["Feature: f", "  When the garçom takes the money, the phone learns it.", "  Background:", "    Given a store", "  Scenario: s", "    Then it closes"].join("\n");
  assert.deepEqual(featureStepTexts(text), ["a store", "it closes"]);
});

test("Scenario Outline placeholders expand from every Examples row", () => {
  const text = [
    "Feature: f",
    "  Scenario Outline: o",
    "    Given a buyer named <who>",
    "    Examples:",
    "      | who |",
    "      | Ana |",
    "      | Bia |",
    "  Scenario: s",
    '    When she pays',
    '      """',
    "      Given not a step",
    '      """',
  ].join("\n");
  assert.deepEqual(featureStepTexts(text), ["a buyer named Ana", "a buyer named Bia", "she pays"]);
});

// --- features ---------------------------------------------------------------

const FEATURES = {
  "features/paga.feature": "Feature: p\n  Scenario: s\n    Given a buyer\n    When she pays\n",
  "features/olha.feature": "Feature: o\n  Scenario: s\n    Given a buyer\n    Then she browses\n",
};

test("only the features speaking a reached definition are selected", () => {
  const root = repo({
    ...FEATURES,
    "steps/buyer.steps.ts": 'Given("a buyer", () => {});\nWhen("she pays", () => {});\nThen("she browses", () => {});\n',
  });
  const affected = new Map([["steps/buyer.steps.ts", new Set(["When@1"])]]);
  const out = gherkinFeatures({ repoRoot: root, projects: [PROJECT], calls: CALLS, affected });
  assert.deepEqual(out.features, ["features/paga.feature"]);
  assert.deepEqual(out.steps["steps/buyer.steps.ts"], { definitions: 1, features: ["features/paga.feature"] });
});

test("any reached definition carries the features holding a line no readable pattern matches", () => {
  const root = repo({
    ...FEATURES,
    "features/loja.feature": "Feature: l\n  Scenario: s\n    Given a store that delivers\n",
    "steps/buyer.steps.ts": 'Given("a buyer", () => {});\nWhen("she pays", () => {});\nThen("she browses", () => {});\n',
    "steps/store.steps.ts": 'const KINDS = ["delivers"];\nGiven(new RegExp(`^a store that (${KINDS.join("|")})$`), () => {});\n',
  });
  const affected = new Map([["steps/store.steps.ts", new Set(["Given@0"])]]);
  const out = gherkinFeatures({ repoRoot: root, projects: [PROJECT], calls: CALLS, affected });
  assert.deepEqual(out.features, ["features/loja.feature"]);
  assert.match(out.steps["steps/store.steps.ts"].why, /no readable pattern matches/);
  // A resolved definition elsewhere in the project carries the orphan too —
  // the reader cannot know which definition owns that line.
  const other = gherkinFeatures({ repoRoot: root, projects: [PROJECT], calls: CALLS, affected: new Map([["steps/buyer.steps.ts", new Set(["When@1"])]]) });
  assert.deepEqual(other.features, ["features/loja.feature", "features/paga.feature"]);
});

test("a MISREAD pattern cannot drop its features: their lines are orphans, and orphans ride along", () => {
  // `/^she pays$/i` is read, but suppose the reader got it wrong — model it as
  // a pattern that matches nothing. The feature speaking it must still run.
  const root = repo({
    ...FEATURES,
    "steps/buyer.steps.ts": 'Given("a buyer", () => {});\nWhen("she pays in cash", () => {});\nThen("she browses", () => {});\n',
  });
  const affected = new Map([["steps/buyer.steps.ts", new Set(["When@1"])]]);
  const out = gherkinFeatures({ repoRoot: root, projects: [PROJECT], calls: CALLS, affected });
  assert.deepEqual(out.features, ["features/paga.feature"]);
});

test("a step file that cannot be bracketed selects its whole project, and says why", () => {
  const root = repo({ ...FEATURES, "steps/hooks.steps.ts": 'Before(() => reset());\nGiven("a buyer", () => {});\n' });
  const affected = new Map([["steps/hooks.steps.ts", "*"]]);
  const out = gherkinFeatures({ repoRoot: root, projects: [PROJECT], calls: CALLS, affected });
  assert.deepEqual(out.features, ["features/olha.feature", "features/paga.feature"]);
  assert.match(out.steps["steps/hooks.steps.ts"].why, /module-level statement/);
});

test("a helper beside the steps with no definitions selects nothing itself", () => {
  const root = repo({ ...FEATURES, "steps/world.ts": "export const world = () => 1;\n" });
  const affected = new Map([["steps/world.ts", "*"]]);
  assert.deepEqual(gherkinFeatures({ repoRoot: root, projects: [PROJECT], calls: CALLS, affected }).features, []);
});

// --- end to end through the selector ------------------------------------------

test("a changed import reaches only the step definitions that use it", () => {
  const root = repo({
    ...FEATURES,
    "steps/data.ts": "export const BUYERS = [2];\nexport const OTHER = 1;\n",
    "steps/buyer.steps.ts": [
      'import { BUYERS, OTHER } from "./data";',
      "const byName = new Map(BUYERS.map((b) => [b, b]));",
      'Given("a buyer", () => OTHER);',
      'When("she pays", () => byName.get(1));',
      'Then("she browses", () => OTHER);',
    ].join("\n"),
  });
  const result = selectAffected({
    repoRoot: root,
    changed: ["steps/data.ts"],
    readBase: () => "export const BUYERS = [1];\nexport const OTHER = 1;\n",
    roots: ["steps"],
    workspaceDirs: [],
    isTest: (f) => f.endsWith(".steps.ts"),
    calls: CALLS,
  });
  assert.deepEqual(result.tests, ["steps/buyer.steps.ts"]);
  assert.deepEqual([...result.affected.get("steps/buyer.steps.ts")], ["When@1"]);
  const out = gherkinFeatures({ repoRoot: root, projects: [PROJECT], calls: CALLS, affected: result.affected });
  assert.deepEqual(out.features, ["features/paga.feature"]);
});

test("a direct edit to one step body selects only the features speaking it", () => {
  const head = 'Given("a buyer", () => 1);\nWhen("she pays", () => 3);\nThen("she browses", () => 1);\n';
  const root = repo({ ...FEATURES, "steps/buyer.steps.ts": head });
  const result = selectAffected({
    repoRoot: root,
    changed: ["steps/buyer.steps.ts"],
    readBase: () => head.replace("() => 3", "() => 2"),
    roots: ["steps"],
    workspaceDirs: [],
    isTest: (f) => f.endsWith(".steps.ts"),
    calls: CALLS,
  });
  const out = gherkinFeatures({ repoRoot: root, projects: [PROJECT], calls: CALLS, affected: result.affected });
  assert.deepEqual(out.features, ["features/paga.feature"]);
});

// --- review round 1: every way a change used to drop to zero -------------------

const selectIn = (root, changed, base) =>
  selectAffected({
    repoRoot: root,
    changed,
    readBase: (f) => base[f] ?? null,
    roots: ["steps"],
    workspaceDirs: [],
    isTest: (f) => f.startsWith("steps/"),
    calls: CALLS,
  });

test("a helper changed in a step file reaches that file's own definitions", () => {
  const head = [
    "export function chain() {",
    "  return 2;",
    "}",
    'Given("a buyer", () => 1);',
    'When("she pays", () => chain());',
    'Then("she browses", () => 1);',
  ].join("\n");
  const root = repo({ ...FEATURES, "steps/buyer.steps.ts": head });
  const result = selectIn(root, ["steps/buyer.steps.ts"], { "steps/buyer.steps.ts": head.replace("return 2", "return 1") });
  const out = gherkinFeatures({ repoRoot: root, projects: [PROJECT], calls: CALLS, affected: result.affected });
  assert.deepEqual(out.features, ["features/paga.feature"]);
});

test("a fixture or a world it constructs reaches every definition through createBdd", () => {
  const fixtures = [
    "export class World {",
    "  go() {",
    "    return 2;",
    "  }",
    "}",
    "export const test = base.extend({ world: async ({}, use) => use(new World()) });",
    "export const { Given, When, Then } = createBdd(test);",
  ].join("\n");
  const root = repo({
    ...FEATURES,
    "steps/fixtures.ts": fixtures,
    "steps/buyer.steps.ts": 'import { Given, When, Then } from "./fixtures";\nGiven("a buyer", () => 1);\nWhen("she pays", () => 1);\nThen("she browses", () => 1);\n',
  });
  const result = selectIn(root, ["steps/fixtures.ts"], { "steps/fixtures.ts": fixtures.replace("return 2", "return 1") });
  const out = gherkinFeatures({ repoRoot: root, projects: [PROJECT], calls: CALLS, affected: result.affected });
  assert.deepEqual(out.features, ["features/olha.feature", "features/paga.feature"]);
});

test("a deleted definition widens, and the feature still speaking it is selected", () => {
  const base = 'Given("a buyer", () => 1);\nWhen("she pays", () => 1);\nThen("she browses", () => 1);\n';
  const head = 'Given("a buyer", () => 1);\nThen("she browses", () => 1);\n';
  assert.equal(changedDeclarations(base, head, { calls: CALLS }), null);
  const root = repo({ ...FEATURES, "steps/buyer.steps.ts": head });
  const result = selectIn(root, ["steps/buyer.steps.ts"], { "steps/buyer.steps.ts": base });
  assert.equal(result.affected.get("steps/buyer.steps.ts"), "*");
  const out = gherkinFeatures({ repoRoot: root, projects: [PROJECT], calls: CALLS, affected: result.affected });
  assert.ok(out.features.includes("features/paga.feature"), "the feature whose step vanished must run (and fail)");
});

test("a deleted step file selects the features bound to nothing now", () => {
  const root = repo({ ...FEATURES, "steps/buyer.steps.ts": 'Given("a buyer", () => 1);\nThen("she browses", () => 1);\n' });
  const out = gherkinFeatures({ repoRoot: root, projects: [PROJECT], calls: CALLS, affected: new Map([["steps/pay.steps.ts", "*"]]) });
  assert.deepEqual(out.features, ["features/paga.feature"]);
});

test("whitespace inside a literal is an edit; between tokens it is not", () => {
  const base = 'Then("{string} is named as the reason", () => fill("R$ 5,50"));\n';
  // Inside the PATTERN it is a new pattern: whoever spoke the old one is
  // stranded, so the answer widens.
  assert.equal(changedDeclarations(base, base.replace("the reason", "the  reason"), { calls: CALLS }), null);
  assert.deepEqual([...changedDeclarations(base, base.replace("R$ 5,50", "R$ 5,50"), { calls: CALLS })], ["Then@0"]);
  assert.deepEqual([...changedDeclarations(base, base.replace(", () =>", ",   () =>"), { calls: CALLS })], []);
});

test("semicolon-less calls stay separate definitions, and multi-line calls key by pattern", () => {
  const src = ['When("a", () => 1)', 'When("b", () => 2)', "When(", '  "c",', "  () => 3,", ")"].join("\n");
  assert.deepEqual(declarationsOf(src, { calls: CALLS }).map((d) => d.name), ["When@0", "When@1", "When@2"]);
  assert.deepEqual([...changedDeclarations(src, src.replace("() => 2", "() => 9"), { calls: CALLS })], ["When@1"]);
  assert.deepEqual([...changedDeclarations(src, src.replace("() => 3", "() => 9"), { calls: CALLS })], ["When@2"]);
});

test("two calls with one pattern cannot be told apart: widen", () => {
  const src = 'When("a", () => 1);\nWhen("a", () => 2);\n';
  assert.equal(changedDeclarations(src, src.replace("() => 2", "() => 3"), { calls: CALLS }), null);
});

test("a file with nothing exported and no call cannot earn 'nothing changed'", () => {
  const base = "export default { retries: 1 };\n";
  assert.deepEqual([...changedDeclarations(base, base.replace("1", "2"), { calls: CALLS })], ["default"]);
  assert.equal(changedDeclarations("run();\n", "run(2);\n", { calls: CALLS }), null);
});

test("patterns the reader cannot prove are unresolved, never misread", () => {
  const src = [
    'const P = "the shopper " + "pays";',
    'When("the shopper " + "pays", () => {});',
    "When(P, () => {});",
    "function inner() {",
    '  const Q = "not this";',
    "}",
    'const Q = "the shopper waits";',
    "When(Q, () => {});",
    "When(/^the shopper leaves$/g, () => {});",
  ].join("\n");
  const defs = stepDefinitions(src, CALLS);
  assert.equal(defs[0].matcher, null, "concatenation is an expression");
  assert.equal(defs[1].matcher, null, "a constant holding an expression is too");
  assert.ok(defs[2].matcher.test("the shopper waits"), "the top-level Q, not the inner one");
  assert.ok(defs[3].matcher.test("the shopper leaves") && defs[3].matcher.test("the shopper leaves"), "no g-flag state");
});

test("Cucumber alternation, escapes and every parameter type", () => {
  assert.ok(cucumberMatcher("she pays/checks out").test("she checks out"));
  assert.ok(cucumberMatcher("she pays/checks out").test("she pays out"));
  assert.ok(cucumberMatcher("a total of {double}").test("a total of 5.5"));
  assert.ok(cucumberMatcher("a {color} card").test("a red card"), "a custom type matches anything");
  assert.ok(cucumberMatcher("a \\(literal) paren").test("a (literal) paren"));
  assert.ok(cucumberMatcher("{int} item(s)").test("2 items"));
});

test("a feature this reader cannot read counts as all orphan lines", () => {
  assert.equal(featureStepTexts("# language: pt\nFuncionalidade: f\n  Cenário: s\n    Dado um cliente\n"), null);
  const scenarioExamples = ["Feature: f", "  Scenario: s", "    Given a buyer named <who>", "    Examples:", "      | who |", "      | Ana |"].join("\n");
  assert.deepEqual(featureStepTexts(scenarioExamples), ["a buyer named Ana"]);
  const root = repo({
    ...FEATURES,
    "features/pt.feature": "# language: pt\nFuncionalidade: f\n  Cenário: s\n    Dado um cliente\n",
    "steps/buyer.steps.ts": 'Given("a buyer", () => {});\nWhen("she pays", () => {});\nThen("she browses", () => {});\n',
  });
  const out = gherkinFeatures({ repoRoot: root, projects: [PROJECT], calls: CALLS, affected: new Map([["steps/buyer.steps.ts", new Set(["When@1"])]]) });
  assert.deepEqual(out.features, ["features/paga.feature", "features/pt.feature"]);
});

// --- review round 2 ------------------------------------------------------------

test("a re-usable step bound to a const is a step definition too", () => {
  const head = 'Given("a buyer", () => 1);\nexport const pay = When("she pays", async () => fill("#b"));\nThen("she browses", () => 1);\n';
  const base = head.replace("#b", "#a");
  assert.deepEqual([...changedDeclarations(base, head, { calls: CALLS })].sort(), ["When@1", "pay"]);
  const root = repo({ ...FEATURES, "steps/buyer.steps.ts": head });
  const result = selectIn(root, ["steps/buyer.steps.ts"], { "steps/buyer.steps.ts": base });
  const out = gherkinFeatures({ repoRoot: root, projects: [PROJECT], calls: CALLS, affected: result.affected });
  assert.deepEqual(out.features, ["features/paga.feature"]);
  // Deleting it strands its speakers: widen.
  assert.equal(changedDeclarations(head, head.replace(/export const pay.*\n/, ""), { calls: CALLS }), null);
});

test("a custom parameter type selects broadly but never proves a line is spoken for", () => {
  const root = repo({
    "features/combo.feature": "Feature: c\n  Scenario: s\n    Then the shirt is red and blue\n",
    "features/solid.feature": "Feature: s\n  Scenario: s\n    Then the shirt is red\n",
    "steps/shirt.steps.ts": 'Then("the shirt is {color}", () => {});\n',
    "steps/combo.steps.ts": 'const COMBOS = ["red and blue"];\nThen(new RegExp(`^the shirt is (${COMBOS.join("|")})$`), () => {});\n',
  });
  const out = gherkinFeatures({ repoRoot: root, projects: [PROJECT], calls: CALLS, affected: new Map([["steps/combo.steps.ts", new Set(["Then@0"])]]) });
  assert.ok(out.features.includes("features/combo.feature"));
});

test("Cucumber's float takes an upper-case exponent only", () => {
  assert.ok(cucumberMatcher("{float} km").test("1.5E3 km"));
  assert.ok(!cucumberMatcher("{float} km").test("1.5e3 km"));
});

test("a step registered where this reader cannot bracket it makes the file unbracketable", () => {
  const multiLine = 'Given("a", () => 1);\nconst create: ReturnType<typeof When> =\n  When("she creates {string}", async () => 1);\n';
  assert.equal(declarationsOf(multiLine, { calls: CALLS }), null);
  const inArray = 'Given("a", () => 1);\nexport const steps = [\n  When("she creates {string}", async () => 1),\n];\n';
  assert.equal(declarationsOf(inArray, { calls: CALLS }), null);
  // …which selects the whole project rather than nothing.
  const root = repo({ ...FEATURES, "steps/buyer.steps.ts": inArray });
  const out = gherkinFeatures({ repoRoot: root, projects: [PROJECT], calls: CALLS, affected: new Map([["steps/buyer.steps.ts", "*"]]) });
  assert.deepEqual(out.features, ["features/olha.feature", "features/paga.feature"]);
});
