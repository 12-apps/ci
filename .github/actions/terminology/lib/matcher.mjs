/**
 * Finding forbidden forms in text, and writing their substitute.
 *
 * Whole words only, whatever the case. A letter, a mark, a digit or `_` on
 * either side means the form is part of a longer word (`entregadores` is not
 * `entregador`, `reentregador` neither, accents included); every other
 * character is a boundary, a hyphen among them, so `Ex-entregadores` matches.
 * A form may hold spaces or a hyphen itself (`frente de caixa`).
 */
import { HIDDEN_LETTER } from "./literals.mjs";

const WORD = `\\p{L}\\p{M}\\p{N}_${HIDDEN_LETTER}`;
/** Only the syntax characters: under the `u` flag an escaped `-` is an error. */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * One matcher for the forbidden forms of `terms`.
 *
 * @param {{ avoid: { word: string, use: string, autofix: boolean }[], allow: string[] }[]} terms
 */
export function buildMatcher(terms) {
  const forms = terms.flatMap((term) =>
    term.avoid.map((entry) => ({ ...entry, term, exact: new RegExp(`^${escapeRegExp(entry.word)}$`, "iu") })),
  );
  const byLower = new Map(forms.map((form) => [form.word.toLowerCase(), form]));
  // Longest first: at one position the alternation takes `um extra` before `um`.
  const alternation = forms
    .map((form) => form.word)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const whole = new RegExp(`(?<![${WORD}])(?:${alternation})(?![${WORD}])`, "giu");
  const anywhere = new RegExp(alternation, "iu");
  const allowed = new Map(terms.map((term) => [term, term.allow.map((phrase) => new RegExp(escapeRegExp(phrase), "giu"))]));

  return {
    terms,
    /** False when no form occurs at all, whole word or not: the text needs no closer look. */
    mayMatch: (text) => anywhere.test(text),
    /** @returns {{ index: number, found: string, form: object }[]} */
    find(text) {
      const matches = [];
      for (const match of text.matchAll(whole)) {
        // Case folding is not always `toLowerCase` (`ſ` folds to `s`), hence the second look.
        const form = byLower.get(match[0].toLowerCase()) ?? forms.find((candidate) => candidate.exact.test(match[0]));
        if (form) matches.push({ index: match.index, found: match[0], form });
      }
      return matches;
    },
    /** Whether columns [from, to) of `line` lie inside one of the term's allowed phrases. */
    insideAllowed(term, line, from, to) {
      for (const phrase of allowed.get(term)) {
        for (const match of line.matchAll(phrase)) if (match.index <= from && to <= match.index + match[0].length) return true;
      }
      return false;
    },
  };
}

/**
 * What replaces `found`, keeping its case: `ENTREGADOR` → `MOTOBOY`,
 * `Entregador` → `Motoboy`, anything else the substitute as the config writes
 * it. A form the config itself writes with a capital (an acronym, `PDV`) is
 * the exception: its substitute is written exactly as configured, because the
 * capitals of an acronym say nothing about the sentence around it.
 *
 * @param {string} found
 * @param {{ word: string, use: string }} form
 */
export function substituteFor(found, form) {
  if (form.word !== form.word.toLowerCase()) return form.use;
  const cased = [...found].filter((ch) => ch.toLowerCase() !== ch.toUpperCase());
  if (cased.length > 1 && found === found.toUpperCase()) return form.use.toUpperCase();
  const [head] = found;
  if (head === head.toLowerCase()) return form.use;
  const [first, ...rest] = form.use;
  return first.toUpperCase() + rest.join("");
}
