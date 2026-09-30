import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { parseConfig } from "../lib/config.mjs";
import { GROUPS, PR_REF, aggregate, baseLine, groupOf, renderReport, replay } from "../report.mjs";
import { git } from "../lib/git.mjs";
import { lines, makeRepo } from "./fixture.mjs";

// The history replay, over one fixture repository that holds each case the
// report has to get right:
//
//   PR 10  an open PR that synced with main and conflicted — a code file and
//          a declared-bucket file, so both sides of the group precedence show.
//   PR 20  squash-merged; PR 21 was branched from it and then synced main —
//          the stacked case: the child meets its own parent's squash.
//   PR 30  merged, but main was REWRITTEN afterwards, so PR 30's merge commit
//          is no longer on main. PR 31 had merged that old main commit in; it
//          is still a sync with main, and only the rebuilt base line knows.

const config = parseConfig(
  JSON.stringify({ buckets: [{ name: "dependencies", paths: ["lock.yaml"] }], ticketPattern: "T-\\d+" }),
);

let r;
let prs;
let baseTip;

before(() => {
  r = makeRepo();
  r.commit("base", { "a.txt": lines("1"), "lock.yaml": lines("v") });
  const c0 = r.git("rev-parse", "HEAD");

  // PR 10
  r.checkout("feat1", true);
  r.commit("feat1", { "a.txt": lines("feat"), "lock.yaml": lines("v", "f") });
  r.checkout("main");
  r.commit("land five (#5)", { "a.txt": lines("main"), "lock.yaml": lines("v", "m") });
  r.checkout("feat1");
  r.mergeResolving("main", { "a.txt": lines("both"), "lock.yaml": lines("v", "m", "f") });
  r.git("update-ref", PR_REF(10), "HEAD");

  // PR 20 / PR 21 (stacked)
  r.checkout("main");
  r.checkout("feat2", true);
  const pr20head = r.commit("feat2", { "b.txt": lines("x") });
  r.git("update-ref", PR_REF(20), pr20head);
  r.checkout("feat3", true);
  r.commit("feat3", { "b.txt": lines("x", "y") });
  r.checkout("main");
  r.write({ "b.txt": lines("x") });
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "feat two (#20)");
  const squash20 = r.git("rev-parse", "HEAD");
  r.checkout("feat3");
  r.mergeResolving("main", { "b.txt": lines("x", "y") });
  r.git("update-ref", PR_REF(21), "HEAD");

  // PR 30 / PR 31 (rewritten base)
  r.checkout("main");
  const beforeRewrite = r.git("rev-parse", "HEAD");
  const old30 = r.commit("old thirty (#30)", { "c.txt": lines("c") });
  r.checkout("feat31", true);
  r.git("reset", "-q", "--hard", beforeRewrite);
  r.commit("feat31", { "d.txt": lines("d") });
  r.mergeResolving(old30, {});
  r.git("update-ref", PR_REF(31), "HEAD");
  r.checkout("main");
  r.git("reset", "-q", "--hard", beforeRewrite);
  r.commit("thirty, rewritten (#30)", { "c.txt": lines("c") });
  // PR 40 / PR 41: stacked, and the PARENT merged main in after the child
  // branched off — the parent then holds base commits the child lacks.
  r.checkout("feat40", true);
  const pr40a = r.commit("feat40", { "e.txt": lines("e") });
  r.checkout("feat41", true);
  r.commit("feat41", { "e.txt": lines("e", "child") });
  r.checkout("main");
  r.commit("land six (#6)", { "f.txt": lines("f") });
  r.checkout("feat40");
  const pr40head = r.mergeResolving("main", {});
  r.git("update-ref", PR_REF(40), pr40head);
  r.checkout("main");
  r.write({ "e.txt": lines("e") });
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "feat forty (#40)");
  const squash40 = r.git("rev-parse", "HEAD");
  r.checkout("feat41");
  r.mergeResolving("main", { "e.txt": lines("e", "child") });
  r.git("update-ref", PR_REF(41), "HEAD");
  r.checkout("main");
  assert.ok(pr40a);

  baseTip = r.git("rev-parse", "HEAD");

  prs = [
    { number: 10, title: "feat one (T-1)", head: "feat1", base: "main", mergedAt: null, mergeCommit: null },
    { number: 20, title: "feat two (T-2)", head: "feat2", base: "main", mergedAt: "2026-01-01T00:00:00Z", mergeCommit: squash20 },
    { number: 21, title: "feat three (T-3)", head: "feat3", base: "main", mergedAt: null, mergeCommit: null },
    { number: 30, title: "thirty", head: "feat30", base: "main", mergedAt: "2026-01-01T00:00:00Z", mergeCommit: old30 },
    { number: 31, title: "thirty-one", head: "feat31", base: "main", mergedAt: null, mergeCommit: null },
    { number: 40, title: "forty", head: "feat40", base: "main", mergedAt: "2026-01-01T00:00:00Z", mergeCommit: squash40 },
    { number: 41, title: "forty-one", head: "feat41", base: "main", mergedAt: null, mergeCommit: null },
  ];
  assert.ok(c0);
});

