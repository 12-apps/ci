/* global Buffer */
/**
 * The overlap comment's memory, and the state table that decides each write.
 *
 * ONE overlap comment per PR, beside (never inside) E0's conflict comment. Its
 * marker does not start with E0's, so neither finder can match the other's
 * comment. Two hidden lines follow the marker:
 *
 *   state    a digest of the comment's PARTNER GROUPS — per partner: how many
 *            (path, kind) rows it has, a hash of all of them, and whether it
 *            merged — or `resolved` / `merged` / `unchecked`. A run whose
 *            groups digest the same writes nothing.
 *   entries  the groups themselves (with the rows that are SHOWN), and `seen`:
 *            every partner this comment has named since it was posted. The
 *            next run needs them to keep a partner it could not fetch (no
 *            flapping), to turn a partner that left the open list into a
 *            merged row, and to tell a NEW partner (re-post: a fresh comment
 *            notifies, an edit does not) from one that came back (edit).
 *
 * THE COMMENT IS BOUNDED. GitHub refuses a body over 65,536 characters, and a
 * refused write fails the run on every event for as long as the pair exists.
 * So what is stored and shown is capped — at most LIMITS.partners groups,
 * LIMITS.rows shown rows (open groups only) within a character budget, paths
 * cut at LIMITS.path — while the digest covers every row through each group's
 * count and hash: a change among the rows NOT shown still moves it. Every
 * group keeps its own count and hash, rows or not, so any of them can be
 * carried for a partner that could not be read. The decoder accepts exactly
 * what the encoder can produce.
 *
 * ACCEPTED: past LIMITS.partners partners on ONE PR, the highest-numbered
 * fold into a single `rest` aggregate. A folded partner cannot be carried
 * (one unreadable run costs an edit, and its return another) and is dropped
 * rather than shown as merged. It takes 200 PRs overlapping one PR.
 *
 * The entries line is read back out of a comment, so it is untrusted input:
 * the finder takes only `github-actions[bot]`'s comments, and even then the
 * payload is validated whole. One bad field and none of it is used — the
 * comment is recomputed from this run alone, in place.
 */
import { createHash } from "node:crypto";

import { KINDS } from "./overlap.mjs";

export const OVERLAP_MARKER = "<!-- 12-apps/ci conflict-monitor:overlap -->";
export const OVERLAP_BOT = "github-actions[bot]";
export const RESOLVED = "resolved";
export const MERGED = "merged";
export const UNCHECKED = "unchecked";

export const LIMITS = {
  partners: 200, // groups stored by partner (count and hash each); the rest fold into `rest`
  rows: 100, // rows shown (and stored) across all groups
  path: 256, // characters of a shown path
  seen: 200, // partners remembered as named
  rowBudget: 30_000, // characters the shown rows may take, table and entries together
  body: 60_000, // the hard ceiling; GitHub's is 65,536
};

const STATE_LINE = (s) => `<!-- conflict-monitor:overlap:state ${s} -->`;
const ENTRIES_LINE = (e) => `<!-- conflict-monitor:overlap:entries ${e} -->`;
const STATE = /^<!-- conflict-monitor:overlap:state (\S+) -->$/m;
const ENTRIES = /^<!-- conflict-monitor:overlap:entries (\S*) -->$/m;
const STATE_TOKEN = /^(resolved|merged|unchecked|[0-9a-f]{16})$/;
const HASH = /^[0-9a-f]{12}$/;

/**
 * The overlap mode's own comment: the marker, a bot, AND the Actions bot by
 * login. `type === "Bot"` alone matches any App — and `github-actions[bot]`
 * from ANY workflow, including one a same-repo PR runs from its own head. The
 * login narrows it to the one account this mode writes as; the payload is
 * still validated (decodeEntries), because that account is not only ours.
 */
export const isOverlapComment = (c) =>
  typeof c?.body === "string" && c.body.startsWith(OVERLAP_MARKER) && c.user?.type === "Bot" && c.user?.login === OVERLAP_BOT;

