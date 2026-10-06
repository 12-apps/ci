import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { parseConfig } from "../lib/config.mjs";
import { git } from "../lib/git.mjs";
import { BOT, commitRestack, planRestack, restackMessage } from "../lib/restack.mjs";
import { GROUPS, PR_REF, aggregate, groupOf, renderReport, replay } from "../report.mjs";
import { buildCase, caseNamed } from "./restack-world.mjs";

// The report, re-stack-aware: which stacked syncs count, under which group,
// and which are the tool's own merges — over histories built from
// restack-cases.json, with every sync merge written as the tool, a person or
// a forger would write it.

const worlds = [];
after(() => worlds.forEach((w) => w.cleanup()));
const config = parseConfig("{}");
const HUMAN = { name: "Dev", email: "dev@example.invalid" };

/** A world from a case, its PR list, and a way to add a child PR whose head is one sync merge. */
function history(name) {
  const world = buildCase(caseNamed(name));
  worlds.push(world);
  const main = world.tipOf("main");
  const prs = Object.entries(world.case.prs).map(([n, pr]) => ({
    number: Number(n),
    title: `pr ${n}`,
    head: pr.headRef ?? pr.branch,
    base: "main",
    mergedAt: pr.squash ? "2026-01-01T00:00:00Z" : null,
    mergeCommit: pr.squash ? world.labels.get(pr.squash) : null,
  }));
  const plan = planRestack({ child: world.tipOf(world.case.prs[2].branch), base: main, cwd: world.dir, resolve: world.localResolve, self: 2 });
  let date = 1767400000;
  const addSync = (n, { tree = plan.tree, message, identity = HUMAN }) => {
    const child = world.tipOf(world.case.prs[2].branch);
    const sha = commitRestack({ tree, child, base: main, message, cwd: world.dir, identity, date: `@${(date += 1)} +0000` });
    world.git("update-ref", PR_REF(n), sha);
    prs.push({ number: n, title: `child ${n}`, head: `child-${n}`, base: "main", mergedAt: null, mergeCommit: null });
    return sha;
  };
  return { world, main, prs, plan, addSync };
}

/** A tree equal to `tree` except that `path` holds `content`. */
function treeWith(world, tree, path, content) {
  const blob = git(["hash-object", "-w", "--stdin"], { cwd: world.dir, input: content }).out.trim();
  const listing = world.git("ls-tree", tree).split("\n").map((l) => (l.endsWith(`\t${path}`) ? `100644 blob ${blob}\t${path}` : l));
  return git(["mktree"], { cwd: world.dir, input: listing.join("\n") + "\n" }).out.trim();
}

const syncOf = (result, n) => result.syncs.find((s) => s.pr === n);

