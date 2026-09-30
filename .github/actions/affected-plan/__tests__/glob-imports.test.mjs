/**
 * Real planner + hashing/filter regression proofs for Vite glob dependencies.
 * No Vite transform/runtime is installed by this suite. Green manifests here
 * are synthetic fixtures, not claims that consumer Vitest suites executed.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";
import { decide } from "../../skip-green/filter.mjs";
import { nextManifest } from "../../skip-green/record.mjs";

const CLI = process.env.GLOB_TEST_CLI ?? fileURLToPath(new URL("../plan.mjs", import.meta.url));
const { parseImports, scan } = await import(pathToFileURL(join(dirname(CLI), "lib/modules.mjs")));
const SUBJECT = "src/glob.test.mjs";
const CONTROL = "src/unrelated.test.mjs";
const CONFIG = {
  workspaces: [], sourceRoots: ["src", "shared"], ignore: String.raw`\.(md|svg)$`,
  lanes: { unit: { roots: ["src"], test: String.raw`\.test\.mjs$`, skipGreen: { globals: [] } } },
};
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function put(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function commit(root, changes) {
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) git(root, "rm", "-q", "--", path);
    else { put(root, path, content); git(root, "add", "--", path); }
  }
  git(root, "commit", "-qm", "test: change glob fixture");
  return git(root, "rev-parse", "HEAD");
}
function fixture(t, files, config = CONFIG) {
  const root = mkdtempSync(join(tmpdir(), "glob-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Glob test");
  git(root, "config", "user.email", "glob@example.test");
  git(root, "config", "commit.gpgsign", "false");
  const tests = {
    [SUBJECT]: "import { files } from './loader.mjs';\nconsole.log(files);\n",
    [CONTROL]: "console.log('independent');\n",
  };
  const base = commit(root, { ".affected-plan.json": JSON.stringify(config), ...tests, ...files });
  return { root, base, tests };
}
function plan(root, base) {
  const result = spawnSync(process.execPath, [CLI, "--base", base, "--out", "plan.json", "--explain", "false"], {
    cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(readFileSync(join(root, "plan.json"), "utf8"));
}
function greenFixture(root, base, tests) {
  const green = commit(root, Object.fromEntries(Object.entries(tests).map(([path, source]) => [path, `${source}console.log('first push');\n`])));
  const initial = plan(root, base);
  assert.deepEqual(initial.tests, [SUBJECT, CONTROL]);
  assert.equal(typeof initial.inputs[SUBJECT], "string", "supported glob must have a bounded hash");
  const manifest = nextManifest({ lane: "unit", plan: initial, laneResult: "success", headSha: green, runId: "fixture-green" }).manifest;
  return { green, initial, manifest };
}
function filtered(plan, manifest) {
  return decide({ plan, manifest, always: new Set(), policy: "enforce", maxShards: 4, perShard: 40 });
}
const loader = (pattern = "'./data/*.mjs'", options = "{ eager: true }") => `export const files = import.meta.glob(${pattern}, ${options});\n`;

for (const [name, files, changes, options = {}] of [
  ["module content", { "src/data/a.mjs": "export const value = 1;\n" }, { "src/data/a.mjs": "export const value = 2;\n" }],
  ["module addition", { "src/data/a.mjs": "export const value = 1;\n" }, { "src/data/b.mjs": "export const value = 2;\n" }],
  ["last module deletion", { "src/data/a.mjs": "export const value = 1;\n" }, { "src/data/a.mjs": null }],
  ["module rename with identical bytes", { "src/data/a.mjs": "export const value = 1;\n" }, { "src/data/a.mjs": null, "src/data/b.mjs": "export const value = 1;\n" }],
  ["first member of an empty glob", {}, { "src/data/new.mjs": "export const value = 1;\n" }],
  ["transitive helper outside graph roots", { "src/data/a.mjs": "import { value } from '../../shared/helper.mjs';\nexport const answer = () => value;\n", "shared/helper.mjs": "export const value = 1;\n" }, { "shared/helper.mjs": "export const value = 2;\n" }],
  ["ignored raw asset bytes", { "src/data/a.md": "first\n" }, { "src/data/a.md": "second\n" }, { pattern: "'./data/*.md'", options: "{ eager: true, query: '?raw', import: 'default' }" }],
  ["ignored asset addition", {}, { "src/data/a.svg": "<svg/>\n" }, { pattern: "'./data/*.svg'", options: "{ query: '?url', import: 'default' }" }],
  ["raw source comment bytes", { "src/data/a.mjs": "// first\nexport const a = 1;\n" }, { "src/data/a.mjs": "// second\nexport const a = 1;\n" }, { options: "{ query: '?raw', import: 'default' }" }],
]) test(`planner/hash/filter: ${name}`, (t) => {
  const { root, base, tests } = fixture(t, { "src/loader.mjs": loader(options.pattern, options.options), ...files });
  const { green, initial, manifest } = greenFixture(root, base, tests);
  commit(root, changes);
  const selected = plan(root, green);
  assert.deepEqual(selected.tests, [SUBJECT], selected.why);
  const cumulative = plan(root, base);
  assert.notEqual(cumulative.inputs[SUBJECT], initial.inputs[SUBJECT]);
  assert.equal(cumulative.inputs[CONTROL], initial.inputs[CONTROL]);
  const decision = filtered(cumulative, manifest);
  assert.deepEqual(decision.plan.tests, [SUBJECT], "changed glob inputs cannot reuse green; independent test still can");
});

test("glob routing supplements an existing source importer", (t) => {
  const { root, base } = fixture(t, {
    "src/loader.mjs": loader(), "src/data/a.mjs": "export const value = 1;\n",
    "src/direct.test.mjs": "import { value } from './data/a.mjs';\nconsole.log(value);\n",
  });
  commit(root, { "src/data/a.mjs": "export const value = 2;\n" });
  assert.deepEqual(plan(root, base).tests, ["src/direct.test.mjs", SUBJECT]);
});

test("arrays, relative exclusions and ** retain selective reusable hashes", (t) => {
  const { root, base, tests } = fixture(t, {
    "src/loader.mjs": loader("['./data/**/*.md', './other/*.md', '!./data/skip.md']", "{ query: '?raw' }"),
    "src/data/deep/a.md": "a", "src/data/skip.md": "ignored", "src/other/b.md": "b", "src/unmatched.md": "unmatched",
  });
  const { green, initial, manifest } = greenFixture(root, base, tests);
  commit(root, { "src/data/skip.md": "still ignored", "src/unmatched.md": "still unmatched" });
  assert.equal(plan(root, green).mode, "none");
  const unchanged = plan(root, base);
  assert.equal(unchanged.inputs[SUBJECT], initial.inputs[SUBJECT]);
  assert.deepEqual(filtered(unchanged, manifest).plan.tests, []);
  const beforeMatch = git(root, "rev-parse", "HEAD");
  commit(root, { "src/data/deep/a.md": "changed" });
  assert.deepEqual(plan(root, beforeMatch).tests, [SUBJECT]);
  assert.notEqual(plan(root, base).inputs[SUBJECT], initial.inputs[SUBJECT]);
});

for (const expression of [
  "import.meta.glob(pattern)", "import.meta.glob('./data/*.md', options)",
  "import.meta.glob('./data/*.md', { base: '../elsewhere' })",
  "import.meta.glob('./data/*.md', { caseSensitive: false })",
  "import.meta.glob('./data/*.md', { exhaustive: true })",
  "import.meta.glob('./data/*.{md,svg}')", "import.meta.glob('@/data/*.md')",
  "import.meta.glob('/data/*.md')", "import.meta.glob('../../outside/*.md')",
  "import.meta.glob('./data/*.md', { query: '?plugin' })",
]) test(`unsupported glob remains blind: ${expression}`, (t) => {
  const { root, base } = fixture(t, { "src/loader.mjs": `export const files = ${expression};\n`, "notes.md": "one" });
  commit(root, { "notes.md": "two" });
  const result = plan(root, base);
  assert.deepEqual(result.tests, [SUBJECT]);
  assert.equal(result.inputs[SUBJECT], null);
  assert.ok(result.counts.blindFiles >= 1);
});

test("untracked filesystem matches refuse a bounded hash", (t) => {
  const { root, base, tests } = fixture(t, { "src/loader.mjs": loader("'./data/*.md'", "{ query: '?raw' }") });
  greenFixture(root, base, tests);
  put(root, "src/data/generated.md", "untracked input");
  assert.equal(plan(root, base).inputs[SUBJECT], null);
});

test("symlink uncertainty is blind instead of excluding a possible match", (t) => {
  const { root, base, tests } = fixture(t, { "src/loader.mjs": loader("'./data/*.md'", "{ query: '?raw' }"), "src/data/a.md": "a" });
  greenFixture(root, base, tests);
  symlinkSync("a.md", join(root, "src/data/link.md"));
  assert.equal(plan(root, base).inputs[SUBJECT], null);
});

test("raw glob files are terminal bytes, while a normal path still expands them", (t) => {
  const { root, base, tests } = fixture(t, {
    "src/loader.mjs": loader("'./data/*.mjs'", "{ query: '?raw' }"),
    "src/data/a.mjs": "import value from './unresolved.mjs';\n",
  });
  const { initial } = greenFixture(root, base, tests);
  assert.equal(typeof initial.inputs[SUBJECT], "string");
  commit(root, { "src/glob.test.mjs": tests[SUBJECT] + "import './data/a.mjs';\n" });
  assert.equal(plan(root, base).inputs[SUBJECT], null);
});

test("a deleted member of a runner-global glob selects the entire lane", (t) => {
  const config = structuredClone(CONFIG);
  config.lanes.unit.skipGreen.globals = [String.raw`^runner/setup\.mjs$`];
  const { root, base } = fixture(t, {
    "src/loader.mjs": "export const files = {};\n",
    "runner/setup.mjs": "const data = import.meta.glob('./data/*.md', { query: '?raw', eager: true });\n",
    "runner/data/a.md": "a",
  }, config);
  commit(root, { "runner/data/a.md": null });
  assert.deepEqual(plan(root, base).tests, [SUBJECT, CONTROL]);
});

test("typed actual-consumer shape parses; quoted glob prose is not code", () => {
  const source = 'const ON_DISK = import.meta.glob<ArticleModule>("../../../content/help/*/*.ts", {\n eager: true,\n});';
  const [record] = parseImports(source);
  assert.deepEqual(record.glob.patterns, ["../../../content/help/*/*.ts"]);
  assert.equal(record.unbounded, false);
  assert.equal(parseImports('const prose = "import.meta.glob(pattern)";').length, 0);
});

