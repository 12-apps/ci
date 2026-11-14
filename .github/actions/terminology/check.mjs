#!/usr/bin/env node
/* global console, process */
/**
 * `terminology`: one word per concept. A forbidden word fails the run and the
 * finding names its substitute.
 *
 *   node check.mjs --config glossary.json [--base <ref> | --staged [files…]] [--fix]
 *   node check.mjs --config glossary.json --list
 *
 * The words, the scope and the exceptions come from the consumer's glossary
 * (lib/config.mjs); nothing here knows a consumer. What is read:
 *
 *   - tracked files matching `include` and not `exclude`;
 *   - in a code file (.ts .tsx .js .jsx .mjs .cjs) only the text of string and
 *     template literals, never a comment, an identifier, an import path, a
 *     property key or a slug (lib/scanner.mjs, lib/literals.mjs);
 *   - every line for a term enforced on `all`; for one enforced on `new`, only
 *     the lines a diff adds: the working tree against the merge base with
 *     `--base <ref>`, the index against HEAD with `--staged`.
 *
 * `--fix` writes the substitute over every finding whose rule allows it, in
 * the working tree, and reports what is left. `--list` prints the terms as
 * JSON, for a consumer that renders its glossary from the same file.
 *
 * Exit status: 0 nothing found, 1 findings, 2 the config or the call is wrong
 * (or a file could not be scanned). A run that would read nothing is a 2,
 * never a 0.
 */
import { appendFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listTerms, loadConfig } from "./lib/config.mjs";
import { fixFile } from "./lib/fixer.mjs";
import { repoPrefix, UsageError } from "./lib/git.mjs";
import { judgeFile } from "./lib/judge.mjs";
import { buildMatcher } from "./lib/matcher.mjs";
import { planWork } from "./lib/plan.mjs";
import { ANNOTATION_LIMIT, errorAnnotation, findingAnnotation, findingLine, fixCommand, stepSummary, summaryLine } from "./lib/report.mjs";

const USAGE = "usage: node check.mjs --config <glossary.json> [--base <ref> | --staged [files…]] [--fix] [--list] [--root <dir>]";
const onActions = process.env.GITHUB_ACTIONS === "true";

function parseArgs(argv) {
  const options = { config: null, root: null, base: null, staged: false, fix: false, list: false, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      options.files.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) options.files.push(arg);
    else if (["--config", "--root", "--base"].includes(arg)) {
      i += 1;
      if (argv[i] === undefined || argv[i] === "") throw new UsageError(`${arg} needs a value\n${USAGE}`);
      options[arg.slice(2)] = argv[i];
    } else if (["--staged", "--fix", "--list"].includes(arg)) options[arg.slice(2)] = true;
    else throw new UsageError(`unknown option ${arg}\n${USAGE}`);
  }
  if (options.config === null) throw new UsageError(`--config is required: the JSON glossary\n${USAGE}`);
  if (options.base !== null && options.staged) throw new UsageError("--base and --staged are two different diffs: pass one");
  if (options.files.length > 0 && !options.staged) throw new UsageError(`file arguments are read only with --staged\n${USAGE}`);
  return options;
}

/** Report a problem that is not a finding. Always exit status 2. */
function refuse(message, where = {}) {
  console.error(`terminology: ${message}`);
  if (onActions) console.log(errorAnnotation(message, where));
  return 2;
}

/** Judge every planned file. Returns the findings, the unscannable files and the totals. */
function judgeAll({ tasks, terms, skipLines }) {
  const matchers = new Map();
  const result = { findings: [], errors: [], bytes: new Map(), files: 0, lines: 0 };
  for (const task of tasks) {
    const applicable = terms.filter((term) => term.inPaths(task.file) && (term.enforce === "all" || task.added === null || task.added.size > 0));
    if (applicable.length === 0) continue;
    const bytes = task.read();
    if (bytes === null) continue;
    const key = applicable.map((term) => terms.indexOf(term)).join(",");
    if (!matchers.has(key)) matchers.set(key, buildMatcher(applicable));
    const judged = judgeFile({ file: task.file, text: bytes.toString("utf8"), matcher: matchers.get(key), skipLines, added: task.added });
    result.files += 1;
    result.lines += judged.lines;
    if (judged.error) result.errors.push({ file: task.file, ...judged.error });
    if (judged.findings.length > 0) {
      result.findings.push(...judged.findings);
      result.bytes.set(task.file, bytes);
    }
  }
  return result;
}