test("trailers decide nothing alone: tool, redo, no trailer, copied trailer, differing blob", () => {
  const { world, main, prs, plan, addSync } = history("clean re-stack");
  const tool = restackMessage({ base: "main", child: 11, parents: plan.parents });
  addSync(11, { message: tool, identity: BOT });
  addSync(12, { message: restackMessage({ base: "main", child: 12, parents: plan.parents, redo: true }) });
  addSync(13, { message: "Merge main into c (#13)\n" });
  // A trailer copied from another sync: it names another held head.
  addSync(14, { message: restackMessage({ base: "main", child: 14, parents: [{ pr: 1, pOld: world.labels.get("m0") }] }) });
  // Valid trailers, but the committed file is not the tool's merge.
  addSync(15, { message: restackMessage({ base: "main", child: 15, parents: plan.parents }), tree: treeWith(world, plan.tree, "doc.txt", "edited by hand\n") });
  const result = replay({ prs, base: "main", baseTip: main, config, cwd: world.dir });

  const groups = (n) => syncOf(result, n).files.map((f) => [f.file, f.group, f.resolvedBy, f.legacyGroup]);
  assert.deepEqual(groups(11), [["doc.txt", null, "tool", GROUPS.stacked]], "the tool's merge is not counted");
  assert.deepEqual(groups(12), [["doc.txt", null, "redone", GROUPS.stacked]], "Restack-Redo: redone at push");
  assert.deepEqual(groups(13), [["doc.txt", GROUPS.stacked, null, GROUPS.stacked]], "the same tree without trailers is a hand merge");
  assert.deepEqual(groups(14), [["doc.txt", GROUPS.stacked, null, GROUPS.stacked]], "a copied trailer is refused");
  assert.deepEqual(groups(15), [["doc.txt", GROUPS.stacked, null, GROUPS.stacked]], "a differing blob is counted");
  assert.equal(syncOf(result, 11).restack.tool, true);
  assert.equal(syncOf(result, 14).restack.tool, false);

  const report = aggregate(result, { since: "2000-01-01T00:00:00Z", config });
  const g = Object.fromEntries(report.groups.map((x) => [x.name, [x.all, x.legacy.all]]));
  assert.deepEqual(g[GROUPS.stacked], [3, 5], "three hand merges re-stack-aware; all five under the legacy rule");
  assert.equal(report.restack.tool.all, 1);
  assert.equal(report.restack.redone.all, 1);
  assert.deepEqual(report.restack.stacked.syncs.map((s) => s.pr).sort(), [13, 14, 15]);
  const md = renderReport(report, { repo: "o/r", base: "main" });
  assert.match(md, /\| _code: stacked_ \| 3 \| 3 \| 5 \| 5 \|/);
  assert.match(md, /\| re-stacked by the tool \| 1 \| 1 \|/);
  assert.match(md, /\| redone at push \| 1 \| 1 \|/);
  assert.match(md, /Left in `code: stacked` since 2000-01-01: (#1[345] <code>[0-9a-f]{7}<\/code>(, )?){3}\./);
});

test("a residual file is grouped by its shape in the re-stack merge, never as stacked", () => {
  const { world, prs, addSync } = history("residual");
  const child = world.tipOf("c");
  const main = world.tipOf("main");
  const merged = git(["merge-tree", "--write-tree", child, main], { cwd: world.dir, ok: [0, 1] }).out.split("\n")[0];
  const resolved = treeWith(world, merged, "doc.txt", "C-1\nC-2\nl3\nl4\nl5\n");
  addSync(16, { message: "Merge main (#16)\n", tree: resolved });
  const result = replay({ prs, base: "main", baseTip: main, config, cwd: world.dir });
  const files = Object.fromEntries(syncOf(result, 16).files.map((f) => [f.file, [f.group, f.legacyGroup]]));
  assert.deepEqual(files["doc.txt"], [GROUPS.edit, GROUPS.stacked], "a real conflict: concurrent edit");
  assert.deepEqual(files["p.txt"], [GROUPS.stacked, GROUPS.stacked], "the parent's own file: stacked");
  assert.equal(syncOf(result, 16).restack.residual, 1);
});

test("legacy = today's rule plus the merge_commit_sha mapping: a squash with no (#N) is still the parent's", () => {
  const { prs, main, world, addSync } = history("parent squash without a PR number");
  addSync(17, { message: "Merge main (#17)\n" });
  const mapped = syncOf(replay({ prs, base: "main", baseTip: main, config, cwd: world.dir }), 17);
  assert.deepEqual(mapped.stackedOn, [1]);
  for (const f of mapped.files) assert.equal(f.legacyGroup, groupOf(f, { stacked: true }));
  assert.deepEqual(mapped.files.map((f) => f.legacyGroup), [GROUPS.stacked]);
  // Without the PR list's merge commit, only the subject could name it — and it carries no number.
  const unmapped = syncOf(replay({ prs: prs.map((p) => ({ ...p, mergeCommit: null })), base: "main", baseTip: main, config, cwd: world.dir }), 17);
  assert.deepEqual(unmapped.stackedOn, []);
  assert.deepEqual(unmapped.files.map((f) => [f.group, f.legacyGroup]), [[GROUPS.duplicate, GROUPS.duplicate]]);
});

test("a subject naming the wrong PR does not make it the parent: the merge commit wins", () => {
  const { prs, main, world, addSync } = history("parent squash naming the wrong PR");
  addSync(18, { message: "Merge main (#18)\n" });
  const s = syncOf(replay({ prs, base: "main", baseTip: main, config, cwd: world.dir }), 18);
  assert.deepEqual(s.stackedOn, [1]);
  assert.ok(s.files.every((f) => !f.culprits.includes(7)));
});

test("a parent main reverted is left out of Z: the file counts by its shape, not as stacked", () => {
  const { prs, main, world, addSync } = history("reverted parent");
  const merged = git(["merge-tree", "--write-tree", world.tipOf("c"), main], { cwd: world.dir, ok: [0, 1] }).out.split("\n")[0];
  addSync(19, { message: "Merge main (#19)\n", tree: treeWith(world, merged, "doc.txt", "l1\nC2\nl3\nP4\nl5\n") });
  const s = syncOf(replay({ prs, base: "main", baseTip: main, config, cwd: world.dir }), 19);
  assert.deepEqual(s.stackedOn, [1], "the held test still sees the parent");
  assert.deepEqual(s.restack.parents, [], "but the revert keeps it out of Z");
  assert.deepEqual(s.files.map((f) => [f.file, f.group, f.legacyGroup]), [["doc.txt", GROUPS.edit, GROUPS.stacked]]);
});

test("a tool merge whose driver-managed file differs from merge-tree's blob is still the tool's", () => {
  const { world, prs, main, plan, addSync } = history("clean re-stack");
  // A consumer's local command runs a real `git merge`, so a merge driver can
  // write another blob than merge-tree's for the same clean file.
  const withFile = (tree, path, content) => {
    const blob = git(["hash-object", "-w", "--stdin"], { cwd: world.dir, input: content }).out.trim();
    const listing = world.git("ls-tree", tree).split("\n").filter((l) => !l.endsWith(`\t${path}`));
    return git(["mktree"], { cwd: world.dir, input: [...listing, `100644 blob ${blob}\t${path}`].join("\n") + "\n" }).out.trim();
  };
  const edited = treeWith(world, plan.tree, "doc.txt", "what the driver wrote\n");
  const message = (n) => restackMessage({ base: "main", child: n, parents: plan.parents });
  addSync(21, { message: message(21), tree: withFile(edited, ".gitattributes", "doc.txt merge=regenerate\n") });
  addSync(22, { message: message(22), tree: withFile(edited, ".gitattributes", "doc.txt text\n") });
  const result = replay({ prs, base: "main", baseTip: main, config, cwd: world.dir });
  assert.deepEqual(syncOf(result, 21).files.map((f) => [f.file, f.group, f.resolvedBy]), [["doc.txt", null, "tool"]], "a driver ran: the tool's");
  assert.deepEqual(syncOf(result, 22).files.map((f) => [f.file, f.group, f.resolvedBy]), [["doc.txt", GROUPS.stacked, null]], "no driver: a hand edit");
});
