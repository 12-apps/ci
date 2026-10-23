/**
 * A module-context edit that evaluates nothing new.
 *
 * `affectedExports` answers `"*"` for any change outside an exported
 * declaration: a changed import list, a new non-exported helper, an edited
 * private function. That is right when the edit can run at load (a side
 * effect, an initializer calling the helper, a module with top-level code now
 * imported), because evaluation effects cross every importer. It is too wide
 * when the edit only adds a deferred function or binds a name from a module
 * whose evaluation does nothing: future-pay#3351 added one helper and one
 * import to an e2e session file, and the `"*"` reached a runner root and ran
 * every journey (`docs/ci/log`, the Gherkin shard ceiling entry).
 *
 * `narrowModuleContext` proves the narrower answer for the whole file, or
 * returns null and the caller keeps `"*"`. The proof does not trust any one
 * bracketer, because both #179 regressions were runtime text a bracketer put
 * inside a type span. It cuts the file into TOP-LEVEL UNITS on the
 * literal-masked text (`scan().masked`): a unit starts at a line whose first
 * character is code at column 0, and owns every following line that is
 * indented, blank, inside a literal (a template it opened included), or
 * starts with a closing bracket. A
 * swallowed statement therefore has to be on the declaration's own line,
 * which the per-kind end checks below reject. Then, for base and head alike:
 *
 *   - every unit balances its brackets and starts with an identifier
 *     character, a quote or `@`, and no unit follows one that ends in an
 *     operator (an `x ||` above a `function` makes it an expression);
 *   - IMPORT units hold import statements and nothing else; the evaluated
 *     specifiers keep their order and their bindings, and every one head
 *     adds resolves to a PURE module (below) that exports each name it binds,
 *     since a missing export fails the link for every importer. A removed or
 *     reordered specifier, a rebinding or an added default import answers
 *     null;
 *   - ERASED units (`type`, `interface`) and INERT units (functions, arrows,
 *     literal constants — `inertDeclaration`) may change; their names are
 *     tainted, as are the names an added import binds;
 *   - every OTHER unit is opaque and must be identical, in order, and may not
 *     reference a tainted name or any inert declaration that can reach one,
 *     since it runs at load.
 *
 * The answer is the tainted names that are exported in base or head; the
 * caller's `removedExport` and `initializationMayObserve` checks still run on
 * it.
 *
 * A PURE module is made only of erased and inert units, local export lists,
 * and imports or re-exports of pure modules or `node:` builtins, each binding
 * a name its target exports. Loading it runs no user code, so importing it
 * changes nothing for an importer that does not call it. A published package
 * is not pure: its source is not here. Neither is an import cycle.
 */
import { builtinModules, stripTypeScriptTypes } from "node:module";

import { canonical } from "./exports-dataflow.mjs";
import { parseImports, scan } from "./modules.mjs";

