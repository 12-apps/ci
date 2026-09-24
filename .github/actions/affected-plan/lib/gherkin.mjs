/**
 * Gherkin: which FEATURES a plan reaches, through the step definitions it
 * reached — read statically, with no install and no `bddgen`.
 *
 * A step file is a list of `Given("…", fn)` calls, and the lane's `calls`
 * option brackets each as a declaration (exports-dataflow.mjs), so the walk
 * already knows WHICH definitions can see a change: `affected` holds
 * `Given@3`-style names for them, or `"*"`. What is left is text on both
 * sides: each definition's pattern, and each feature's step lines. A feature
 * runs when one of its lines matches a reached definition.
 *
 * ## The answer never trusts the resolver to be complete
 *
 * A pattern is a string (a Cucumber expression), a regex literal, a
 * `new RegExp(…)` over same-file string constants, or a same-file constant
 * holding one of those. Anything else — `new RegExp(keys.join("|"))` — is
 * UNRESOLVED, and is handled without guessing: the runner refuses an
 * undefined or an ambiguous step, so every line of a compiled feature matches
 * exactly one definition of its project. A line that no readable pattern
 * matches (an ORPHAN) therefore belongs to a definition this reader could not
 * read — or read WRONG, which is the case worth designing for: a misread
 * pattern matches none of its own lines, and nothing would say so. So a
 * project with any definition reached also selects every feature carrying an
 * orphan line, whoever owns it. A resolver gap widens the answer; it can
 * never drop a feature.
 *
 * A step file that cannot be bracketed at all (a hook, or any other
 * module-level statement, runs for every scenario of its project) selects its
 * whole project, and says so.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { declarationsOf } from "./exports-dataflow.mjs";

const IDENT_RE = /^[A-Za-z_$][\w$]*/;

/** The end index (exclusive) of the quoted literal opening at `i`, or -1. */
function quotedEnd(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === q) return j + 1;
    else if (src[j] === "\n" && q !== "`") return -1;
  }
  return -1;
}

/** The end of the regex literal opening at `i` (flags included), or -1. */
function regexEnd(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length && src[j] !== "\n"; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      let k = j + 1;
      while (/[a-z]/.test(src[k] ?? "")) k++;
      return k;
    }
  }
  return -1;
}

/** One escape sequence of a string/template literal, cooked. */
const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
function cookEscape(body, j) {
  const c = body[j];
  if (c === "u" && body[j + 1] === "{") {
    const end = body.indexOf("}", j);
    return [String.fromCodePoint(parseInt(body.slice(j + 2, end), 16)), end + 1];
  }
  if (c === "u") return [String.fromCharCode(parseInt(body.slice(j + 1, j + 5), 16)), j + 5];
  if (c === "x") return [String.fromCharCode(parseInt(body.slice(j + 1, j + 3), 16)), j + 3];
  if (c === "\n") return ["", j + 1];
  return [ESCAPES[c] ?? c, j + 1];
}

/**
 * The value of a string or template literal (quotes included), with `${NAME}`
 * substituted from same-file constants and `${"…"}` from its own literal; null
 * when a `${}` holds anything else. Cooked by hand — nothing from the file is evaluated.
 */
