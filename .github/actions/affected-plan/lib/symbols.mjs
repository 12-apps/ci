/**
 * Exported-symbol extraction and content hashing — the "did this actually
 * change?" layer.
 *
 * File-level selection asks *does this test load the changed file?* That is the
 * wrong question, and it is why a diff of a dozen files can select most of a
 * suite: one shared entry module is loaded by nearly everything, so touching it
 * selects nearly everything, whether or not the code those tests execute is
 * different afterwards.
 *
 * This module asks the useful question instead — *is the code reachable from
 * this test different?* — by hashing each exported symbol's body.
 *
 * Two properties make the answer trustworthy:
 *
 * **Comments are stripped before hashing** (`stripComments`, shared with the
 * import parser). A comment cannot change behaviour,
 * so a paragraph of rationale added to a shared module must not re-run the
 * suite. The stripper is string- and template-aware, so a `//` inside a URL
 * literal is not mistaken for a comment.
 *
 * **Hashes are keyed by symbol NAME across the whole diff, not by file.** A
 * function moved between files with an identical body is unchanged, and the
 * selector must see that: relocating code is the single most common shape of
 * refactor, and treating it as "everything changed" makes the selector useless
 * exactly when the diff is largest.
 *
 * Everything here fails safe. If a declaration cannot be bracketed confidently,
 * the file reports `*` (every export affected) rather than a partial answer.
 */
import { createHash } from "node:crypto";

import { stripComments } from "./modules.mjs";

/** Short content hash — collision risk is irrelevant at one repo's scale. */
const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** `export [default] [async] function|class|const|let|var|type|interface|enum NAME` */
const DECLARATION =
  /^[ \t]*export\s+(?:default\s+)?(?:async\s+)?(function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z0-9_$]+)/;
/** `export { a, b as c }` and `export { a } from "./x"` */
const EXPORT_LIST = /^[ \t]*export\s*\{([^}]*)\}/;
/** `export * from "./x"` / `export * as ns from "./x"` */
const EXPORT_STAR = /^[ \t]*export\s*\*/;

/**
 * Where a declaration that starts on `startLine` ends.
 *
 * Tracks bracket depth across `{}`, `()` and `[]`. A declaration ends when
 * depth returns to zero and either a brace has closed (function/class bodies,
 * object literals) or the statement is terminated. Returns null when depth
 * never balances, which the caller turns into "widen this file".
 */
function declarationEnd(lines, startLine) {
  let depth = 0;
  let opened = false;
  for (let i = startLine; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "{" || ch === "(" || ch === "[") {
        depth += 1;
        opened = true;
      } else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    }
    if (depth < 0) return null; // unbalanced — refuse to guess
    if (depth === 0) {
      const text = lines[i].trimEnd();
      if (opened || text.endsWith(";") || /=\s*[^=].*[^,{([]$/.test(text)) return i;
    }
  }
  return null;
}

/**
 * Collapse whitespace OUTSIDE string and template literals.
 *
 * Inside a literal every character is the value: `'a  b'` and `'a b'` are
 * different strings, and a hash that read them alike let a literal-only edit
 * through unselected — the test comparing the value failed while the plan
 * said `none` (E4 of the 2026-09-30 audit). Escapes are honoured. A template's
 * `${…}` is kept verbatim too, which can only make two bodies compare UNEQUAL,
 * never equal — the safe direction.
 */
function collapseWhitespace(text) {
  let out = "";
  let quote = null;
  let space = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 1;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      space = false;
      continue;
    }
    if (/\s/.test(ch)) {
      if (!space) {
        out += " ";
        space = true;
      }
      continue;
    }
    out += ch;
    space = false;
  }
  return out.trim();
}

