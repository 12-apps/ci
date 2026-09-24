/**
 * Key routing: a change to seeded DATA selects the tests that name that data.
 *
 * ## The case this exists for
 *
 * An end-to-end suite provisions its world before the first test runs — users,
 * stores, tables — from plain modules no test imports (`e2e-users.mjs`,
 * `journey-stores.mjs`, the provisioner itself). A test reaches that world by
 * KEY: it signs in as `"jm-olivia@futurepay.test"`, it opens
 * `"jornada-mesa-sai"`. The import graph cannot see that edge, so a selector
 * that only follows imports either misses the tests entirely (the seeder
 * reaches nothing) or gives up and runs every test (the seeder is "harness").
 * future-pay did the second: a one-user addition to `e2e-users.mjs` ran all
 * 162 specs and every Gherkin feature, and so did a comment.
 *
 * The edge is recoverable from the diff. Seed modules are tables of records,
 * and almost every change is either prose or one record:
 *
 *   { id: "e2e-jm-olivia", email: "jm-olivia@futurepay.test", name: "Olívia Mesa" },
 *
 * So a route with `keys` reads the changed hunks, both sides, and answers:
 *
 * - **only comments or whitespace moved** → nothing can observe it;
 * - **a record changed** — the changed line opens, closes or sits inside an
 *   object literal holding key-shaped strings (ids, slugs, e-mails) → the KEYS
 *   of that record, plus the property it is filed under (`mesaSai: {`). The
 *   tests, step files and helpers that name one of them are the entries, each
 *   attributed to the declaration holding the hit (occurrences.mjs), and any
 *   non-source file that names one (a `.feature`) is listed for the caller;
 * - **anything else** — an import, a loop, a function body with no keyed
 *   literal on the line — is setup LOGIC. The file is then an ordinary source
 *   entry and the graph decides what it reaches; for a provisioner that the
 *   runner loads, that is honestly everything.
 *
 * Both sides are read because a record that was RENAMED is still named by the
 * tests written against its old key — those are exactly the ones that break.
 * A record whose keys no test names at all is traced as source too, rather
 * than read as "nothing observes it": a test that iterates the whole table
 * (every seeded store renders) names none of its rows.
 */

/** A string that names a record: an id, a slug, an e-mail — not prose, not a path. */
export const isKey = (s) =>
  s.length >= 5 &&
  s.length <= 160 &&
  /^[A-Za-z0-9][A-Za-z0-9._@+:-]*[A-Za-z0-9]$/.test(s) &&
  /[-@._:]|\d/.test(s) &&
  !/^\d+([.:]\d+)*$/.test(s) &&
  !/^(node|https?|file):/.test(s);

const WORD = /[A-Za-z0-9_$]/;
const OBJECT_AFTER_WORD = new Set(["return", "default", "yield", "await", "typeof", "in", "of", "case", "throw"]);

const REGEX_AFTER = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"]);

/**
 * One pass over JS source, position-aligned: `masked` is the source with every
 * comment, every string/template chunk's CONTENT and every regex literal
 * blanked to spaces (newlines kept, quote delimiters kept), so a bracket left
 * standing is code; `live[i]` says whether position i is code or string text
 * (not a comment, not whitespace); `stripped` is the source minus comments.
 *
 * It is its own scanner, not modules.mjs's `scan`, because the cases that
 * matter here are the ones that one does not model: a regex literal holding a
 * quote (`/VERSION\s*=\s*"([^"]+)"/` in a provisioner flipped every later
 * line's inside/outside), a `${…}` expression inside a template, and a line
 * that sits wholly inside a multi-line SQL template — which is code that
 * changed, not a comment. `lost` records that the scan ended mid-string or
 * mid-regex: the caller treats every change in such a file as logic.
 */
