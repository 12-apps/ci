/**
 * What a run prints: the finding lines, the GitHub annotations, the summary
 * line, the job-summary table and the command that fixes what can be fixed.
 * Pure text in, text out; check.mjs decides where it goes.
 */

/** Enough to mark a pull request's diff without burying it; every finding is in the log either way. */
export const ANNOTATION_LIMIT = 30;

const escapeData = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (text) => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** A path at the start of a log line must never read as a workflow command (`::notice::…`). */
export const printable = (file) => (file.startsWith("::") ? `./${file}` : file);

const verdict = (finding) => `"${finding.found}" → use "${finding.use}"`;

/** `apps/x/copy.pt-BR.ts:12:18  "entregador" → use "motoboy"  (reason)` */
export const findingLine = (finding) =>
  `${printable(finding.file)}:${finding.line}:${finding.col}  ${verdict(finding)}${finding.term.reason ? `  (${finding.term.reason})` : ""}`;

/**
 * The workflow command that puts a finding on the pull request's diff.
 * `prefix` is the checked directory's path inside the repository, since
 * GitHub resolves `file=` from the repository root.
 */
export const findingAnnotation = (finding, prefix = "") =>
  `::error file=${escapeProperty(prefix + finding.file)},line=${finding.line},col=${finding.col},title=Terminology::${escapeData(
    `${verdict(finding)}${finding.term.reason ? ` (${finding.term.reason})` : ""}`,
  )}`;

/** An error that is not a finding: a config problem, a file the scanner could not follow. */
export const errorAnnotation = (message, { file = null, line = null } = {}) => {
  const where = [file === null ? null : `file=${escapeProperty(file)}`, line === null ? null : `line=${line}`, "title=Terminology"];
  return `::error ${where.filter(Boolean).join(",")}::${escapeData(message)}`;
};

/**
 * @param {{ files: number, lines: number, findings: number, fixed: number, annotated?: number }} totals
 *   `annotated` is set under GitHub Actions: how many findings got an annotation.
 */
export function summaryLine({ files, lines, findings, fixed, annotated = findings }) {
  const hidden = findings - annotated;
  const overflow = hidden > 0 ? ` Annotations stop at ${ANNOTATION_LIMIT}: ${hidden} more finding(s) are only in the list above.` : "";
  return `[terminology] ${files} file(s) read, ${lines} line(s) judged, ${findings} finding(s), ${fixed} fixed.${overflow}`;
}

/** The table for `$GITHUB_STEP_SUMMARY`: one row per enforced term. */
export function stepSummary({ terms, left, fixed, summary }) {
  const count = (list, term) => list.filter((finding) => finding.term === term).length;
  const cell = (text) => text.replace(/\|/g, "\\|");
  return [
    "### Terminology",
    "",
    "| term | findings | fixed |",
    "| --- | ---: | ---: |",
    ...terms.map((term) => `| ${cell(term.use)} | ${count(left, term)} | ${count(fixed, term)} |`),
    "",
    summary,
    "",
  ].join("\n");
}

const shellWord = (text) => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`);

/**
 * The command that rewrites the autofixable findings, as the person reading
 * the report would type it: the same script, config and mode, plus `--fix`.
 *
 * @param {{ script: string, config: string, root: string | null, mode: string[] }} call
 *   `script` is printed as given when it is the `<ci>/…` placeholder.
 */
export const fixCommand = ({ script, config, root, mode }) =>
  [
    "node",
    script.startsWith("<ci>/") ? script : shellWord(script),
    ...["--config", config, ...(root === null ? [] : ["--root", root]), ...mode, "--fix"].map(shellWord),
  ].join(" ");
