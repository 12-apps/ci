/**
 * The two diff modes, against repositories git builds at test time.
 *
 * `--base <ref>` reads the working tree and counts as new the lines it adds
 * against the merge base; `--staged` reads the index and counts the lines the
 * staged diff adds. Both directions matter: old debt must pass, or a term
 * could never be adopted on new lines only, and a new line must fail, or the
 * rule is decoration.
 */
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { parseAddedLines } from "../lib/git.mjs";
import { commitAll, git, gitWith, glossary, repo, run, scratch, write } from "./helpers.mjs";

const TERMS = [
  { use: "motoboy", avoid: ["entregador"], enforce: "new", reason: "Always motoboy." },
  { use: "caixa", avoid: ["PDV"], enforce: "all" },
];
const ARGS = ["--config", "glossary.json"];
const OLD = "O entregador antigo.\nlinha dois\n";

/** A repository whose `main` already holds a forbidden word on a line nobody is touching. */
const withOldDebt = (files = {}) => repo({ "glossary.json": glossary({ terms: TERMS }), "src/a.md": OLD, ...files });

test("--base: old debt passes for a term enforced on new lines", () => {
  const root = withOldDebt();
  const r = run(root, [...ARGS, "--base", "main"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, "[terminology] 1 file(s) read, 2 line(s) judged, 0 finding(s), 0 fixed.\n");
});

test("--base: a line the working tree adds fails, committed or not", () => {
  const root = withOldDebt();
  git(root, "checkout", "-q", "-b", "feat/copy");
  write(root, { "src/a.md": `${OLD}O entregador novo.\n` });
  const uncommitted = run(root, [...ARGS, "--base", "main"]);
  assert.equal(uncommitted.status, 1);
  assert.match(uncommitted.stdout, /^src\/a\.md:3:3 {2}"entregador" → use "motoboy" {2}\(Always motoboy\.\)\n\[terminology\] 1 file\(s\) read, 3 line\(s\) judged, 1 finding\(s\)/);

  commitAll(root, "add a line");
  const committed = run(root, [...ARGS, "--base", "main"]);
  assert.equal(committed.status, 1);
  assert.match(committed.stdout, /^src\/a\.md:3:3 /);
  assert.doesNotMatch(committed.stdout, /^src\/a\.md:1:/m, "the old line is still not a finding");
});

test("--base: the lines are counted against the merge base, not the tip of the base", () => {
  const root = withOldDebt();
  git(root, "checkout", "-q", "-b", "feat/copy");
  write(root, { "src/other.md": "nada aqui\n" });
  commitAll(root, "branch work");
  // Meanwhile main rewrites the old line. Against main's TIP the branch would
  // seem to add it back; against the merge base it never touched it.
  git(root, "checkout", "-q", "main");
  write(root, { "src/a.md": "O motoboy antigo.\nlinha dois\n" });
  commitAll(root, "sweep on main");
  git(root, "checkout", "-q", "feat/copy");
  const r = run(root, [...ARGS, "--base", "main"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("--base: a term enforced on all lines is judged in every file, changed or not", () => {
  const root = withOldDebt({ "src/untouched.md": "Abra o PDV.\n" });
  write(root, { "src/a.md": `${OLD}mais uma\n` });
  const r = run(root, [...ARGS, "--base", "main"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^src\/untouched\.md:1:8 {2}"PDV" → use "caixa"\n\[terminology\] 2 file\(s\) read, 4 line\(s\) judged, 1 finding\(s\)/);
});

test("--base: the line numbers are the working tree's, where --fix writes", () => {
  const root = withOldDebt();
  write(root, { "src/a.md": `nova primeira\noutra\n${OLD}Chame o entregador.\n` });
  const r = run(root, [...ARGS, "--base", "main"]);
  assert.match(r.stdout, /^src\/a\.md:5:9 /);
  assert.equal(r.stdout.match(/^src\//gm).length, 1, "the old line moved down to line 3 and is still old");
});

test("--base: a line moved from another file counts as added", () => {
  const root = withOldDebt();
  git(root, "mv", "src/a.md", "src/renamed.md");
  const r = run(root, [...ARGS, "--base", "main"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^src\/renamed\.md:1:3 {2}"entregador"/);
});

test("--base: an untracked file in scope is all new; one out of scope or ignored is not read", () => {
  const root = withOldDebt({ ".gitignore": "src/ignored.md\n" });
  write(root, { "src/fresh.md": "Sem nada.\nUm entregador.\n", "src/ignored.md": "entregador\n", "elsewhere/x.md": "entregador\n" });
  const r = run(root, [...ARGS, "--base", "main"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^src\/fresh\.md:2:4 {2}"entregador"/);
  assert.equal(r.stdout.match(/^\S+:\d+:\d+ /gm).length, 1);
});

test("--base: a tracked file deleted from the working tree is not read", () => {
  const root = withOldDebt({ "src/gone.md": "Abra o PDV.\n" });
  rmSync(join(root, "src/gone.md"));
  const r = run(root, [...ARGS, "--base", "main"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 file\(s\) read/);
});

test("--base: a base that does not resolve is exit 2, never a pass", () => {
  const root = withOldDebt();
  const r = run(root, [...ARGS, "--base", "origin/nope"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /terminology: --base origin\/nope does not resolve to a commit: fetch it first/);
  assert.equal(r.stdout, "");
  // A value shaped like an option is a ref that does not resolve, not an option git obeys.
  const option = run(root, [...ARGS, "--base", "--output=/tmp/x"]);
  assert.equal(option.status, 2);
  assert.match(option.stderr, /--base --output=\/tmp\/x does not resolve to a commit/);
});

test("--base: histories with no common commit are exit 2", () => {
  const root = withOldDebt();
  git(root, "checkout", "-q", "--orphan", "unrelated");
  commitAll(root, "another root");
  const r = run(root, [...ARGS, "--base", "main"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--base main and HEAD have no merge base in this checkout: fetch more history/);
});

test("a diff that touches no file in scope is a normal pass, and says so", () => {
  const onlyNew = glossary({ terms: [TERMS[0]] });
  const root = repo({ "glossary.json": onlyNew, "src/a.md": OLD, "other/b.md": "x\n" });
  write(root, { "other/b.md": "entregador\n" });
  for (const mode of [["--base", "main"], ["--staged"]]) {
    git(root, "add", "-A");
    const r = run(root, [...ARGS, ...mode]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, "[terminology] the diff touches no file in scope: nothing to judge.\n[terminology] 0 file(s) read, 0 line(s) judged, 0 finding(s), 0 fixed.\n");
  }
});

test("--staged: the index is judged, not the working tree", () => {
  const root = withOldDebt();
  write(root, { "src/a.md": `${OLD}O entregador novo.\n` });
  git(root, "add", "src/a.md");
  // The working tree moves on: the staged word is gone from it, another appears.
  write(root, { "src/a.md": `${OLD}O motoboy novo.\nOutro entregador.\n` });
  const r = run(root, [...ARGS, "--staged"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^src\/a\.md:3:3 {2}"entregador" → use "motoboy"/);
  assert.equal(r.stdout.match(/^src\//gm).length, 1, "the unstaged line 4 is not what is being committed");
});

test("--staged: only the lines the staged diff adds, for a term enforced on new lines", () => {
  const root = withOldDebt();
  write(root, { "src/a.md": `${OLD}linha limpa\n` });
  git(root, "add", "src/a.md");
  const clean = run(root, [...ARGS, "--staged"]);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /1 file\(s\) read, 3 line\(s\) judged/);
});

test("--staged: a term enforced on all lines is judged on every line of the staged files only", () => {
  const root = withOldDebt({ "src/old-pdv.md": "Abra o PDV.\n", "src/b.md": "PDV antigo\nlinha\n" });
  write(root, { "src/b.md": "PDV antigo\nlinha\nmais uma\n" });
  git(root, "add", "src/b.md");
  const r = run(root, [...ARGS, "--staged"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^src\/b\.md:1:1 {2}"PDV" → use "caixa"\n\[terminology\] 1 file\(s\) read, 3 line\(s\) judged, 1 finding\(s\)/);
});

test("--staged files…: limited to the files given", () => {
  const root = withOldDebt({ "src/b.md": "x\n" });
  write(root, { "src/a.md": `${OLD}entregador\n`, "src/b.md": "x\nentregador\n", "src/c.md": "entregador\n" });
  git(root, "add", "-A");
  assert.equal(run(root, [...ARGS, "--staged"]).stdout.match(/^src\//gm).length, 3);

  const one = run(root, [...ARGS, "--staged", "src/b.md"]);
  assert.equal(one.status, 1);
  assert.match(one.stdout, /^src\/b\.md:2:1 .*\n\[terminology\] 1 file\(s\) read/);

  // As a hook or lint-staged passes them: `./`, absolute, after `--`.
  const forms = run(root, [...ARGS, "--staged", "--", "./src/a.md", join(root, "src/c.md")]);
  assert.deepEqual(forms.stdout.match(/^src\/\w+\.md/gm), ["src/a.md", "src/c.md"]);

  // A file that is not staged, or not in scope, has nothing to judge.
  const none = run(root, [...ARGS, "--staged", "glossary.json", "src/never.md"]);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /the diff touches no file in scope/);
});

test("--staged: a staged deletion is not read", () => {
  const root = withOldDebt({ "src/b.md": "PDV\n" });
  git(root, "rm", "-q", "src/b.md");
  const r = run(root, [...ARGS, "--staged"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /0 file\(s\) read/);
});

test("--staged: the caller's GIT_INDEX_FILE decides which index is read", () => {
  const root = withOldDebt();
  const index = join(scratch(), "index");
  writeFileSync(join(root, "src/a.md"), `${OLD}O entregador novo.\n`);
  // Stage into a temporary index, the way a commit authored with commit-tree does.
  const temporaryIndex = { GIT_INDEX_FILE: index };
  gitWith(temporaryIndex, root, "read-tree", "HEAD");
  gitWith(temporaryIndex, root, "add", "src/a.md");

  const temporary = run(root, [...ARGS, "--staged"], temporaryIndex);
  assert.equal(temporary.status, 1);
  assert.match(temporary.stdout, /^src\/a\.md:3:3 /);
  const real = run(root, [...ARGS, "--staged"]);
  assert.equal(real.status, 0, "the repository's own index has nothing staged");
});

test("the diff reader: hunk headers become added line numbers", () => {
  const patch = [
    "diff --git a/src/a.md b/src/a.md",
    "index 1111111..2222222 100644",
    "--- a/src/a.md",
    "+++ b/src/a.md",
    "@@ -3,0 +4,2 @@ context",
    "+one",
    "+two",
    "@@ -9 +11 @@",
    "-old",
    "+new",
    "@@ -20,3 +21,0 @@",
    "-gone",
    "diff --git a/src/new file.md b/src/new file.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new file.md\t",
    "@@ -0,0 +1 @@",
    "+++ b/not-a-header.md",
    "diff --git a/src/dead.md b/src/dead.md",
    "deleted file mode 100644",
    "--- a/src/dead.md",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-x",
    'diff --git "a/src/q\\"uote.md" "b/src/q\\"uote.md"',
    '--- "a/src/q\\"uote.md"',
    '+++ "b/src/q\\"uote.md"',
    "@@ -1,0 +2 @@",
    "+y",
    "",
  ].join("\n");
  const files = parseAddedLines(patch);
  assert.deepEqual([...files.keys()], ["src/a.md", "src/new file.md", 'src/q"uote.md']);
  assert.deepEqual([...files.get("src/a.md")], [4, 5, 11]);
  assert.deepEqual([...files.get("src/new file.md")], [1], "an added line that starts with ++ is content, not a header");
  assert.deepEqual([...files.get('src/q"uote.md')], [2]);
  assert.deepEqual([...parseAddedLines("").keys()], []);
});
