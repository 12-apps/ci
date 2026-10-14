/**
 * Exported-symbol extraction and content hashing.
 *
 * Only same-file declarations with unchanged module context may narrow a
 * change. A matching name/body in another file does not prove equivalence:
 * imported bindings, module initialization and lexical context can differ.
 * Comments and formatting may compare equal, but literals remain byte-exact.
 * Every extraction uncertainty widens to the whole module.
 */
import { createHash } from "node:crypto";

import { canonical } from "./exports-dataflow.mjs";
import { parseImports, stripComments } from "./modules.mjs";

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
 * @returns {{symbols:Map<string,string>, moduleLevel:string[], reexports:{names:string[],spec:string|null,star:boolean,text:string}[], ok:boolean}}
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
      reexports.push({ names, spec, star, text: line.trim() });
      // A re-export has no body here. Its own text/dependency context is
      // compared separately; changes in its target follow graph edges.
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
    const body = canonical(lines.slice(i, end + 1).join("\n"));
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

/** Runtime dependencies include binding names and order, not formatting. */
export function importsChanged(baseSource, headSource) {
  const signature = (source) => JSON.stringify(
    parseImports(source ?? "").filter((record) => !record.dynamic && !record.typeOnly)
      .map((record) => {
        // Tokenize only the clause. The specifier stays byte-exact separately,
        // and quoted import names remain whole tokens (including whitespace).
        const tokens = record.clause.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*|[^\s]/g) ?? [];
        const brace = tokens.indexOf("{");
        // bindingsOf already excludes erased inline `type` bindings. Keep any
        // default binding before the braces, plus every runtime alias pair.
        const clause = brace === -1 ? tokens : [tokens.slice(0, brace), record.bindings];
        return [record.statement.startsWith("export") ? "export" : "import", record.spec, clause];
      }),
  );
  return signature(baseSource) !== signature(headSource);
}

/**
 * Dependency declarations are compared above. Remove their recognized spans
 * before comparing executable module context, so a type-only import or an
 * import's line wrapping cannot look like a new top-level side effect.
 * Keep everything after the specifier (such as import attributes) verbatim.
 */
function withoutStaticImports(source) {
  const clean = stripComments(source);
  const records = parseImports(clean).filter((record) => !record.dynamic);
  let out = "";
  let from = 0;
  for (const record of records) {
    const suffix = /^[ \t]*;/.exec(clean.slice(record.end));
    const end = record.end + (suffix?.[0].length ?? 0);
    out += clean.slice(from, record.start);
    out += clean.slice(record.start, end).replace(/[^\n]/g, " ");
    from = end;
  }
  return out + clean.slice(from);
}

/**
 * Which same-file exports changed, or `*` when module context changed.
 *
 * Cross-file name/body equality is intentionally not used as evidence that a
 * relocation preserves behavior. A new context must be tested by its callers.
 */
export function affectedExports(baseSource, headSource) {
  const head = exportedSymbols(withoutStaticImports(headSource));
  if (!head.ok || importsChanged(baseSource, headSource)) return new Set(["*"]);
  if (baseSource === null) {
    if (head.symbols.size === 0 || head.moduleLevel.length > 0) return new Set(["*"]);
    return new Set(head.symbols.keys());
  }

  const base = exportedSymbols(withoutStaticImports(baseSource));
  if (!base.ok) return new Set(["*"]);
  // Preserve ordering and multiplicity: moving or duplicating a top-level
  // effect can alter behavior even when every individual line already existed.
  if (JSON.stringify(base.moduleLevel) !== JSON.stringify(head.moduleLevel) ||
      JSON.stringify(base.reexports) !== JSON.stringify(head.reexports)) return new Set(["*"]);

  const affected = new Set();
  for (const [name, body] of head.symbols)
    if (base.symbols.get(name) !== body) affected.add(name);
  for (const name of base.symbols.keys()) if (!head.symbols.has(name)) affected.add(name);
  return affected;
}

export { hash };
