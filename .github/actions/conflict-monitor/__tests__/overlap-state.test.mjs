import { strict as assert } from "node:assert";
import { test } from "node:test";

import { MARKER, decide, isOwnComment, overlapRow, renderOverlap } from "../lib/comment.mjs";
import {
  LIMITS,
  MERGED,
  OVERLAP_BOT,
  OVERLAP_MARKER,
  RESOLVED,
  UNCHECKED,
  decodeEntries,
  fold,
  groupsOf,
  isOverlapComment,
  planOverlap,
  planUnchecked,
  readComment,
  shownPath,
  stateFor,
} from "../lib/overlap-state.mjs";

// The overlap comment's state table, row by row (lib/overlap-state.mjs), the
// untrusted entries line it reads back, and the bounds that keep a comment
// under GitHub's size limit. The rule it keeps: a push that changes nothing
// writes nothing; a partner this comment never named is a NEW comment (an edit
// notifies nobody); everything else is an edit in place.

const ctx = { base: "main", baseSha: "a1b2c3d4e5f6" };
const row = (partner, path = "a.ts", kind = "same lines") => ({ partner, path, kind });
const BOT = { type: "Bot", login: OVERLAP_BOT };
/** Groups for rows, with the partners in `merged` marked merged. */
const groups = (rows, merged = []) => groupsOf(rows).map((g) => (merged.includes(g.partner) ? { ...g, merged: true } : g));
/** The comment a plan would leave, read back the way the next run reads it. */
const after = (plan, self = 1, open = [2, 3, 4]) => readComment({ body: renderOverlap(plan, ctx), user: BOT }, { self, open: new Set(open) });
const b64 = (payload) => Buffer.from(JSON.stringify(payload)).toString("base64url");
const withEntries = (payload, state = "resolved") =>
  `${OVERLAP_MARKER}\n<!-- conflict-monitor:overlap:state ${state} -->\n<!-- conflict-monitor:overlap:entries ${b64(payload)} -->`;
const H = "0123456789ab";