function cook(literal, resolveName) {
  const body = literal.slice(1, -1);
  const template = literal[0] === "`";
  let out = "";
  for (let j = 0; j < body.length; ) {
    if (body[j] === "\\") {
      const [text, next] = cookEscape(body, j + 1);
      out += text;
      j = next;
    } else if (template && body.startsWith("${", j)) {
      const end = body.indexOf("}", j);
      const expr = end < 0 ? "" : body.slice(j + 2, end).trim();
      // A quoted literal is a constant too: `${"(?:her|his)"}`.
      const literal = /^(["'])(?:(?!\1)[^\\]|\\.)*\1$/.test(expr);
      const value = end < 0 ? null : literal ? cook(expr, resolveName) : resolveName(expr);
      if (typeof value !== "string") return null;
      out += value;
      j = end + 1;
    } else {
      out += body[j];
      j += 1;
    }
  }
  return out;
}

/** A regex literal's source text → RegExp, or null. */
function regexFromLiteral(literal) {
  const close = literal.lastIndexOf("/");
  return safeRegExp(literal.slice(1, close), literal.slice(close + 1));
}

/** A matcher without `g`/`y`: those make `test` stateful across lines. */
function safeRegExp(source, flags = "") {
  try {
    return new RegExp(source, flags.replace(/[gy]/g, ""));
  } catch {
    return null;
  }
}

/** What each Cucumber parameter type matches; a custom type matches anything. */
// Cucumber's own definitions: an integer, and a float whose exponent is an
// upper-case E.
const INTEGER = "-?\\d+";
const NUMBER = "(?=.*\\d)[-+]?\\d*(?:\\.(?=\\d))?\\d*(?:\\d+E[-+]?\\d+)?";
const PARAMETERS = {
  int: INTEGER,
  long: INTEGER,
  short: INTEGER,
  byte: INTEGER,
  biginteger: INTEGER,
  float: NUMBER,
  double: NUMBER,
  bigdecimal: NUMBER,
  word: "[^\\s]+",
  string: "\"[^\"]*\"|'[^']*'",
  "": ".*",
};
const escapeText = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * One alternative of a Cucumber expression → regex source: `\x` is a literal
 * x, `{type}` a parameter, `(text)` optional text. Null when malformed.
 */
function compileCucumber(text, broad) {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === "\\") {
      out += escapeText(text[i + 1] ?? "");
      i += 2;
    } else if (c === "{" || c === "(") {
      const end = text.indexOf(c === "{" ? "}" : ")", i);
      if (end < 0) return null;
      const inner = text.slice(i + 1, end);
      const known = Object.hasOwn(PARAMETERS, inner);
      if (c === "{" && !known) broad.hit = true;
      out += c === "{" ? `(${known ? PARAMETERS[inner] : ".*"})` : `(?:${escapeText(inner)})?`;
      i = end + 1;
    } else {
      out += escapeText(c);
      i += 1;
    }
  }
  return out;
}

/**
 * A Cucumber expression as a matcher — every parameter type, optional text,
 * `\` escapes, and alternation (`pays/checks out` is "pays out" or "checks
 * out": `/` binds within one whitespace-delimited word). Null when malformed.
 */
export function cucumberMatcher(pattern) {
  const broad = { hit: false };
  const words = pattern.split(/(\s+)/);
  const parts = words.map((word) => {
    if (/^\s+$/.test(word)) return escapeText(word);
    const alternatives = word.split(/(?<!\\)\/(?![^({]*[)}])/);
    const compiled = alternatives.map((alt) => compileCucumber(alt, broad));
    if (compiled.some((x) => x === null)) return null;
    return compiled.length > 1 ? `(?:${compiled.join("|")})` : compiled[0];
  });
  if (parts.some((x) => x === null)) return null;
  const re = safeRegExp(`^${parts.join("")}$`);
  // A custom type is guessed as "anything": good enough to SELECT with, too
  // broad to prove a line is NOT another definition's (see projectIndex).
  if (re && broad.hit) re.broad = true;
  return re;
}

/** The pattern expression at `i` → RegExp, string (Cucumber), or null. */
function patternAt(src, i, resolveName) {
  const c = src[i];
  // A literal is the pattern only when the argument ends right after it:
  // `"the shopper " + "pays"` is an expression, and an expression is not read.
  const ends = (end) => /^\s*(?:[,);]|$)/.test(src.slice(end));
  if (c === '"' || c === "'" || c === "`") {
    const end = quotedEnd(src, i);
    return end < 0 || !ends(end) ? null : cook(src.slice(i, end), resolveName);
  }
  if (c === "/") {
    const end = regexEnd(src, i);
    return end < 0 || !ends(end) ? null : regexFromLiteral(src.slice(i, end));
  }
  const ctor = /^new\s+RegExp\(\s*/.exec(src.slice(i, i + 40));
  if (ctor) {
    const inner = patternAt(src, i + ctor[0].length, resolveName);
    const rest = src.slice(i + ctor[0].length);
    // A second argument (flags) or anything after the literal is not read.
    const closes = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)\s*\)/s.test(rest);
    return typeof inner === "string" && closes ? safeRegExp(inner) : null;
  }
  const name = IDENT_RE.exec(src.slice(i, i + 80));
  return name && /^\s*(?:[,);]|$)/.test(src.slice(i + name[0].length)) ? resolveName(name[0]) : null;
}