function lex(source) {
  const n = source.length;
  const masked = source.split("");
  const live = new Uint8Array(n);
  const strings = [];
  let stripped = "";
  let lost = false;
  let lastSig = ""; // last significant code character
  let lastWord = "";
  const tplDepth = []; // brace depth of each open `${` expression
  let i = 0;

  const blank = (a, b) => {
    for (let k = a; k < b; k += 1) if (source[k] !== "\n") masked[k] = " ";
  };
  const keep = (a, b, isLive) => {
    stripped += source.slice(a, b);
    if (isLive) for (let k = a; k < b; k += 1) if (!/\s/.test(source[k])) live[k] = 1;
  };
  // A template chunk from i (just after ` or }) to its closing ` or ${.
  const templateChunk = () => {
    const start = i - 1;
    while (i < n && source[i] !== "`" && !(source[i] === "$" && source[i + 1] === "{")) i += source[i] === "\\" ? 2 : 1;
    if (i >= n) {
      lost = true;
      blank(start + 1, n);
      keep(start, n, true);
      return;
    }
    strings.push({ start, end: i, value: source.slice(start + 1, i) });
    blank(start + 1, i);
    keep(start, i, true);
    if (source[i] === "`") {
      keep(i, i + 1, true);
      i += 1;
      lastSig = "`";
      lastWord = "";
    } else {
      masked[i] = " ";
      masked[i + 1] = " ";
      keep(i, i + 2, true);
      i += 2;
      tplDepth.push(0);
      lastSig = "(";
    }
  };

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const e = source.indexOf("\n", i);
      const end = e === -1 ? n : e;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && next === "*") {
      const e = source.indexOf("*/", i + 2);
      const end = e === -1 ? n : e + 2;
      if (e === -1) lost = true;
      blank(i, end);
      for (let k = i; k < end; k += 1) if (source[k] === "\n") stripped += "\n";
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      if (j >= n || source[j] === "\n") lost = true;
      const end = Math.min(j, n);
      strings.push({ start: i, end, value: source.slice(i + 1, end) });
      blank(i + 1, end);
      keep(i, end + 1, true);
      i = end + 1;
      lastSig = c;
      lastWord = "";
      continue;
    }
    if (c === "`") {
      keep(i, i + 1, true);
      i += 1;
      templateChunk();
      continue;
    }
    if (c === "/" && (lastSig === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSig) || REGEX_AFTER.has(lastWord))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== "\n" && (inClass || source[j] !== "/")) {
        if (source[j] === "\\") j += 1;
        else if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        j += 1;
      }
      if (j >= n || source[j] === "\n") lost = true;
      j = Math.min(j + 1, n);
      while (j < n && /[a-z]/i.test(source[j])) j += 1;
      blank(i, j);
      keep(i, j, true);
      i = j;
      lastSig = ")";
      lastWord = "";
      continue;
    }
    if (tplDepth.length > 0) {
      if (c === "{") tplDepth[tplDepth.length - 1] += 1;
      else if (c === "}") {
        if (tplDepth[tplDepth.length - 1] === 0) {
          tplDepth.pop();
          masked[i] = " ";
          keep(i, i + 1, true);
          i += 1;
          templateChunk();
          continue;
        }
        tplDepth[tplDepth.length - 1] -= 1;
      }
    }
    keep(i, i + 1, true);
    if (!/\s/.test(c)) {
      if (WORD.test(c)) lastWord = WORD.test(source[i - 1] ?? "") ? lastWord + c : c;
      else lastWord = "";
      lastSig = c;
    }
    i += 1;
  }
  if (tplDepth.length > 0) lost = true;
  return { masked: masked.join(""), live, strings, stripped, lost };
}

/**
 * The source's brackets and string literals, found on `lex`'s `masked` view —
 * where comments are gone and every literal's content is blanked, so a brace
 * or a quote left standing is code.
 */
function structure(source) {
  const { masked, live, strings: raw, lost } = lex(source);
  const strings = [];
  for (const s of raw) {
    strings.push(s);
    // SQL inside a string names its rows in its OWN quotes —
    // `VALUES ('e2e-b-anon-cart', …)` — which is one string to the scanner.
    for (const m of s.value.matchAll(/'([^'\s]{5,})'/g)) strings.push({ start: s.start, end: s.end, value: m[1] });
  }

  const prevSignificant = (i) => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(masked[j])) j -= 1;
    return j;
  };
  const wordEndingAt = (j) => {
    let k = j;
    while (k >= 0 && WORD.test(masked[k])) k -= 1;
    return masked.slice(k + 1, j + 1);
  };
  const kindOf = (i) => {
    const j = prevSignificant(i);
    if (j < 0) return "block";
    const p = masked[j];
    if (p === ">" && masked[j - 1] === "=") return "block"; // `=> {` is a body
    if ("(,[:=?!&|".includes(p)) return "object";
    if (WORD.test(p)) return OBJECT_AFTER_WORD.has(wordEndingAt(j)) ? "object" : "block";
    return "block"; // `) {`, `; {`, `} {`, start of file
  };
  const propOf = (i) => {
    const j = prevSignificant(i);
    if (j < 0 || masked[j] !== ":") return null;
    let k = prevSignificant(j);
    if (k >= 0 && (masked[k] === '"' || masked[k] === "'")) {
      const s = strings.find((x) => x.end === k);
      return s ? s.value : null;
    }
    const w = wordEndingAt(k);
    return w || null;
  };

  const frames = [];
  const stack = [];
  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === "{" || c === "[" || c === "(") {
      const kind = c === "{" ? kindOf(i) : c === "[" ? "array" : "paren";
      const frame = { kind, open: i, close: masked.length, prop: c === "{" ? propOf(i) : null, parent: stack.at(-1) ?? null };
      stack.push(frame);
      frames.push(frame);
    } else if (c === "}" || c === "]" || c === ")") {
      const frame = stack.pop();
      if (frame) frame.close = i;
    }
  }

  const lineStarts = [0];
  for (let i = 0; i < masked.length; i += 1) if (masked[i] === "\n") lineStarts.push(i + 1);
  return { masked, live, strings, frames, lineStarts, lost: lost || stack.length > 0 };
}