after(() => r?.cleanup());

test("the base line keeps a rewritten-away commit that a merged PR's merge commit still names", () => {
  const line = baseLine({ prs, base: "main", baseTip, cwd: r.dir });
  assert.ok(line.has(prs[3].mergeCommit), "old main commit is on the rebuilt line");
  assert.ok(line.has(baseTip));
  const onlyTip = baseLine({ prs: [], base: "main", baseTip, cwd: r.dir });
  assert.ok(!onlyTip.has(prs[3].mergeCommit), "and today's tip alone does not reach it");
});

test("every sync is found, including the one whose base parent was rewritten away", () => {
  const { syncs, otherMerges } = replay({ prs, base: "main", baseTip, config, cwd: r.dir });
  assert.deepEqual(syncs.map((s) => s.pr).sort((a, b) => a - b), [10, 21, 31, 40, 41]);
  assert.equal(otherMerges, 0);
  assert.equal(syncs.find((s) => s.pr === 31).conflicted, false);
});

test("group precedence: a declared bucket beats the shape; stacked beats the shape", () => {
  const { syncs } = replay({ prs, base: "main", baseTip, config, cwd: r.dir });
  const pr10 = syncs.find((s) => s.pr === 10);
  assert.deepEqual(
    pr10.files.map((f) => [f.file, f.shape, f.group]).sort(),
    [
      ["a.txt", "edit/edit", GROUPS.edit],
      ["lock.yaml", "insert/insert", "dependencies"],
    ],
  );
  const pr21 = syncs.find((s) => s.pr === 21);
  assert.deepEqual(pr21.stackedOn, [20]);
  assert.deepEqual(pr21.files.map((f) => [f.file, f.shape, f.group]), [["b.txt", "add/add", GROUPS.stacked]]);
});

test("groupOf: a stacked sync's declared-bucket file keeps its bucket", () => {
  assert.equal(groupOf({ bucket: "dependencies", shape: "add/add" }, { stacked: true }), "dependencies");
  assert.equal(groupOf({ bucket: "code", shape: "add/add" }, { stacked: false }), GROUPS.duplicate);
  assert.equal(groupOf({ bucket: "code", shape: "modify/delete" }, { stacked: false }), GROUPS.moved);
  assert.equal(groupOf({ bucket: "code", shape: "unknown" }, { stacked: false }), GROUPS.other);
});

test("`until` pins the replay: nothing committed after it is counted", () => {
  const none = replay({ prs, base: "main", baseTip, config, until: "2000-01-01T00:00:00Z", cwd: r.dir });
  assert.equal(none.syncs.length, 0);
  const all = replay({ prs, base: "main", baseTip, config, until: "2999-01-01T00:00:00Z", cwd: r.dir });
  assert.equal(all.syncs.length, 5);
  // At the boundary: a merge committed AT `until` counts, one second before does not.
  const at = git(["show", "-s", "--format=%cI", all.syncs.find((x) => x.pr === 10).commit], { cwd: r.dir }).out.trim();
  const edge = replay({ prs: [prs[0]], base: "main", baseTip, config, until: at, cwd: r.dir });
  assert.equal(edge.syncs.length, 1);
  const before = new Date(Date.parse(at) - 1000).toISOString();
  assert.equal(replay({ prs: [prs[0]], base: "main", baseTip, config, until: before, cwd: r.dir }).syncs.length, 0);
  assert.throws(() => replay({ prs, base: "main", baseTip, config, until: "not a date", cwd: r.dir }), /until is not a date/);
});

test("stacked holds when the parent merged main in after the child branched", () => {
  const { syncs } = replay({ prs, base: "main", baseTip, config, cwd: r.dir });
  const pr41 = syncs.find((s) => s.pr === 41);
  assert.equal(pr41.conflicted, true);
  assert.deepEqual(pr41.stackedOn, [40]);
  assert.deepEqual(pr41.files.map((f) => f.group), [GROUPS.stacked]);
});

test("the aggregate counts pairs, distinct merges, declared-only syncs and the window", () => {
  const result = replay({ prs, base: "main", baseTip, config, cwd: r.dir });
  const report = aggregate(result, { since: "2000-01-01T00:00:00Z", config });
  assert.equal(report.syncs.total, 5);
  assert.equal(report.syncs.conflicted, 3);
  assert.equal(report.syncs.distinctConflictedMerges, 3);
  assert.equal(report.syncs.mechanicalOnly, 0);
  assert.equal(report.syncs.stacked, 2);
  assert.equal(report.files.total, 4);
  assert.equal(report.files.inWindow, 4);
  const g = Object.fromEntries(report.groups.map((x) => [x.name, x.all]));
  assert.deepEqual(g, { dependencies: 1, [GROUPS.edit]: 1, [GROUPS.stacked]: 2 });
  const future = aggregate(result, { since: "2999-01-01T00:00:00Z", config });
  assert.equal(future.files.inWindow, 0);
  const md = renderReport(report, { repo: "o/r", base: "main" });
  assert.match(md, /\*\*3 of 5 syncs conflicted\*\*/);
  assert.match(md, /\| dependencies \| 1 \| 1 \|/);
});