/** Rewrite what can be rewritten. Returns the fixed findings and the files left alone, by why. */
function fixAll({ root, findings, bytes, staged }) {
  const byFile = new Map();
  for (const finding of findings.filter((each) => each.fixable)) byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
  const outcome = { fixed: new Set(), unstaged: [], encoding: [] };
  for (const [file, list] of byFile) {
    const verdict = fixFile({ root, file, bytes: bytes.get(file), findings: list, staged });
    if (verdict === "fixed") {
      console.log(`fixed: ${file}`);
      for (const finding of list) outcome.fixed.add(finding);
    } else outcome[verdict].push(file);
  }
  return outcome;
}

/** This script as the reader would type it: relative to where they stand, unless the absolute path is shorter. */
function ownPath() {
  const absolute = fileURLToPath(import.meta.url);
  const fromHere = relative(process.cwd(), absolute);
  return fromHere.length < absolute.length ? fromHere : absolute;
}

function main(argv) {
  const options = parseArgs(argv);
  const root = resolve(options.root ?? process.cwd());
  const { config, problems } = loadConfig(resolve(root, options.config));
  if (config === null) {
    for (const problem of problems) refuse(`${options.config}: ${problem}`, { file: repoPrefix(root) + options.config });
    return 2;
  }
  if (options.list) {
    console.log(JSON.stringify(listTerms(config), null, 2));
    return 0;
  }

  const terms = config.terms.filter((term) => term.avoid.length > 0);
  if (terms.length === 0) throw new UsageError("no term has an avoid list: the check would pass having judged nothing");
  const fresh = terms.filter((term) => term.enforce === "new");
  if (fresh.length > 0 && !options.staged && options.base === null)
    throw new UsageError(
      `${fresh.length} term(s) are enforced on new lines only (${fresh.map((term) => term.use).join(", ")}): ` +
        "pass --base <ref> or --staged, so there is a diff to read the new lines from",
    );

  const tasks = planWork({ root, config, base: options.base, staged: options.staged, files: options.files });
  const judged = judgeAll({ tasks, terms, skipLines: config.skipLines });
  if (judged.errors.length > 0) {
    for (const { file, line, message } of judged.errors)
      refuse(`could not scan ${file}:${line}: ${message}. The file is read as code and nothing in it was judged; see "Files the scanner refuses" in the README`, {
        file: repoPrefix(root) + file,
        line,
      });
    return 2;
  }

  const fixes = options.fix ? fixAll({ root, findings: judged.findings, bytes: judged.bytes, staged: options.staged }) : { fixed: new Set(), unstaged: [], encoding: [] };
  const left = judged.findings.filter((finding) => !fixes.fixed.has(finding));
  for (const finding of left) console.log(findingLine(finding));
  const annotated = onActions ? left.slice(0, ANNOTATION_LIMIT) : left;
  if (onActions && annotated.length > 0) {
    const prefix = repoPrefix(root);
    for (const finding of annotated) console.log(findingAnnotation(finding, prefix));
  }

  if (judged.files === 0) console.log("[terminology] the diff touches no file in scope: nothing to judge.");
  const summary = summaryLine({ files: judged.files, lines: judged.lines, findings: left.length, fixed: fixes.fixed.size, annotated: annotated.length });
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, stepSummary({ terms, left, fixed: [...fixes.fixed], summary }));

  const call = { script: onActions ? "<ci>/.github/actions/terminology/check.mjs" : ownPath(), config: options.config, root: options.root };
  const mode = options.staged ? ["--staged"] : options.base === null ? [] : ["--base", options.base];
  const fixable = left.filter((finding) => finding.fixable).length;
  if (fixes.unstaged.length > 0) {
    console.log(`[terminology] not rewritten, the file has unstaged changes: ${fixes.unstaged.join(", ")}`);
    console.log(`  rewrite the working tree, then stage the corrected lines:\n  ${fixCommand({ ...call, mode: ["--base", "HEAD"] })}`);
  }
  if (fixes.encoding.length > 0) console.log(`[terminology] not rewritten, the file is not valid UTF-8: ${fixes.encoding.join(", ")}`);
  if (!options.fix && fixable > 0) console.log(`[terminology] ${fixable} of them can be rewritten for you:\n  ${fixCommand({ ...call, mode })}`);
  return left.length > 0 ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  // Exit status 1 means findings and nothing else: anything unexpected is a 2.
  process.exitCode = refuse(error instanceof UsageError ? error.message : `unexpected failure: ${error.stack ?? error}`);
}
