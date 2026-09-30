import { strict as assert } from "node:assert";
import { test } from "node:test";

import { MARKER, decide, isOwnComment, renderOverlap } from "../lib/comment.mjs";
import {
  MERGED,
  OVERLAP_BOT,
  OVERLAP_MARKER,
  RESOLVED,
  decodeEntries,
  encodeEntries,
  isOverlapComment,
  overlapDigest,
  planOverlap,
  readComment,
} from "../lib/overlap-state.mjs";

// The overlap comment's state table, row by row (lib/overlap-state.mjs), and
// the untrusted entries line it reads back. The rule it keeps: a push that
// changes nothing writes nothing; a partner this comment never named is a NEW
// comment (an edit notifies nobody); everything else is an edit in place.

const ctx = { base: "main", baseSha: "a1b2c3d4e5f6" };
const row = (partner, path = "a.ts", kind = "same lines", merged = false) => ({ partner, path, kind, ...(merged ? { merged: true } : {}) });
const BOT = { type: "Bot", login: OVERLAP_BOT };
/** The comment a plan would leave, read back the way the next run reads it. */
const after = (plan, self = 1, open = [2, 3, 4]) => readComment({ body: renderOverlap(plan, ctx), user: BOT }, { self, open: new Set(open) });

test("no comment → overlapping: create, and the partner is seen", () => {
  const plan = planOverlap(null, [row(2)]);
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
  const prev = after(planOverlap(null, [row(2, "a.ts"), row(2, "b.ts", "same spot")]));
  assert.deepEqual(planOverlap(prev, [row(2, "b.ts", "same spot"), row(2, "a.ts")]), { action: "none" });
});

test("a partner never seen: re-post; a partner's paths or kinds change, or a partner drops out: edit", () => {
  const prev = after(planOverlap(null, [row(2)]));
  const added = planOverlap(prev, [row(2), row(3, "c.ts")]);
  assert.equal(added.action, "repost");
  assert.deepEqual(added.seen, [2, 3], "a re-post starts `seen` over with what it names");
  const two = after(added);
  assert.equal(planOverlap(two, [row(2), row(3, "c.ts", "same spot")]).action, "update");
  const dropped = planOverlap(two, [row(2)]);
  assert.equal(dropped.action, "update");
  assert.deepEqual(dropped.seen, [2, 3], "a partner that drops out stays seen");
  // …and when it comes back, it is an edit: it was named before.
  const back = planOverlap(after(dropped), [row(2), row(3, "c.ts")]);
  assert.equal(back.action, "update");
});

test("nothing left: resolved, once", () => {
  const prev = after(planOverlap(null, [row(2)]));
  const plan = planOverlap(prev, []);
  assert.equal(plan.action, "update");
  const resolved = after(plan);
  assert.equal(resolved.state, RESOLVED);
  assert.match(renderOverlap(plan, ctx), /No open PR overlaps this one any more/);
  assert.deepEqual(planOverlap(resolved, []), { action: "none" });
});

test("resolved → overlapping: re-post, even for a partner seen before", () => {
  const resolved = after(planOverlap(after(planOverlap(null, [row(2)])), []));
  assert.equal(planOverlap(resolved, [row(2)]).action, "repost");
});

