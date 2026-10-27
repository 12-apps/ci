/**
 * Symbol-level affected-test selection with module-evaluation propagation.
 *
 * Deferred function changes can follow only the exports that observe them.
 * Eager initialization can throw or mutate state before ANY imported binding
 * is used, so those changes must cross every runtime import transitively.
 * Type-only imports remain excluded; unresolved dependencies widen their owner
 * and its importers rather than paying for unrelated tests.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { changedKeys, keyedUse, passesKeysThrough } from "./catalogs.mjs";
import { boundOf, changedDeclarations, declarationsOf, reachableExports, spread, withinFile } from "./exports-dataflow.mjs";
import { inertClass, inertDeclaration, isBuiltin, loadsCleanly, moduleExports, narrowModuleContext } from "./module-context.mjs";
import { buildGraph, EXTENSIONS, listSourceFiles, loadPackages } from "./modules.mjs";
import { affectedExports, exportedSymbols, importsChanged } from "./symbols.mjs";

/** Everything selected, with the reason chain for each test. */
export const FULL = "full";

/** Does an import record reach any of `symbols`? */
function importReaches(record, symbols) {
  if (symbols === "*" || record.wildcard) return true;
  return record.names.some((n) => symbols.has(n));
}

/**
 * The exports of `file` that can see what this import record just bound.
 *
 * A wildcard record (`import * as ns`, a default import, a bare side-effect
 * import, `require`, a dynamic `import()`) understates nothing on purpose —
 * there is no name list to intersect, so the whole file widens, exactly as it
 * did before this narrowing existed.
 */
function narrowedExports(source, record, symbols, calls) {
  const tainted = taintOf(record, symbols);
  if (source == null || tainted === "*") return "*";
  return reachableExports(source, tainted, { calls });
}

/**
 * The exports of `file` that can see its declarations `hot` — the ones that
 * read a changed catalog key (catalogs.mjs) — following its own references.
 */
function keyedExports(source, hot, calls) {
  const decls = declarationsOf(source, { calls });
  if (decls === null || !decls.some((d) => d.exported || d.call)) return "*";
  const reach = spread(decls, hot);
  return new Set(decls.filter((d) => (d.exported || d.call) && reach.has(d.name)).flatMap(boundOf));
}

/**
 * The local names an import record binds from a changed module — `"*"` when
 * it has no name list to intersect (see narrowedExports).
 */
function taintOf(record, symbols) {
  if (record.wildcard) return "*";
  const names = symbols === "*" ? record.names : record.names.filter((n) => symbols.has(n));
  const locals = (record.bindings ?? []).filter(([name]) => names.includes(name)).map(([, local]) => local);
  return names.length === 0 ? "*" : [...names, ...locals, ...names.map((n) => `${record.spec}#${n}`)];
}

/**
 * The names a test can use to reach a deferred page: the last segment of the
 * import's path (`"./hours"` → `hours`; an `index` file or `"."` answers its
 * folder), every literal `path` segment on a `<Route>` whose `element` renders
 * the lazy binding, and the binding itself. Route parameters (`:slug`) and
 * splats name nothing and are left out.
 */
export function deferredNames(record, importerSource) {
  const names = new Set();
  const parts = record.spec.split("/").filter((p) => p && p !== ".");
  let last = parts.pop() ?? "";
  last = last.replace(/\.[cm]?[jt]sx?$/, "");
  if ((last === "index" || last === "..") && parts.length) last = parts.pop();
  if (last && last !== "." && last !== ".." && last !== "index") names.add(last);
  if (record.binding) {
    names.add(record.binding);
    const tag = new RegExp(`<Route\\b[^>]*\\belement=\\{\\s*<\\s*${record.binding}\\b[^>]*>`, "g");
    for (const m of (importerSource ?? "").matchAll(tag)) {
      const path = /\bpath=["']([^"']+)["']/.exec(m[0])?.[1] ?? "";
      for (const segment of path.split("/")) if (segment && !/[:*]/.test(segment)) names.add(segment);
    }
  }
  return [...names].sort();
}

