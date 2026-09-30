/* global Buffer */
/**
 * The overlap comment's memory, and the state table that decides each write.
 *
 * ONE overlap comment per PR, beside (never inside) E0's conflict comment. Its
 * marker does not start with E0's, so neither finder can match the other's
 * comment. Two hidden lines follow the marker:
 *
 *   state    a digest of the (partner, path, kind) rows — merged rows
 *            included, SHAs never — or `resolved` / `merged`. A run whose
 *            rows digest the same writes nothing.
 *   entries  the rows themselves, and `seen`: every partner this comment has
 *            named since it was posted. The next run needs them to keep a
 *            partner it could not fetch (no flapping), to turn a partner that
 *            left the open list into a merged row, and to tell a NEW partner
 *            (re-post: a fresh comment notifies, an edit does not) from one
 *            that came back (edit).
 *
 * The entries line is read back out of a comment, so it is untrusted input:
 * the finder takes only `github-actions[bot]`'s comments, and even then the
 * payload is validated whole. One bad field and none of it is used — the
 * comment is recomputed from this run alone.
 */
import { createHash } from "node:crypto";

import { KINDS } from "./overlap.mjs";

export const OVERLAP_MARKER = "<!-- 12-apps/ci conflict-monitor:overlap -->";
export const OVERLAP_BOT = "github-actions[bot]";
export const RESOLVED = "resolved";
export const MERGED = "merged";

const STATE_LINE = (s) => `<!-- conflict-monitor:overlap:state ${s} -->`;
const ENTRIES_LINE = (e) => `<!-- conflict-monitor:overlap:entries ${e} -->`;
const STATE = /^<!-- conflict-monitor:overlap:state (\S+) -->$/m;
const ENTRIES = /^<!-- conflict-monitor:overlap:entries (\S*) -->$/m;
const STATE_TOKEN = /^(resolved|merged|[0-9a-f]{16})$/;

/**
 * The overlap mode's own comment: the marker, a bot, AND the Actions bot by
 * login. `type === "Bot"` alone matches any App — and `github-actions[bot]`
 * from ANY workflow, including one a same-repo PR runs from its own head. The
 * login narrows it to the one account this mode writes as; the payload is
 * still validated (decodeEntries), because that account is not only ours.
 */
export const isOverlapComment = (c) =>
  typeof c?.body === "string" && c.body.startsWith(OVERLAP_MARKER) && c.user?.type === "Bot" && c.user?.login === OVERLAP_BOT;

const rowKey = (r) => `${r.partner}\t${r.path}\t${r.kind}\t${r.merged ? MERGED : ""}`;