test("no comment → overlapping: create, and the partner is seen", () => {
  const plan = planOverlap(null, groups([row(2)]));
  assert.equal(plan.action, "create");
  assert.deepEqual(plan.seen, [2]);
  const body = renderOverlap(plan, ctx);
  assert.ok(body.startsWith(OVERLAP_MARKER));
  assert.match(body, /\| #2 \| <code>a\.ts<\/code> \| same lines \|/);
  assert.match(body, /No action needed\. If #2 merges first, the conflict comment will list what to resolve\./);
});

test("no overlap and no comment: nothing", () => {
  assert.deepEqual(planOverlap(null, []), { action: "none" });
});

test("the same set again: nothing — however the rows are ordered", () => {
  const prev = after(planOverlap(null, groups([row(2, "a.ts"), row(2, "b.ts", "same spot")])));
  assert.equal(prev.trusted, true);
  assert.deepEqual(planOverlap(prev, groups([row(2, "b.ts", "same spot"), row(2, "a.ts")])), { action: "none" });
});

test("a partner never seen: re-post; a partner's paths or kinds change, or a partner drops out: edit", () => {
  const prev = after(planOverlap(null, groups([row(2)])));
  const added = planOverlap(prev, groups([row(2), row(3, "c.ts")]));
  assert.equal(added.action, "repost");
  assert.deepEqual(added.seen, [2, 3], "a re-post starts `seen` over with what it names");
  const two = after(added);
  assert.equal(planOverlap(two, groups([row(2), row(3, "c.ts", "same spot")])).action, "update");
  const dropped = planOverlap(two, groups([row(2)]));
  assert.equal(dropped.action, "update");
  assert.deepEqual(dropped.seen, [2, 3], "a partner that drops out stays seen");
  assert.equal(planOverlap(after(dropped), groups([row(2), row(3, "c.ts")])).action, "update", "…and coming back is an edit");
});

test("nothing left: resolved, once", () => {
  const plan = planOverlap(after(planOverlap(null, groups([row(2)]))), []);
  assert.equal(plan.action, "update");
  const resolved = after(plan);
  assert.equal(resolved.state, RESOLVED);
  assert.match(renderOverlap(plan, ctx), /No open PR overlaps this one any more/);
  assert.deepEqual(planOverlap(resolved, []), { action: "none" });
});

test("resolved → overlapping: re-post, even for a partner seen before", () => {
  const resolved = after(planOverlap(after(planOverlap(null, groups([row(2)]))), []));
  assert.equal(planOverlap(resolved, groups([row(2)])).action, "repost");
});

test("merged groups stay in the digest; only merged groups left is `merged`; then overlapping again re-posts", () => {
  const prev = after(planOverlap(null, groups([row(2), row(3, "c.ts")])), 1, [2, 3]);
  assert.notEqual(stateFor(fold(groups([row(2), row(3, "c.ts")], [3]))), stateFor(fold(groups([row(2), row(3, "c.ts")]))));
  const one = planOverlap(prev, groups([row(2), row(3, "c.ts")], [3]));
  assert.equal(one.action, "update");
  const body = renderOverlap(one, ctx);
  assert.match(body, /#3 merged\. If this PR now conflicts, the conflict comment lists the files\./);
  assert.match(body, /If #2 merges first/);
  const both = planOverlap(after(one, 1, [2]), groups([row(2), row(3, "c.ts")], [2, 3]));
  assert.equal(both.action, "update");
  const merged = after(both, 1, []);
  assert.equal(merged.state, MERGED);
  assert.deepEqual(planOverlap(merged, merged.groups), { action: "none" });
  const again = planOverlap(merged, [...merged.groups, ...groups([row(4)])]);
  assert.equal(again.action, "repost");
  assert.deepEqual(again.groups.map((g) => g.partner), [4], "a re-post drops the merged groups");
});

test("an untrusted comment is rewritten in place — never trusted for a no-op, never a re-post, whatever its state line says", () => {
  const good = renderOverlap(planOverlap(null, groups([row(2)])), ctx);
  const junk = good.replace(/entries \S+/, "entries !!!");
  for (const state of ["resolved", "merged", "unchecked", /state (\S+)/.exec(good)[1]]) {
    const prev = readComment({ body: junk.replace(/state \S+/, `state ${state}`), user: BOT }, { self: 1, open: new Set([2, 3]) });
    assert.equal(prev.trusted, false, state);
    assert.equal(prev.state, null, "an untrusted state is no state");
    assert.equal(planOverlap(prev, groups([row(2)])).action, "update", state);
    assert.equal(planOverlap(prev, groups([row(2), row(3)])).action, "update", state);
  }
  const other = renderOverlap(planOverlap(null, groups([row(3)])), ctx);
  const spliced = good.replace(/entries \S+/, other.match(/entries \S+/)[0]);
  assert.equal(readComment({ body: spliced, user: BOT }, { self: 1, open: new Set([2, 3]) }).trusted, false, "entries that do not digest to the state line");
});

test("a bad entries payload is dropped whole", () => {
  const open = new Set([2]);
  const g = (partner, rows = [["a.ts", "same lines"]], merged = 0, total = rows.length || 1) => [partner, total, H, merged, rows];
  const bad = [
    { g: [g("2")], s: [] }, // partner not an integer
    { g: [g(2.5)], s: [] },
    { g: [g(1)], s: [] }, // the PR itself
    { g: [g(2), g(2)], s: [] }, // the same partner twice
    { g: [g(2, [["a.ts", "<img src=x>"]])], s: [] }, // not a kind
    { g: [g(2, [["", "same lines"]])], s: [] },
    { g: [g(2, [["a\nb", "same lines"]])], s: [] }, // a control character: shownPath never writes one
    { g: [g(2, [["x".repeat(LIMITS.path + 1), "same lines"]])], s: [] },
    { g: [g(2, [], 1)], s: [] }, // an OPEN partner cannot have merged
    { g: [[2, 0, H, 0, []]], s: [] }, // a group with no rows
    { g: [[2, 1, "nothex", 0, []]], s: [] },
    { g: [g(2)], s: ["2"] },
    { g: Array.from({ length: LIMITS.partners + 1 }, (_, i) => g(100 + i)), s: [] },
    { g: [g(7, Array.from({ length: LIMITS.rows + 1 }, (_, i) => [`f${i}`, "same lines"]))], s: [] },
    { g: [g(2)], s: [], r: [3, 1, H] }, // a rest with fewer than LIMITS.partners groups
    { g: {}, s: [] },
  ];
  for (const payload of bad) assert.equal(decodeEntries(withEntries(payload), { self: 1, open }), null, JSON.stringify(payload).slice(0, 120));
  assert.equal(decodeEntries(`${OVERLAP_MARKER}\n<!-- conflict-monitor:overlap:entries !!! -->`, { self: 1, open }), null);
  assert.ok(decodeEntries(withEntries({ g: [g(7, [["a.ts", "distinct types"]], 1)], s: [2, 7] }), { self: 1, open }), "a merged partner that is not open");
  assert.deepEqual(decodeEntries(withEntries({ g: [g(2)], s: [2, 99] }), { self: 1, open }).seen, [2], "a seen partner nobody knows is dropped");
});

test("1,000+ rows over 60 partners, worst-case paths: the body stays under the ceiling, reads back trusted, and a hidden row still moves the digest", () => {
  const rows = [];
  for (let p = 0; p < 60; p += 1) {
    for (let i = 0; i < 35; i += 1) rows.push(row(1000 + p, `${"|`@<".repeat(80)}/${i}`, "same lines"));
  }
  const plan = planOverlap(null, groupsOf(rows));
  const body = renderOverlap(plan, ctx);
  assert.ok(body.length <= LIMITS.body, `${body.length} characters`);
  const open = new Set(rows.map((r) => r.partner));
  const back = readComment({ body, user: BOT }, { self: 1, open });
  assert.equal(back.trusted, true);
  assert.equal(back.groups.length, LIMITS.partners);
  assert.equal(back.rest.partners, 10);
  assert.deepEqual(planOverlap(back, groupsOf(rows)), { action: "none" }, "the next run over the same rows writes nothing");
  // The last row of the last partner is never shown; changing it moves the digest.
  const changed = rows.map((r, i) => (i === rows.length - 1 ? { ...r, kind: "same spot" } : r));
  assert.equal(planOverlap(back, groupsOf(changed)).action, "update");
  assert.match(body, /\| 10 more PR\(s\) \| \| \|/);
});

test("typical paths: 1,200 rows show the first 100 and count the rest per partner", () => {
  const rows = Array.from({ length: 1200 }, (_, i) => row(2300 + (i % 3), `apps/admin/src/features/configuracao/vendas/components/file-${String(i).padStart(4, "0")}.tsx`));
  const body = renderOverlap(planOverlap(null, groupsOf(rows)), ctx);
  assert.ok(body.length < 40_000, `${body.length}`);
  assert.equal(body.split("\n").filter((l) => l.startsWith("| #") && l.includes("<code>")).length, LIMITS.rows);
  assert.match(body, /\| #2300 \| 300 more file\(s\) \| \|/);
  assert.match(body, /\| #2302 \| 400 more file\(s\) \| \|/);
  assert.equal(readComment({ body, user: BOT }, { self: 1, open: new Set([2300, 2301, 2302]) }).trusted, true);
});

test("a path cannot break the table or inject markup; a partner is #N only", () => {
  for (const evil of ["x` [click](https://evil.example) @someone `y|z.md", "x\n\n## Heading [link](https://evil.example)\r\u2028y"]) {
    const body = renderOverlap(planOverlap(null, groups([row(2, evil)])), ctx);
    const line = body.split("\n").find((l) => l.includes("evil"));
    assert.equal(line.split("|").length, 5, "the pipe did not add a column, the newline did not end the row");
    assert.ok(!line.includes("`") && !line.includes("@someone"));
    assert.doesNotMatch(body, /^## Heading/m);
    assert.ok(!/@\w/.test(body.replace(/<code>.*<\/code>/g, "")), "no @mention anywhere");
  }
  assert.equal(shownPath("a\tb\u0000"), "a\u2409b\u2400");
  assert.equal(overlapRow(2, "a\nb", "same lines"), "| #2 | <code>a\u240ab</code> | same lines |");
});

test("an open PR no longer paired is told once, and its next overlap is a re-post", () => {
  const overlapping = after(planOverlap(null, groups([row(2)])));
  const plan = planUnchecked(overlapping);
  assert.equal(plan.action, "update");
  assert.match(renderOverlap(plan, ctx), /no longer checked for overlaps/);
  const unchecked = after(plan);
  assert.equal(unchecked.state, UNCHECKED);
  assert.deepEqual(planUnchecked(unchecked), { action: "none" });
  assert.deepEqual(planUnchecked(null), { action: "none" });
  assert.equal(planOverlap(unchecked, groups([row(2)])).action, "repost");
});

test("only github-actions[bot] with the marker is the overlap comment; E0's comment and this one never match each other", () => {
  const overlap = renderOverlap(planOverlap(null, groups([row(2)])), ctx);
  const e0 = decide([{ file: "a.ts", shape: "edit/edit", bucket: "code", culprits: [] }], null, ctx).body;
  assert.equal(isOverlapComment({ body: overlap, user: BOT }), true);
  assert.equal(isOverlapComment({ body: overlap, user: { type: "User", login: OVERLAP_BOT } }), false, "a person pasting the marker");
  assert.equal(isOverlapComment({ body: overlap, user: { type: "Bot", login: "some-app[bot]" } }), false, "another App");
  assert.equal(isOverlapComment({ body: e0, user: BOT }), false);
  assert.equal(isOwnComment({ body: overlap, user: BOT }), false, "E0's finder never takes the overlap comment");
  assert.ok(!OVERLAP_MARKER.startsWith(MARKER) && !MARKER.startsWith(OVERLAP_MARKER));
});