const IDENT = /[A-Za-z_$][\w$]*/g;
const ERASED = /^(?:export\s+)?(?:declare\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/;
const NAMED =
  /^(?:export\s+)?(default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var)\s*([A-Za-z_$][\w$]*)?/;
const LOCAL_EXPORT_LIST = /^export\s*\{([^}]*)\}\s*;?\s*$/;
/** A unit's first character: an identifier, a string directive or a decorator. */
const UNIT_START = /^[A-Za-z_"'@]/;
/**
 * The unit above ends mid-expression, so this one is its operand: an
 * operator, or a word that still needs one (`export default` over a column-0
 * `function` makes that function the default export, `new` makes it a
 * constructor call at load).
 */
const CONTINUES =
  /(?:=>|[=(,[{:?&|+\-*/%!~^.<>]|\b(?:new|typeof|void|delete|await|yield|in|of|instanceof|extends|implements|default|return|throw|case|else|do|export|import|async|function|class|const|let|var|as|satisfies|keyof|is|asserts|readonly|declare|abstract|unique|infer|from))\s*$/;
/**
 * A line ending in a token that cannot end an expression: an assignment or a
 * binary operator (never `++`/`--`, which are postfix, nor `/`, which may
 * close a regex), `=>`, an open bracket, `,`, `:` or `?`. The masked text
 * leaves no literal content to fool it.
 */
const ENDS_OPEN = /(?:=>|[=!<>]=|===|!==|&&|\|\||\?\?|(?<![+])\+|(?<![-])-|[*%=,(\[{:?|&^<])\s*$/;
/**
 * A line starting with a token that cannot start a statement, so it can only
 * continue the one above: never `!`, `+`, `-`, `/`, `<`, `(`, `[` or a
 * backtick, and never a word JavaScript lets a statement begin with
 * (`as` and `satisfies` are identifiers there).
 */
const STARTS_CLOSED = /^\s*(?:\?\.|\.(?!\d)|[|&?:,)\]}*%^]|=(?!=*\s*$)|>|(?:in|instanceof|extends)\b)/;

/**
 * Does every top-level line break in `masked` sit inside one expression? A
 * break after a complete expression and before a fresh statement is where ASI
 * ends the declaration, and the next line runs at load: `const f = () => 1`
 * over an indented `globalThis.flag = 1`. Prettier breaks after an operator or
 * `=>`, or before a `|`, `.` or `?` continuation; anything else is refused.
 */
function asiSafe(masked) {
  let depth = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if ("({[".includes(ch)) depth += 1;
    else if (")}]".includes(ch)) depth -= 1;
    else if (ch === "\n" && depth === 0) {
      const before = masked.slice(0, i).trimEnd();
      const after = masked.slice(i + 1);
      if (!after.trim()) return true;
      if (!ENDS_OPEN.test(before) && !STARTS_CLOSED.test(after)) return false;
    }
  }
  return true;
}

/** The index of the bracket closing the one at `open`, or -1. */
function matching(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if ("({[".includes(code[i])) depth += 1;
    else if (")}]".includes(code[i]) && --depth === 0) return i;
  }
  return -1;
}

/**
 * Where a function declaration's BODY opens, in masked code, or -1. The first
 * `{` is not it when a parameter destructures (`({ key }: Options)`) or the
 * return type is an object (`): { ok: boolean } {`). After the parameter list
 * comes the body, or `:` and a type; within the type, a `{` that follows a
 * type operator opens an object type and is skipped whole. Anything the walk
 * does not recognise answers -1, which reads as "not inert".
 */
function functionBodyOpen(code) {
  const params = code.indexOf("(");
  if (params === -1 || code.slice(0, params).includes("{")) return -1;
  const paramsEnd = matching(code, params);
  if (paramsEnd === -1) return -1;
  let i = paramsEnd + 1;
  while (/\s/.test(code[i] ?? "")) i += 1;
  if (code[i] === "{") return i;
  if (code[i] !== ":") return -1;
  for (i += 1; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "(" || ch === "[") {
      i = matching(code, i);
      if (i === -1) return -1;
    } else if (ch === "{") {
      const before = code.slice(0, i).trimEnd();
      if (!/(?:[:|&<,(]|=>)$/.test(before)) return i;
      i = matching(code, i);
      if (i === -1) return -1;
    } else if (ch === ";" || ch === "}" || ch === ")" || ch === "]") return -1;
  }
  return -1;
}

/**
 * A small allowlist of declarations whose evaluation cannot call user code.
 * Everything else (calls, property reads, classes, enums, destructuring, ...)
 * may throw or mutate state while the module loads. This is deliberately not
 * a purity claim about arbitrary expressions.
 */
export function inertDeclaration(text) {
  const parsed = scan(text);
  const code = parsed.masked.trim();
  if (/^(?:export\s+)?(?:declare\s+)?(?:type|interface)\b/.test(code)) return erasedEndsCleanly(code) && asiSafe(code);
  if (/^export\s*\{/.test(code)) return true; // reexport evaluation follows its graph edge
  if (/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/.test(code)) {
    const open = functionBodyOpen(code);
    if (open === -1) return false;
    const close = matching(code, open);
    return close !== -1 && /^\s*;?\s*$/.test(code.slice(close + 1));
  }
  const binding = /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:[^=]+)?\s*=\s*/.exec(code);
  if (!binding) return false;
  const value = code.slice(binding[0].length).replace(/;\s*$/, "").trim();
  if (!asiSafe(value)) return false;
  if (/^(?:true|false|null|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?n?)$/i.test(value)) return true;
  // Literal contents are masked, but their quotes remain. Templates are not
  // included: substitutions execute while constructing the value.
  if (/^(["'])[ \r\n]*\1$/.test(value)) return true;
  try {
    const raw = parsed.code.trim().slice(binding[0].length).replace(/;\s*$/, "").trim();
    const array = JSON.parse(raw);
    const literal = (item) => item === null || typeof item !== "object" || (Array.isArray(item) && item.every(literal));
    if (Array.isArray(array) && array.every(literal)) return true;
  } catch { /* not a literal-only array: defer no purity assumptions */ }
  if (!/^(?:async\s+)?(?:[A-Za-z_$][\w$]*|\([^()]*\))\s*(?::[^=]+)?=>/.test(value)) return false;
  let depth = 0;
  for (const ch of value) {
    if ("({[".includes(ch)) depth += 1;
    else if (")}]".includes(ch)) depth -= 1;
    else if (depth === 0 && (ch === "," || ch === ";")) return false;
  }
  return depth === 0;
}

/** Brackets balance and never go negative across `masked`. */
function balanced(masked) {
  let depth = 0;
  for (const ch of masked) {
    if ("({[".includes(ch)) depth += 1;
    else if (")}]".includes(ch) && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * An erased declaration ends where it says: an interface at the brace that
 * closes its body, a type alias at its `;` or its last line. Anything after
 * that on the same unit is a statement the column-0 cut could not separate.
 */
function erasedEndsCleanly(masked) {
  let depth = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if ("({[".includes(ch)) depth += 1;
    else if (")}]".includes(ch)) {
      depth -= 1;
      if (depth === 0 && ch === "}" && /^\s*interface\b/.test(masked.replace(/^(?:export\s+)?(?:declare\s+)?/, "")))
        return /^\s*;?\s*$/.test(masked.slice(i + 1));
    } else if (depth === 0 && ch === ";") return /^\s*$/.test(masked.slice(i + 1));
  }
  return true;
}

/**
 * The file's top-level units, or null when it cannot be cut safely.
 *
 * @returns {{kind: "import"|"erased"|"inert"|"exports"|"opaque", code: string, masked: string,
 *   names: string[], exported: boolean, refs: Set<string>, records?: object[], list?: string[][]}[] | null}
 */
export function topLevelUnits(source) {
  const { code, masked } = scan(source);
  const codeLines = code.split("\n");
  const maskedLines = masked.split("\n");
  const spans = [];
  let backticks = 0; // odd while the current unit holds an open template literal
  for (let i = 0; i < maskedLines.length; i += 1) {
    const line = maskedLines[i];
    if (!line.trim()) continue;
    const opensUnit = backticks % 2 === 0 && /^\S/.test(line) && !/^[)}\]]/.test(line);
    if (opensUnit || spans.length === 0) {
      spans.push({ from: i, to: i });
      backticks = 0;
    } else spans[spans.length - 1].to = i;
    backticks += (line.match(/`/g) ?? []).length;
  }

  const units = [];
  for (const { from, to } of spans) {
    const unitCode = codeLines.slice(from, to + 1).join("\n");
    const unitMasked = maskedLines.slice(from, to + 1).join("\n");
    const head = unitMasked.trimStart();
    if (!UNIT_START.test(head) || !balanced(unitMasked)) return null;
    const previous = units[units.length - 1];
    if (previous && CONTINUES.test(previous.masked)) return null;
    const refs = new Set(unitMasked.match(IDENT) ?? []);
    const unit = { code: unitCode, masked: unitMasked, names: [], exported: /^export\b/.test(head), refs };

    if (/^(?:import|export)\b/.test(head) && !/^import\s*[(.]/.test(head) && /\bfrom\s*["']|^import\s*["']/.test(head)) {
      // Import and re-export statements, and nothing else.
      const records = parseImports(unitCode);
      if (records.length === 0 || records.some((r) => r.dynamic || r.start === undefined)) return null;
      let rest = unitCode;
      for (const r of [...records].sort((a, b) => b.start - a.start)) rest = rest.slice(0, r.start) + rest.slice(r.end);
      if (!/^[\s;]*$/.test(rest)) return null;
      const reexport = records.some((r) => r.statement.startsWith("export"));
      units.push({ ...unit, kind: reexport ? "opaque" : "import", records, reexport, refs: new Set() });
      continue;
    }
    const list = LOCAL_EXPORT_LIST.exec(head);
    if (list) {
      const pairs = list[1].split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
        const type = /^type\s+/.test(entry);
        const [orig, alias = orig] = entry.replace(/^type\s+/, "").split(/\s+as\s+/).map((p) => p.trim());
        return [orig, alias, type];
      });
      units.push({ ...unit, kind: "exports", list: pairs });
      continue;
    }
    const erased = ERASED.exec(head);
    if (erased) {
      if (!erasedEndsCleanly(head) || !asiSafe(head)) return null;
      units.push({ ...unit, kind: "erased", names: [erased[1]] });
      continue;
    }
    const named = NAMED.exec(head);
    if (named && inertDeclaration(unitCode)) {
      const names = [...(named[1] ? ["default"] : []), ...(named[2] ? [named[2]] : [])];
      if (names.length === 0) return null;
      units.push({ ...unit, kind: "inert", names });
      continue;
    }
    units.push({ ...unit, kind: "opaque" });
  }
  return units;
}

/** Runtime names a unit declares, for the duplicate check. */
function runtimeNames(unit) {
  if (unit.kind === "inert") return unit.names.filter((n) => n !== "default");
  if (unit.kind === "opaque" && !unit.reexport) {
    const m = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:const|let|var|class|enum|function\s*\*?)\s*([A-Za-z_$][\w$]*)/.exec(unit.masked.trimStart());
    return m ? [m[1]] : [];
  }
  if (unit.kind !== "import") return [];
  const out = [];
  for (const r of unit.records) {
    if (r.typeOnly) continue;
    for (const [, local] of r.bindings ?? []) out.push(local);
    const clause = r.clause.trim();
    const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) out.push(ns[1]);
    const before = (clause.includes("{") ? clause.slice(0, clause.indexOf("{")) : clause).replace(/\*\s*as\s+[A-Za-z_$][\w$]*/, "").replace(/,/g, "").trim();
    if (/^[A-Za-z_$][\w$]*$/.test(before)) out.push(before);
  }
  return out;
}

/**
 * The RUNTIME names a module of erased, inert, export-list and re-export
 * units exports, or null when a re-export star leaves them open. Read from the
 * units, not line by line, so a template's `export const` line is not one. A
 * type is not among them: a value import of one fails Node's link.
 */
export function unitExports(units) {
  const out = new Set();
  for (const u of units) {
    if (u.kind === "inert" && u.exported)
      (/^export\s+default\b/.test(u.masked.trimStart()) ? ["default"] : u.names).forEach((n) => out.add(n));
    if (u.kind === "exports") u.list.forEach(([, alias, type]) => type || out.add(alias));
    if (u.reexport) {
      for (const r of u.records) {
        if (r.typeOnly) continue;
        if (/^\s*\*/.test(r.clause) && !/\bas\b/.test(r.clause)) return null;
        const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(r.clause);
        if (ns) out.add(ns[1]);
        for (const [, alias] of r.bindings ?? []) out.add(alias);
      }
    }
  }
  return out;
}

/** The names a module exports, or null when they cannot all be read here. */
export function moduleExports(source) {
  const units = source == null ? null : topLevelUnits(source);
  return units ? unitExports(units) : null;
}

/** Does `source` parse? JSX and non-erasable TypeScript answer false. */
function parses(source) {
  if (typeof stripTypeScriptTypes !== "function") return false;
  try {
    const warn = process.emitWarning;
    process.emitWarning = () => {};
    try {
      stripTypeScriptTypes(source);
    } finally {
      process.emitWarning = warn;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Does every local export list name a runtime binding the file declares? A
 * name with nothing behind it is a SyntaxError at load, and an unchanged list
 * hides the removal of what it named.
 */
function exportListsResolve(units) {
  const declared = new Set(units.flatMap(runtimeNames));
  return units.every((u) => u.kind !== "exports" || u.list.every(([orig, , type]) => type || declared.has(orig)));
}

/** Is `spec` a module Node ships? */
export const isBuiltin = (spec) => spec.startsWith("node:") && (builtinModules.includes(spec.slice(5)) || builtinModules.includes(spec));

/** Load-time code that reads names this cut cannot see. */
const DYNAMIC_SCOPE = new Set(["eval", "Function"]);

/**
 * What each runtime import binds, by specifier: `{ named, namespace, fallback }`
 * — `fallback` is a default import's local name, `namespace` a `* as` one. A
 * link error names a missing export, so the bindings are part of what a
 * module does at load.
 */
function bindingsBySpec(units) {
  const out = new Map();
  for (const unit of units) {
    if (unit.kind !== "import" && !unit.reexport) continue;
    for (const r of unit.records) {
      if (r.typeOnly) continue;
      const entry = out.get(r.spec) ?? { named: [], namespace: false, fallback: false };
      const clause = r.clause.trim();
      const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
      const before = (clause.includes("{") ? clause.slice(0, clause.indexOf("{")) : clause).replace(/\*\s*as\s+[A-Za-z_$][\w$]*/, "");
      const fallback = before.replace(/,/g, "").trim();
      if (/[A-Za-z_$]/.test(fallback)) entry.fallback = fallback;
      if (ns) entry.namespace = ns[1];
      for (const [name, local] of r.bindings ?? []) entry.named.push(`${name} as ${local}`);
      entry.named.sort();
      out.set(r.spec, entry);
    }
  }
  return out;
}

/** The specifiers a module evaluates, first occurrence first. */
function evaluated(units) {
  const specs = [];
  for (const unit of units)
    for (const r of unit.records ?? []) if (!r.typeOnly && !specs.includes(r.spec)) specs.push(r.spec);
  return specs;
}

/**
 * Does importing `spec` from `from` with `binding` run no user code and link?
 * A default import is refused: whether a module has one is not read here.
 */
export function loadsCleanly(spec, from, binding, context, seen) {
  const { resolve, exportsOf } = context;
  const target = resolve(spec, from);
  if (!target) return false;
  if (binding?.fallback) return false;
  const names = (binding?.named ?? []).map((pair) => pair.split(" as ")[0]);
  if (names.length > 0) {
    const exported = exportsOf(target);
    if (!exported || !names.every((n) => exported.has(n))) return false;
  }
  return target === "builtin" || pureModule(target, context, seen);
}

/**
 * Is loading `file` free of user code? `resolve(spec, from)` answers the
 * repo file a specifier names, `"builtin"`, or null; `read(file)` its source;
 * `exportsOf(target)` the names a module exports, or null when unknown.
 */
export function pureModule(file, { resolve, read, exportsOf }, seen = new Map()) {
  if (seen.has(file)) return seen.get(file);
  // A cycle answers impure: assuming the open module pure would cache that
  // assumption into every module the cycle visits.
  seen.set(file, false);
  const source = read(file);
  const units = source == null ? null : topLevelUnits(source);
  const declared = units ? units.flatMap(runtimeNames) : [];
  let pure = units !== null && parses(source) && new Set(declared).size === declared.length && exportListsResolve(units) &&
    !units.some((u) => [...u.refs].some((ref) => DYNAMIC_SCOPE.has(ref))) && units.every((u) =>
    u.kind === "erased" || u.kind === "inert" || u.kind === "exports" || u.kind === "import" || (u.kind === "opaque" && u.reexport));
  if (pure) {
    const bound = bindingsBySpec(units);
    for (const spec of evaluated(units)) {
      if (!loadsCleanly(spec, file, bound.get(spec), { resolve, read, exportsOf }, seen)) {
        pure = false;
        break;
      }
    }
  }
  seen.set(file, pure);
  return pure;
}

/**
 * The exports a module-context edit can reach, or null when it cannot be
 * proven confined to them (see the module docblock).
 *
 * @param {string} base
 * @param {string} head
 * @param {(spec: string, binding: object|undefined) => boolean} addedLoadsCleanly
 *   for a specifier head adds: it resolves to a pure module exporting what is bound
 * @returns {Set<string> | null}
 */
export function narrowModuleContext(base, head, addedLoadsCleanly) {
  if (base == null || head == null) return null;
  const was = topLevelUnits(base);
  const now = topLevelUnits(head);
  if (!was || !now || !parses(head)) return null;
  // Direct `eval` and `Function` reach names through strings, which the cut masks.
  if ([...was, ...now].some((u) => [...u.refs].some((ref) => DYNAMIC_SCOPE.has(ref)))) return null;
  // A name declared twice is an early SyntaxError the parse does not report.
  const declaredNow = now.flatMap(runtimeNames);
  if (new Set(declaredNow).size !== declaredNow.length || !exportListsResolve(now)) return null;

  // Opaque units run at load: same text, same order.
  const opaque = (units) => units.filter((u) => u.kind === "opaque").map((u) => canonical(u.code));
  if (JSON.stringify(opaque(was)) !== JSON.stringify(opaque(now))) return null;
  const exportsLists = (units) => units.filter((u) => u.kind === "exports").map((u) => canonical(u.code));
  if (JSON.stringify(exportsLists(was)) !== JSON.stringify(exportsLists(now))) return null;

  // Imports: the same modules evaluate in the same order, plus pure additions.
  const before = evaluated(was);
  const after = evaluated(now);
  const added = after.filter((spec) => !before.includes(spec));
  if (JSON.stringify(after.filter((spec) => before.includes(spec))) !== JSON.stringify(before)) return null;
  const boundBefore = bindingsBySpec(was);
  const boundAfter = bindingsBySpec(now);
  for (const spec of before)
    if (JSON.stringify(boundBefore.get(spec) ?? null) !== JSON.stringify(boundAfter.get(spec) ?? null)) return null;
  if (!added.every((spec) => addedLoadsCleanly(spec, boundAfter.get(spec)))) return null;

  // An added module runs nothing; what it binds is new to this file.
  const tainted = new Set();
  for (const spec of added) {
    const binding = boundAfter.get(spec);
    for (const pair of binding?.named ?? []) tainted.add(pair.split(" as ")[1]);
    if (binding?.namespace) tainted.add(binding.namespace);
  }

  // Erased and inert declarations: compare by name, overloads joined in order.
  const declared = (units) => {
    const out = new Map();
    for (const u of units) {
      if (u.kind !== "erased" && u.kind !== "inert") continue;
      for (const name of u.names) out.set(name, [...(out.get(name) ?? []), canonical(u.code)].sort());
    }
    return out;
  };
  const declBefore = declared(was);
  const declAfter = declared(now);
  for (const name of new Set([...declBefore.keys(), ...declAfter.keys()]))
    if (JSON.stringify(declBefore.get(name)) !== JSON.stringify(declAfter.get(name))) tainted.add(name);

  // Whatever an inert or erased declaration can reach through its references.
  const hot = new Set(tainted);
  for (const units of [was, now]) {
    for (let grew = true; grew; ) {
      grew = false;
      for (const u of units) {
        if ((u.kind !== "inert" && u.kind !== "erased") || u.names.every((n) => hot.has(n))) continue;
        if (![...u.refs].some((ref) => hot.has(ref))) continue;
        u.names.forEach((n) => hot.add(n));
        grew = true;
      }
    }
  }
  // Load-time code must not see any of it.
  for (const units of [was, now])
    if (units.some((u) => u.kind === "opaque" && !u.reexport && [...u.refs].some((ref) => hot.has(ref)))) return null;

  const exported = new Set();
  for (const units of [was, now]) {
    for (const u of units) {
      if ((u.kind === "inert" || u.kind === "erased") && u.exported) u.names.filter((n) => hot.has(n)).forEach((n) => exported.add(n));
      if (u.kind === "exports") for (const [orig, alias] of u.list) if (hot.has(orig)) exported.add(alias);
    }
  }
  return exported;
}
