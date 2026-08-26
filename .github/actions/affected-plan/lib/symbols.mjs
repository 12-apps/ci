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
 * Every exported symbol in a source file, with a hash of its body.
 *
 * @returns {{symbols:Map<string,string>, moduleLevel:string[], reexports:{names:string[],spec:string,star:boolean}[], ok:boolean}}
 *   `moduleLevel` is every line NOT owned by a declaration — imports and
 *   side-effecting top-level code. `ok:false` means extraction was not
 *   confident and the caller must treat the whole file as affected.
 */
export function exportedSymbols(source) {
  const clean = stripComments(source);
  const lines = clean.split("\n");
  const symbols = new Map();
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
    const body = lines
      .slice(i, end + 1)
      .join("\n")
      .replace(/\s+/g, " ")
      .trim();
    symbols.set(decl[2], hash(body));
    for (let k = i; k <= end; k += 1) owned.add(k);
  }

  const moduleLevel = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (owned.has(i)) continue;
    const text = lines[i].trim();
    if (text) moduleLevel.push(text);
  }
  return { symbols, moduleLevel, reexports, ok };
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
  // …with one exception: an IMPORT line. Its only effect is to bind a name,
  // and whether that name's behaviour moved is already decided by hashing the
  // symbol itself. Without this, relocating a helper into a new module widens
  // to the whole file and the move-awareness above buys nothing.
  if (changedModuleLines.some((l) => !IS_IMPORT_LINE.test(l))) return new Set(["*"]);

  return affected;
}

export { hash };
