/**
 * `--fix`: write the substitute over each autofixable finding, in the working
 * tree, and nothing else.
 *
 * A file is left alone, and its findings stay findings, when writing it could
 * lose something:
 *
 *   - `unstaged`: under `--staged` the findings were read from the index, so
 *     their offsets are only true of a working-tree copy with the same bytes.
 *     A file with unstaged changes is the author's to fix by hand;
 *   - `encoding`: the bytes are not the UTF-8 of the text that was judged, so
 *     writing the text back would change more than the words.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `text` with each finding's span replaced by its substitute. */
export function applyFixes(text, findings) {
  let fixed = text;
  for (const { start, end, use } of [...findings].sort((a, b) => b.start - a.start)) fixed = fixed.slice(0, start) + use + fixed.slice(end);
  return fixed;
}

/**
 * Move the columns of the findings left in a rewritten file to where they now
 * stand: each shifts by what was rewritten before it on its line. A form never
 * holds a line break, so the line numbers are already right.
 */
export function shiftColumns(left, rewritten) {
  for (const finding of left) {
    for (const done of rewritten)
      if (done.line === finding.line && done.start < finding.start) finding.col += done.use.length - done.found.length;
  }
}

/**
 * @param {object} input
 * @param {string} input.root
 * @param {string} input.file
 * @param {Buffer} input.bytes   What was judged: the working-tree file, or the index entry under `--staged`.
 * @param {object[]} input.findings  The file's autofixable findings.
 * @param {boolean} input.staged
 * @returns {"fixed" | "unstaged" | "encoding"}
 */
export function fixFile({ root, file, bytes, findings, staged }) {
  const path = join(root, file);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return "encoding";
  if (staged) {
    let working;
    try {
      working = readFileSync(path);
    } catch {
      return "unstaged";
    }
    if (!working.equals(bytes)) return "unstaged";
  }
  writeFileSync(path, applyFixes(text, findings));
  return "fixed";
}
