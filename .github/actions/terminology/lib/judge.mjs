/**
 * One file, judged: the findings in it and how many of its lines were looked
 * at.
 *
 * A code file is judged literal by literal (lib/scanner.mjs, lib/literals.mjs)
 * and a plain-text file line by line. On top of that, for both:
 *
 *   - `skipLines`: a line whose trimmed text starts with one of the prefixes is
 *     never judged (a help article's `keywords: […]` line holds the synonyms on
 *     purpose), and neither are the lines directly below it that are indented
 *     deeper: a formatter wraps the value onto them;
 *   - a term enforced on `new` lines is judged only on the lines `added` names;
 *   - `terminology-allow: a, b` keeps those words on its own line and the next
 *     one, `terminology-allow-file: a, b` in the whole file. In code both are
 *     read from comments only; in plain text from the line itself. The list
 *     ends at the first character that cannot continue it, so a reason may
 *     follow in parentheses: `terminology-allow: entregador (iFood's word)`;
 *   - a match inside one of its term's `allow` phrases on that line stands.
 */
import { judgedRegions } from "./literals.mjs";
import { substituteFor } from "./matcher.mjs";
import { scan } from "./scanner.mjs";

const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const WORD = "[\\p{L}\\p{M}\\p{N}_]+(?:[ -][\\p{L}\\p{M}\\p{N}_]+)*";
/** The pragma and its list: words or phrases separated by commas, and nothing after the last one. */
const PRAGMA = new RegExp(`terminology-allow(-file)?:[ \\t]*(${WORD}(?:[ \\t]*,[ \\t]*${WORD})*)`, "gu");
/** A substitute holding one of these cannot be pasted into a literal without changing the code around it. */
const BREAKS_A_LITERAL = /['"`\\]|\$\{/;

export const isCodeFile = (file) => CODE_FILE.test(file);

/**
 * @param {object} input
 * @param {string} input.file    Path as reported.
 * @param {string} input.text    The content to judge.
 * @param {ReturnType<import("./matcher.mjs").buildMatcher>} input.matcher  Built for the terms that apply to this file.
 * @param {string[]} input.skipLines
 * @param {Set<number> | null} input.added  1-based added lines; null when every line counts as added.
 * @returns {{ findings: object[], lines: number, error: { line: number, message: string } | null }}
 */
export function judgeFile({ file, text, matcher, skipLines, added }) {
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const lineOf = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const lineText = (line) => text.slice(lineStarts[line - 1], lineStarts[line] ?? text.length).replace(/\r?\n$/, "");
  const lineCount = lineStarts.length - (text.length === lineStarts.at(-1) ? 1 : 0);
  const skippedLines = skipLines.length === 0 ? new Set() : skippedBlocks(lineCount, lineText, skipLines);
  const skipped = (line) => skippedLines.has(line);

  const wholeFile = added === null || matcher.terms.some((term) => term.enforce === "all");
  let lines = 0;
  for (const line of wholeFile ? Array.from({ length: lineCount }, (_, i) => i + 1) : added)
    if (line <= lineCount && !skipped(line)) lines += 1;
  if (!matcher.mayMatch(text)) return { findings: [], lines, error: null };

  const pragmas = { file: new Set(), lines: new Map() };
  let regions;
  if (isCodeFile(file)) {
    const scanned = scan(text);
    if (scanned.error) return { findings: [], lines, error: { line: lineOf(scanned.error.offset), message: scanned.error.message } };
    regions = judgedRegions(text, scanned.literals).map((region) => ({ ...region, code: true }));
    for (const comment of scanned.comments) readPragmas(text.slice(comment.start, comment.end), comment.start, lineOf, pragmas);
  } else {
    regions = [{ start: 0, text, fixable: true, afterExpr: false, beforeExpr: false, code: false }];
    readPragmas(text, 0, lineOf, pragmas);
  }

  const findings = [];
  for (const region of regions) {
    for (const { index, found, form } of matcher.find(region.text)) {
      const start = region.start + index;
      const line = lineOf(start);
      const column = start - lineStarts[line - 1];
      const word = found.toLowerCase();
      if (form.term.enforce === "new" && added !== null && !added.has(line)) continue;
      if (skipped(line)) continue;
      if (pragmas.file.has(word) || pragmas.lines.get(line)?.has(word) || pragmas.lines.get(line - 1)?.has(word)) continue;
      if (matcher.insideAllowed(form.term, lineText(line), column, column + found.length)) continue;
      const use = substituteFor(found, form);
      const touchesExpression = (region.afterExpr && index === 0) || (region.beforeExpr && index + found.length === region.text.length);
      findings.push({
        file,
        line,
        // A byte order mark is not a column anybody sees.
        col: column + 1 - (line === 1 && text.charCodeAt(0) === 0xfeff ? 1 : 0),
        start,
        end: start + found.length,
        found,
        use,
        term: form.term,
        fixable: form.autofix && region.fixable && !touchesExpression && !(region.code && BREAKS_A_LITERAL.test(use)),
      });
    }
  }
  findings.sort((a, b) => a.start - b.start);
  return { findings, lines, error: null };
}

/**
 * The skipped lines: each line that starts with a prefix, and the lines
 * directly below it that are indented deeper (blank lines included).
 */
function skippedBlocks(lineCount, lineText, prefixes) {
  const skipped = new Set();
  const indentOf = (text) => text.length - text.trimStart().length;
  let under = -1;
  for (let line = 1; line <= lineCount; line += 1) {
    const text = lineText(line);
    if (prefixes.some((prefix) => text.trimStart().startsWith(prefix))) {
      under = indentOf(text);
      skipped.add(line);
    } else if (under !== -1 && (text.trim() === "" || indentOf(text) > under)) skipped.add(line);
    else under = -1;
  }
  return skipped;
}

/** Collect the pragmas of one comment (or of a whole plain-text file) that starts at `offset`. */
function readPragmas(text, offset, lineOf, pragmas) {
  for (const match of text.matchAll(PRAGMA)) {
    const words = match[2]
      .split(",")
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean);
    if (match[1]) {
      for (const word of words) pragmas.file.add(word);
      continue;
    }
    const line = lineOf(offset + match.index);
    if (!pragmas.lines.has(line)) pragmas.lines.set(line, new Set());
    for (const word of words) pragmas.lines.get(line).add(word);
  }
}
