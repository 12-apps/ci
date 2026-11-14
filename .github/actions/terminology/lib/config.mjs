/**
 * The consumer's glossary: which words are forbidden, what replaces each, and
 * where the rule applies.
 *
 *     {
 *       "include": ["docs/**", "apps/web/content/help/**"],
 *       "exclude": ["docs/archive/**"],
 *       "skipLines": ["keywords:"],
 *       "terms": [
 *         { "use": "motoboy", "avoid": ["entregador", { "word": "entregadores", "use": "motoboys" }],
 *           "autofix": true, "enforce": "new", "reason": "…" },
 *         { "use": "ficha técnica", "definition": "A composição de um produto." }
 *       ]
 *     }
 *
 * Validation is strict in one direction on purpose: a key this file does not
 * know is an error at every level. A typo such as `autofx` would otherwise
 * switch a rule off and the gate would go on reporting success.
 */
import { readFileSync } from "node:fs";

import { globMatcher } from "./globs.mjs";
import { buildMatcher } from "./matcher.mjs";

const TOP_KEYS = ["include", "exclude", "skipLines", "terms"];
const TERM_KEYS = ["use", "definition", "search", "avoid", "autofix", "enforce", "allow", "paths", "reason"];
const AVOID_KEYS = ["word", "use", "autofix"];

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** A word or phrase: non-empty, no surrounding space, on one line, no control character. */
const isPhrase = (value) => typeof value === "string" && value.length > 0 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);

/**
 * @param {string} path
 * @returns {{ config: object | null, problems: string[] }}
 */
export function loadConfig(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { config: null, problems: [`cannot read the config: ${error.message}`] };
  }
  return parseConfig(raw);
}

/** The same, over an already-parsed document. */
export function parseConfig(raw) {
  const problems = [];
  const at = (where, message) => problems.push(`${where}: ${message}`);
  if (!isObject(raw)) return { config: null, problems: ["the config must be a JSON object"] };

  unknownKeys(raw, TOP_KEYS, "config", at);
  const include = phraseList(raw.include, "include", at);
  if (raw.include === undefined || (Array.isArray(raw.include) && raw.include.length === 0))
    at("include", "is required: a non-empty list of path globs");
  const exclude = phraseList(raw.exclude, "exclude", at);
  const skipLines = phraseList(raw.skipLines, "skipLines", at);

  const terms = [];
  if (!Array.isArray(raw.terms) || raw.terms.length === 0) at("terms", "is required: a non-empty list of terms");
  else raw.terms.forEach((term, index) => terms.push(parseTerm(term, `terms[${index}]`, at)));
  forbiddenOnce(terms, at);
  if (problems.length === 0) substitutesAreClean(terms, at);

  if (problems.length > 0) return { config: null, problems };
  return {
    config: { include, exclude, skipLines, terms, included: globMatcher(include), excluded: globMatcher(exclude) },
    problems,
  };
}

/** What `--list` prints: every term with its defaults filled in, and nothing compiled. */
export const listTerms = (config) => ({
  terms: config.terms.map(({ use, definition, search, avoid, autofix, enforce, allow, paths, reason }) => ({
    use,
    definition,
    search,
    avoid: avoid.map((entry) => ({ word: entry.word, use: entry.use, autofix: entry.autofix })),
    autofix,
    enforce,
    allow,
    paths,
    reason,
  })),
});

function unknownKeys(object, allowed, where, at) {
  for (const key of Object.keys(object))
    if (!allowed.includes(key)) at(where, `unknown key "${key}" (allowed: ${allowed.join(", ")})`);
}

/** A list of phrases, or [] with a problem recorded; `undefined` is an empty list. */
function phraseList(value, where, at) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isPhrase)) {
    at(where, "must be a list of non-empty strings");
    return [];
  }
  return value;
}

