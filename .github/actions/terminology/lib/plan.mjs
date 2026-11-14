/**
 * What a run reads: which files, from where, and which of their lines count as
 * added.
 *
 *   whole tree   every tracked file in scope, from the working tree; every line.
 *   --base ref   the same files, plus the untracked ones in scope; a term
 *                enforced on `new` lines sees only what the working tree adds
 *                against the merge base (an untracked file is all new).
 *   --staged     only the files the staged diff changes, read from the index;
 *                a `new` term sees only the lines that diff adds.
 *
 * A scope that matches nothing is refused here: a check that read no file
 * would report success, and that is the one answer it must never give by
 * accident.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { addedLines, indexContent, listFiles, mergeBase, UsageError } from "./git.mjs";

const NO_LINES = new Set();

/**
 * @param {object} input
 * @param {string} input.root
 * @param {{ include: string[], included: (p: string) => boolean, excluded: (p: string) => boolean }} input.config
 * @param {string | null} input.base   The ref of `--base`, or null.
 * @param {boolean} input.staged
 * @param {string[]} input.files       The paths given after `--staged`, if any.
 * @returns {{ file: string, added: Set<number> | null, read: () => Buffer | null }[]}
 *   `added` is null when every line counts as added.
 */
export function planWork({ root, config, base, staged, files }) {
  const tracked = listFiles(root);
  const included = tracked.filter(config.included);
  if (included.length === 0)
    throw new UsageError(`the include globs match no tracked file (${config.include.join(", ")}): the check would pass having read nothing`);
  const inScope = (file) => config.included(file) && !config.excluded(file);
  if (!included.some(inScope))
    throw new UsageError(`every file the include globs match is excluded: the check would pass having read nothing`);
  const fromDisk = (file) => () => readWorkingFile(root, file);

  if (staged) {
    const diff = addedLines(root, null);
    const only = files.length > 0 ? new Set(files.map((file) => relativePath(root, file))) : null;
    return [...diff.keys()]
      .filter((file) => inScope(file) && (only === null || only.has(file)))
      .sort()
      .map((file) => ({ file, added: diff.get(file), read: () => indexContent(root, file) }));
  }
  const scoped = tracked.filter(inScope);
  if (base === null) return scoped.map((file) => ({ file, added: null, read: fromDisk(file) }));

  const diff = addedLines(root, mergeBase(root, base));
  const untracked = listFiles(root, { others: true }).filter(inScope);
  return [
    ...scoped.map((file) => ({ file, added: diff.get(file) ?? NO_LINES, read: fromDisk(file) })),
    ...untracked.map((file) => ({ file, added: null, read: fromDisk(file) })),
  ].sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** A path as git prints it: relative to `root`, forward slashes, no `./`. */
function relativePath(root, file) {
  const path = isAbsolute(file) ? relative(root, file) : file;
  return path.split(sep).join("/").replace(/^\.\//, "");
}

/** The bytes of a working-tree file, or null when it is gone or is not a file. */
function readWorkingFile(root, file) {
  try {
    const path = join(root, file);
    return statSync(path).isFile() ? readFileSync(path) : null;
  } catch {
    return null;
  }
}
