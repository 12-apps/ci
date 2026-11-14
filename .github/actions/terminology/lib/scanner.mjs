/**
 * A small scanner for JavaScript and TypeScript source. It answers three
 * questions and nothing else: where the string and template literals are,
 * where the comments are, and which tokens stand on either side of each
 * literal (so the caller can tell a property key or an import path from a
 * sentence).
 *
 * It is not a parser. What it follows: `'…'`, `"…"`, `` `…` `` with nested
 * `${ }`, escapes, `//` and block comments, and regex literals well enough to
 * step over a quote inside one.
 *
 * It is TOTAL: any input returns a result. On a construct it cannot follow it
 * says so (`error`, with the offset where it lost the thread) and returns no
 * literal at all, so the caller fails the file instead of judging half of it.
 * The usual cause is a quote outside a literal: JSX text (`<p>d'água</p>`),
 * or a regex literal the heuristic below took for a division.
 *
 * @typedef {{ kind: "word" | "punct" | "value", text: string }} Token
 * @typedef {{ start: number, end: number, afterExpr: boolean, beforeExpr: boolean }} Chunk
 * @typedef {{ kind: "string" | "template", start: number, end: number, chunks: Chunk[],
 *             prev: Token | null, prev2: Token | null, next: string }} Literal
 */

const IDENTIFIER = /[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*/uy;
const NUMBER = /\d[\w.]*/y;
const SPACE = /\s+/y;
const OPERATORS = ["===", "!==", "==", "!=", "++", "--"];
const COMPARISONS = OPERATORS.slice(0, 4);
/** Keywords a regex literal may follow; after any other word a `/` divides. */
const REGEX_AFTER = new Set(["return", "typeof", "case", "do", "else", "in", "of", "instanceof", "new", "delete", "void", "throw", "yield", "await"]);
const VALUE = { kind: "value", text: "" };

/**
 * @param {string} source
 * @returns {{ literals: Literal[], comments: { start: number, end: number }[], error: { offset: number, message: string } | null }}
 */
export function scan(source) {
  try {
    return scanSource(source);
  } catch (error) {
    return { literals: [], comments: [], error: { offset: 0, message: `the scanner failed (${error.message})` } };
  }
}

function scanSource(source) {
  const literals = [];
  const comments = [];
  /** Template literals whose `${ }` expression is being read, innermost last. */
  const open = [];
  let pos = 0;
  let prev = null;
  let prev2 = null;
  const lost = (offset, message) => ({ literals: [], comments, error: { offset, message } });
  const token = (kind, text) => {
    prev2 = prev;
    prev = { kind, text };
  };

  /** Read one more chunk of `literal`; false when the source ends inside it. */
  const templateChunk = (literal, from, afterExpr) => {
    const { end, closer } = templateChunkEnd(source, from);
    if (closer === null) return false;
    literal.chunks.push({ start: from, end, afterExpr, beforeExpr: closer === "${" });
    if (closer === "${") {
      // An expression starts a context of its own: nothing stands before it.
      open.push({ literal, depth: 0 });
      pos = end + 2;
      prev = null;
      prev2 = null;
      return true;
    }
    literal.end = end + 1;
    literal.next = nextPunctuator(source, literal.end);
    literals.push(literal);
    pos = literal.end;
    prev2 = literal.prev;
    prev = VALUE;
    return true;
  };

  while (pos < source.length) {
    const ch = source[pos];
    SPACE.lastIndex = pos;
    if (SPACE.test(source)) {
      pos = SPACE.lastIndex;
    } else if (ch === "/" && source[pos + 1] === "/") {
      const end = lineEnd(source, pos);
      comments.push({ start: pos, end });
      pos = end;
    } else if (ch === "/" && source[pos + 1] === "*") {
      const close = source.indexOf("*/", pos + 2);
      if (close === -1) return lost(pos, "a block comment is never closed");
      comments.push({ start: pos, end: close + 2 });
      pos = close + 2;
    } else if (ch === "/") {
      const end = regexMayFollow(prev) ? regexEnd(source, pos) : -1;
      if (end === -1) token("punct", "/");
      else token("value", "");
      pos = end === -1 ? pos + 1 : end;
    } else if (ch === '"' || ch === "'") {
      const end = stringEnd(source, pos);
      if (end === -1) return lost(pos, "a string literal is never closed on its line");
      const chunk = { start: pos + 1, end: end - 1, afterExpr: false, beforeExpr: false };
      literals.push({ kind: "string", start: pos, end, chunks: [chunk], prev, prev2, next: nextPunctuator(source, end) });
      token("value", "");
      pos = end;
    } else if (ch === "`") {
      const literal = { kind: "template", start: pos, end: -1, chunks: [], prev, prev2, next: "" };
      if (!templateChunk(literal, pos + 1, false)) return lost(pos, "a template literal is never closed");
    } else if (ch === "}" && open.length > 0 && open.at(-1).depth === 0) {
      const { literal } = open.pop();
      if (!templateChunk(literal, pos + 1, true)) return lost(literal.start, "a template literal is never closed");
    } else {
      if (open.length > 0 && (ch === "{" || ch === "}")) open.at(-1).depth += ch === "{" ? 1 : -1;
      pos = readToken(source, pos, token);
    }
  }
  if (open.length > 0) return lost(open[0].literal.start, "a template literal is never closed");
  literals.sort((a, b) => a.start - b.start);
  return { literals, comments, error: null };
}

/** An identifier, a number, or a punctuator: record it and return where it ends. */
function readToken(source, pos, token) {
  IDENTIFIER.lastIndex = pos;
  if (IDENTIFIER.test(source)) {
    token("word", source.slice(pos, IDENTIFIER.lastIndex));
    return IDENTIFIER.lastIndex;
  }
  NUMBER.lastIndex = pos;
  if (NUMBER.test(source)) {
    token("value", "");
    return NUMBER.lastIndex;
  }
  const operator = OPERATORS.find((op) => source.startsWith(op, pos)) ?? source[pos];
  token("punct", operator);
  return pos + operator.length;
}

const lineEnd = (source, from) => {
  const end = source.indexOf("\n", from);
  return end === -1 ? source.length : end;
};

/** The index after the closing quote, or -1 when the line ends first. */
function stringEnd(source, start) {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") i += source[i + 1] === "\r" && source[i + 2] === "\n" ? 2 : 1;
    else if (ch === quote) return i + 1;
    else if (ch === "\n" || ch === "\r") return -1;
  }
  return -1;
}

