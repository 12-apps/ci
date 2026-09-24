/**
 * Which of a file's exports can SEE a name it imported?
 *
 * The selector is symbol-precise at hop one — it knows which exported symbols
 * of the changed file actually moved. At hop two it stopped: an importer that
 * bound any changed name had ALL of its exports marked changed. On a five-hop
 * chain that is four rounds of over-approximation compounding, and it is why a
 * one-symbol edit to a payments hub selected 79 unit test files when the
 * honest answer was 32-71 depending on where the edit landed.
 *
 * This asks the narrower question at EVERY hop: given the imported names that
 * carry a change, which top-level declarations reference them, and which of
 * those are exported? Taint flows along references only. `export { X } from
 * "./y"` needs no special case — it is a reference to ./y's X and nothing else,
 * which is exactly the barrel behaviour wanted.
 *
 * ## Everything it cannot bracket widens
 *
 * This is a NARROWING analysis, and the failure direction of a narrowing is a
 * green lane that ran nothing. So every uncertainty answers `"*"`:
 *
 *   - a file with a top-level statement that is neither an import nor a
 *     declaration — module side effects can touch anything;
 *   - `export * from` — the names are not in this file to bracket;
 *   - a file the graph reached BY NAME in which no export can be found, which
 *     means the bracketing failed rather than that the file exports nothing.
 *
 * That last one is the case worth naming. An empty answer reads as "nothing
 * here can see the change" and silently cuts a real chain — a narrowing
 * produced by a parse failure, indistinguishable from one that is earned. It
 * is the same shape as reading an import out of a string literal (#73): both
 * are green, both are wrong, and only one of them is loud.
 */