/**
 * A resolver for the file's TOP-LEVEL `const NAME = <pattern>` declarations —
 * the only scope a top-level step call can see; a `const` of the same name
 * inside a function is another binding.
 */
function constResolver(decls) {
  const consts = new Map();
  for (const d of decls) {
    const m = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*/.exec(d.text);
    if (m && !d.names) consts.set(m[1], { text: d.text.trim(), at: m[0].trim().length });
  }
  const resolving = new Set();
  const resolveName = (name) => {
    const c = consts.get(name);
    if (!c || resolving.has(name)) return null;
    resolving.add(name);
    let at = c.at;
    while (/\s/.test(c.text[at] ?? "")) at += 1;
    const value = patternAt(c.text, at, resolveName);
    resolving.delete(name);
    return value;
  };
  return resolveName;
}

/**
 * A step file's definitions, in bracketing order — `{ name, matcher }` with a
 * null matcher when the pattern cannot be read — or null when the file cannot
 * be bracketed.
 */
export function stepDefinitions(source, calls) {
  const decls = declarationsOf(source, { calls });
  if (decls === null) return null;
  const resolveName = constResolver(decls);
  return decls
    .filter((d) => d.call)
    .map((d) => {
      const open = d.text.indexOf("(");
      let at = open + 1;
      while (/\s/.test(d.text[at] ?? "")) at++;
      const p = patternAt(d.text, at, resolveName);
      const matcher = p instanceof RegExp ? safeRegExp(p.source, p.flags) : typeof p === "string" ? cucumberMatcher(p) : null;
      return { name: d.name, matcher };
    });
}

/**
 * Every step line a feature can run, with `<placeholders>` expanded from each
 * Examples row — under a Scenario Outline or, as Gherkin 6 allows, a plain
 * Scenario. A Feature's or Rule's description is prose even when a line of it
 * starts with "When". Null when the feature cannot be read here: a
 * non-English `# language:` header, or no step line at all — the caller then
 * treats every line of it as unmatched.
 */
export function featureStepTexts(text) {
  const language = /^\s*#\s*language:\s*(\S+)/m.exec(text);
  if (language && !/^en\b/.test(language[1])) return null;
  const steps = [];
  let block = null; // { steps, rows } of the Scenario being read, or "background"
  let header = null;
  let inExamples = false;
  let inDocString = false;
  const flush = () => {
    if (block && block !== "background") {
      for (const t of block.steps) {
        if (!/<[^>]+>/.test(t) || block.rows.length === 0) steps.push(t);
        else for (const row of block.rows) steps.push(t.replace(/<([^>]+)>/g, (m, k) => row[k] ?? m));
      }
    }
    block = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('"""') || line.startsWith("```")) {
      inDocString = !inDocString;
      continue;
    }
    if (inDocString || line.startsWith("#")) continue;
    if (/^(Scenario Outline|Scenario Template|Scenario|Example):/.test(line)) {
      flush();
      block = { steps: [], rows: [] };
      inExamples = false;
    } else if (/^Background:/.test(line)) {
      flush();
      block = "background";
      inExamples = false;
    } else if (/^(Rule|Feature):/.test(line)) {
      flush();
      inExamples = false;
    } else if (/^(Examples|Scenarios):/.test(line)) {
      inExamples = true;
      header = null;
    } else if (line.startsWith("|") && inExamples && block && block !== "background") {
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (!header) header = cells;
      else block.rows.push(Object.fromEntries(header.map((h, k) => [h, cells[k]])));
    } else if (block && !inExamples) {
      const step = /^(?:Given|When|Then|And|But|\*)\s+(.*)$/.exec(line);
      if (step) (block === "background" ? steps : block.steps).push(step[1]);
    }
  }
  flush();
  return steps.length > 0 ? steps : null;
}

