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

import { LIMITS, MERGED, RESOLVED as OVERLAP_RESOLVED, UNCHECKED, compact, fold, hiddenLines, partnersOf, stateFor, visible } from "./overlap-state.mjs";

export const MARKER = "<!-- 12-apps/ci conflict-monitor -->";
const STATE = /<!-- conflict-monitor:state (\S+) -->/;
export const RESOLVED = "resolved";

export function digest(records, stack = null) {
  const rows = records.map((r) => `${r.file}\t${r.shape}\t${r.bucket}`);
  // A stacked PR's state also names its parents and their held heads, so the
  // comment changes when the re-stack would. A PR that is not stacked keeps
  // exactly the digest it always had: its comment is never rewritten for this.
  if (stack) rows.push(...stack.parents.map((p) => `stacked\t#${p.pr}\t${p.pOld}`));
  return createHash("sha256").update(rows.sort().join("\n")).digest("hex").slice(0, 16);
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

const prList = (parents) => {
  const prs = parents.map((p) => `#${p.pr}`);
  return prs.length < 2 ? prs.join("") : `${prs.slice(0, -1).join(", ")} and ${prs[prs.length - 1]}`;
};

/**
 * The lines a stacked PR's comment adds: which parent, what the files below
 * mean, and how to take the base in with the parent's pre-squash head as a
 * merge base — the consumer's own command when its config names one, and
 * the raw git recipe (lib/restack.mjs) always.
 */
function stackLines(stack, { base, clean }) {
  const theirs = stack.parents.length > 1 ? "their pre-squash heads" : `${prList(stack.parents)}'s pre-squash head`;
  const lead = clean
    ? `Stacked on ${prList(stack.parents)} (squash-merged): every conflicted file is the parent's own code meeting its squash, and the merge is clean with ${theirs} as the merge base.`
    : `Stacked on ${prList(stack.parents)} (squash-merged): these files conflict even with ${theirs} as the merge base.`;
  const how = stack.command
    ? `Take \`${base}\` in with \`${stack.command}\`, or by hand:`
    : `Take \`${base}\` in this way:`;
  return [lead, "", how, "", "```sh", ...stack.recipe, "```", ""];
}

export function renderConflict(records, { base, baseSha, stack = null }) {
  const rows = [...records]
    .sort((a, b) => a.bucket.localeCompare(b.bucket) || a.file.localeCompare(b.file))
    .map((r) => `| ${codeOf(r.file)} | ${esc(r.shape)} | ${esc(r.bucket)} | ${culpritCell(r.culprits)} |`);
  const hints = [...new Set(records.map((r) => r.shape))]
    .filter((s) => SHAPE_HINT[s])
    .map((s) => `**${s}**: ${SHAPE_HINT[s]}.`);
  const state = `<!-- conflict-monitor:state ${digest(records, stack)} -->`;
  const kept = "This comment is kept up to date and marked resolved when the branch merges cleanly again.";
  if (stack && !records.length) {
    return [
      MARKER,
      state,
      `### This PR conflicts with \`${base}\` only through its parent's squash`,
      "",
      `Checked against \`${base}\` at \`${baseSha.slice(0, 7)}\`.`,
      "",
      ...stackLines(stack, { base, clean: true }),
      kept,
    ].join("\n");
  }
  return [
    MARKER,
    state,
    `### This PR no longer merges cleanly with \`${base}\``,
    "",
    `Checked against \`${base}\` at \`${baseSha.slice(0, 7)}\`. ${records.length} file(s) conflict:`,
    "",
    "| file | conflict | group | changed on the base since this branch last synced |",
    "|---|---|---|---|",
    ...rows,
    "",
    ...(hints.length ? [hints.join(" "), ""] : []),
    ...(stack
      ? [...stackLines(stack, { base, clean: false }), `Resolve the files above. ${kept}`]
      : [`Bring \`${base}\` into this branch and resolve the files above. ${kept}`]),
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
 * A stacked PR (`ctx.stack`) counts as conflicted with no residual records.
 *
 *   conflicted, no comment          → create
 *   conflicted, different state     → update
 *   conflicted, same state          → nothing
 *   clean, comment says conflicted  → update to resolved
 *   clean, no comment / resolved    → nothing
 */
export function decide(records, existing, ctx) {
  const current = stateOf(existing?.body);
  // A stacked PR whose re-stack would be clean still conflicts with the base
  // until somebody takes the base in: it is not "resolved".
  if ((records && records.length) || ctx.stack) {
    const next = digest(records ?? [], ctx.stack ?? null);
    if (current === next) return { action: "none" };
    return { action: existing ? "update" : "create", body: renderConflict(records ?? [], ctx) };
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
const listOf = (items, word) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${word} ${items[items.length - 1]}`);
/** Every merged partner on one line: the list is bounded by LIMITS.partners, the lines would not be. */
const mergedLine = (partners) =>
  partners.length ? [`* ${listOf(partners.map((n) => `#${n}`), "and")} merged. If this PR now conflicts, the conflict comment lists the files.`] : [];

/**
 * One table row of the overlap comment. The path is already `shownPath`'s
 * (lib/overlap-state.mjs: no line break or control character survives it, so
 * nothing can end the row or the code span); the kind goes through `visible`
 * as well, because this renderer never trusts that its input was validated.
 * E0's own rows (renderConflict) are not changed by any of this.
 */
export const overlapRow = (partner, path, kind) => `| #${partner} | ${codeOf(visible(path))} | ${esc(visible(kind))} |`;

function overlapBody(view, seen, { base, baseSha }) {
  const state = stateFor(view);
  const head = hiddenLines(view, seen);
  const checked = `Checked against \`${base}\` at \`${baseSha.slice(0, 7)}\`.`;
  if (state === OVERLAP_RESOLVED) return [...head, "### No open PR overlaps this one any more", "", checked].join("\n");
  const merged = mergedLine(partnersOf(view.groups.filter((g) => g.merged)));
  if (state === MERGED) return [...head, "### Every PR that overlapped this one has merged", "", checked, "", ...merged].join("\n");
  const open = view.groups.filter((g) => !g.merged);
  const table = [];
  for (const g of open) {
    table.push(...g.rows.map((r) => overlapRow(g.partner, r.path, r.kind)));
    if (g.total > g.rows.length) table.push(`| #${g.partner} | ${g.total - g.rows.length} more file(s) | |`);
  }
  const restOpen = view.rest?.open ?? 0;
  if (restOpen) table.push(`| ${restOpen} more PR(s) | | |`);
  const hints = [...new Set(open.flatMap((g) => g.rows.map((r) => r.kind)))].filter((k) => OVERLAP_HINT[k]).map((k) => `**${k}**: ${OVERLAP_HINT[k]}.`);
  const partners = [...partnersOf(open).map((n) => `#${n}`), ...(restOpen ? [`one of ${restOpen} more`] : [])];
  return [
    ...head,
    "### Another open PR overlaps this one",
    "",
    `${checked} Whichever of the two merges second will conflict on these files:`,
    "",
    "| PR | file | overlap |",
    "|---|---|---|",
    ...table,
    "",
    ...(hints.length ? [hints.join(" "), ""] : []),
    ...(merged.length ? [...merged, ""] : []),
    `No action needed. If ${listOf(partners, "or")} merges first, the conflict comment will list what to resolve.`,
  ].join("\n");
}

/**
 * The overlap comment (lib/overlap-state.mjs keeps its memory). Partners are
 * `#N` only — a title is attacker-chosen on a fork — and there is no
 * @mention: `#N` cross-references the partner's timeline, which is the point.
 * It asks for nothing. The only line of advice says so.
 *
 * The body is bounded: the groups are folded and compacted (LIMITS) before a
 * character is written, and should the result still pass LIMITS.body, it is
 * written again with no file rows at all — counts only, which cannot.
 */
export function renderOverlap(plan, ctx) {
  if (plan.unchecked) {
    return [
      ...hiddenLines({ groups: [], rest: null }, [], UNCHECKED),
      "### This PR is no longer checked for overlaps",
      "",
      `Its base is not \`${ctx.base}\`, or its head branch is one the configuration ignores, so it is not paired with any PR.`,
    ].join("\n");
  }
  const view = compact(fold(plan.groups), overlapRow);
  const body = overlapBody(view, plan.seen, ctx);
  if (body.length <= LIMITS.body) return body;
  return overlapBody({ groups: view.groups.map((g) => ({ ...g, rows: [] })), rest: view.rest }, plan.seen, ctx);
}