// Control characters, and the Unicode line and paragraph separators: anything
// that could end a table row or a line of markdown. Shown as control pictures.
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g;
const PICTURE = { 0x7f: "\u2421", 0x85: "\u2424", 0x2028: "\u2424", 0x2029: "\u00b6" };

/** `s` with every line-breaking or control character replaced by a visible one. */
export const visible = (s) =>
  String(s).replace(CONTROL, (c) => {
    const n = c.charCodeAt(0);
    return n < 0x20 ? String.fromCharCode(0x2400 + n) : PICTURE[n];
  });

/** A path as it is stored and shown: visible, and cut (never mid-surrogate) at LIMITS.path. */
export function shownPath(path) {
  const v = visible(path);
  if (v.length <= LIMITS.path) return v;
  let cut = v.slice(0, LIMITS.path - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}\u2026`;
}

const sha = (text, n) => createHash("sha256").update(text).digest("hex").slice(0, n);
const byPartner = (a, b) => a.partner - b.partner;
const rowOrder = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);

/**
 * Rows `{ partner, path, kind }` → one group per partner:
 * `{ partner, merged, total, hash, rows }`. `total` and `hash` cover EVERY row;
 * `rows` holds them all here, and only the shown ones once compacted.
 */
export function groupsOf(rows) {
  const by = new Map();
  for (const r of rows) (by.get(r.partner) ?? by.set(r.partner, []).get(r.partner)).push({ path: r.path, kind: r.kind });
  return [...by.entries()]
    .map(([partner, list]) => {
      const sorted = [...list].sort(rowOrder);
      return { partner, merged: false, total: sorted.length, hash: sha(sorted.map((r) => `${r.path}\t${r.kind}`).join("\n"), 12), rows: sorted };
    })
    .sort(byPartner);
}

export const partnersOf = (groups) => [...new Set(groups.map((g) => g.partner))].sort((x, y) => x - y);
const openGroups = (groups) => groups.filter((g) => !g.merged);
const groupKey = (g) => `${g.partner}\t${g.total}\t${g.hash}\t${g.merged ? 1 : 0}`;

/**
 * The groups as they are stored: the LIMITS.partners lowest-numbered, and the
 * rest folded into `{ partners, open, hash }`. Deterministic, so the same
 * groups always digest the same.
 */
export function fold(groups) {
  const sorted = [...groups].sort(byPartner);
  const kept = sorted.slice(0, LIMITS.partners);
  const over = sorted.slice(LIMITS.partners);
  const rest = over.length ? { partners: over.length, open: openGroups(over).length, hash: sha(over.map(groupKey).join("\n"), 12) } : null;
  return { groups: kept, rest };
}

/** What the state line says for these (folded) groups. */
export function stateFor({ groups, rest }) {
  if (!groups.length && !rest) return RESOLVED;
  if (!openGroups(groups).length && !rest?.open) return MERGED;
  const key = [...groups.map(groupKey), ...(rest ? [`rest\t${rest.partners}\t${rest.open}\t${rest.hash}`] : [])].join("\n");
  return sha(key, 16);
}

const jsonCost = (value) => Math.ceil((Buffer.byteLength(JSON.stringify(value)) * 4) / 3) + 4;

/**
 * Choose the rows that are shown, and so stored: OPEN groups in partner order,
 * rows in path order, a prefix that stops at the first row over LIMITS.rows or
 * the character budget. A merged group stores no rows — it is shown as one
 * "#Y merged" line — so it never takes an open partner's place. `tableRow(partner, path, kind)` is the renderer's own row,
 * so the budget counts what is really written.
 */
export function compact({ groups, rest }, tableRow) {
  let shown = 0;
  let spent = 0;
  let full = false;
  const out = groups.map((g) => {
    const rows = [];
    if (g.merged) return { ...g, rows };
    for (const r of g.rows) {
      if (full) break;
      const row = { path: shownPath(r.path), kind: r.kind };
      const cost = tableRow(g.partner, row.path, row.kind).length + 1 + jsonCost([row.path, row.kind]);
      if (shown + 1 > LIMITS.rows || spent + cost > LIMITS.rowBudget) {
        full = true;
        break;
      }
      rows.push(row);
      shown += 1;
      spent += cost;
    }
    return { ...g, rows };
  });
  return { groups: out, rest };
}

export function encodeEntries({ groups, rest }, seen) {
  const payload = {
    g: groups.map((g) => [g.partner, g.total, g.hash, g.merged ? 1 : 0, g.rows.map((r) => [r.path, r.kind])]),
    r: rest ? [rest.partners, rest.open, rest.hash] : null,
    s: [...seen].sort((x, y) => x - y).slice(-LIMITS.seen),
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** The hidden lines of a comment body, for compacted groups (or `unchecked`). */
export const hiddenLines = (view, seen, state = stateFor(view)) => [OVERLAP_MARKER, STATE_LINE(state), ENTRIES_LINE(encodeEntries(view, seen))];

const FIXED_KINDS = new Set(Object.values(KINDS));
// git's own kinds, verbatim: `file/directory`, `distinct types`, `unknown`, a
// comma-joined set. Nothing that could carry markup.
const GIT_KIND = /^[a-z/ ,-]{1,64}$/;
const isPr = (n) => Number.isSafeInteger(n) && n > 0;
const isCount = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const HAS_CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

/**
 * The entries line of `body`, validated: `{ groups, rest, seen }`, or `null`
 * when it is missing or ANY part of it fails. `self` is the PR the comment is
 * on; `open` the open PR numbers.
 *
 *   - at most LIMITS.partners distinct groups, LIMITS.rows rows in all, and
 *     LIMITS.seen seen partners — exactly what encodeEntries can write;
 *   - a MERGED group's partner must not be open (an open PR has not merged),
 *     and it has no shown rows;
 *   - an OPEN group whose partner is not open is only a claim — overlap.mjs
 *     confirms it with one bounded `GET /pulls/{n}` before it is kept; a
 *     merged group was confirmed when it was written, and is final;
 *   - a shown path is what shownPath writes: no control character, no longer
 *     than LIMITS.path; a kind is one of the four or git's own spelling.
 *
 * A `seen` partner that is neither open nor a group's is dropped, not an
 * error: it is what a partner that closed after dropping out looks like.
 */
export function decodeEntries(body, { self, open }) {
  const m = ENTRIES.exec(body ?? "");
  if (!m || m[1].length > 65_536) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.g) || !Array.isArray(payload.s)) return null;
  if (payload.g.length > LIMITS.partners || payload.s.length > LIMITS.seen) return null;
  const groups = [];
  let rows = 0;
  for (const g of payload.g) {
    if (!Array.isArray(g) || g.length !== 5) return null;
    const [partner, total, hash, merged, shown] = g;
    if (!isPr(partner) || partner === self || groups.some((x) => x.partner === partner)) return null;
    if (merged !== 0 && merged !== 1) return null;
    if (merged && (open.has(partner) || (Array.isArray(shown) && shown.length))) return null;
    if (typeof hash !== "string" || !HASH.test(hash) || !Array.isArray(shown)) return null;
    if (!isCount(total, 1_000_000) || total < 1 || total < shown.length) return null;
    rows += shown.length;
    if (rows > LIMITS.rows) return null;
    const list = [];
    for (const r of shown) {
      if (!Array.isArray(r) || r.length !== 2) return null;
      const [path, kind] = r;
      if (typeof path !== "string" || !path || path.length > LIMITS.path || HAS_CONTROL.test(path)) return null;
      if (typeof kind !== "string" || !(FIXED_KINDS.has(kind) || GIT_KIND.test(kind))) return null;
      list.push({ path, kind });
    }
    groups.push({ partner, merged: merged === 1, total, hash, rows: list });
  }
  let rest = null;
  if (payload.r != null) {
    if (!Array.isArray(payload.r) || payload.r.length !== 3) return null;
    const [partners, openCount, hash] = payload.r;
    if (!isCount(partners, 1_000_000) || partners < 1 || !isCount(openCount, partners) || typeof hash !== "string" || !HASH.test(hash)) return null;
    if (groups.length < LIMITS.partners) return null;
    rest = { partners, open: openCount, hash };
  }
  if (!payload.s.every((n) => isPr(n) && n !== self)) return null;
  const named = new Set(groups.map((g) => g.partner));
  return { groups: groups.sort(byPartner), rest, seen: [...new Set(payload.s.filter((n) => open.has(n) || named.has(n)))] };
}

/**
 * The previous state of an overlap comment: `{ state, groups, rest, seen, trusted }`.
 * `trusted: false` — the state line or the entries failed validation, or the
 * two disagree — means NOTHING from the comment is reused, its state included
 * (it reads as `null`): the comment is rewritten in place from this run's rows.
 */
export function readComment(comment, ctx) {
  const raw = STATE.exec(comment.body)?.[1] ?? null;
  const token = raw && STATE_TOKEN.test(raw) ? raw : null;
  const entries = token ? decodeEntries(comment.body, ctx) : null;
  // The two lines are written together, so they agree; entries that do not
  // digest to the state line were not written by this mode as they stand.
  const agrees = entries && (token === UNCHECKED ? !entries.groups.length && !entries.rest : stateFor(entries) === token);
  if (!agrees) return { state: null, groups: [], rest: null, seen: [], trusted: false };
  return { state: token, ...entries, trusted: true };
}

/**
 * What to write, given the previous comment (`readComment`, or null) and this
 * run's groups for the PR (`groupsOf` for the partners read this run, plus the
 * groups carried from `prev` for the ones that could not be).
 *
 *   no comment, overlapping                 → create
 *   no comment, nothing                     → none
 *   overlapping, same digest                → none
 *   overlapping, a partner never seen       → repost (create, then delete the old)
 *   overlapping, anything else changed      → update (a returning partner included)
 *   resolved / merged / unchecked → overlap → repost
 *   only merged groups left                 → update to `merged`
 *   nothing left                            → update to `resolved`, once
 *   untrusted                               → update, whatever it says
 *
 * A repost starts over: merged groups are dropped and `seen` is what it names.
 */
export function planOverlap(prev, groups) {
  const open = openGroups(groups);
  const folded = fold(groups);
  const next = stateFor(folded);
  // Partners folded into `rest` are not tracked one by one: only the stored
  // groups' partners are `seen`, and only they can be new.
  const named = partnersOf(openGroups(folded.groups));
  const seenOf = (...lists) => [...new Set([...named, ...lists.flat()])].slice(0, LIMITS.seen).sort((x, y) => x - y);
  if (!prev) return open.length ? { action: "create", groups: open, seen: seenOf() } : { action: "none" };
  const trusted = prev.trusted;
  if (trusted && prev.state === next) return { action: "none" };
  if (!open.length) return { action: "update", groups, seen: groups.length ? prev.seen : [] };
  // An untrusted comment has no state and no `seen` to compare with: it is
  // rewritten in place rather than re-posted, so a bad payload cannot buy a
  // notification — whatever its state line claims.
  if (trusted && [RESOLVED, MERGED, UNCHECKED].includes(prev.state)) return { action: "repost", groups: open, seen: seenOf() };
  if (trusted && named.some((p) => !prev.seen.includes(p))) return { action: "repost", groups: open, seen: seenOf() };
  return { action: "update", groups, seen: seenOf(prev.seen) };
}

/**
 * An open PR this mode no longer pairs (its head is ignored, or its base is
 * not the base): its comment, if it has one, says so ONCE.
 */
export function planUnchecked(prev) {
  if (!prev || (prev.trusted && prev.state === UNCHECKED)) return { action: "none" };
  return { action: "update", groups: [], seen: [], unchecked: true };
}