function parseTerm(raw, where, at) {
  const term = { use: "", definition: null, search: [], avoid: [], autofix: false, enforce: "all", allow: [], paths: [], reason: "", inPaths: () => true };
  if (!isObject(raw)) {
    at(where, "must be an object");
    return term;
  }
  unknownKeys(raw, TERM_KEYS, where, at);

  if (isPhrase(raw.use)) term.use = raw.use;
  else at(`${where}.use`, "is required: the canonical word, a non-empty string");
  if (raw.definition !== undefined) {
    if (typeof raw.definition === "string" && raw.definition.trim() !== "") term.definition = raw.definition;
    else at(`${where}.definition`, "must be a non-empty string");
  }
  if (raw.autofix !== undefined) {
    if (typeof raw.autofix === "boolean") term.autofix = raw.autofix;
    else at(`${where}.autofix`, "must be true or false");
  }
  if (raw.enforce !== undefined) {
    if (raw.enforce === "all" || raw.enforce === "new") term.enforce = raw.enforce;
    else at(`${where}.enforce`, 'must be "all" or "new"');
  }
  if (raw.reason !== undefined) {
    if (isPhrase(raw.reason)) term.reason = raw.reason;
    else at(`${where}.reason`, "must be one line of text");
  }
  term.search = phraseList(raw.search, `${where}.search`, at);
  term.allow = phraseList(raw.allow, `${where}.allow`, at);
  term.paths = phraseList(raw.paths, `${where}.paths`, at);
  if (Array.isArray(raw.paths) && raw.paths.length === 0) at(`${where}.paths`, "is empty: omit it to apply the term in the whole scope");
  if (term.paths.length > 0) term.inPaths = globMatcher(term.paths);

  if (raw.avoid === undefined) {
    if (term.definition === null) at(where, 'needs "avoid" (the forbidden words) or "definition" (a definition-only term)');
  } else if (!Array.isArray(raw.avoid) || raw.avoid.length === 0) {
    at(`${where}.avoid`, "must be a non-empty list: omit it for a definition-only term");
  } else {
    raw.avoid.forEach((entry, index) => {
      const parsed = parseAvoid(entry, term, `${where}.avoid[${index}]`, at);
      if (parsed) term.avoid.push(parsed);
    });
  }
  return term;
}

function parseAvoid(raw, term, where, at) {
  const entry = { word: "", use: term.use, autofix: term.autofix, where };
  if (typeof raw === "string") {
    entry.word = raw;
  } else if (isObject(raw)) {
    unknownKeys(raw, AVOID_KEYS, where, at);
    entry.word = raw.word;
    if (raw.use !== undefined) {
      if (isPhrase(raw.use)) entry.use = raw.use;
      else at(`${where}.use`, "must be a non-empty string");
    }
    if (raw.autofix !== undefined) {
      if (typeof raw.autofix === "boolean") entry.autofix = raw.autofix;
      else at(`${where}.autofix`, "must be true or false");
    }
  } else {
    at(where, 'must be a string or { "word", "use"?, "autofix"? }');
    return null;
  }
  if (!isPhrase(entry.word)) {
    at(typeof raw === "string" ? where : `${where}.word`, "must be a non-empty word or phrase on one line");
    return null;
  }
  if (entry.word.toLowerCase() === entry.use.toLowerCase())
    at(where, `"${entry.word}" is its own substitute: a rule that replaces a word with itself never clears`);
  return entry;
}

/**
 * No substitute may hold a forbidden form, its own or another term's: `extra`
 * → `item extra` would be rewritten again on the next run, and again.
 */
function substitutesAreClean(terms, at) {
  const judged = terms.filter((term) => term.avoid.length > 0);
  if (judged.length === 0) return;
  const matcher = buildMatcher(judged);
  for (const term of judged) {
    for (const entry of term.avoid) {
      const [inside] = matcher.find(entry.use);
      if (inside) at(entry.where, `the substitute "${entry.use}" holds the forbidden "${inside.found}" (${inside.form.where}): a fix would never settle`);
    }
  }
}

/** A forbidden word belongs to one rule: two would give a finding two substitutes. */
function forbiddenOnce(terms, at) {
  const seen = new Map();
  for (const term of terms) {
    for (const entry of term.avoid) {
      const key = entry.word.toLowerCase();
      if (seen.has(key)) at(entry.where, `"${entry.word}" is already forbidden by ${seen.get(key)}`);
      else seen.set(key, entry.where);
    }
  }
}
