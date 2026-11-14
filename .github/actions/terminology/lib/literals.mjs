/**
 * Which literals of a code file hold text a person reads, and which are code
 * wearing quotes.
 *
 * Never judged:
 *   - a module specifier: `import … from "…"`, `export … from "…"`,
 *     `import "…"`, `import("…")`, `require("…")`, `declare module "…"`;
 *   - a quoted property key: a literal followed by `:` whose previous token is
 *     `{` or `,` (the middle arm of a ternary follows `?`, so it is not one);
 *   - a slug or a path: the whole text is `[a-z0-9_./:#@-]` and holds one of
 *     `_ . / : # @ -` or a digit (`"delivery_zone"`, `"/entregadores/novo"`);
 *   - one bare lower-case word that is an operand of `===`, `!==`, `==`, `!=`
 *     or a `case` label: that is a value being compared, not copy.
 *
 * Judged but never rewritten: any other bare lower-case word. A consumer does
 * render those (`n === 1 ? "entregador" : "entregadores"`), and it also writes
 * enum values that way (`icon: "delivery"`), so a person decides.
 */
const SLUG_TEXT = /^[a-z0-9_./:#@-]*$/;
const SLUG_MARK = /[\d_./:#@-]/;
const BARE_WORD = /^\p{Ll}+$/u;
const COMPARISONS = new Set(["===", "!==", "==", "!="]);
const SPECIFIER_WORDS = new Set(["from", "import", "module"]);
const SPECIFIER_CALLS = new Set(["import", "require"]);

/** Stands where an escape sequence was; never part of a forbidden form. */
export const GAP = "\u0000";
/** Stands where an escaped LETTER was (`é`), so the word beside it is not whole. */
export const HIDDEN_LETTER = "\u0001";

const ESCAPE = /\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g;
const WORD_CHARACTER = /[\p{L}\p{M}\p{N}_]/u;

const isToken = (token, kind, text) => token !== null && token.kind === kind && token.text === text;

export function isModuleSpecifier({ prev, prev2 }) {
  if (prev !== null && prev.kind === "word" && SPECIFIER_WORDS.has(prev.text)) return true;
  return isToken(prev, "punct", "(") && prev2 !== null && prev2.kind === "word" && SPECIFIER_CALLS.has(prev2.text);
}

export const isPropertyKey = ({ prev, next }) => next === ":" && (isToken(prev, "punct", "{") || isToken(prev, "punct", ","));

const isCompared = ({ prev, next }) =>
  COMPARISONS.has(next) || (prev !== null && prev.kind === "punct" && COMPARISONS.has(prev.text)) || isToken(prev, "word", "case");

/**
 * The same text with every escape sequence blanked, length unchanged, so an
 * offset in the result is an offset in the source: `\n` before a word is a
 * boundary and not the letter `n`.
 */
export function maskEscapes(raw) {
  if (!raw.includes("\\")) return raw;
  return raw.replace(ESCAPE, (escape) => {
    if (escape[1] === "\n" || escape[1] === "\r") return GAP + escape.slice(1);
    return (WORD_CHARACTER.test(escapedCharacter(escape)) ? HIDDEN_LETTER : GAP).repeat(escape.length);
  });
}

/** The character an escape sequence stands for; the control escapes (`\n`, `\t`, …) are not letters. */
function escapedCharacter(escape) {
  const body = escape.slice(1);
  if (body.length === 1) return "nrtbfv0".includes(body) ? " " : body;
  const code = Number.parseInt(body.replace(/^[ux]\{?|\}$/g, ""), 16);
  return code <= 0x10ffff ? String.fromCodePoint(code) : " ";
}

/**
 * The stretches of `source` to judge, in order.
 *
 * `fixable: false` marks a bare lower-case word. `afterExpr` / `beforeExpr`
 * mark template text that touches a `${ }`: the expression may continue the
 * word (`entregador${plural}`), so a match on that edge is reported only.
 *
 * @param {string} source
 * @param {import("./scanner.mjs").Literal[]} literals
 * @returns {{ start: number, text: string, fixable: boolean, afterExpr: boolean, beforeExpr: boolean }[]}
 */
export function judgedRegions(source, literals) {
  const regions = [];
  for (const literal of literals) {
    if (isModuleSpecifier(literal) || isPropertyKey(literal)) continue;
    const texts = literal.chunks.map((chunk) => source.slice(chunk.start, chunk.end));
    const whole = texts.join("");
    if (texts.every((text) => SLUG_TEXT.test(text)) && SLUG_MARK.test(whole)) continue;
    const bare = literal.chunks.length === 1 && BARE_WORD.test(whole);
    if (bare && isCompared(literal)) continue;
    literal.chunks.forEach((chunk, index) => {
      if (chunk.end === chunk.start) return;
      regions.push({
        start: chunk.start,
        text: maskEscapes(texts[index]),
        fixable: !bare,
        afterExpr: chunk.afterExpr,
        beforeExpr: chunk.beforeExpr,
      });
    });
  }
  return regions;
}