/** Every file under `dir` (repo-relative) whose name ends with one of `exts`. */
function filesUnder(repoRoot, dir, exts) {
  let entries;
  try {
    entries = readdirSync(join(repoRoot, dir));
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const rel = `${dir.replace(/\/$/, "")}/${entry}`;
    if (statSync(join(repoRoot, rel)).isDirectory()) return filesUnder(repoRoot, rel, exts);
    return exts.some((e) => entry.endsWith(e)) ? [rel] : [];
  });
}

/** One project's index: its step files' definitions and its features' lines. */
function projectIndex(repoRoot, project, calls, read) {
  const stepFiles = filesUnder(repoRoot, project.steps, [".ts", ".tsx", ".js", ".mjs", ".cjs"]);
  const features = filesUnder(repoRoot, project.features, [".feature"]).sort();
  const defs = new Map(stepFiles.map((f) => [f, stepDefinitions(read(f), calls)]));
  const lines = new Map(features.map((f) => [f, featureStepTexts(read(f))]));
  // A broad matcher may claim a line that is really an unreadable
  // definition's, so it never proves a line is spoken for.
  const resolved = [...defs.values()].flatMap((d) => (d ?? []).map((x) => x.matcher).filter((m) => m && !m.broad));
  // A feature that cannot be read is all orphan lines.
  const orphans = features.filter((f) => {
    const texts = lines.get(f);
    return texts === null || texts.some((t) => !resolved.some((re) => re.test(t)));
  });
  return { features, defs, lines, orphans };
}

/** The features one reached step file selects, and why. */
function featuresOfStepFile(index, file, reached) {
  const defs = index.defs.get(file);
  if (defs === null) return { definitions: "*", features: index.features, why: "cannot be bracketed — a module-level statement runs for every scenario" };
  const hot = reached === "*" ? defs : defs.filter((d) => reached.has(d.name));
  if (hot.length === 0) return null;
  const matchers = hot.map((d) => d.matcher).filter(Boolean);
  const features = index.features.filter(
    (f) => index.orphans.includes(f) || index.lines.get(f).some((t) => matchers.some((re) => re.test(t))),
  );
  return {
    definitions: reached === "*" ? "*" : hot.length,
    features,
    ...(index.orphans.length > 0
      ? { why: `with ${index.orphans.length} feature(s) holding a line no readable pattern matches — its definition may be the one reached` }
      : {}),
  };
}

/**
 * The features a plan reaches.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {{steps: string, features: string}[]} options.projects  dirs, repo-relative
 * @param {string[]} options.calls
 * @param {Map<string, Set<string>|"*">} options.affected  select.mjs's answer
 * @param {(file: string) => string} [options.read]
 * @returns {{features: string[], steps: Record<string, {definitions: number|"*", features: string[], why?: string}>}}
 */
export function gherkinFeatures({ repoRoot, projects, calls, affected, read = (f) => readFileSync(join(repoRoot, f), "utf8") }) {
  const selected = new Set();
  const steps = {};
  for (const project of projects) {
    const prefix = `${project.steps.replace(/\/$/, "")}/`;
    const reached = [...affected.entries()].filter(([f]) => f.startsWith(prefix));
    if (reached.length === 0) continue;
    const index = projectIndex(repoRoot, project, calls, read);
    for (const [file, names] of reached) {
      if (!index.defs.has(file)) {
        // Deleted: whoever still speaks its steps is bound to nothing now,
        // and a line bound to nothing is exactly an orphan.
        if (!existsSync(join(repoRoot, file))) {
          steps[file] = { definitions: "*", features: index.orphans, why: "deleted — the features still speaking its steps are bound to nothing" };
          index.orphans.forEach((f) => selected.add(f));
        }
        continue;
      }
      const answer = featuresOfStepFile(index, file, names);
      if (!answer) continue;
      steps[file] = answer;
      answer.features.forEach((f) => selected.add(f));
    }
  }
  return { features: [...selected].sort(), steps };
}