/**
 * Does a test name a deferred page? A path name counts as a URL segment inside
 * a string literal of the test (`"/acme/config/hours"`, `` `/${slug}/hours?x` ``),
 * except a literal that is an API address (`/api/…`): a fetch mock for
 * `/api/admin/acme/products` names the endpoint, not the products screen. The
 * binding counts as a whole word anywhere. An unreadable test names nothing it
 * can prove, so it is kept — the safe reading of a hole.
 */
export function namesPage(testSource, names) {
  if (testSource == null) return true;
  const literals = [...testSource.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)]
    .map((m) => m[2])
    .filter((text) => !text.includes("/api/"));
  return names.some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (/^[A-Z]/.test(name)) return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(testSource);
    const segment = new RegExp(`/${escaped}(?=[/?#\\s]|$)`);
    return literals.some((text) => segment.test(text));
  });
}

/** Can a changed binding alter eager module evaluation, not just an export? */
function initializationMayObserve(source, tainted, calls) {
  if (source == null) return true;
  const declarations = declarationsOf(source, { calls });
  if (declarations === null) return true;
  const hot = tainted === "*" ? new Set(declarations.flatMap(boundOf)) : spread(declarations, tainted);
  return declarations.some((d) => !d.call && boundOf(d).some((name) => hot.has(name)) && !inertDeclaration(d.text) && !inertClass(d.text, hot));
}

/**
 * Compute the affected test files for one lane.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string[]} options.changed        repo-relative changed paths
 * @param {string[]} options.deleted        repo-relative deleted paths
 * @param {(path:string)=>string|null} options.readBase  base-revision content, null if absent
 * @param {string[]} options.roots          directories to graph
 * @param {string[]} options.workspaceDirs  package roots, for `exports` resolution
 * @param {(f:string)=>boolean} options.isTest
 * @param {(f:string)=>boolean} options.isIgnored     cannot change any verdict
 * @param {(f:string)=>boolean} options.isUntraceable forces the full suite
 * @param {(f:string)=>{prefix:string,replacement:string}[]} [options.aliasesFor]
 * @param {string[]} [options.calls]  callees whose top-level calls bracket as
 *   declarations (Gherkin step definitions — see exports-dataflow.mjs)
 * @returns {{mode:"full"|"narrowed"|"none", tests:string[], reasons:object, symbols:object, affected:Map, stats:object, why:string}}
 *   `affected`: file → the names in it that can see the change (exports, and
 *   `<callee>@<n>` for a bracketed call), or "*"
 */