/** Declaration kinds whose initializer RUNS when the module loads. */
const INIT_KINDS = new Set(["const", "let", "var"]);
/** The first `=` that is an assignment — not `==`, `=>`, `>=`, `<=`, `!=`. */
const ASSIGN = /(^|[^=!<>])=(?![=>])/;
/** An initializer that only DEFINES code: nothing runs until it is called. */
const FUNCTION_LIKE = /^(?:async\s*)?(?:function\b|class\b|\([^)]*\)\s*(?::\s*[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>|<[^>]*>\s*\()/;
const STRING_LITERALS = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/** `export const x = <init>` → the init text; `null` for a function, class, type, interface or enum. */
function initializerOf(decl) {
  if (!decl || !INIT_KINDS.has(decl.kind)) return null;
  const m = ASSIGN.exec(decl.text);
  return m ? decl.text.slice(m.index + m[0].length).trim() : "";
}

/**
 * Whether an initializer can be observed by an importer that never names the
 * symbol.
 *
 * `export const setup = JSON.parse("oops")` throws for EVERY importer of the
 * module, including the test that imports only `value` from it — yet a
 * per-symbol diff marks `setup` alone and never reaches that test (E5 of the
 * 2026-09-30 audit). Symbol granularity is only honest for an initializer
 * that runs no code at load: a literal, an identifier, an object or array of
 * those, or a function/class/arrow, whose body is deferred. Anything with a
 * call, `new`, `await`, `yield` or a template substitution is treated as a
 * module-level effect, and a change to it widens to every export.
 */
function inertInitializer(init) {
  if (init === null) return true;
  if (/`[^`]*\$\{/.test(init)) return false;
  const masked = init.replace(STRING_LITERALS, '""');
  if (FUNCTION_LIKE.test(masked)) return true;
  return !/[(]|\bnew\b|\bawait\b|\byield\b/.test(masked);
}

/**
 * Every exported symbol in a source file, with a hash of its body.
 *
 * @returns {{symbols:Map<string,string>, decls:Map<string,{kind:string,text:string}>, moduleLevel:string[], reexports:{names:string[],spec:string,star:boolean}[], ok:boolean}}
 *   `moduleLevel` is every line NOT owned by a declaration — imports and
 *   side-effecting top-level code. `decls` keeps each declaration's kind and
 *   normalised text, for the initializer check below. `ok:false` means
 *   extraction was not confident and the caller must treat the whole file as
 *   affected.
 */
export function exportedSymbols(source) {
  const clean = stripComments(source);
  const lines = clean.split("\n");
  const symbols = new Map();
  const decls = new Map();
  const owned = new Set();
  const reexports = [];
  let ok = true;

  for (let i = 0; i < lines.length; i += 1) {
    if (owned.has(i)) continue;
    const line = lines[i];

    const star = EXPORT_STAR.test(line);
    const list = !star && EXPORT_LIST.exec(line);
    if (star || list) {
      const spec = /from\s*["']([^"']+)["']/.exec(line)?.[1] ?? null;
      const names = list
        ? list[1]
            .split(",")
            .map((n) => n.trim())
            .filter((n) => n && !/^type\s/.test(n))
            .map((n) => (n.split(/\s+as\s+/)[1] ?? n.split(/\s+as\s+/)[0]).trim())
        : [];
      reexports.push({ names, spec, star });
      // A re-export has no body of its own; it is hashed by what it names, so
      // that moving a symbol behind a re-export is not read as a change.
      for (const name of names) symbols.set(name, `reexport:${name}`);
      owned.add(i);
      continue;
    }

    const decl = DECLARATION.exec(line);
    if (!decl) continue;
    const end = declarationEnd(lines, i);
    if (end === null) {
      ok = false;
      break;
    }
    const body = collapseWhitespace(lines.slice(i, end + 1).join("\n"));
    symbols.set(decl[2], hash(body));
    decls.set(decl[2], { kind: decl[1], text: body });
    for (let k = i; k <= end; k += 1) owned.add(k);
  }

  const moduleLevel = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (owned.has(i)) continue;
    const text = lines[i].trim();
    if (text) moduleLevel.push(text);
  }
  return { symbols, decls, moduleLevel, reexports, ok };
}

/** An import statement contributes no behaviour of its own — see below. */
const IS_IMPORT_LINE = /^import\b|^export\s+(?:type\s+)?\{[^}]*\}\s*from\b|^export\s*\*/;

/**
 * Which exports of one file the diff actually changed.
 *
 * @param {string|null} baseSource  file content at the merge base (null = new file)
 * @param {string} headSource       file content at the PR head
 * @param {Map<string,string>} baseByName  every symbol hash seen anywhere in the
 *   diff's BASE side, keyed by name — this is what makes a pure move invisible.
 * @returns {Set<string>} affected export names, or a set containing `"*"`
 */
export function affectedExports(baseSource, headSource, baseByName = new Map(), headByName = new Map()) {
  // A re-export carries no body, so it is hashed by the NAME it forwards and
  // settled here against the real body wherever that body now lives. Without
  // this, turning `export function x` into `export { x } from "./moved"` — the
  // exact shape of every extraction refactor — reads as a change to `x` and
  // re-runs everything that touches it.
  const settle = (name, h, byName) =>
    typeof h === "string" && h.startsWith("reexport:") ? (byName.get(name) ?? h) : h;
  const head = exportedSymbols(headSource);
  if (!head.ok) return new Set(["*"]);
  if (baseSource === null) {
    // A file the diff ADDS. Its exports are new to this path, but a symbol
    // that arrived here carrying a body seen elsewhere on the base side was
    // MOVED, not written — and the destination of a move is exactly where a
    // file-keyed check would call every relocated symbol brand new.
    if (head.symbols.size === 0) return new Set(["*"]);
    const arrived = new Set();
    for (const [name, h] of head.symbols)
      if (baseByName.get(name) !== settle(name, h, headByName)) arrived.add(name);
    return arrived;
  }

  const base = exportedSymbols(baseSource);
  if (!base.ok) return new Set(["*"]);

  const affected = new Set();
  for (const [name, rawHead] of head.symbols) {
    const now = settle(name, rawHead, headByName);
    const before = settle(name, base.symbols.get(name), baseByName);
    if (before === now) continue;
    // Not in THIS file before — but if the same name carried the same body
    // anywhere else in the diff, it moved rather than changed.
    if (baseByName.get(name) === now) continue;
    affected.add(name);
  }
  for (const name of base.symbols.keys()) if (!head.symbols.has(name)) affected.add(name);

  // Module-level code — a side-effecting call, a config object, a mount — is
  // not owned by any export, so a change there can alter any of them.
  const baseModule = base.moduleLevel;
  const headModule = head.moduleLevel;
  const changedModuleLines = [
    ...headModule.filter((l) => !baseModule.includes(l)),
    ...baseModule.filter((l) => !headModule.includes(l)),
  ];
  // …with one exception: an IMPORT line, when the change to it is a PROVEN
  // move. Rewiring `import { value } from "./good"` to `"./bad"` changes what
  // every export reading `value` returns without touching one body (E3 of
  // the 2026-09-30 audit), so an import edit is harmless only when the bound
  // symbol's body is the same on both sides of the diff — the shape of a
  // relocation, which is the case this exception exists to keep cheap.
  if (changedModuleLines.some((l) => !IS_IMPORT_LINE.test(l))) return new Set(["*"]);
  const baseChanged = baseModule.filter((l) => !headModule.includes(l));
  const headChanged = headModule.filter((l) => !baseModule.includes(l));
  if (!importChangeIsProvenMove(baseChanged, headChanged, baseByName, headByName)) return new Set(["*"]);
  if (!reexportChangeIsProvenMove(base.reexports, head.reexports, baseByName, headByName)) return new Set(["*"]);

  // E5: an affected variable whose initializer runs code at load (on either
  // side) is observed by every importer of the module, named or not.
  for (const name of affected) {
    if (!inertInitializer(initializerOf(head.decls.get(name))) || !inertInitializer(initializerOf(base.decls.get(name)))) {
      return new Set(["*"]);
    }
  }

  return affected;
}

const IMPORT_FROM_LINE = /^import\s+(type\s+)?([^"']*?)\s*from\s*["']([^"']+)["']\s*;?$/;
const BARE_IMPORT_LINE = /^import\s*["']([^"']+)["']\s*;?$/;

/**
 * `<spec>#<exported name>` for every value binding the given import lines
 * create; `#default`, `#*` and `#<side-effect>` for the shapes no symbol hash
 * can vouch for. `ok:false` when a line that looks like an import cannot be
 * read as one (a multi-line import's first line, for instance).
 */
function importBindings(lines) {
  const bindings = new Set();
  let ok = true;
  for (const line of lines) {
    if (!IS_IMPORT_LINE.test(line)) continue;
    const bare = BARE_IMPORT_LINE.exec(line);
    if (bare) {
      bindings.add(`${bare[1]}#<side-effect>`);
      continue;
    }
    const m = IMPORT_FROM_LINE.exec(line);
    if (!m) {
      ok = false;
      continue;
    }
    if (m[1]) continue; // `import type` is erased before any module exists
    const [, , clause, spec] = m;
    const braces = /\{([^}]*)\}/.exec(clause);
    const rest = clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
    if (rest) bindings.add(`${spec}#${rest.startsWith("*") ? "*" : "default"}`);
    for (const part of (braces?.[1] ?? "").split(",")) {
      const name = part.trim();
      if (!name || /^type\s/.test(name)) continue;
      bindings.add(`${spec}#${name.split(/\s+as\s+/)[0].trim()}`);
    }
  }
  return { bindings, ok };
}

/** A bound name whose body is identical on both sides of the diff — a move, not a change. */
const provenSame = (name, baseByName, headByName) => baseByName.has(name) && baseByName.get(name) === headByName.get(name);

function importChangeIsProvenMove(baseLines, headLines, baseByName, headByName) {
  const before = importBindings(baseLines);
  const after = importBindings(headLines);
  if (!before.ok || !after.ok) return false;
  const changed = [
    ...[...before.bindings].filter((b) => !after.bindings.has(b)),
    ...[...after.bindings].filter((b) => !before.bindings.has(b)),
  ];
  return changed.every((binding) => {
    const name = binding.slice(binding.indexOf("#") + 1);
    if (name === "<side-effect>" || name === "*" || name === "default") return false;
    return provenSame(name, baseByName, headByName);
  });
}

/**
 * `export { x } from "./a"` → `from "./b"` keeps the hash `reexport:x` on
 * both sides, so `settle` alone would call it unchanged even when `./b`'s `x`
 * is a different thing. A re-export whose source moved is a move only when
 * the named body is the same across the diff; a changed `export *` is never
 * provable.
 */
function reexportChangeIsProvenMove(before, after, baseByName, headByName) {
  const specsOf = (list) => {
    const stars = new Set();
    const named = new Map();
    for (const r of list) {
      if (r.star) stars.add(r.spec ?? "");
      for (const n of r.names) named.set(n, r.spec ?? "<local>");
    }
    return { stars, named };
  };
  const b = specsOf(before);
  const h = specsOf(after);
  if (b.stars.size !== h.stars.size || [...b.stars].some((s) => !h.stars.has(s))) return false;
  for (const [name, spec] of h.named) {
    if (b.named.has(name) && b.named.get(name) !== spec && !provenSame(name, baseByName, headByName)) return false;
  }
  return true;
}

export { hash };