export function overlapDigest(rows) {
  const key = rows.map(rowKey).sort().join("\n");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** What the state line says for these rows. */
export function stateFor(rows) {
  if (!rows.length) return RESOLVED;
  if (rows.every((r) => r.merged)) return MERGED;
  return overlapDigest(rows);
}

export const partnersOf = (rows) => [...new Set(rows.map((r) => r.partner))].sort((x, y) => x - y);

export function encodeEntries({ rows, seen }) {
  const payload = {
    rows: rows.map((r) => (r.merged ? [r.partner, r.path, r.kind, 1] : [r.partner, r.path, r.kind])),
    seen: [...seen].sort((x, y) => x - y),
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** The hidden lines of a comment body. */
export const hiddenLines = ({ rows, seen }) => [OVERLAP_MARKER, STATE_LINE(stateFor(rows)), ENTRIES_LINE(encodeEntries({ rows, seen }))];

const MAX_ROWS = 2000;
const FIXED_KINDS = new Set(Object.values(KINDS));
// git's own kinds, verbatim: `file/directory`, `distinct types`, `unknown`, a
// comma-joined set. Nothing that could carry markup.
const GIT_KIND = /^[a-z/ ,-]{1,64}$/;
const isPr = (n) => Number.isSafeInteger(n) && n > 0;

/**
 * The entries line of `body`, validated: `{ rows, seen }`, or `null` when it is
 * missing or ANY part of it fails. `self` is the PR the comment is on; `open`
 * the open PR numbers. A row's partner may be closed or merged (that is what a
 * merged row is), so a row need only name a PR — one that turns out not to
 * exist is dropped by the partner-state read (overlap.mjs). A `seen` partner
 * that is neither open nor named by a row is dropped.
 */
export function decodeEntries(body, { self, open }) {
  const m = ENTRIES.exec(body ?? "");
  if (!m || m[1].length > 200_000) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.rows) || !Array.isArray(payload.seen)) return null;
  if (payload.rows.length > MAX_ROWS || payload.seen.length > MAX_ROWS) return null;
  const rows = [];
  for (const r of payload.rows) {
    if (!Array.isArray(r) || r.length < 3 || r.length > 4) return null;
    const [partner, path, kind, merged] = r;
    if (!isPr(partner) || partner === self) return null;
    if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0")) return null;
    if (typeof kind !== "string" || !(FIXED_KINDS.has(kind) || GIT_KIND.test(kind))) return null;
    if (merged !== undefined && merged !== 1) return null;
    rows.push({ partner, path, kind, ...(merged ? { merged: true } : {}) });
  }
  if (!payload.seen.every((n) => isPr(n) && n !== self)) return null;
  // `seen` only ever answers "has this OPEN partner been named before?", so a
  // seen partner that is neither open nor named by a row is dropped, not an
  // error: it is what a partner that closed after dropping out looks like.
  const named = new Set(rows.map((r) => r.partner));
  return { rows, seen: [...new Set(payload.seen.filter((n) => open.has(n) || named.has(n)))] };
}

/**
 * The previous state of an overlap comment: `{ state, rows, seen, trusted }`.
 * `trusted: false` — the state line or the entries failed validation, or the
 * two disagree — means nothing from the comment is reused, and its digest
 * never matches, so the comment is rewritten from this run's rows.
 */
export function readComment(comment, ctx) {
  const raw = STATE.exec(comment.body)?.[1] ?? null;
  const state = raw && STATE_TOKEN.test(raw) ? raw : null;
  const entries = state ? decodeEntries(comment.body, ctx) : null;
  // The two lines are written together, so they agree; entries that do not
  // digest to the state line were not written by this mode as they stand.
  if (!entries || stateFor(entries.rows) !== state) return { state, rows: [], seen: [], trusted: false };
  return { state, ...entries, trusted: true };
}

/**
 * What to write, given the previous comment (`readComment`, or null) and this
 * run's rows for the PR. Rows are `{ partner, path, kind, merged? }`; an open
 * partner's rows come from this run, or — when the partner could not be read —
 * from `prev` unchanged.
 *
 *   no comment, overlapping             → create
 *   no comment, nothing                 → none
 *   overlapping, same digest            → none
 *   overlapping, a partner never seen   → repost (create, then delete the old)
 *   overlapping, anything else changed  → update (a returning partner included)
 *   resolved / merged → overlapping     → repost
 *   only merged rows left               → update to `merged`
 *   nothing left                        → update to `resolved`, once
 *
 * A repost starts over: merged rows are dropped and `seen` is what it names.
 */
export function planOverlap(prev, rows) {
  const open = rows.filter((r) => !r.merged);
  const next = stateFor(rows);
  if (!prev) return open.length ? { action: "create", rows: open, seen: partnersOf(open) } : { action: "none" };
  const unchanged = prev.trusted && prev.state === next;
  if (!open.length) {
    if (unchanged) return { action: "none" };
    return { action: "update", rows, seen: rows.length ? prev.seen : [] };
  }
  if (prev.state === RESOLVED || prev.state === MERGED) return { action: "repost", rows: open, seen: partnersOf(open) };
  // An untrusted comment has no `seen` to compare with: it is rewritten in
  // place rather than re-posted, so a bad payload cannot buy a notification.
  if (prev.trusted && partnersOf(open).some((p) => !prev.seen.includes(p))) {
    return { action: "repost", rows: open, seen: partnersOf(open) };
  }
  if (unchanged) return { action: "none" };
  return { action: "update", rows, seen: [...new Set([...prev.seen, ...partnersOf(open)])].sort((x, y) => x - y) };
}
