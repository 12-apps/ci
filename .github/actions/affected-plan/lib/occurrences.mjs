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
 * @returns {string[]} entries: `file` or `file#a,b`
 */
export function entriesForMatches({ files, textOf, isTest, specs }) {
  if (specs.length === 0) return [];
  const entries = [];
  for (const file of files) {
    const text = textOf(file);
    if (!text) continue;
    const live = specs.filter((s) => s.re.test(text) && (!s.mentionRe || s.mentionRe.test(text)));
    if (live.length === 0) continue;
    if (isTest(file)) {
      entries.push(file);
      continue;
    }
    const decls = declarationsOf(text);
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
    const reach = reachableExports(text, hot);
    if (reach === "*") entries.push(file);
    else if (reach.size > 0) entries.push(`${file}#${[...reach].sort().join(",")}`);
  }
  return entries;
}
