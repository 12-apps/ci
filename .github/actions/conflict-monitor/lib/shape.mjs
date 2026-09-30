/**
 * What KIND of conflict a file has — the half of the classification that needs
 * no consumer knowledge.
 *
 * The shape is what decides whether a conflict was avoidable:
 *
 *   edit/edit      both sides changed the same base lines. Two features really
 *                  did touch the same code — or a generator rewrote lines it had
 *                  no reason to (a positional `route0…routeN` table does this on
 *                  every insertion).
 *   insert/insert  both sides only ADDED lines at the same spot, keeping the
 *                  base. The append-point collision: a registry, an index table,
 *                  a list every feature extends at its end.
 *   add/add        both sides created the same path — duplicated scope, or a
 *                  child branch meeting its squash-merged parent.
 *   modify/delete, rename/delete, file location, …
 *                  a refactor moved or removed a file the other side edited.
 *
 * The git message kinds are reported verbatim when they are not `content`, so
 * a kind this file has never seen still shows up in the report under its own
 * name instead of being folded into a bucket that would hide it.
 */

/**
 * diff3 hunks of a conflicted blob: `{ ours, base, theirs }`, each an array of
 * lines. Only complete marker groups count; a file whose own content contains
 * a stray `=======` line cannot produce a phantom hunk because the group needs
 * all four markers, in order, at column zero.
 */
export function diff3Hunks(blob) {
  // Exactly seven marker characters (`(?![<|=>])`): a recursive merge nests
  // nine-character markers inside, and those are content of this hunk. `\r?`
  // lets a CRLF file's markers match.
  const re = /^<{7}(?!<)[^\n]*\n([\s\S]*?)^\|{7}(?!\|)[^\n]*\n([\s\S]*?)^={7}(?!=)\r?\n([\s\S]*?)^>{7}(?!>)/gm;
  const split = (text) => text.split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l !== "");
  return [...blob.matchAll(re)].map(([, ours, base, theirs]) => ({ ours: split(ours), base: split(base), theirs: split(theirs) }));
}

/** `needle` appears in `haystack` in order, gaps allowed. */
function isSubsequence(needle, haystack) {
  let at = 0;
  for (const line of needle) {
    while (at < haystack.length && haystack[at] !== line) at += 1;
    if (at === haystack.length) return false;
    at += 1;
  }
  return true;
}

export function hunkShape({ ours, base, theirs }) {
  if (base.length === 0) return "insert/insert";
  if (isSubsequence(base, ours) && isSubsequence(base, theirs)) return "insert/insert";
  if (sameLines(ours, base) || sameLines(theirs, base)) return "trivial";
  return "edit/edit";
}

const sameLines = (a, b) => a.length === b.length && a.every((l, i) => l === b[i]);

/**
 * The shape of one conflicted file. `kinds` is the set of conflict kinds git
 * attached to the path (lib/git.mjs parses them out of `merge-tree -z`);
 * `blob` is the file as the merge wrote it, with diff3 markers, read only for
 * a `content` conflict.
 *
 * One edit/edit hunk makes the file edit/edit: a single hunk where both sides
 * rewrote the same lines is enough to need a human, whatever the other hunks
 * look like.
 */
export function fileShape(kinds, blob) {
  if (!kinds.has("content")) return kinds.size ? [...kinds].sort().join(",") : "unknown";
  const shapes = diff3Hunks(blob).map(hunkShape);
  if (shapes.includes("edit/edit")) return "edit/edit";
  if (shapes.length) return "insert/insert";
  return "unknown";
}