for (const [name, source] of [
  ["template interpolation", "export const files = `${Object.keys(import.meta.glob('./data/*.md', { query: '?raw' })).length}`;\n"],
  ["nested template interpolation", "export const files = `${({ text: '}', nested: `inside ${Object.keys(import.meta.glob('./data/*.md', { query: '?raw' })).length}` }).nested}`;\n"],
  ["interpolation after regex and comment braces", "export const files = `${/}/.test('}') ? /* } */ Object.keys(import.meta.glob('./data/*.md', { query: '?raw' })).length : 0}`;\n"],
]) test(`planner/hash/filter: ${name} keeps executable glob dependencies`, (t) => {
  // The first fixture is executable by Vite: adding b.md changes files from
  // '1' to '2', so an unchanged assertion for '1' fails. These planner checks
  // must see that same member addition rather than discard it as ignored prose.
  const { root, base, tests } = fixture(t, { "src/loader.mjs": source, "src/data/a.md": "a" });
  const { green, initial, manifest } = greenFixture(root, base, tests);
  commit(root, { "src/data/b.md": "b" });
  assert.deepEqual(plan(root, green).tests, [SUBJECT]);
  const cumulative = plan(root, base);
  assert.notEqual(cumulative.inputs[SUBJECT], initial.inputs[SUBJECT]);
  assert.equal(cumulative.inputs[CONTROL], initial.inputs[CONTROL]);
  assert.deepEqual(filtered(cumulative, manifest).plan.tests, [SUBJECT]);
});

