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

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/** Every `CONFLICT (<kind>)` git printed about `path`. */
export function conflictKinds(messages, path) {
  const re = new RegExp(`CONFLICT \\(([^)]+)\\): [^\\n]*${path.replace(ESCAPE, "\\$&")}`, "g");
  return new Set([...messages.matchAll(re)].map((m) => m[1]));
}

/**
 * diff3 hunks of a conflicted blob: `{ ours, base, theirs }`, each an array of
 * lines. Only complete marker groups count; a file whose own content contains
 * a stray `=======` line cannot produce a phantom hunk because the group needs
 * all four markers, in order, at column zero.
 */
export function diff3Hunks(blob) {
  const re = /^<{7}[^\n]*\n([\s\S]*?)^\|{7}[^\n]*\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7}/gm;
  return [...blob.matchAll(re)].map(([, ours, base, theirs]) => ({
    ours: ours.split("\n").filter((l, i, a) => i < a.length - 1 || l !== ""),
    base: base.split("\n").filter((l, i, a) => i < a.length - 1 || l !== ""),
    theirs: theirs.split("\n").filter((l, i, a) => i < a.length - 1 || l !== ""),
  }));
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
 * The shape of one conflicted file. `blob` is the file as the merge wrote it
 * (with diff3 markers); it is only read for a `content` conflict.
 *
 * One edit/edit hunk makes the file edit/edit: a single hunk where both sides
 * rewrote the same lines is enough to need a human, whatever the other hunks
 * look like.
 */
export function fileShape(messages, path, blob) {
  const kinds = conflictKinds(messages, path);
  if (!kinds.has("content")) return kinds.size ? [...kinds].sort().join(",") : "unknown";
  const shapes = diff3Hunks(blob).map(hunkShape);
  if (shapes.includes("edit/edit")) return "edit/edit";
  if (shapes.length) return "insert/insert";
  return "unknown";
}