/**
 * What changed on `lines` (1-based) of `source`: record keys, or logic.
 *
 * @returns {{keys:Set<string>, props:Set<string>, logic:number[]}}
 */
export function analyseLines(source, lines) {
  const { masked, live, strings, frames, lineStarts, lost } = structure(source ?? "");
  const keys = new Set();
  const props = new Set();
  const logic = [];
  // A scan that ended mid-string or with brackets open cannot place a line in
  // a record; every change in such a file is logic, which only widens.
  if (lost) return { keys, props, logic: lines.filter((l) => lineStarts[l - 1] !== undefined) };
  const keysIn = (f) => strings.filter((s) => s.start > f.open && s.end < f.close && isKey(s.value)).map((s) => s.value);
  // A record's keys are its whole record's: a changed `product: {…}` inside a
  // store is observed through the STORE's slug. Climb to the outermost literal
  // below a container — a top-level declaration or a statement.
  const isContainer = (f) => f.parent === null || f.parent.kind === "block";
  const take = (f) => {
    let r = f;
    while (r.parent && r.parent.kind !== "block" && !isContainer(r.parent)) r = r.parent;
    for (const k of keysIn(r)) keys.add(k);
    for (let x = f; x && x !== r.parent; x = x.parent) if (x.prop && x.prop.length >= 4) props.add(x.prop);
  };

  for (const line of lines) {
    const ls = lineStarts[line - 1];
    if (ls === undefined) continue;
    const le = lineStarts[line] ?? masked.length;
    let hasCode = false;
    for (let k = ls; k < le && !hasCode; k += 1) hasCode = live[k] === 1;
    if (!hasCode) continue; // a comment or a blank line — text inside a string is code
    const lineKeys = strings.filter((s) => s.start >= ls && s.start < le && isKey(s.value)).map((s) => s.value);

    // A line that OPENS or CLOSES a record is about that record, not about the
    // table it sits in — `mesaSai: {` must not read as every store.
    // So is a line that opens or closes a keyed CALL — `await db.query(` and
    // its `);` wrap the row the SQL names.
    const edges = frames.filter(
      (f) => f.kind !== "block" && ((f.open >= ls && f.open < le) || (f.close >= ls && f.close < le)) && keysIn(f).length > 0,
    );
    if (edges.length > 0) {
      edges.forEach(take);
      continue;
    }

    // The innermost frame around the line's first code position — for a line
    // inside a multi-line string, the frame around that string.
    let p = ls;
    while (p < le && live[p] !== 1) p += 1;
    let frame = null;
    for (const f of frames) if (f.open < p && f.close > p && (!frame || f.open > frame.open)) frame = f;
    let resolved = false;
    for (let f = frame; f; f = f.parent) {
      if (f.kind === "block") break;
      // An object literal is a record. An argument list or an array is one
      // only when the changed line itself carries a key —
      // `db.query(sql, ["e2e-b-anon-cart"])` — or a new `wipe(db),` inside
      // `Promise.all([seed(db, "x")])` would read as x's record, not logic.
      if (keysIn(f).length > 0 && (f.kind === "object" || lineKeys.length > 0)) {
        take(f);
        resolved = true;
        break;
      }
    }
    if (resolved) continue;
    // Inside a function body, or at the top level: a keyed literal on the line
    // is still data (`await seed("loja-salao")`); anything else is logic.
    if (lineKeys.length > 0) lineKeys.forEach((k) => keys.add(k));
    else logic.push(line);
  }
  return { keys, props, logic };
}

/** Code with comments removed and whitespace collapsed — what actually runs. */
export const executable = (source) => lex(source ?? "").stripped.replace(/\s+/g, " ").trim();

/** `git diff -U0` → the changed line ranges on each side. */
export function hunksOf(diff) {
  const out = [];
  for (const m of (diff ?? "").matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    out.push({ base: [Number(m[1]), m[2] === undefined ? 1 : Number(m[2])], head: [Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] });
  }
  return out;
}

const range = ([start, count]) => Array.from({ length: count }, (_, i) => start + i);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What one keyed file's change means.
 *
 * @returns {{kind:"none"} | {kind:"logic", lines:number[], keys:string[], props:string[]} | {kind:"keys", keys:string[], props:string[]}}
 *   Logic lines are 1-based; a NEGATIVE number is a line of the base side.
 */