/** Where the template text from `from` stops, and on what: a backtick, a `${`, or nothing. */
function templateChunkEnd(source, from) {
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") i += 1;
    else if (ch === "`") return { end: i, closer: "`" };
    else if (ch === "$" && source[i + 1] === "{") return { end: i, closer: "${" };
  }
  return { end: source.length, closer: null };
}

/**
 * Whether a `/` here can open a regex literal, by the token before it. After a
 * value, a closing bracket or `++`/`--` it divides. `)` and `}` are ambiguous
 * (`if (x) /re/.test(y)`) and read as division: a quote inside such a regex
 * then fails the file as an unclosed string, which is the safe direction.
 */
function regexMayFollow(prev) {
  if (prev === null) return true;
  if (prev.kind === "word") return REGEX_AFTER.has(prev.text);
  return prev.kind === "punct" && !")]}".includes(prev.text) && prev.text !== "++" && prev.text !== "--";
}

/** The index after a regex literal and its flags, or -1 when the line ends first (it was a division). */
function regexEnd(source, start) {
  let inClass = false;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\n" || ch === "\r") return -1;
    if (ch === "\\") i += 1;
    else if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      let end = i + 1;
      while (end < source.length && /[A-Za-z]/.test(source[end])) end += 1;
      return end;
    }
  }
  return -1;
}

/**
 * The punctuator after a literal, past any space and comment: `:` (also for
 * an optional member, `"key"?:`), a comparison operator, or one character.
 */
function nextPunctuator(source, from) {
  let i = skipSpace(source, from);
  while (source[i] === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
    const close = source[i + 1] === "/" ? lineEnd(source, i) : source.indexOf("*/", i + 2);
    if (close === -1) return "";
    i = skipSpace(source, source[i + 1] === "/" ? close : close + 2);
  }
  const comparison = COMPARISONS.find((op) => source.startsWith(op, i));
  if (comparison) return comparison;
  if (source[i] === "?" && source[skipSpace(source, i + 1)] === ":") return ":";
  return source[i] ?? "";
}

function skipSpace(source, from) {
  SPACE.lastIndex = from;
  return SPACE.test(source) ? SPACE.lastIndex : from;
}
