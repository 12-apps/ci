/**
 * Keyed catalogs: an object of words, read one key at a time.
 *
 * A copy pack — `{ tillAlreadyOpen: "…", operatorBusy: (name) => `…` }` — is a
 * top-level object literal, so the ordinary analysis sees a module-scope value
 * being built and calls every edit to it an initialization effect. That effect
 * crosses every runtime import, whatever name the importer bound, which is how
 * rewording ONE sentence of a consumer's till refusals selected 385 of its 646
 * integration tests: everything that reaches any till route, through any
 * helper that imports the pack for any other sentence.
 *
 * What the edit actually changed is one KEY's value, and a reader observes it
 * only by reading that key — `tillRefusal().tillAlreadyOpen`. So for the files
 * a lane declares as catalogs, the change travels as a set of keys instead:
 *
 *   1. `changedKeys` reads the diff of a catalog. When every difference is an
 *      entry of a top-level object literal whose old and new values are inert
 *      (a string, a template without substitutions, a number, an arrow
 *      function, or an array / object of those), the answer is the keys that
 *      moved. Anything else — an import, a function, a spread, a computed key,
 *      a substitution — answers null, and the ordinary analysis takes over.
 *   2. A catalog that imports a changed catalog and only passes it on (spreads
 *      it, or holds it as a value: `{ "pt-BR": PT_BR_COPY }`) carries the same
 *      keys to ITS importers (`passesKeysThrough`).
 *   3. Any other importer is reached only by the declarations that read one of
 *      those keys from what it bound (`keyedUse`): `copy.key`, `copy().key`,
 *      `const c = copy(); c.key`, `const { key } = copy()`. A use that is not
 *      one of those shapes — the pack passed to a function, spread, indexed,
 *      returned, re-exported — answers null, and the ordinary analysis takes
 *      over for that file.
 *
 * The trust a lane extends by declaring a catalog is narrow and checkable: that
 * the file's exports hand out the keys of the objects it holds unchanged — a
 * locale accessor returns one of its packs, it does not rename their keys.
 * Every other step either proves its claim or widens.
 */
import { declarationsOf, boundOf, canonical } from "./exports-dataflow.mjs";
import { parseImports, scan } from "./modules.mjs";
import { importsChanged } from "./symbols.mjs";

const IDENT = "[A-Za-z_$][\\w$]*";
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The index of the bracket closing the one at `open` in masked text, or -1. */
function closing(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i];
    if ("({[".includes(c)) depth += 1;
    else if (")}]".includes(c) && --depth === 0) return i;
  }
  return -1;
}

/** Split masked text at depth-0 `separators`; returns [start, end) ranges. */
function topLevelParts(masked, separators = ",") {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i];
    if ("({[".includes(c)) depth += 1;
    else if (")}]".includes(c)) depth -= 1;
    else if (depth === 0 && separators.includes(c)) {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  parts.push([start, masked.length]);
  return parts.filter(([s, e]) => masked.slice(s, e).trim() !== "");
}

/**
 * Can building this value run anything? Only literals, templates without
 * substitutions, arrow functions (their bodies run later), and arrays or
 * objects of those are inert. A bare identifier is NOT: reading a binding
 * declared further down the file throws at evaluation.
 */