export function keyedChange({ base, head, diff }) {
  if (base !== null && head !== null && executable(base) === executable(head)) return { kind: "none" };
  const hunks = hunksOf(diff);
  const headLines = head === null ? [] : base === null ? range([1, head.split("\n").length]) : hunks.flatMap((h) => range(h.head));
  const baseLines = base === null ? [] : head === null ? range([1, base.split("\n").length]) : hunks.flatMap((h) => range(h.base));
  const a = analyseLines(head, headLines);
  const b = analyseLines(base, baseLines);
  const logic = [...a.logic, ...b.logic.map((l) => -l)];
  const keys = [...new Set([...a.keys, ...b.keys])].sort();
  const props = [...new Set([...a.props, ...b.props])].sort();
  // The keys found beside the logic travel with it: a caller that resolves
  // the logic lines (wiring, a seeder's chain) must not lose the records.
  if (logic.length > 0) return { kind: "logic", lines: logic, keys, props };
  // The code differs, yet no line placed it anywhere: the analysis cannot
  // explain the change, so it is logic. "Nothing observable" is reserved for
  // the one case proven above — comments and whitespace only.
  if (keys.length === 0 && props.length === 0) return { kind: "logic", lines: [...headLines, ...baseLines.map((l) => -l)], keys, props };
  return { kind: "keys", keys, props };
}

/** One pattern per key kind: a key is bounded by non-key characters; a prop is a word. */
export function keyPatterns({ keys, props }) {
  const specs = [];
  // Bounded by letters and digits only: a key is still named inside a longer
  // id — `getByTestId("salao-mesa-e2e-salao-mesa-2")` names e2e-salao-mesa-2.
  if (keys.length > 0) specs.push({ re: new RegExp(`(?<![A-Za-z0-9])(?:${keys.map(escape).join("|")})(?![A-Za-z0-9])`), mentionRe: null });
  if (props.length > 0) specs.push({ re: new RegExp(`\\b(?:${props.map(escape).join("|")})\\b`), mentionRe: null, codeOnly: true });
  return specs;
}

/**
 * Every key a file's records carry, both sides — the answer for a LOGIC change
 * in a seeder, whose effect is confined to the records it seeds. Wider than a
 * one-record change and still far narrower than every test.
 */
export function fileKeys(...sources) {
  const keys = new Set();
  const props = new Set();
  for (const source of sources) {
    if (source === null || source === undefined) continue;
    const { strings, frames } = structure(source);
    for (const s of strings) if (isKey(s.value)) keys.add(s.value);
    for (const f of frames)
      if (f.kind === "object" && f.prop && f.prop.length >= 4 && strings.some((s) => s.start > f.open && s.end < f.close && isKey(s.value)))
        props.add(f.prop);
  }
  return { keys: [...keys].sort(), props: [...props].sort() };
}

/**
 * Which of `lines` only WIRE a sibling module in: an import from it, or a call
 * of a name imported from it. `seedPastDueTenant(usersDb)` changes the world
 * by exactly the rows `past-due-tenant.mjs` seeds, however little the calling
 * line itself says.
 *
 * @param {string} source
 * @param {number[]} lines
 * @param {(specifier:string)=>string|null} resolveSibling  a sibling's path, or null
 * @returns {{wired: Map<number,string[]>, rest: number[]}}
 */
export function wiringOf(source, lines, resolveSibling) {
  const text = source ?? "";
  const importsBy = new Map(); // local name -> sibling file
  const siblingOfLine = new Map(); // line -> sibling (an import statement's own lines)
  for (const m of text.matchAll(/import\s*(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?(?:\*\s*as\s*([\w$]+))?\s*from\s*["']([^"']+)["']/g)) {
    const sibling = resolveSibling(m[4]);
    if (!sibling) continue;
    const first = text.slice(0, m.index).split("\n").length;
    const last = first + m[0].split("\n").length - 1;
    for (let l = first; l <= last; l += 1) siblingOfLine.set(l, sibling);
    const names = [m[1], m[3], ...(m[2] ?? "").split(",").map((x) => x.trim().split(/\s+as\s+/).pop())].filter(Boolean);
    for (const n of names) importsBy.set(n, sibling);
  }
  const all = text.split("\n");
  const wired = new Map();
  const rest = [];
  for (const line of lines) {
    if (siblingOfLine.has(line)) {
      wired.set(line, [siblingOfLine.get(line)]);
      continue;
    }
    const code = (all[line - 1] ?? "").replace(/\/\/.*$/, "");
    const hit = [...importsBy].filter(([name]) => new RegExp(`(?<![\\w$.])${escape(name)}\\s*\\(`).test(code)).map(([, f]) => f);
    if (hit.length > 0) wired.set(line, [...new Set(hit)]);
    else rest.push(line);
  }
  return { wired, rest };
}