test("merged rows stay in the digest; only merged rows left is `merged`; then overlapping again re-posts", () => {
  const prev = after(planOverlap(null, [row(2), row(3, "c.ts")]), 1, [2, 3]);
  assert.notEqual(overlapDigest([row(2), row(3, "c.ts", "same lines", true)]), overlapDigest([row(2), row(3, "c.ts")]));
  const one = planOverlap(prev, [row(2), row(3, "c.ts", "same lines", true)]);
  assert.equal(one.action, "update");
  const body = renderOverlap(one, ctx);
  assert.match(body, /#3 merged\. If this PR now conflicts, the conflict comment lists the files\./);
  assert.match(body, /If #2 merges first/);
  const both = planOverlap(after(one, 1, [2]), [row(2, "a.ts", "same lines", true), row(3, "c.ts", "same lines", true)]);
  assert.equal(both.action, "update");
  const merged = after(both, 1, []);
  assert.equal(merged.state, MERGED);
  assert.deepEqual(planOverlap(merged, merged.rows), { action: "none" });
  const again = planOverlap(merged, [...merged.rows, row(4)]);
  assert.equal(again.action, "repost");
  assert.deepEqual(again.rows, [row(4)], "a re-post drops the merged rows");
});

test("the entries line round-trips, and a bad one is dropped whole", () => {
  const plan = { rows: [row(2), row(3, "x|y`z", "file/directory", true)], seen: [2, 3] };
  const body = renderOverlap(plan, ctx);
  assert.deepEqual(decodeEntries(body, { self: 1, open: new Set([2]) }), plan);
  const withEntries = (payload) => `${OVERLAP_MARKER}\n<!-- conflict-monitor:overlap:entries ${Buffer.from(JSON.stringify(payload)).toString("base64url")} -->`;
  const open = new Set([2]);
  const bad = [
    { rows: [["2", "a.ts", "same lines"]], seen: [] }, // partner not an integer
    { rows: [[2.5, "a.ts", "same lines"]], seen: [] },
    { rows: [[1, "a.ts", "same lines"]], seen: [] }, // the PR itself
    { rows: [[2, "a.ts", "<img src=x>"]], seen: [] }, // not a kind
    { rows: [[2, "a.ts", "same lines", "yes"]], seen: [] },
    { rows: [[2, "", "same lines"]], seen: [] },
    { rows: [[2, "a.ts", "same lines"]], seen: ["2"] },
    { rows: {}, seen: [] },
  ];
  for (const payload of bad) assert.equal(decodeEntries(withEntries(payload), { self: 1, open }), null, JSON.stringify(payload));
  assert.equal(decodeEntries(`${OVERLAP_MARKER}\n<!-- conflict-monitor:overlap:entries !!! -->`, { self: 1, open }), null);
  assert.ok(decodeEntries(withEntries({ rows: [[7, "a.ts", "distinct types", 1]], seen: [2, 7] }), { self: 1, open }), "a merged partner need not be open");
  assert.deepEqual(decodeEntries(withEntries({ rows: [[2, "a.ts", "same lines"]], seen: [2, 99] }), { self: 1, open }).seen, [2], "a seen partner nobody knows is dropped");
});

test("an untrusted comment is rewritten in place from this run — never trusted for a no-op, never a re-post", () => {
  const good = renderOverlap({ rows: [row(2)], seen: [2] }, ctx);
  const tampered = good.replace(/entries \S+/, `entries ${encodeEntries({ rows: [row(2)], seen: [2] }).slice(0, -3)}`);
  const prev = readComment({ body: tampered, user: BOT }, { self: 1, open: new Set([2, 3]) });
  assert.equal(prev.trusted, false);
  assert.equal(planOverlap(prev, [row(2)]).action, "update", "the same rows are still written: the payload was not usable");
  assert.equal(planOverlap(prev, [row(2), row(3)]).action, "update");
  const badState = readComment({ body: good.replace(/state \S+/, "state <b>"), user: BOT }, { self: 1, open: new Set([2]) });
  assert.equal(badState.trusted, false);
  const other = renderOverlap({ rows: [row(3)], seen: [3] }, ctx);
  const spliced = good.replace(/entries \S+/, other.match(/entries \S+/)[0]);
  assert.equal(readComment({ body: spliced, user: BOT }, { self: 1, open: new Set([2, 3]) }).trusted, false, "entries that do not digest to the state line");
});

test("only github-actions[bot] with the marker is the overlap comment; E0's comment and this one never match each other", () => {
  const overlap = renderOverlap({ rows: [row(2)], seen: [2] }, ctx);
  const e0 = decide([{ file: "a.ts", shape: "edit/edit", bucket: "code", culprits: [] }], null, ctx).body;
  assert.equal(isOverlapComment({ body: overlap, user: BOT }), true);
  assert.equal(isOverlapComment({ body: overlap, user: { type: "User", login: OVERLAP_BOT } }), false, "a person pasting the marker");
  assert.equal(isOverlapComment({ body: overlap, user: { type: "Bot", login: "some-app[bot]" } }), false, "another App");
  assert.equal(isOverlapComment({ body: e0, user: BOT }), false);
  assert.equal(isOwnComment({ body: overlap, user: BOT }), false, "E0's finder never takes the overlap comment");
  assert.ok(!OVERLAP_MARKER.startsWith(MARKER) && !MARKER.startsWith(OVERLAP_MARKER));
});

test("a path cannot break the table or inject markup; a partner is #N only", () => {
  const evil = "x` [click](https://evil.example) @someone `y|z.md";
  const body = renderOverlap({ rows: [row(2, evil)], seen: [2] }, ctx);
  const line = body.split("\n").find((l) => l.includes("evil"));
  assert.equal(line.split("|").length, 5, "the pipe did not add a column");
  assert.ok(!line.includes("`") && !line.includes("@someone"));
  assert.ok(!/@\w/.test(body.replace(/<code>.*<\/code>/g, "")), "no @mention anywhere");
});
