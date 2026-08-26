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
import { stripComments } from "./modules.mjs";

/** A top-level declaration: name, exported-ness, and the identifiers it uses. */
const DECL =
  /^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(function|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const REEXPORT = /^export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/;
const EXPORT_STAR = /^export\s+(?:type\s+)?\*\s+from\s*["']([^"']+)["']/;
const IMPORT_LINE = /^(?:import|export)\b.*\bfrom\s*["'][^"']+["']|^import\s*["'][^"']+["']/;
/** A local `export { a, b }` with no `from` — names already declared above. */
const LOCAL_EXPORT_LIST = /^export\s*\{([^}]*)\}\s*;?$/;

/**
 * Bracket a file into top-level declarations, or null when it cannot be
 * bracketed safely (see the module docblock).
 *
 * @param {string} source
 * @returns {{name: string, exported: boolean, refs: Set<string>}[] | null}
 */
export function declarationsOf(source) {
  const lines = stripComments(source).split(/\r?\n/);
  const decls = [];
  const alsoExported = new Set();
  let current = null;
  let depth = 0;
  let pendingImport = false;

  for (const raw of lines) {
    const line = raw.trim();
    const opens = (raw.match(/[{([]/g) ?? []).length;
    const closes = (raw.match(/[})\]]/g) ?? []).length;

    // A multi-line `import {` clause: consume until its `from "…"` or its `;`.
    if (pendingImport) {
      if (/\bfrom\s*["'][^"']+["']/.test(line) || line.endsWith(";")) pendingImport = false;
      depth = Math.max(0, depth + opens - closes);
      continue;
    }

    if (depth === 0 && !current) {
      const opensImportClause =
        /^(import|export)\b/.test(line) &&
        !/\bfrom\s*["'][^"']+["']/.test(line) &&
        !DECL.test(line) &&
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
          decls.push({ name: alias ?? orig, exported: true, refs: new Set([`${re[2]}#${orig}`]) });
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

      const m = DECL.exec(line);
      if (m) current = { name: m[3], exported: Boolean(m[1]), refs: new Set() };
      // A continuation of a multi-line type union or a chained call never opens
      // a top-level statement; anything else at depth 0 is a side effect.
      else if (line && !/^[|&?:,.)}\]]/.test(line)) return null;
      if (current) decls.push(current);
    }

    if (current) for (const id of raw.match(/[A-Za-z_$][\w$]*/g) ?? []) current.refs.add(id);
    depth = Math.max(0, depth + opens - closes);
    // A declaration ends when the braces balance AND the line terminates it. A
    // multi-line union type never opens a brace, so `;` is what closes it.
    if (current && depth === 0 && (line.endsWith(";") || line.endsWith("}"))) current = null;
  }

  for (const d of decls) if (alsoExported.has(d.name)) d.exported = true;
  return decls;
}

/**
 * The exports of `source` that can see `tainted` — the names this file bound
 * from a changed module, plus the `spec#name` form a re-export line references.
 *
 * @param {string} source
 * @param {Iterable<string>} tainted
 * @returns {Set<string> | "*"}   `"*"` means "assume every export" (see docblock)
 */
export function reachableExports(source, tainted) {
  const decls = declarationsOf(source);
  if (decls === null) return "*";
  // Reached by name, yet nothing exported: the bracketing failed. Widen rather
  // than report the silent, unearned "nothing here can see it".
  if (!decls.some((d) => d.exported)) return "*";

  const hot = new Set(tainted);
  for (let pass = 0; pass <= decls.length; pass += 1) {
    let grew = false;
    for (const d of decls) {
      if (hot.has(d.name)) continue;
      for (const ref of d.refs)
        if (hot.has(ref)) {
          hot.add(d.name);
          grew = true;
          break;
        }
    }
    if (!grew) break;
  }

  const out = new Set();
  for (const d of decls) if (d.exported && hot.has(d.name)) out.add(d.name);
  return out;
}
