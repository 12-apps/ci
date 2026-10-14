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

import { boundOf, changedDeclarations, declarationsOf, reachableExports, spread, withinFile } from "./exports-dataflow.mjs";
import { buildGraph, listSourceFiles, loadPackages, scan } from "./modules.mjs";
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
 * A small allowlist of declarations whose evaluation cannot call user code.
 * Everything else (calls, property reads, classes, enums, destructuring, ...)
 * may throw or mutate state while the module loads. This is deliberately not
 * a purity claim about arbitrary expressions.
 */
function inertDeclaration(text) {
  const parsed = scan(text);
  const code = parsed.masked.trim();
  if (/^(?:export\s+)?(?:declare\s+)?(?:type|interface)\b/.test(code)) return true;
  if (/^export\s*\{/.test(code)) return true; // reexport evaluation follows its graph edge
  if (/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/.test(code)) {
    const open = code.indexOf("{");
    if (open === -1) return false;
    let depth = 0;
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}" && --depth === 0) return /^\s*;?\s*$/.test(code.slice(i + 1));
    }
    return false;
  }
  const binding = /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:[^=]+)?\s*=\s*/.exec(code);
  if (!binding) return false;
  const value = code.slice(binding[0].length).replace(/;\s*$/, "").trim();
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

/** Can a changed binding alter eager module evaluation, not just an export? */
function initializationMayObserve(source, tainted, calls) {
  if (source == null) return true;
  const declarations = declarationsOf(source, { calls });
  if (declarations === null) return true;
  const hot = tainted === "*" ? new Set(declarations.flatMap(boundOf)) : spread(declarations, tainted);
  return declarations.some((d) => !d.call && boundOf(d).some((name) => hot.has(name)) && !inertDeclaration(d.text));
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

  /** file -> Set<symbol> | "*" */
  const affected = new Map();
  // Initialization effects cross EVERY runtime import, even when its named
  // binding is unused. Keep this separate from ordinary symbol taint, which
  // can still narrow through an intermediate file's deferred functions.
  const moduleEffects = new Set();
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
    const names = affectedExports(base, head);
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

  if (affected.size === 0) {
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
  const via = new Map(); // file -> {from, line, text, spec}
  const queue = [...affected.keys()]; // includes the blind files seeded above
  const settled = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (settled.has(current)) continue;
    settled.add(current);
    const symbols = affected.get(current);
    for (const { file, record } of importers.get(current) ?? []) {
      const evaluationEffect = moduleEffects.has(current);
      if (!evaluationEffect && !importReaches(record, symbols)) continue;
      const previous = affected.get(file);
      const alreadyEffectful = moduleEffects.has(file);
      if (previous === "*" && (!evaluationEffect || alreadyEffectful)) continue;

      // Which of THIS file's exports can see what it just bound? Answering
      // "all of them" is what made hop two lose the precision hop one has, and
      // compounded it over every hop after (see exports-dataflow.mjs). Every
      // uncertainty in there answers `"*"`, so this can only ever narrow a
      // claim the old walk was already making.
      const source = headSourceOf(file);
      const effectful = evaluationEffect || initializationMayObserve(source, taintOf(record, symbols), calls);
      const next = effectful ? "*" : narrowedExports(source, record, symbols, calls);
      if (effectful) moduleEffects.add(file);
      // Nothing here can observe it: the chain genuinely ends at this file.
      if (next !== "*" && next.size === 0) continue;
      // Already knew everything this hop carries — re-queueing would not add.
      if (next !== "*" && previous && [...next].every((n) => previous.has(n))) continue;

      affected.set(file, next === "*" ? "*" : new Set([...(previous ?? []), ...next]));
      if (!via.has(file)) via.set(file, { from: current, line: record.line, text: record.text, spec: record.spec });
      settled.delete(file);
      queue.push(file);
    }
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