import { regexLiteralEnd, stripComments } from "./modules.mjs";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A top-level declaration: name, exported-ness, and the identifiers it uses. */
const DECL =
  /^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(function|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const REEXPORT = /^export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/;
const EXPORT_STAR = /^export\s+(?:type\s+)?\*\s+from\s*["']([^"']+)["']/;
const IMPORT_LINE = /^(?:import|export)\b.*\bfrom\s*["'][^"']+["']|^import\s*["'][^"']+["']/;
/** `const { a, b: c } = …` / `const [a, b] = …` — a declaration binding several names. */
const DESTRUCTURE = /^(export\s+)?(?:const|let|var)\s*([{[])/;

/**
 * The names a one-line destructuring pattern binds — `{ a, b: c, d = 1,
 * ...e }` binds a, c, d and e — or null when the pattern cannot be read here
 * (it spans lines, or nests), which the caller turns into a widening.
 */
function destructuredNames(line, open) {
  const close = open === "{" ? "}" : "]";
  const start = line.indexOf(open);
  const end = line.indexOf(close, start);
  if (end < 0) return null;
  const inner = line.slice(start + 1, end);
  if (/[{[]/.test(inner)) return null;
  const names = inner
    .split(",")
    .map((part) => part.trim().replace(/^\.\.\./, "").replace(/\s*=.*$/, ""))
    .filter(Boolean)
    .map((part) => (part.includes(":") ? part.split(":")[1].trim() : part));
  return names.length > 0 && names.every((n) => /^[A-Za-z_$][\w$]*$/.test(n)) ? names : null;
}

/** Does this top-level line open a statement of its own? */
const startsStatement = (line, callRe) =>
  DECL.test(line) || DESTRUCTURE.test(line) || EXPORT_DEFAULT.test(line) || /^(import|export)\b/.test(line) || Boolean(callRe?.test(line));

/**
 * Does a statement ending in `line` continue on the next line? An operator or
 * an opening bracket at the end means the next line is its operand, even when
 * that line starts with `async function` or a callee name.
 */
const continues = (line) => /(=>|[=(,[{:?&|+\-*%<!])$/.test(line);

/** Every name a declaration binds: one, or a destructuring pattern's list. */
export const boundOf = (d) => d.names ?? [d.name];

/** `export default <expression>` — an anonymous export named `default`. */
const EXPORT_DEFAULT = /^export\s+default\b/;

/** A local `export { a, b }` with no `from` — names already declared above. */
const LOCAL_EXPORT_LIST = /^export\s*\{([^}]*)\}\s*;?$/;

/**
 * Bracket a file into top-level declarations, or null when it cannot be
 * bracketed safely (see the module docblock).
 *
 * `calls` names callees whose top-level CALL is a declaration of its own
 * rather than a side effect — a Gherkin step file is a list of
 * `Given("…", …)` statements, and each one is a unit a scenario binds. Such a
 * statement is bracketed as `{ name: "<callee>@<n>", call: true }`, never
 * exported; with no `calls` nothing changes.
 *
 * @param {string} source
 * @param {{calls?: string[]}} [options]
 * @returns {{name: string, exported: boolean, refs: Set<string>, text: string, call?: boolean}[] | null}
 *   `text` is the declaration's own source, comments stripped — what a caller
 *   searching for a pattern needs to say WHICH declaration holds it.
 */
export function declarationsOf(source, { calls = [] } = {}) {
  const callRe = calls.length > 0 ? new RegExp(`^(${calls.map(escapeRegExp).join("|")})\\s*\\(`) : null;
  let callCount = 0;
  const lines = stripComments(source).split(/\r?\n/);
  const decls = [];
  const alsoExported = new Set();
  let current = null;
  let depth = 0;
  let pendingImport = false;
  let previousLine = "";

  let lastLine = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (line) lastLine = previousLine;
    previousLine = line || previousLine;
    const opens = (raw.match(/[{([]/g) ?? []).length;
    const closes = (raw.match(/[})\]]/g) ?? []).length;

    // A multi-line `import {` clause: consume until its `from "…"` or its `;`.
    if (pendingImport) {
      if (/\bfrom\s*["'][^"']+["']/.test(line) || line.endsWith(";")) pendingImport = false;
      depth = Math.max(0, depth + opens - closes);
      continue;
    }

    // A statement written without its `;` is closed by the next one: two
    // semicolon-less step calls must stay two declarations, not one.
    if (depth === 0 && current && startsStatement(line, callRe) && !continues(lastLine)) current = null;

    if (depth === 0 && !current) {
      // Before the import-clause check, which would otherwise swallow it: an
      // `export const { a, b } = …` starts with `export` and has no `from`,
      // and consumed as an import its names silently vanish from the file.
      const destructure = DESTRUCTURE.exec(line);
      if (destructure) {
        const names = destructuredNames(line, destructure[2]);
        if (names === null) return null;
        current = { name: names[0], names, exported: Boolean(destructure[1]), refs: new Set(), text: "" };
        decls.push(current);
      }
      const opensImportClause =
        !destructure &&
        /^(import|export)\b/.test(line) &&
        !/\bfrom\s*["'][^"']+["']/.test(line) &&
        !DECL.test(line) &&
        !EXPORT_DEFAULT.test(line) &&
        !LOCAL_EXPORT_LIST.test(line);
      if (opensImportClause) {
        pendingImport = true;
        depth = Math.max(0, depth + opens - closes);
        continue;
      }
      // Both re-export forms are matched BEFORE the generic import line, which
      // would otherwise swallow them: `export … from "…"` satisfies it too. An
      // `export * from` consumed as an import is the dangerous direction — the
      // file then looks bracketable and its forwarded names silently vanish.
      const re = REEXPORT.exec(line);
      if (re) {
        for (const spec of re[1].split(",").map((x) => x.trim()).filter(Boolean)) {
          const [orig, alias] = spec.split(/\s+as\s+/).map((x) => x.trim());
          decls.push({ name: alias ?? orig, exported: true, refs: new Set([`${re[2]}#${orig}`]), text: line });
        }
        continue;
      }
      // `export * from` — the names are not here to bracket. Widen.
      if (EXPORT_STAR.test(line)) return null;

      if (IMPORT_LINE.test(line)) {
        depth = Math.max(0, depth + opens - closes);
        continue;
      }

      const local = LOCAL_EXPORT_LIST.exec(line);
      if (local) {
        for (const spec of local[1].split(",").map((x) => x.trim()).filter(Boolean)) {
          const [orig] = spec.split(/\s+as\s+/).map((x) => x.trim());
          alsoExported.add(orig.replace(/^type\s+/, ""));
        }
        continue;
      }

      const m = destructure ? null : DECL.exec(line);
      const call = !m && !destructure && callRe ? callRe.exec(line) : null;
      // `const createTodo = When("…", fn)` — playwright-bdd's re-usable step:
      // a step definition that also binds a name.
      const bound = m && callRe ? callRe.exec(line.slice(line.indexOf("=") + 1).trim()) : null;
      if (destructure) {
        // bracketed above
      } else if (bound && /^(?:export\s+)?(?:const|let|var)\s/.test(line)) {
        const name = `${bound[1]}@${callCount++}`;
        current = { name, names: [name, m[3]], exported: Boolean(m[1]), call: true, refs: new Set(), text: "" };
      } else if (m) current = { name: m[3], exported: Boolean(m[1]), refs: new Set(), text: "" };
      // Read as an import clause, `export default { … }` used to vanish.
      else if (EXPORT_DEFAULT.test(line)) current = { name: "default", exported: true, refs: new Set(), text: "" };
      else if (call) current = { name: `${call[1]}@${callCount++}`, exported: false, call: true, refs: new Set(), text: "" };
      // A continuation of a multi-line type union or a chained call never opens
      // a top-level statement; anything else at depth 0 is a side effect.
      else if (line && !/^[|&?:,.)}\]]/.test(line)) return null;
      if (current && !destructure) decls.push(current);
    }

    if (current) {
      for (const id of raw.match(/[A-Za-z_$][\w$]*/g) ?? []) current.refs.add(id);
      current.text += `${raw}\n`;
    }
    depth = Math.max(0, depth + opens - closes);
    // A declaration ends when the braces balance AND the line terminates it. A
    // multi-line union type never opens a brace, so `;` is what closes it.
    // A call statement also ends at its closing parenthesis.
    if (current && depth === 0 && (line.endsWith(";") || line.endsWith("}") || (current.call && line.endsWith(")"))))
      current = null;
  }

  for (const d of decls) if (boundOf(d).some((n) => alsoExported.has(n))) d.exported = true;
  // A step registered anywhere else — inside an array, a helper, a value on
  // the next line — is a definition this bracketing cannot see, and an edit to
  // it would select nothing. Such a file cannot be bracketed.
  if (callRe) {
    const inside = new RegExp(`(?<![\\w$.])(${calls.map(escapeRegExp).join("|")})\\s*\\(`);
    if (decls.some((d) => !d.call && inside.test(d.text))) return null;
  }
  return decls;
}

/**
 * The exports of `source` that can see `tainted` — the names this file bound
 * from a changed module, plus the `spec#name` form a re-export line references.
 *
 * @param {string} source
 * @param {Iterable<string>} tainted
 * @param {{calls?: string[]}} [options]  see declarationsOf
 * @returns {Set<string> | "*"}   `"*"` means "assume every export" (see docblock)
 */
export function reachableExports(source, tainted, options = {}) {
  const decls = declarationsOf(source, options);
  if (decls === null) return "*";
  // Reached by name, yet nothing exported: the bracketing failed — unless the
  // file is a list of bracketed calls (a step file), which exports nothing by
  // design and whose calls are read by the caller, not propagated.
  if (!decls.some((d) => d.exported || d.call)) return "*";
  const hot = spread(decls, tainted);
  const out = new Set();
  // A hot bracketed call is reported too: it is how a step file with no hot
  // export still counts as reached. No import can name `Given@3`, so it never
  // propagates past this file.
  for (const d of decls) if ((d.exported || d.call) && hot.has(d.name)) boundOf(d).forEach((n) => out.add(n));
  return out;
}

/** Every declaration name that can see `tainted`, following references. */
export function spread(decls, tainted) {
  const hot = new Set(tainted);
  for (let pass = 0; pass <= decls.length; pass += 1) {
    let grew = false;
    for (const d of decls) {
      if (boundOf(d).every((n) => hot.has(n)) || ![...d.refs].some((ref) => hot.has(ref))) continue;
      boundOf(d).forEach((n) => hot.add(n));
      grew = true;
    }
    if (!grew) break;
  }
  return hot;
}

/**
 * Walk `text`, calling `visit(kind, start, end)` for each literal (`"str"`,
 * `'str'`, a template, a regex) and each run of code between them. Template
 * substitutions are kept inside the literal: a misplaced boundary only ever
 * makes more text compare verbatim, which reads as "changed".
 */
function walkLiterals(text, visit) {
  let i = 0;
  let code = 0;
  let lastSig = "";
  let lastWord = "";
  const flush = (end) => {
    if (end > code) visit("code", code, end);
  };
  while (i < text.length) {
    const c = text[i];
    let end = -1;
    if (c === '"' || c === "'" || c === "`") {
      end = i + 1;
      while (end < text.length && text[end] !== c) end += text[end] === "\\" ? 2 : 1;
      end = Math.min(end + 1, text.length);
    } else if (c === "/") {
      end = regexLiteralEnd(text, i, lastSig, lastWord);
    }
    if (end > i) {
      flush(i);
      visit("literal", i, end);
      i = end;
      code = end;
      lastSig = ")";
      lastWord = "";
      continue;
    }
    if (!/\s/.test(c)) {
      lastWord = /[\w$]/.test(c) ? (/[\w$]/.test(text[i - 1] ?? "") ? lastWord + c : c) : "";
      lastSig = c;
    }
    i += 1;
  }
  flush(text.length);
}

/**
 * A declaration's text with whitespace BETWEEN tokens collapsed and every
 * literal kept byte for byte — a stripped comment or a reindent is not an
 * edit, a second space inside `"R$ 5,50"` is.
 */
export function canonical(text) {
  let out = "";
  walkLiterals(text, (kind, start, end) => {
    const part = text.slice(start, end);
    out += kind === "literal" ? part : part.replace(/[ \t\r\n]+/g, " ");
  });
  return out.trim();
}

/** The source of a call's first argument — `Given(<this>, fn)` — canonical. */
function firstArgument(text) {
  const open = text.indexOf("(");
  let depth = 0;
  let result = null;
  walkLiterals(text.slice(open + 1), (kind, start, end) => {
    if (result !== null || kind === "literal") return;
    const part = text.slice(open + 1 + start, open + 1 + end);
    for (let k = 0; k < part.length; k += 1) {
      const c = part[k];
      if ("([{".includes(c)) depth += 1;
      else if (")]}".includes(c)) depth -= 1;
      if ((c === "," && depth === 0) || depth < 0) {
        result = open + 1 + start + k;
        return;
      }
    }
  });
  return canonical(text.slice(open + 1, result ?? text.length));
}

/**
 * What a direct edit changed, declaration by declaration: the exports and
 * bracketed calls of `head` whose own text moved or that reference one that
 * did — or null when the answer cannot be narrowed (the caller widens):
 *
 * - either side cannot be bracketed, or `head` has nothing exported and no
 *   bracketed call (a bracketing that found nothing failed, it did not earn
 *   "nothing changed");
 * - a bracketed call was REMOVED, or its pattern changed — whoever spoke the
 *   old one is now bound to nothing, and no declaration of `head` can say who;
 * - two calls share a pattern, so which one moved cannot be told apart.
 *
 * A call is keyed by its first argument (the step pattern): an edit to a
 * step's body changes that step. Text is compared canonically — whitespace
 * between tokens is not behaviour, whitespace inside a literal is.
 *
 * @param {string|null} base   null for a file the diff adds
 * @param {string} head
 * @param {{calls?: string[]}} [options]
 * @returns {Set<string> | null}
 */
export function changedDeclarations(base, head, options = {}) {
  const now = declarationsOf(head, options);
  const before = base === null ? [] : declarationsOf(base, options);
  if (now === null || before === null) return null;
  if (!now.some((d) => d.exported || d.call)) return null;
  const keyOf = (d) => (d.call ? `call:${firstArgument(d.text)}` : d.name);
  const keysNow = now.map(keyOf);
  const keysBefore = before.map(keyOf);
  if (new Set(keysNow).size !== keysNow.length || new Set(keysBefore).size !== keysBefore.length) return null;
  const seen = new Set(keysNow);
  if (before.some((d) => d.call && !seen.has(keyOf(d)))) return null;
  const was = new Map(before.map((d) => [keyOf(d), canonical(d.text)]));
  const moved = now.filter((d) => was.get(keyOf(d)) !== canonical(d.text)).flatMap(boundOf);
  for (const d of before) if (!seen.has(keyOf(d))) moved.push(...boundOf(d));
  const hot = spread(now, moved);
  return new Set(now.filter((d) => (d.exported || d.call) && hot.has(d.name)).flatMap(boundOf));
}

/**
 * `names` — the exports a direct edit changed — plus every export and
 * bracketed call of the same file that references one of them. An export's
 * hash covers its own body only, so `export const b = () => a()` does not move
 * when `a` does; without this, a test importing only `b` ran nothing. Null
 * bracketing widens to `"*"`.
 *
 * @param {string} head
 * @param {Set<string>} names
 * @param {{calls?: string[]}} [options]
 * @returns {Set<string> | "*"}
 */
export function withinFile(head, names, options = {}) {
  if (names.size === 0) return names;
  const decls = declarationsOf(head, options);
  if (decls === null) return "*";
  const hot = spread(decls, names);
  const out = new Set(names);
  for (const d of decls) if ((d.exported || d.call) && hot.has(d.name)) boundOf(d).forEach((n) => out.add(n));
  return out;
}