export function selectAffected(options) {
  const {
    repoRoot,
    changed,
    deleted = [],
    readBase,
    roots,
    workspaceDirs = [],
    isTest,
    isIgnored = () => false,
    isSource = () => true,
    routeOf = () => [],
    aliasesFor,
    calls = [],
    deferredCalls = [],
    isCatalog = () => false,
  } = options;

  // A glob observes membership as well as exported symbols. Discover it
  // before ignore/classification and `none` pruning, including deleted assets.
  const diff = [...changed, ...deleted];
  const packages = loadPackages(repoRoot, workspaceDirs);
  const files = listSourceFiles(repoRoot, roots);
  const { edges, unresolved, globs } = buildGraph(repoRoot, files, { packages, aliasesFor });
  const globSources = new Map();
  const globChanged = new Set();
  for (const glob of globs) {
    const inputs = diff.filter(glob.matches);
    if (inputs.length) {
      globSources.set(glob.file, [...new Set([...(globSources.get(glob.file) ?? []), ...inputs])]);
      inputs.forEach((file) => globChanged.add(file));
    }
  }
  // An unsupported glob can read even a normally ignored asset. Keep its
  // importer blind and unskippable on any edit; never add an unchecked waiver.
  for (const item of unresolved) if (item.glob && diff.length) globSources.set(item.file, diff);
  const relevant = diff.filter((f) => !isIgnored(f) || globChanged.has(f));
  if (relevant.length === 0 && globSources.size === 0) {
    return { mode: "none", tests: [], reasons: {}, symbols: {}, stats: { changed: 0 }, why: "every changed path is one the ignore rules prove cannot change a verdict" };
  }

  // ── routing: a changed file that is not source, but whose whole effect on
  // the graph is expressed by one that is ───────────────────────────────────
  //
  // `full` is the answer for a path the import graph cannot account for, and it
  // is the right answer for a lockfile: anything could move. It is the WRONG
  // answer for a codegen INPUT, where the output is a known source file and the
  // graph already knows how to follow it. A Prisma schema is the case that
  // forced this — non-`.ts`, so untraceable by shape, while its only runtime
  // effect is the surface of the generated client, which every consumer reaches
  // through one entry module.
  //
  // So a routed path is REPLACED by its entry, seeded as fully changed, and the
  // ordinary walk takes it from there. That is strictly narrower than `full`
  // and strictly wider than ignoring it — the two things a codegen input must
  // sit between. Routing is opt-in per repo and per lane, because only the
  // caller knows whether its generator's output really is that one file.
  //
  // A route may also answer with an OBJECT, `{ entries }`, and that form is
  // classified even when the list is empty: the database router proves some
  // changes observable by nothing (a comment added to a migration, a plain
  // index), and "routed to nothing" must not read as "unclassified". An entry
  // may name symbols — `file#a,b` — and only those are seeded, so a route can
  // be as narrow as the change it stands for.
  const routedFrom = new Map(globSources);
  const direct = [];
  const unobservable = [];
  for (const file of relevant) {
    const routed = routeOf(file);
    const classified = !Array.isArray(routed);
    const entries = classified ? routed.entries : routed;
    if (entries.length === 0) {
      if (classified) unobservable.push(file);
      else if (isSource(file) || !globChanged.has(file)) direct.push(file);
      continue;
    }
    for (const entry of entries) {
      if (!routedFrom.has(entry)) routedFrom.set(entry, []);
      routedFrom.get(entry).push(file);
    }
  }

  // ── every remaining path must be SOURCE, or the plan does not know it ─────
  //
  // There used to be a `full` here: a path the graph could not trace made the
  // lane run everything. It is gone, and the reason is arithmetic. `full` was
  // reached by ANY path that was not a workspace source file — a budget JSON, a
  // migration, a docs fixture, a root script — which on this repo's own history
  // was 69% of commits. A selector that opts out of selecting on seven pushes
  // in ten is not a selector, and worse, it opts out INVISIBLY: the run is
  // green either way, so nothing ever reported the miss.
  //
  // The replacement is the shape this repo already uses for its burn-down
  // ratchets: everything is classified, and an UNCLASSIFIED path is a hard
  // failure naming the file. That inverts the failure direction — a path
  // nobody has thought about now stops the plan job in red, where a human sees
  // it and adds one rule, instead of quietly buying the whole suite.
  //
  // It is safe to fail closed here precisely because it fails LOUD. The danger
  // `full` guarded against is a lane that runs too little while reporting
  // success; a plan job that exits non-zero reports nothing at all.
  const unclassified = direct.filter((f) => !isSource(f));
  if (unclassified.length > 0) {
    return {
      mode: "unclassified",
      tests: [],
      reasons: {},
      symbols: {},
      unclassified,
      stats: { changed: relevant.length, unclassified: unclassified.length },
      why:
        `${unclassified.length} changed path(s) match no rule — ` +
        `classify each as ignore, route, or source: ${unclassified.slice(0, 6).join(", ")}`,
    };
  }

  // ── which exported symbols actually changed ──────────────────────────────
  const headSources = new Map();
  const baseSources = new Map();

  /**
   * A graph file's current source, read once and cached. `headSources` only
   * covers the DIFF; the narrowing needs any importer the walk reaches, which
   * is most of the graph. Unreadable answers null, which widens.
   */
  const sourceCache = new Map();
  const headSourceOf = (file) => {
    if (headSources.has(file)) return headSources.get(file);
    if (!sourceCache.has(file)) {
      try {
        sourceCache.set(file, readFileSync(join(repoRoot, file), "utf8"));
      } catch {
        sourceCache.set(file, null);
      }
    }
    return sourceCache.get(file);
  };
  for (const file of direct) {
    const base = readBase(file);
    baseSources.set(file, base);
    if (!deleted.includes(file)) {
      try {
        const source = readFileSync(join(repoRoot, file), "utf8");
        headSources.set(file, source);
      } catch {
        headSources.set(file, null);
      }
    }
  }

  /**
   * What a specifier in `from` loads: a repo source file, `"builtin"` for a
   * `node:` module, or null (a package, an asset, a hole) — never pure.
   */
  const resolveEdge = (spec, from) => {
    if (spec.startsWith("node:")) return isBuiltin(spec) ? "builtin" : null;
    const edge = (edges.get(from) ?? []).find((e) => e.spec === spec && !e.dynamic && !e.glob);
    const target = edge?.target;
    if (!target || target.startsWith("../") || !EXTENSIONS.includes(target.slice(target.lastIndexOf(".")))) return null;
    return target;
  };
  const exportsOf = (target) => (target === "builtin" ? null : moduleExports(headSourceOf(target)));
  const pureSeen = new Map();
  const loading = { resolve: resolveEdge, read: headSourceOf, exportsOf };
  const narrowedContext = (file, base, head) => {
    if (!affectedExports(base, head).has("*")) return null;
    return narrowModuleContext(base, head, (spec, binding) => loadsCleanly(spec, file, binding, loading, pureSeen));
  };

  /** file -> Set<symbol> | "*" */
  const affected = new Map();
  // Initialization effects cross EVERY runtime import, even when its named
  // binding is unused. Keep this separate from ordinary symbol taint, which
  // can still narrow through an intermediate file's deferred functions.
  const moduleEffects = new Set();
  // file -> the catalog keys it carries, for a catalog reached ONLY by keys.
  const catalogKeys = new Map();
  const symbolReport = {};
  const routeReport = {};
  for (const file of direct) {
    if (deleted.includes(file)) {
      affected.set(file, "*");
      moduleEffects.add(file);
      symbolReport[file] = ["*"];
      continue;
    }
    const head = headSources.get(file);
    if (head === null) {
      affected.set(file, "*");
      moduleEffects.add(file);
      symbolReport[file] = ["*"];
      continue;
    }
    const base = baseSources.get(file);
    // A declared catalog whose edit only moved inert entries carries KEYS, not
    // an initialization effect (catalogs.mjs). Its exports are all "changed";
    // the walk lets only the readers of those keys through.
    const keys = isCatalog(file) ? changedKeys(base, head) : null;
    if (keys !== null) {
      if (keys.size === 0) continue;
      catalogKeys.set(file, keys);
      symbolReport[file] = [...keys].sort().map((key) => `.${key}`);
      continue;
    }
    // `*` from a module-context edit — a new import, a private helper — is
    // re-proven over the whole file: when nothing new runs at load, only the
    // exports that can reach the edit are affected (module-context.mjs).
    const names = narrowedContext(file, base, head) ?? affectedExports(base, head);
    // An export's hash covers its own body, so the exports that merely CALL a
    // changed one are found by following the file's own references. A lane
    // that brackets calls (Gherkin steps) also reads a module-level edit
    // declaration by declaration rather than as "everything in the file".
    let value = names.has("*")
      ? ((calls.length > 0 && !importsChanged(base, head) ? changedDeclarations(base, head, { calls }) : null) ?? "*")
      : withinFile(head, names, { calls });
    const exports = exportedSymbols(head).symbols;
    const removedExport = !names.has("*") && [...names].some((name) => !exports.has(name));
    if (value === "*" || (value.size > 0 && (
      removedExport ||
      initializationMayObserve(head, value, calls) ||
      (base !== null && initializationMayObserve(base, value, calls))
    ))) {
      value = "*";
      moduleEffects.add(file);
    }
    affected.set(file, value);
    symbolReport[file] = value === "*" ? ["*"] : [...value].sort();
  }

  // Same-file export bodies and module context both remained unchanged (for
  // example, a comment edit). Report the file even though it seeds no work.
  for (const [file, syms] of affected) if (syms !== "*" && syms.size === 0) affected.delete(file);

  // Routed entries are seeded AFTER that pruning: the entry file's own bytes
  // did not move, so a symbol diff over it would find nothing and prune it
  // away — which would silently drop the change that routed here. A bare entry
  // seeds every export (`*`); `file#a,b` seeds exactly those.
  for (const [entry, sources] of routedFrom) {
    const hash = entry.indexOf("#");
    const file = hash === -1 ? entry : entry.slice(0, hash);
    const names = hash === -1 ? null : entry.slice(hash + 1).split(",").filter(Boolean);
    const previous = affected.get(file);
    const next = !names || names.length === 0 || previous === "*" ? "*" : new Set([...(previous ?? []), ...names]);
    affected.set(file, next);
    if (globSources.has(file)) moduleEffects.add(file);
    symbolReport[file] = next === "*" ? ["*"] : [...next].sort();
    routeReport[file] = [...new Set([...(routeReport[file] ?? []), ...sources])];
  }

  if (affected.size === 0 && catalogKeys.size === 0) {
    return {
      ...(unobservable.length ? { unobservable } : {}),
      mode: "none",
      tests: [],
      reasons: {},
      symbols: symbolReport,
      stats: { changed: relevant.length, affectedFiles: 0 },
      why: "no exported symbol changed — every edit was a comment or left the same-file exports and module context unchanged",
    };
  }

  // An import we cannot resolve is a hole in the graph, and the safe reading of
  // a hole is "this file might depend on anything". That used to widen the
  // whole RUN to `full`, which is safe and also how this stops working: one odd
  // file in thousands disables narrowing for every diff, forever, and the only
  // symptom is a lane that is slow. Two lines of one test file — a suite that
  // asserts on another file's source and therefore writes `import("./x")`
  // inside a string literal — did exactly that here.
  //
  // Widen the FILE instead. A file whose imports cannot be read is treated as
  // affected by any change at all: if it is a test it runs, and if it is a
  // module its importers follow through the ordinary propagation below. That is
  // the same claim the global fallback made, made only where it is true, so a
  // hole costs one file rather than the entire suite.
  //
  // Ordinary unresolved imports do not resurrect a comment-only `none`.
  // Unsupported globs were seeded above because their unknown membership can
  // include ignored assets as well as source declarations.
  const blind = [...new Set(unresolved.map((u) => u.file))];
  for (const file of blind) {
    affected.set(file, "*");
    moduleEffects.add(file);
    symbolReport[file] = ["*"];
  }

  const importers = new Map(); // target -> [{file, record}]
  for (const [file, records] of edges)
    for (const record of records) {
      if (!importers.has(record.target)) importers.set(record.target, []);
      importers.get(record.target).push({ file, record });
    }

  // ── propagate ────────────────────────────────────────────────────────────
  //
  // A DEFERRED edge — a dynamic `import()` in an arrow handed to one of the
  // caller's `deferredCalls` (`lazyRoute(() => import("./hours"))`) — is not
  // walked here. The page it loads runs only when its route renders, so a test
  // that mounts the whole app to check one screen does not execute every other
  // screen, yet walking the edge selected it for all of them: on the admin
  // SPA, 80% of a plan's tests arrived through App → routes → one page. Each
  // such edge is collected instead and resolved below, test by test.
  const isDeferred = (record) =>
    deferredCalls.length > 0 && record.dynamic && !record.glob && Boolean(record.wrapper) &&
    deferredCalls.includes(record.wrapper);
  const deferredHits = [];
  // Catalog keys (catalogs.mjs) travel beside the ordinary taint, never inside
  // it: `keyed` maps a file to the keys it carries and the exports that carry
  // them (`"*"` for a declared catalog that hands its pack on, the re-exported
  // names for a barrel). An export can be in both maps; each side is a sound
  // claim about its own source, so the union of what they reach is too.
  const walk = (aff, effects, viaMap, queue, keyed = new Map()) => {
    const settled = new Set();
    const requeue = (file, current, record) => {
      if (!viaMap.has(file)) viaMap.set(file, { from: current, line: record.line, text: record.text, spec: record.spec });
      settled.delete(file);
      queue.push(file);
    };
    // Ordinary taint for `file`: the bookkeeping every hop shares.
    const mark = (file, next, effectful, current, record) => {
      const previous = aff.get(file);
      const newEffect = effectful && !effects.has(file);
      if (effectful) effects.add(file);
      if (!newEffect) {
        // Nothing here can observe it: the chain genuinely ends at this file.
        if (next !== "*" && next.size === 0) return;
        // Already knew everything this hop carries — re-queueing would not add.
        if (previous === "*" || (next !== "*" && previous && [...next].every((n) => previous.has(n)))) return;
      }
      aff.set(file, next === "*" ? "*" : new Set([...(previous ?? []), ...next]));
      requeue(file, current, record);
    };
    const carry = (file, keys, names, current, record) => {
      const held = keyed.get(file);
      const grows = !held || [...keys].some((k) => !held.keys.has(k)) ||
        (held.names !== "*" && (names === "*" || [...names].some((n) => !held.names.has(n))));
      if (!grows) return;
      keyed.set(file, {
        keys: new Set([...(held?.keys ?? []), ...keys]),
        names: names === "*" || held?.names === "*" ? "*" : new Set([...(held?.names ?? []), ...names]),
      });
      requeue(file, current, record);
    };
    const restrict = (record, names) => ({ ...record, names, bindings: (record.bindings ?? []).filter(([n]) => names.includes(n)) });

    while (queue.length > 0) {
      const current = queue.shift();
      if (settled.has(current)) continue;
      settled.add(current);
      const symbols = aff.get(current);
      const evaluationEffect = effects.has(current);
      const state = keyed.get(current);
      for (const { file, record } of importers.get(current) ?? []) {
        let ordinary = evaluationEffect ? "*" : symbols !== undefined && importReaches(record, symbols) ? symbols : null;
        // The names this record binds that carry keys. A wildcard binds them
        // all with no name to follow, so it takes the ordinary hop instead.
        let keyedBound = [];
        if (state && !evaluationEffect) {
          if (record.wildcard) ordinary = "*";
          else keyedBound = record.names.filter((n) => state.names === "*" || state.names.has(n));
        }
        if (ordinary === null && keyedBound.length === 0) continue;
        if (isDeferred(record)) {
          deferredHits.push({ page: current, importer: file, record });
          continue;
        }
        if (aff.get(file) === "*" && (!evaluationEffect || effects.has(file))) continue;
        const source = headSourceOf(file);

        // Keys first: a declared catalog that hands the pack on carries them;
        // any other file is reached by the declarations that read one, and
        // re-exports the names it hands on. Any use that is not a plain key
        // read joins the ordinary hop below, as a name the record bound.
        let use = null;
        if (keyedBound.length > 0) {
          const bound = restrict(record, keyedBound);
          if (isCatalog(file) && passesKeysThrough(source, bound)) carry(file, state.keys, "*", current, record);
          else {
            use = isCatalog(file) ? null : keyedUse(source, bound, state.keys);
            if (use === null) ordinary = ordinary === "*" ? "*" : new Set([...(ordinary ?? []), ...keyedBound]);
          }
        }
        if (use !== null) {
          if (use.reexports.size > 0) carry(file, state.keys, use.reexports, current, record);
          if (use.decls === "*") mark(file, "*", initializationMayObserve(source, "*", calls), current, record);
          else if (use.decls.size > 0) {
            const effectful = initializationMayObserve(source, use.decls, calls);
            mark(file, effectful ? "*" : keyedExports(source, use.decls, calls), effectful, current, record);
          }
        }
        if (ordinary === null) continue;

        // Which of THIS file's exports can see what it just bound? Answering
        // "all of them" is what made hop two lose the precision hop one has, and
        // compounded it over every hop after (see exports-dataflow.mjs). Every
        // uncertainty in there answers `"*"`, so this can only ever narrow a
        // claim the old walk was already making.
        const effectful = evaluationEffect || initializationMayObserve(source, taintOf(record, ordinary), calls);
        mark(file, effectful ? "*" : narrowedExports(source, record, ordinary, calls), effectful, current, record);
      }
    }
  };
  const via = new Map(); // file -> {from, line, text, spec}
  const keyed = new Map([...catalogKeys].map(([file, keys]) => [file, { keys, names: "*" }]));
  walk(affected, moduleEffects, via, [...affected.keys(), ...catalogKeys.keys()], keyed); // includes the blind files seeded above

  // ── deferred edges, resolved per test ────────────────────────────────────
  //
  // A test crosses a deferred edge only when it NAMES the page: a URL segment
  // the page answers (`"/acme/config/hours"` for `import("./hours")`, or a
  // `path` on the `<Route>` that renders the lazy binding), or the binding
  // itself. That is how this repo's app tests reach a screen: they push its
  // address and mount the app. A test that reaches a page only by clicking to
  // it from another one is not selected; the daily full suite on `main` runs it
  // (ADR 0211 in the consumer accepts that trade). Everything the importer
  // reaches is found by the ordinary walk seeded at the importer, then kept or
  // dropped by that one rule.
  const deferredReport = {};
  const seenHits = new Set();
  for (let h = 0; h < deferredHits.length; h += 1) {
    const { page, importer, record } = deferredHits[h];
    const key = `${importer}\0${record.spec}\0${record.line}`;
    if (seenHits.has(key)) continue;
    seenHits.add(key);
    const names = deferredNames(record, headSourceOf(importer));
    const aff = new Map([[importer, "*"]]);
    const viaMap = new Map();
    walk(aff, new Set(), viaMap, [importer]);
    const named = [];
    for (const file of aff.keys()) {
      if (!isTest(file) || affected.has(file)) continue;
      if (!namesPage(headSourceOf(file), names)) continue;
      named.push(file);
      affected.set(file, "*");
      for (let node = file; viaMap.has(node) && !via.has(node); node = viaMap.get(node).from) via.set(node, viaMap.get(node));
    }
    if (named.length > 0 && !via.has(importer)) {
      via.set(importer, { from: page, line: record.line, text: `${record.text} (deferred — the test names ${names.join(" | ")})`, spec: record.spec });
    }
    deferredReport[`${importer}:${record.line}`] = { page, names, tests: named.length };
  }

  // ── the answer ───────────────────────────────────────────────────────────
  const tests = [...affected.keys()].filter(isTest).sort();
  const reasons = {};
  for (const test of tests) {
    const chain = [];
    let node = test;
    const guard = new Set();
    while (via.has(node) && !guard.has(node)) {
      guard.add(node);
      const hop = via.get(node);
      chain.push({ importer: node, imports: hop.from, line: hop.line, statement: hop.text });
      node = hop.from;
    }
    reasons[test] = chain.length > 0 ? chain : [{ importer: test, imports: test, line: 0, statement: "changed file — runs as itself" }];
  }

  return {
    ...(unobservable.length ? { unobservable } : {}),
    mode: tests.length > 0 ? "narrowed" : "none",
    tests,
    reasons,
    symbols: symbolReport,
    affected,
    // entry -> the changed non-source paths that routed to it, so a reviewer
    // can see WHY a file nobody edited is seeded as fully changed.
    routes: routeReport,
    // importer:line -> the deferred page, the names a test must use to reach
    // it, and how many tests did (see "deferred edges, resolved per test").
    ...(Object.keys(deferredReport).length ? { deferred: deferredReport } : {}),
    // The graph this selection walked, for a caller that needs to answer a
    // second question over the SAME edges — which files a selected test's
    // verdict can depend on (lib/inputs.mjs). Handed out rather than rebuilt:
    // two graphs over one tree are two things that can disagree, and a hash
    // computed over a graph the selection did not walk is a hash of something
    // else. `blind` names the files whose imports did not resolve; anything
    // reaching one has no bounded closure.
    graph: { edges, blind },
    stats: {
      changed: relevant.length,
      routed: Object.keys(routeReport).length,
      affectedFiles: affected.size,
      graphFiles: edges.size,
      unresolved: unresolved.length,
      blindFiles: blind.length,
      tests: tests.length,
    },
    // The blind count is reported even when it is the whole reason a test was
    // picked: a selection nobody can explain is one nobody can check.
    why:
      (tests.length > 0
        ? `${tests.length} test file(s) reach a changed symbol across ${relevant.length} changed file(s)`
        : "no test file reaches a changed symbol") +
      (blind.length > 0
        ? `; ${blind.length} file(s) always run — their imports cannot be resolved (first: ${unresolved[0].file}:${unresolved[0].line} → ${unresolved[0].spec})`
        : ""),
  };
}
