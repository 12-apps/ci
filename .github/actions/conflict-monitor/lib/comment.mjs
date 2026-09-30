/**
 * The one comment the monitor keeps on a PR.
 *
 * ONE comment, edited in place, found by a hidden marker — never a new
 * comment per push to main. A PR that stays conflicted across ten merges gets
 * one notification, not ten; the author reads the current state in one place.
 *
 * Whether to write at all is decided by a digest of what the conflict IS (the
 * files, their shapes and buckets), written into the comment itself. The
 * culprit list is deliberately NOT part of it: it grows with every base commit
 * that touches a conflicted file, and an edit that only lengthens that list
 * would notify the author about nothing they can act on.
 */
import { createHash } from "node:crypto";

import { MERGED, RESOLVED as OVERLAP_RESOLVED, hiddenLines, partnersOf, stateFor } from "./overlap-state.mjs";

export const MARKER = "<!-- 12-apps/ci conflict-monitor -->";
const STATE = /<!-- conflict-monitor:state (\S+) -->/;
export const RESOLVED = "resolved";

export function digest(records) {
  const key = records
    .map((r) => `${r.file}\t${r.shape}\t${r.bucket}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export const stateOf = (body) => STATE.exec(body ?? "")?.[1] ?? null;

/**
 * The monitor's own comment: carries the marker AND was written by a bot.
 * Anyone can post a comment that starts with the marker on a public repo;
 * matching on the text alone would let a stranger's comment be edited by the
 * bot, or pre-seed a digest that suppresses the notice.
 */
export const isOwnComment = (c) =>
  typeof c?.body === "string" && c.body.startsWith(MARKER) && c.user?.type === "Bot";

const SHAPE_HINT = {
  "edit/edit": "both sides changed the same lines",
  "insert/insert": "both sides added lines at the same spot",
  "add/add": "both sides created this file",
};

/**
 * A path, shown as code WITHOUT markdown: the path comes from the PR's own
 * tree, so it is attacker-chosen on a fork — a backtick in it would close a
 * code span and let the rest render as a live link or an @mention under the
 * bot's name. `<code>` with HTML escaping cannot be closed from inside.
 */
export const codeOf = (s) =>
  `<code>${String(s).replace(/[&<>"'|`@\\]/g, (c) => `&#${c.charCodeAt(0)};`)}</code>`;
const esc = (s) => String(s).replace(/[&<>|]/g, (c) => `&#${c.charCodeAt(0)};`);

function culpritCell(list) {
  const prs = [...new Set(list.map((c) => (c.pr ? `#${c.pr}` : codeOf(c.sha.slice(0, 7)))))];
  if (!prs.length) return "—";
  return prs.length > 6 ? `${prs.slice(0, 6).join(", ")} +${prs.length - 6}` : prs.join(", ");
}

export function renderConflict(records, { base, baseSha }) {
  const rows = [...records]
    .sort((a, b) => a.bucket.localeCompare(b.bucket) || a.file.localeCompare(b.file))
    .map((r) => `| ${codeOf(r.file)} | ${esc(r.shape)} | ${esc(r.bucket)} | ${culpritCell(r.culprits)} |`);
  const hints = [...new Set(records.map((r) => r.shape))]
    .filter((s) => SHAPE_HINT[s])
    .map((s) => `**${s}**: ${SHAPE_HINT[s]}.`);
  return [
    MARKER,
    `<!-- conflict-monitor:state ${digest(records)} -->`,
    `### This PR no longer merges cleanly with \`${base}\``,
    "",
    `Checked against \`${base}\` at \`${baseSha.slice(0, 7)}\`. ${records.length} file(s) conflict:`,
    "",
    "| file | conflict | group | changed on the base since this branch last synced |",
    "|---|---|---|---|",
    ...rows,
    "",
    ...(hints.length ? [hints.join(" "), ""] : []),
    `Bring \`${base}\` into this branch and resolve the files above. This comment is kept up to date and marked resolved when the branch merges cleanly again.`,
  ].join("\n");
}

export function renderResolved({ base, baseSha }) {
  return [
    MARKER,
    `<!-- conflict-monitor:state ${RESOLVED} -->`,
    `### Resolved: this PR merges cleanly with \`${base}\` again`,
    "",
    `Checked against \`${base}\` at \`${baseSha.slice(0, 7)}\`.`,
  ].join("\n");
}

/**
 * What to do with the PR's comment, given its current conflict records
 * (`null` = clean) and the monitor's existing comment, if any.
 *
 *   conflicted, no comment          → create
 *   conflicted, different state     → update
 *   conflicted, same state          → nothing
 *   clean, comment says conflicted  → update to resolved
 *   clean, no comment / resolved    → nothing
 */
export function decide(records, existing, ctx) {
  const current = stateOf(existing?.body);
  if (records && records.length) {
    const next = digest(records);
    if (current === next) return { action: "none" };
    return { action: existing ? "update" : "create", body: renderConflict(records, ctx) };
  }
  if (existing && current !== RESOLVED) return { action: "update", body: renderResolved(ctx) };
  return { action: "none" };
}

const OVERLAP_HINT = {
  "same lines": "both PRs changed the same lines",
  "same spot": "both PRs added lines at the same spot",
  "both add": "both PRs create this file",
  "deletes or moves": "one PR deletes or moves a file the other edits",
};
const MAX_OVERLAP_ROWS = 100;
const orList = (prs) => (prs.length < 2 ? prs.join("") : `${prs.slice(0, -1).join(", ")} or ${prs[prs.length - 1]}`);
const mergedLine = (n) => `* #${n} merged. If this PR now conflicts, the conflict comment lists the files.`;

/**
 * The overlap comment (lib/overlap-state.mjs keeps its memory). Partners are
 * `#N` only — a title is attacker-chosen on a fork — and there is no
 * @mention: `#N` cross-references the partner's timeline, which is the point.
 * It asks for nothing. The only line of advice says so.
 */
export function renderOverlap({ rows, seen }, { base, baseSha }) {
  const state = stateFor(rows);
  const head = hiddenLines({ rows, seen });
  const checked = `Checked against \`${base}\` at \`${baseSha.slice(0, 7)}\`.`;
  if (state === OVERLAP_RESOLVED) return [...head, "### No open PR overlaps this one any more", "", checked].join("\n");
  const merged = partnersOf(rows.filter((r) => r.merged)).map(mergedLine);
  if (state === MERGED) {
    return [...head, "### Every PR that overlapped this one has merged", "", checked, "", ...merged].join("\n");
  }
  const open = [...rows.filter((r) => !r.merged)].sort((a, b) => a.partner - b.partner || a.path.localeCompare(b.path));
  const shown = open.slice(0, MAX_OVERLAP_ROWS).map((r) => `| #${r.partner} | ${codeOf(r.path)} | ${esc(r.kind)} |`);
  const more = open.length > MAX_OVERLAP_ROWS ? [`| | ${open.length - MAX_OVERLAP_ROWS} more | |`] : [];
  const hints = [...new Set(open.map((r) => r.kind))].filter((k) => OVERLAP_HINT[k]).map((k) => `**${k}**: ${OVERLAP_HINT[k]}.`);
  const partners = partnersOf(open).map((n) => `#${n}`);
  return [
    ...head,
    "### Another open PR overlaps this one",
    "",
    `${checked} Whichever of the two merges second will conflict on these files:`,
    "",
    "| PR | file | overlap |",
    "|---|---|---|",
    ...shown,
    ...more,
    "",
    ...(hints.length ? [hints.join(" "), ""] : []),
    ...(merged.length ? [...merged, ""] : []),
    `No action needed. If ${orList(partners)} merges first, the conflict comment will list what to resolve.`,
  ].join("\n");
}
