/**
 * Symbol-level affected-test selection.
 *
 * The propagation rule, stated once because everything else follows from it:
 *
 * > A file is affected when it imports a symbol that changed. Once affected,
 * > ALL of its own exports are treated as changed.
 *
 * The first half is the narrowing that matters — an importer that takes only
 * `packageRoutes` from a module whose `packageRoutes` is byte-identical is not
 * affected, however much else in that module moved. The second half is the
 * deliberate over-approximation that keeps it sound: once a file consumes
 * something that changed, any of its exports may now behave differently, and
 * tracking which would require type-checking the whole program.
 *
 * Every uncertainty widens, never narrows. A file whose declarations could not
 * be bracketed, a relative import that did not resolve, a changed path the
 * caller classified as untraceable — each of those returns the full suite. The
 * failure this design must never produce is a green lane that skipped the test
 * which would have caught the bug; paying for a wide run is the cheap error.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { reachableExports } from "./exports-dataflow.mjs";
import { buildGraph, listSourceFiles, loadPackages } from "./modules.mjs";
import { affectedExports, exportedSymbols } from "./symbols.mjs";

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
function narrowedExports(source, record, symbols) {
  if (source == null || record.wildcard) return "*";
  const tainted = symbols === "*" ? record.names : record.names.filter((n) => symbols.has(n));
  if (tainted.length === 0) return "*";
  return reachableExports(source, [...tainted, ...tainted.map((n) => `${record.spec}#${n}`)]);
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
 * @returns {{mode:"full"|"narrowed"|"none", tests:string[], reasons:object, symbols:object, stats:object, why:string}}
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
    isUntraceable = () => false,
    aliasesFor,
  } = options;

  const relevant = [...changed, ...deleted].filter((f) => !isIgnored(f));
  if (relevant.length === 0) {
    return { mode: "none", tests: [], reasons: {}, symbols: {}, stats: { changed: 0 }, why: "every changed path is one the ignore rules prove cannot change a verdict" };
  }

  const untraceable = relevant.filter(isUntraceable);
  if (untraceable.length > 0) {
    return {
      mode: FULL,
      tests: [],
      reasons: {},
      symbols: {},
      stats: { changed: relevant.length, untraceable: untraceable.length },
      why: `change(s) the import graph cannot account for (${untraceable.slice(0, 4).join(", ")})`,
    };
  }

  // ── which exported symbols actually changed ──────────────────────────────
  // The base-side hashes are collected across the WHOLE diff first, so a
  // symbol that moved from one changed file to another is recognised as
  // unchanged rather than as "deleted here, added there".
  const baseByName = new Map();
  const headByName = new Map();
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
  for (const file of relevant) {
    const base = readBase(file);
    baseSources.set(file, base);
    if (base !== null) {
      const parsed = exportedSymbols(base);
      // Re-export placeholders are skipped: these maps answer "where does this
      // name's BODY live", and a forwarding entry has no body of its own.
      if (parsed.ok)
        for (const [name, h] of parsed.symbols) if (!String(h).startsWith("reexport:")) baseByName.set(name, h);
    }
    if (!deleted.includes(file)) {
      try {
        const source = readFileSync(join(repoRoot, file), "utf8");
        headSources.set(file, source);
        const parsed = exportedSymbols(source);
        if (parsed.ok)
          for (const [name, h] of parsed.symbols) if (!String(h).startsWith("reexport:")) headByName.set(name, h);
      } catch {
        headSources.set(file, null);
      }
    }
  }

  /** file -> Set<symbol> | "*" */
  const affected = new Map();
  const symbolReport = {};
  for (const file of relevant) {
    if (deleted.includes(file)) {
      affected.set(file, "*");
      symbolReport[file] = ["*"];
      continue;
    }
    const head = headSources.get(file);
    if (head === null) {
      affected.set(file, "*");
      symbolReport[file] = ["*"];
      continue;
    }
    const names = affectedExports(baseSources.get(file), head, baseByName, headByName);
    const value = names.has("*") ? "*" : names;
    affected.set(file, value);
    symbolReport[file] = value === "*" ? ["*"] : [...names].sort();
  }

  // A changed file whose exports are all byte-identical (a pure move, a
  // comment) contributes nothing at all — but it is still a real change, so it
  // is reported rather than silently dropped.
  for (const [file, syms] of affected) if (syms !== "*" && syms.size === 0) affected.delete(file);
  if (affected.size === 0) {
    return {
      mode: "none",
      tests: [],
      reasons: {},
      symbols: symbolReport,
      stats: { changed: relevant.length, affectedFiles: 0 },
      why: "no exported symbol changed — every edit was a relocation, a comment, or otherwise not observable",
    };
  }

  // ── the graph ────────────────────────────────────────────────────────────
  const packages = loadPackages(repoRoot, workspaceDirs);
  const files = listSourceFiles(repoRoot, roots);
  const { edges, unresolved } = buildGraph(repoRoot, files, { packages, aliasesFor });

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
  // It cannot resurrect a `none`: that verdict is returned above, before this
  // graph exists, and it means no exported symbol moved anywhere — so there is
  // nothing for an unreadable file to have depended on.
  const blind = [...new Set(unresolved.map((u) => u.file))];
  for (const file of blind) {
    affected.set(file, "*");
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
      if (!importReaches(record, symbols)) continue;
      const previous = affected.get(file);
      if (previous === "*") continue;

      // Which of THIS file's exports can see what it just bound? Answering
      // "all of them" is what made hop two lose the precision hop one has, and
      // compounded it over every hop after (see exports-dataflow.mjs). Every
      // uncertainty in there answers `"*"`, so this can only ever narrow a
      // claim the old walk was already making.
      const next = narrowedExports(headSourceOf(file), record, symbols);
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
    mode: tests.length > 0 ? "narrowed" : "none",
    tests,
    reasons,
    symbols: symbolReport,
    stats: {
      changed: relevant.length,
      affectedFiles: affected.size,
      graphFiles: files.length,
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
