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

const SHAPE_HINT = {
  "edit/edit": "both sides changed the same lines",
  "insert/insert": "both sides added lines at the same spot",
  "add/add": "both sides created this file",
};

const esc = (s) => String(s).replace(/\|/g, "\\|");

function culpritCell(list) {
  const prs = [...new Set(list.map((c) => (c.pr ? `#${c.pr}` : `\`${c.sha.slice(0, 7)}\``)))];
  if (!prs.length) return "—";
  return prs.length > 6 ? `${prs.slice(0, 6).join(", ")} +${prs.length - 6}` : prs.join(", ");
}

export function renderConflict(records, { base, baseSha }) {
  const rows = [...records]
    .sort((a, b) => a.bucket.localeCompare(b.bucket) || a.file.localeCompare(b.file))
    .map((r) => `| \`${esc(r.file)}\` | ${esc(r.shape)} | ${esc(r.bucket)} | ${culpritCell(r.culprits)} |`);
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