export function inertValue(text) {
  const raw = text.trim();
  const value = scan(raw).masked;
  if (/^(?:true|false|null|undefined|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)$/i.test(value)) return true;
  // Masked, a literal's content is blank and a substitution stays code.
  if (/^(["'`])\s*\1$/.test(value)) return true;
  if (/^(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/.test(value)) {
    return topLevelParts(value, ",;").length === 1;
  }
  if ((value.startsWith("[") || value.startsWith("{")) && closing(value, 0) === value.length - 1) {
    const inner = raw.slice(1, -1);
    const entries = topLevelParts(value.slice(1, -1)).map(([s, e]) => inner.slice(s, e));
    if (value.startsWith("[")) return entries.every((entry) => inertValue(entry));
    return entries.every((entry) => {
      const parsed = entryOf(entry);
      return parsed !== null && !parsed.spread && inertValue(parsed.value);
    });
  }
  return false;
}

/**
 * One object-literal entry: `{ key, value }`, `{ spread }` for `...X`, or null
 * when it cannot be read (a computed key, a method, a getter, shorthand).
 */
function entryOf(text) {
  const trimmed = text.trim();
  const spread = new RegExp(`^\\.\\.\\.\\s*(${IDENT})$`).exec(trimmed);
  if (spread) return { spread: spread[1] };
  const m = new RegExp(`^(?:(${IDENT})|"([^"\\\\]*)"|'([^'\\\\]*)')\\s*:`).exec(trimmed);
  if (!m) return null;
  return { key: m[1] ?? m[2] ?? m[3], value: trimmed.slice(m[0].length) };
}

/**
 * A top-level `const NAME[: Type] = { … }[ as const][ satisfies T];` — the
 * text around its braces, canonical, and its entries — or null for any other
 * declaration.
 */
function objectDeclaration(text) {
  const { masked } = scan(text);
  const head = new RegExp(`^\\s*(?:export\\s+)?const\\s+${IDENT}\\s*(?::[^=]+)?=\\s*\\{`).exec(masked);
  if (!head) return null;
  const open = head[0].length - 1;
  const close = closing(masked, open);
  if (close === -1) return null;
  if (!/^(?:as\s+const\s*)?(?:satisfies\s+[^;]+)?;?$/.test(masked.slice(close + 1).trim())) return null;
  const inner = text.slice(open + 1, close);
  const entries = [];
  for (const [s, e] of topLevelParts(masked.slice(open + 1, close))) {
    const entry = entryOf(inner.slice(s, e));
    if (entry === null) return null;
    entries.push(entry);
  }
  return { shell: `${canonical(text.slice(0, open + 1))}…${canonical(text.slice(close))}`, entries };
}

/** An object declaration's keyed values, or null when a key repeats. */
function valuesOf(declaration) {
  const map = new Map();
  for (const entry of declaration.entries) {
    if (entry.spread) continue;
    if (map.has(entry.key)) return null;
    map.set(entry.key, entry.value);
  }
  return map;
}

/**
 * The keys a catalog edit changed, or null when the edit is anything but a
 * change to inert entries of its object literals (see the module docblock).
 * An empty set means no entry moved.
 *
 * @param {string|null} base
 * @param {string|null} head
 * @returns {Set<string> | null}
 */
export function changedKeys(base, head) {
  if (base == null || head == null || importsChanged(base, head)) return null;
  const before = declarationsOf(base);
  const now = declarationsOf(head);
  if (before === null || now === null) return null;
  const shape = (decls, source) => [
    ...decls.map((d) => `${d.exported ? "export " : ""}${boundOf(d).join(",")}`),
    ...[...scan(source).code.matchAll(/\bexport\s*\{[^}]*\}(?!\s*from)/g)].map((m) => canonical(m[0])),
  ].join("\0");
  // Same declarations, exported the same way: `export { EN as EN_US }` is
  // no declaration's text, and renaming it breaks importers of `EN`.
  if (shape(before, base) !== shape(now, head)) return null;
  const keys = new Set();
  const changed = [];
  for (let i = 0; i < now.length; i += 1) {
    // Compared as written, comments aside: a newline after `return` is
    // behaviour (ASI), so whitespace is never normalised here.
    if (verbatim(before[i].text) === verbatim(now[i].text)) continue;
    const was = objectDeclaration(before[i].text);
    const is = objectDeclaration(now[i].text);
    if (!was || !is || was.shell !== is.shell) return null;
    const spreads = (o) => o.entries.filter((e) => e.spread).map((e) => e.spread).join(",");
    if (spreads(was) !== spreads(is)) return null;
    const old = valuesOf(was);
    const neu = valuesOf(is);
    if (!old || !neu || old.has("__proto__") || neu.has("__proto__")) return null;
    // Order is behaviour: a key after a spread overrides it, before it is
    // overridden, and `Object.keys` reads the order itself.
    const order = (o, other) => o.entries.map((e) => (e.spread ? `...${e.spread}` : e.key)).filter((k) => k.startsWith("...") || other.has(k));
    if (order(was, neu).join("\0") !== order(is, old).join("\0")) return null;
    for (const key of new Set([...old.keys(), ...neu.keys()])) {
      const a = old.get(key);
      const b = neu.get(key);
      if (a !== undefined && b !== undefined && verbatim(a) === verbatim(b)) continue;
      if ((a !== undefined && !inertValue(a)) || (b !== undefined && !inertValue(b))) return null;
      keys.add(key);
    }
    changed.push(now[i].name);
  }
  // A changed object reached any way but a reader's own key — read by a
  // sibling entry (`welcome: () => `${EN.shop}``), nested in another
  // declaration, or measured at load (`EN.a.length`) — is not a key change.
  for (const name of changed) {
    for (const decls of [before, now]) {
      for (const d of decls) {
        if (!d.refs.has(name)) continue;
        const uses = occurrences(scan(d.text).masked, name).length;
        if (d.name === name) {
          if (uses !== 1) return null;
          continue;
        }
        const holder = objectDeclaration(d.text);
        if (!holder || holder.entries.filter((e) => e.spread === name).length !== uses) return null;
      }
    }
  }
  return keys;
}

/** A declaration's source, comments stripped and otherwise as written. */
const verbatim = (text) => scan(text).code.trim();

/**
 * `source` scanned — `code` (comments stripped) and `masked` (literal contents
 * blanked), still character-aligned — with every static import and re-export
 * statement blanked in both.
 */
function scanned(source) {
  let { code, masked } = scan(source);
  const blank = (text, record) => text.slice(0, record.start) + text.slice(record.start, record.end).replace(/[^\n]/g, " ") + text.slice(record.end);
  for (const record of parseImports(source)) {
    if (record.dynamic || record.start == null) continue;
    code = blank(code, record);
    masked = blank(masked, record);
  }
  return { code, masked };
}

/**
 * Every occurrence of a local name in masked code: its index. A property of
 * the same name (`other.copy`) is not one; a spread (`...copy`) is.
 */
function occurrences(masked, local) {
  const re = new RegExp(`(?<![\\w$])${escapeRegExp(local)}(?![\\w$])`, "g");
  return [...masked.matchAll(re)]
    .map((m) => m.index)
    .filter((at) => masked[at - 1] !== "." || masked.slice(Math.max(0, at - 3), at) === "...");
}

/** The property read right after `at` in masked code (`.key` / `?.key`), or null. */
function memberAt(masked, at) {
  const m = new RegExp(`^\\s*\\??\\.\\s*(${IDENT})`).exec(masked.slice(at));
  return m ? m[1] : null;
}

/**
 * Every property a member chain reads from `at` in masked code — `.a().b?.c`
 * is `a`, `b`, `c` — and where the chain ends. Calls in the chain are skipped
 * over; a computed read (`[k]`) ends it, and the caller widens.
 */
function chainAt(masked, at) {
  const segments = [];
  let end = at;
  for (;;) {
    const call = /^\s*(?:\?\.)?\s*\(/.exec(masked.slice(end));
    if (call) {
      const close = closing(masked, end + call[0].length - 1);
      if (close === -1) return null;
      end = close + 1;
      continue;
    }
    const member = new RegExp(`^\\s*\\??\\.\\s*(${IDENT})`).exec(masked.slice(end));
    if (!member) return { segments, end };
    segments.push(member[1]);
    end += member[0].length;
  }
}

/**
 * The keys read through `locals` in masked code, with the aliases bound to
 * them, or null when any use is not a plain key read (the module docblock
 * lists the shapes). Every property along a chain counts as read: a pack
 * reached one level down (`copy.till().key`) is still read by its key.
 */
function keysRead(masked, locals) {
  const keys = new Set();
  const aliases = [];
  for (const local of locals) {
    for (const at of occurrences(masked, local)) {
      const chain = chainAt(masked, at + local.length);
      if (chain === null) return null;
      if (chain.segments.length > 0) {
        chain.segments.forEach((key) => keys.add(key));
        continue;
      }
      const before = masked.slice(0, at);
      if (!/^\s*(?:;|\n|$)/.test(masked.slice(chain.end))) return null;
      const alias = new RegExp(`(?:const|let|var)\\s+(${IDENT})\\s*=\\s*$`).exec(before);
      if (alias) {
        aliases.push(alias[1]);
        continue;
      }
      const destructure = /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*$/.exec(before);
      if (!destructure) return null;
      for (const part of destructure[1].split(",").map((p) => p.trim()).filter(Boolean)) {
        const name = new RegExp(`^(${IDENT})(?:\\s*:\\s*${IDENT})?$`).exec(part);
        if (!name) return null;
        keys.add(name[1]);
      }
    }
  }
  for (const alias of aliases) {
    for (const at of occurrences(masked, alias)) {
      const chain = chainAt(masked, at + alias.length);
      if (chain === null) return null;
      if (chain.segments.length > 0) chain.segments.forEach((key) => keys.add(key));
      else if (!/(?:const|let|var)\s+$/.test(masked.slice(0, at))) return null;
    }
  }
  return { keys, aliases };
}

/**
 * Does the masked text hide a use the code shows? The scanner can read JSX's
 * `{a}/{b}` as a regex and blank what lies between; a use that vanishes that
 * way must widen, not read as no use at all.
 */
const hidden = ({ code, masked }, locals) =>
  locals.some((local) => occurrences(code, local).length > occurrences(masked, local).length);

/** The local names a record binds — none for a wildcard (namespace, default, require). */
const localsOf = (record) => (record.wildcard ? [] : (record.bindings ?? []).map(([, local]) => local));

/**
 * The names under which `masked` hands one of `locals` on: `export { copy }`,
 * `export { copy as other }`, `export default copy`. Each such statement is
 * blanked in the returned text, so it is not read again as a use.
 */
function reexportsOf(masked, locals) {
  const names = new Set();
  let text = masked.replace(/\bexport\s*\{([^}]*)\}/g, (statement, list) => {
    let hit = false;
    for (const spec of list.split(",").map((part) => part.trim()).filter(Boolean)) {
      const [orig, alias] = spec.split(/\s+as\s+/).map((part) => part.trim());
      if (locals.includes(orig)) {
        names.add(alias ?? orig);
        hit = true;
      }
    }
    return hit ? statement.replace(/[^\n]/g, " ") : statement;
  });
  const fallback = new RegExp(`\\bexport\\s+default\\s+(?:${locals.map(escapeRegExp).join("|")})(?![\\w$])(?=[ \\t]*(?:;|\\n|$))`, "g");
  text = text.replace(fallback, (statement) => {
    names.add("default");
    return statement.replace(/[^\n]/g, " ");
  });
  return { names, text };
}

/**
 * What `source` does with what `record` bound from a catalog carrying `keys`:
 * `decls`, the declarations that read one of the keys (`"*"` for a file with
 * no declarations to bracket, a test, that reads one), and `reexports`, the
 * names it hands the binding on under (an `export { x } from` record hands on
 * all of its names). Null when a use is not a plain key read: the caller
 * falls back to the ordinary analysis.
 */
export function keyedUse(source, record, keys) {
  const locals = localsOf(record);
  if (source == null || locals.length === 0) return null;
  if (/^export\b/.test(record.statement ?? "")) return { decls: new Set(), reexports: new Set(locals) };
  const whole = scanned(source);
  if (hidden(whole, locals)) return null;
  const { names: reexports, text: code } = reexportsOf(whole.masked, locals);
  const hits = (read) => [...read.keys].some((key) => keys.has(key));
  const decls = declarationsOf(source);
  if (decls === null) {
    const read = keysRead(code, locals);
    if (read === null) return null;
    return { decls: hits(read) ? "*" : new Set(), reexports };
  }
  const out = new Set();
  for (const d of decls) {
    if (!locals.some((local) => d.refs.has(local))) continue;
    if (d.name === "default" && reexports.has("default")) continue; // `export default copy`, handed on above
    if (boundOf(d).some((n) => locals.includes(n))) return null; // a local re-bound at the top level
    const text = scan(d.text);
    if (hidden(text, locals)) return null;
    const read = keysRead(text.masked, locals);
    // A top-level alias (`const COPY = PACK`) is read in other declarations,
    // which this one-declaration reading cannot follow.
    if (read === null || read.aliases.some((alias) => boundOf(d).includes(alias))) return null;
    if (hits(read)) boundOf(d).forEach((n) => out.add(n));
  }
  return { decls: out, reexports };
}

/**
 * Does this catalog hand what `record` bound on with its keys intact? Only a
 * spread (`...PACK`) or a value under a key no `.` can read (`"pt-BR": PACK`)
 * does. A member read (`PACK.key`) could rename a key; a value under an
 * identifier (`{ en: PACK }`) could be read one level up (`HOLDER.en.key`),
 * where a reader's key would never match. A bracket read always widens.
 */
export function passesKeysThrough(source, record) {
  const locals = localsOf(record);
  if (source == null || locals.length === 0) return false;
  const whole = scanned(source);
  if (hidden(whole, locals) || reexportsOf(whole.masked, locals).names.size > 0) return false;
  const decls = declarationsOf(source);
  if (decls === null) return false;
  // Every use is a direct entry of a top-level object declaration: `...PACK`,
  // or `"pt-BR": PACK`. Anywhere else — nested (`{ en: { ...PACK } }`), in a
  // call (`Object.values({ ...PACK })`) — the keys could move a level.
  const ident = new RegExp(`^${IDENT}$`);
  return locals.every((local) => {
    let counted = 0;
    for (const d of decls) {
      if (!d.refs.has(local)) continue;
      const holder = objectDeclaration(d.text);
      if (!holder) return false;
      const uses = occurrences(scan(d.text).masked, local).length;
      const direct = holder.entries.filter((e) => e.spread === local || (!e.spread && e.value.trim() === local && !ident.test(e.key))).length;
      if (uses !== direct) return false;
      counted += uses;
    }
    return counted === occurrences(whole.masked, local).length;
  });
}