test("an unsupported glob in template interpolation remains blind", (t) => {
  const { root, base } = fixture(t, {
    "src/loader.mjs": "export const files = `${Object.keys(import.meta.glob(pattern)).length}`;\n", "notes.md": "one",
  });
  commit(root, { "notes.md": "two" });
  const result = plan(root, base);
  assert.deepEqual(result.tests, [SUBJECT]);
  assert.equal(result.inputs[SUBJECT], null);
});

test("template text, escaped interpolations and expression prose stay masked", (t) => {
  const source = [
    "export const files = `import.meta.glob(pattern) ${'import.meta.glob(pattern)'}",
    "  \\${import.meta.glob(pattern)} ${/* import.meta.glob(pattern) } */ 1}",
    "  ${`nested import.meta.glob(pattern)`} ${/import.meta.glob(pattern)/.source}`;",
    "// import.meta.glob(pattern)",
  ].join("\n");
  assert.deepEqual(parseImports(source), []);
  const { code, masked } = scan(source);
  assert.equal(code.length, masked.length);
  assert.equal(code.split("\n").length, source.split("\n").length);
  const { root, base } = fixture(t, { "src/loader.mjs": source, "notes.md": "one" });
  commit(root, { "notes.md": "two" });
  assert.equal(plan(root, base).mode, "none");
});


test("an unmodeled asset transform is blind without a raw/url query", (t) => {
  const { root, base } = fixture(t, {
    "src/loader.mjs": loader("'./data/*.css'"), "src/data/main.css": "@import './other.css';\n", "notes.md": "one",
  });
  commit(root, { "notes.md": "two" });
  const result = plan(root, base);
  assert.deepEqual(result.tests, [SUBJECT]);
  assert.equal(result.inputs[SUBJECT], null);
});
