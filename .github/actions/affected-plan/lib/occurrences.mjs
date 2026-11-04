/**
 * From "this pattern occurs in these files" to route entries the walk can use.
 *
 * Two routers need the same last step. The database router finds the code that
 * touches a table or a column; the key router (keys.mjs) finds the code that
 * names a seeded record. Either way the answer must be as narrow as the hit:
 *
 * - a TEST that matches is an entry on its own — it runs;
 * - any other source file is attributed to the top-level declarations that
 *   hold the match, then to the exports that can see them (exports-dataflow),
 *   and the entry is `file#a,b` — the walk starts from those symbols, not from
 *   every export of a module that happens to mention the pattern once;
 * - a match no declaration owns is module-level code, which can reach any
 *   export, so the whole file is the entry. So is a file that cannot be
 *   bracketed into declarations. Both widen; neither guesses.
 */
import { declarationsOf, reachableExports } from "./exports-dataflow.mjs";

const IMPORT_LINE = /^\s*(?:import\b|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\b).*$/gm;

const count = (re, text) => (text.match(new RegExp(re.source, `${re.flags.replace("g", "")}g`)) ?? []).length;

/**
 * @param {object} options
 * @param {string[]} options.files        source files to search
 * @param {(file:string)=>string|null} options.textOf
 * @param {(file:string)=>boolean} options.isTest
 * @param {{re:RegExp, mentionRe:RegExp|null}[]} options.specs
 *   `re` is the pattern; when `mentionRe` is set, a hit only counts in a file —
 *   and a declaration — that ALSO matches it (a one-word field beside its model).
 * @param {ReturnType<typeof matchCache>} [options.cache]
 *   Shared across calls over the SAME files and texts (one router run), so a
 *   pattern is tested against each file once however many calls ask for it.
 *   The database router calls this once per migration — 567 in future-pay, all
 *   over the same files and mostly the same models — and without the cache
 *   that repetition was 94% of a 5-minute integration plan (12-apps/ci, the
 *   lane-timings change). The answer is identical with or without it.
 * @returns {string[]} entries: `file` or `file#a,b`
 */
export function entriesForMatches({ files, textOf, isTest, specs, cache = null }) {
  if (specs.length === 0) return [];
  const matches = cache ? (re, file) => cache.matching(re, files, textOf).has(file) : (re, file) => re.test(textOf(file));
  // With a cache, only the files some spec matches are visited at all; the
  // order of `files` is kept, so the entries come out in the same order.
  const candidates = cache
    ? (() => {
        const hit = new Set();
        for (const s of specs) for (const f of cache.matching(s.re, files, textOf)) hit.add(f);
        return files.filter((f) => hit.has(f));
      })()
    : files;
  const entries = [];
  for (const file of candidates) {
    const text = textOf(file);
    if (!text) continue;
    const live = specs.filter((s) => matches(s.re, file) && (!s.mentionRe || matches(s.mentionRe, file)));
    if (live.length === 0) continue;
    if (isTest(file)) {
      entries.push(file);
      continue;
    }
    const decls = cache ? cache.declarations(file, text) : declarationsOf(text);
    if (decls === null) {
      entries.push(file);
      continue;
    }
    const hot = new Set();
    let inDecls = 0;
    let everywhere = 0;
    const outsideImports = text.replace(IMPORT_LINE, "");
    for (const s of live) {
      const owns = (t) => s.re.test(t) && (!s.mentionRe || s.mentionRe.test(t));
      for (const d of decls)
        if (owns(d.text)) {
          hot.add(d.name);
          inDecls += count(s.re, d.text);
        }
      everywhere += s.mentionRe ? 0 : count(s.re, outsideImports);
    }
    // A hit no declaration owns is module-level code — it can reach anything.
    if (everywhere > inDecls) {
      entries.push(file);
      continue;
    }
    const reach = cache ? cache.reachable(file, text, hot) : reachableExports(text, hot);
    if (reach === "*") entries.push(file);
    else if (reach.size > 0) entries.push(`${file}#${[...reach].sort().join(",")}`);
  }
  return entries;
}

/**
 * The memo `entriesForMatches` shares across calls: which files a pattern
 * matches (keyed by its source and flags — the specs are rebuilt per call, so
 * the RegExp objects differ while the patterns repeat), and each file's
 * declarations. Valid only while `files` and `textOf` stay the same.
 */
export function matchCache() {
  const byPattern = new Map();
  const decls = new Map();
  const reach = new Map();
  // file -> its set of whole words. `\b` splits exactly where [A-Za-z0-9_]
  // does, so `\b(?:a|b)\b` over plain identifiers matches a text iff one of
  // them is among its words: a Set lookup per name instead of a regex per file.
  // Thousands of such patterns (one per model field) over thousands of files
  // were most of what was left of the plan once the memo was in.
  const words = new Map();
  const wordsOf = (file, textOf) => {
    let set = words.get(file);
    if (!set) {
      set = new Set((textOf(file) ?? "").match(/[A-Za-z0-9_]+/g) ?? []);
      words.set(file, set);
    }
    return set;
  };
  // The same, lower-cased: the anchor pre-filter of a case-insensitive pattern.
  const lowerWords = new Map();
  const lowerWordsOf = (file, textOf) => {
    let set = lowerWords.get(file);
    if (!set) {
      set = new Set([...wordsOf(file, textOf)].map((w) => w.toLowerCase()));
      lowerWords.set(file, set);
    }
    return set;
  };
  return {
    matching(re, files, textOf) {
      const key = `${re.flags}/${re.source}`;
      let hit = byPattern.get(key);
      const names = hit ? null : identifierAlternation(re);
      if (!hit && names) {
        hit = new Set();
        for (const f of files) {
          const set = wordsOf(f, textOf);
          if (names.some((n) => set.has(n))) hit.add(f);
        }
        byPattern.set(key, hit);
      }
      if (!hit) {
        // A global or sticky RegExp keeps state between .test() calls; test a
        // stateless copy so the memo cannot depend on the order of the files.
        const probe = re.global || re.sticky ? new RegExp(re.source, re.flags.replace(/[gy]/g, "")) : re;
        hit = new Set();
        const anchors = re[ANCHORS];
        for (const f of files) {
          // A pattern every alternative of which starts with an anchor word
          // cannot match a file holding none of them: skip the regex there.
          if (anchors && !anchors.some((a) => lowerWordsOf(f, textOf).has(a))) continue;
          const text = textOf(f);
          if (text && probe.test(text)) hit.add(f);
        }
        byPattern.set(key, hit);
      }
      return hit;
    },
    declarations(file, text) {
      if (!decls.has(file)) decls.set(file, declarationsOf(text));
      return decls.get(file);
    },
    /** `reachableExports` is a pure function of the text and the hot names. */
    reachable(file, text, hot) {
      const key = `${file}\0${[...hot].sort().join(",")}`;
      if (!reach.has(key)) reach.set(key, reachableExports(text, hot));
      return reach.get(key);
    },
  };
}

/**
 * The identifiers of a pattern that is exactly `\b(?:a|b|…)\b` (or `\ba\b`)
 * over plain identifiers, case-sensitive; null for anything else, which the
 * cache then tests as a regex.
 */
export function identifierAlternation(re) {
  if (/[iu]/.test(re.flags)) return null;
  const m = /^\\b(?:\(\?:([A-Za-z0-9_|]+)\)|([A-Za-z0-9_]+))\\b$/.exec(re.source);
  if (!m) return null;
  const names = (m[1] ?? m[2]).split("|");
  return names.every((n) => n.length > 0) ? names : null;
}

const ANCHORS = Symbol("anchors");

/**
 * Mark `re` with the words one of which every match must contain whole —
 * a NECESSARY condition, so the memo may skip a file holding none of them
 * without changing any answer. Matched case-insensitively (a superset of
 * either case). Anything not a plain identifier disables the hint: the word
 * index splits on everything else, so it could not vouch for it.
 */
export function withAnchors(re, anchors) {
  const words = [...new Set(anchors)];
  if (words.length > 0 && words.every((w) => /^[A-Za-z0-9_]+$/.test(w))) {
    Object.defineProperty(re, ANCHORS, { value: words.map((w) => w.toLowerCase()) });
  }
  return re;
}
