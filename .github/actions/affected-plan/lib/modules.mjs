/**
 * Module resolution and import extraction — the graph layer.
 *
 * Two decisions here decide whether the selection above it is sound.
 *
 * **Type-only imports are not edges.** `import type { X } from "./y"` is erased
 * by the transform before a bundler or vitest ever builds a module graph, so a
 * change to `y` cannot reach the importer through it. Counting it would widen
 * every selection with edges that do not exist at runtime. The parser therefore
 * classifies each statement and the graph drops the type-only ones.
 *
 * **An unresolvable specifier is not silently dropped.** A bare specifier that
 * is not a known workspace package is external (`react`, a published package)
 * and genuinely cannot reach the consumer's own source, so it resolves to null
 * by design. But a RELATIVE specifier that fails to resolve means this module
 * misread the tree, and the caller is told: it counts as an unresolved edge and
 * the lane widens rather than narrowing on a graph with holes in it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve as pathResolve } from "node:path";

/** Extensions tried, in order, when a specifier names no file extension. */
export const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Extensions that name a NON-module asset — a stylesheet, an image, an HTML
 * entry. These are resolved exactly and may miss quietly: assets are routinely
 * generated, virtual, or served by a bundler plugin, and failing a lane over
 * one would make this unusable in a real app.
 *
 * Deliberately an allowlist. `.json` is absent because a JSON import IS a
 * module whose contents can change a test's outcome.
 */
const ASSET_EXTENSIONS = new Set([
  ".css", ".scss", ".sass", ".less", ".styl",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp",
  ".html", ".htm", ".txt", ".md", ".mdx", ".csv", ".yaml", ".yml",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".webm", ".wav", ".ogg", ".wasm",
]);

/** Never walked: build output, dependencies, VCS. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".git",
  "coverage",
  ".features-gen",
]);

/**
 * `import`/`export … from "spec"` — captures the clause so the caller can tell
 * a type-only statement from a value one.
 *
 * Anchored on the keyword rather than on a preceding newline: matching the
 * newline puts `match.index` one line early, and every line number this module
 * reports would be off by one. Those line numbers are the only thing a human
 * can check a selection against, so they are load-bearing.
 */
const FROM_STATEMENT = /(?:^|[\n;])[ \t]*(import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']/g;
/** `import "./side-effect"` — no clause, always a value edge. */
const BARE_IMPORT = /(?:^|[\n;])[ \t]*import\s*["']([^"']+)["']/g;
/** `import("./x")` and `require("./x")` — dynamic, always a value edge. */
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_CALL = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

/**
 * One scan, two views of the same source.
 *
 * `code` removes comments and keeps string, template and regex literals —
 * hand-written rather than regex-based because the cases that matter are
 * exactly the ones a regex gets wrong: `"https://x"` is not a comment, and a
 * `/* *​/` sequence inside a template literal is not a comment either.
 *
 * `masked` is `code` with every string literal's CONTENT blanked to spaces,
 * the quotes themselves left in place. It exists because import syntax is not
 * only written as code — it is also written ABOUT, inside string literals, by
 * any test that asserts on the shape of another file's source:
 *
 *   expect(chip).toContain('import("./mesa-sheet")');
 *
 * Read as code that is a dynamic import of `./mesa-sheet` from the test's own
 * directory, which does not exist, so it reports as an unresolved edge. Two
 * such lines in one file of this repo's 2,992 were enough to make every plan
 * report `full` — safe, and silently useless, which is the worst way for a
 * selector to fail. Positions are found in `masked` and specifiers read from
 * `code`, so the two must stay CHARACTER-ALIGNED: every branch below appends
 * the same number of characters to both.
 */
function scan(source) {
  let out = "";
  let hidden = "";
  let i = 0;
  const n = source.length;
  let quote = null; // ' " ` when inside a string
  let templateDepth = 0;

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (quote) {
      out += c;
      // A newline inside a template literal is a real newline: blank it to a
      // space and every line number after it would shift.
      hidden += c === "\n" ? "\n" : c === quote ? c : " ";
      if (c === "\\") {
        out += next ?? "";
        hidden += next === undefined ? "" : next === "\n" ? "\n" : " ";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      if (c === "`") templateDepth += 1;
      out += c;
      hidden += c;
      i += 1;
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue; // the newline itself is emitted on the next pass
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") {
          out += "\n"; // keep line numbering intact
          hidden += "\n";
        }
        i += 1;
      }
      i += 2;
      continue;
    }

    out += c;
    hidden += c;
    i += 1;
    void templateDepth;
  }
  return { code: out, masked: hidden };
}

/** Comments removed, literals intact. */
export const stripComments = (source) => scan(source).code;

/** Line number (1-based) of `index` within `source`. */
const lineAt = (source, index) => source.slice(0, index).split("\n").length;

/**
 * Is this `import`/`export` clause type-only?
 *
 * Two spellings erase: the statement form `import type { A } from …`, and the
 * inline form where EVERY named binding carries `type`. A mixed clause
 * (`import { type A, b }`) keeps a value edge, because `b` survives the
 * transform. A default or namespace binding alongside braces is always a value.
 */
export function isTypeOnlyClause(clause) {
  const text = clause.trim();
  if (/^type\b/.test(text)) return true;
  const braces = text.match(/\{([\s\S]*)\}/);
  if (!braces) return false;
  const beforeBrace = text.slice(0, text.indexOf("{")).replace(/,/g, "").trim();
  if (beforeBrace) return false; // default/namespace binding is a value
  const names = braces[1]
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((n) => /^type\s/.test(n));
}

/**
 * The named bindings a clause pulls in, plus whether it takes everything.
 *
 * `wildcard` is true for `import * as ns`, `export * from`, a default import,
 * or a bare side-effect import — cases where naming individual symbols would
 * understate what the importer can observe. The selector treats a wildcard as
 * "depends on every export", which is the widening (safe) direction.
 */
export function bindingsOf(clause) {
  const text = clause.trim();
  if (/\*/.test(text)) return { names: [], wildcard: true };
  const braces = text.match(/\{([\s\S]*)\}/);
  const beforeBrace = braces ? text.slice(0, text.indexOf("{")) : text;
  const hasDefault = /[A-Za-z0-9_$]/.test(beforeBrace.replace(/^(import|export)\s*/, "").replace(/,/g, "").trim());
  if (!braces) return { names: [], wildcard: hasDefault };
  const names = braces[1]
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n && !/^type\s/.test(n))
    .map((n) => n.split(/\s+as\s+/)[0].trim());
  return { names, wildcard: hasDefault };
}

/**
 * Every import statement in one file's source.
 *
 * @returns {{spec:string, typeOnly:boolean, wildcard:boolean, names:string[], line:number, text:string}[]}
 */
export function parseImports(rawSource) {
  // Comments are stripped FIRST. A docblock that explains a dynamic
  // `import("./x")` is prose, not an edge, and following it fabricated an
  // unresolvable dependency that forced whole lanes to the full suite.
  // `stripComments` preserves newlines, so reported line numbers still point
  // at the real line in the real file.
  const { code: source, masked } = scan(rawSource);
  const lines = rawSource.split("\n");
  const out = [];
  const push = (spec, clause, index, forceValue = false) => {
    const line = lineAt(source, index);
    const typeOnly = forceValue ? false : isTypeOnlyClause(clause);
    const { names, wildcard } = forceValue ? { names: [], wildcard: true } : bindingsOf(clause);
    out.push({ spec, typeOnly, wildcard, names, line, text: (lines[line - 1] ?? "").trim() });
  };
  /**
   * Match `re` where it is CODE, and read the specifier from the code.
   *
   * `masked` decides which occurrences are real — a blanked literal cannot
   * still contain the word `import` — and `source` supplies the value, because
   * in `masked` the specifier itself is spaces. The two are character-aligned
   * by construction, so one index means the same place in both. Masking can
   * only delete characters, never introduce an `import` keyword, so an index
   * present in `masked` and absent from `source` contributes nothing.
   */
  const inCode = (re) => {
    const real = new Set();
    for (const m of masked.matchAll(re)) real.add(m.index);
    return [...source.matchAll(re)].filter((m) => real.has(m.index));
  };
  for (const m of inCode(FROM_STATEMENT)) push(m[3], m[2], m.index + m[0].indexOf(m[1]));
  for (const m of inCode(BARE_IMPORT)) push(m[1], "", m.index, true);
  for (const m of inCode(DYNAMIC_IMPORT)) push(m[1], "", m.index, true);
  for (const m of inCode(REQUIRE_CALL)) push(m[1], "", m.index, true);
  return out;
}

/** Resolve a repo-relative path that may omit its extension or name a folder. */
export function resolveFile(repoRoot, candidate) {
  const abs = join(repoRoot, candidate);
  if (existsSync(abs) && statSync(abs).isFile()) return candidate;
  for (const ext of EXTENSIONS) if (existsSync(abs + ext)) return candidate + ext;
  for (const ext of EXTENSIONS) {
    const index = join(abs, `index${ext}`);
    if (existsSync(index)) return relative(repoRoot, index);
  }
  return null;
}

/**
 * Workspace packages by name, with their `exports` map — so `@repo/x/sub`
 * resolves the way the bundler resolves it rather than by guessing a path.
 */
export function loadPackages(repoRoot, workspaceDirs) {
  const byName = new Map();
  for (const dir of workspaceDirs) {
    const manifest = join(repoRoot, dir, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name) byName.set(pkg.name, { dir, exports: pkg.exports ?? {} });
    } catch {
      /* an unreadable manifest contributes no package; callers widen */
    }
  }
  return byName;
}

/** Follow a package `exports` entry (string or conditions object) to a path. */
function exportTarget(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") return entry.import ?? entry.default ?? null;
  return null;
}

/**
 * Resolve one specifier from one file.
 *
 * @returns {{file:string|null, external:boolean}} `external` distinguishes "a
 *   published package, correctly not followed" from "a path this module failed
 *   to resolve", which the caller must treat as a hole in the graph.
 */
export function resolveSpecifier(repoRoot, rawSpec, fromFile, options = {}) {
  const { packages = new Map(), aliases = [] } = options;

  // Vite-style virtual modules and query suffixes (`./x.svg?react`, `?raw`,
  // `?worker`). The query selects a TRANSFORM, not a different module, so it
  // is stripped before resolution.
  if (/^(virtual:|\0)/.test(rawSpec)) return { file: null, external: true };
  const spec = rawSpec.replace(/[?#].*$/, "");
  if (!spec) return { file: null, external: true };

  // A specifier naming a non-JS extension is an ASSET — a stylesheet, an SVG,
  // an HTML entry. It is resolved exactly (no extension guessing) so a changed
  // asset still reaches its importers, but a miss is not treated as a hole in
  // the graph: assets are routinely generated, virtual, or served by a plugin,
  // and failing the whole lane over one would make this unusable in any real
  // app. A missing JS module, by contrast, is a genuine hole — see buildGraph.
  // Asset detection is an ALLOWLIST, and the extension comes from the
  // BASENAME. Both halves were learned the same painful way — each mistake
  // silently DROPPED edges, which narrows a lane, the one direction this
  // module must never fail in:
  //
  //   `./surface`          a dot in the `./` prefix is not an extension
  //   `../routes.generated`  `.generated` is part of the NAME, not a file type
  //
  // So anything whose extension is not a known asset is resolved as a module,
  // extension-guessing included; if that fails it is reported unresolved and
  // the caller widens. Only a recognised asset may miss quietly.
  const basename = spec.slice(spec.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  const extension = dot > 0 ? basename.slice(dot).toLowerCase() : "";
  const isAsset = ASSET_EXTENSIONS.has(extension);
  if (isAsset && spec.startsWith(".")) {
    const target = normalize(join(dirname(fromFile), spec));
    return { file: existsSync(join(repoRoot, target)) ? target : null, external: false, asset: true };
  }
  if (isAsset) return { file: null, external: true, asset: true };

  if (spec.startsWith(".")) {
    const target = normalize(join(dirname(fromFile), spec));
    // resolveFile first so `./routes.generated` finds `routes.generated.ts`;
    // then the exact path, for a real `./data.json`.
    const resolved = resolveFile(repoRoot, target);
    if (resolved) return { file: resolved, external: false };
    return { file: existsSync(join(repoRoot, target)) ? target : null, external: false };
  }

  for (const { prefix, replacement } of aliases) {
    // Prefix match on a path boundary, matching bundler alias semantics: "@"
    // matches "@" and "@/x" but never "@repo/x", which is a different package.
    if (spec === prefix || spec.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)) {
      const rest = spec.slice(prefix.length).replace(/^\//, "");
      const target = normalize(join(replacement, rest));
      return { file: resolveFile(repoRoot, target), external: false };
    }
  }

  for (const [name, pkg] of packages) {
    if (spec !== name && !spec.startsWith(`${name}/`)) continue;
    const sub = spec === name ? "." : `./${spec.slice(name.length + 1)}`;
    const declared = exportTarget(pkg.exports[sub]);

    // Candidates in order of authority: what `exports` declares, then the
    // source tree. The fallback is not a guess — a workspace package commonly
    // publishes from `dist/`, and in a test run nothing has built it, which is
    // why consumers alias these to source in their vitest config. Resolving
    // only what `exports` names would leave the graph full of holes on exactly
    // the packages a monorepo cares most about.
    const candidates = [
      declared && normalize(join(pkg.dir, declared)),
      sub === "." ? join(pkg.dir, "src", "index") : normalize(join(pkg.dir, "src", sub.slice(2))),
      sub === "." ? join(pkg.dir, "index") : normalize(join(pkg.dir, sub.slice(2))),
    ].filter(Boolean);
    for (const candidate of candidates) {
      const resolved = resolveFile(repoRoot, candidate);
      if (resolved) return { file: resolved, external: false };
    }
    return { file: null, external: false };
  }

  // Not relative, not aliased, not a workspace package: a published dependency.
  // It cannot import the consumer's own source, so not following it is correct.
  return { file: null, external: true };
}

/** Every source file under `roots`, repo-relative. */
export function listSourceFiles(repoRoot, roots) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(join(repoRoot, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (EXTENSIONS.includes(entry.name.slice(entry.name.lastIndexOf(".")))) out.push(rel);
    }
  };
  for (const root of roots) walk(root);
  return out;
}

/**
 * Build the import graph.
 *
 * @returns {{edges:Map<string,object[]>, unresolved:{file:string,spec:string,line:number}[]}}
 *   `unresolved` lists relative specifiers that did not resolve. A non-empty
 *   list means the graph is incomplete and the caller must widen.
 */
export function buildGraph(repoRoot, files, options = {}) {
  const edges = new Map();
  const unresolved = [];
  for (const file of files) {
    let source;
    try {
      source = readFileSync(join(repoRoot, file), "utf8");
    } catch {
      unresolved.push({ file, spec: "<unreadable>", line: 0 });
      continue;
    }
    const out = [];
    for (const imp of parseImports(source)) {
      if (imp.typeOnly) continue;
      const aliases = typeof options.aliasesFor === "function" ? options.aliasesFor(file) : (options.aliases ?? []);
      const { file: target, external, asset } = resolveSpecifier(repoRoot, imp.spec, file, {
        packages: options.packages,
        aliases,
      });
      if (target) out.push({ ...imp, target });
      // An unresolved ASSET is tolerated (generated, virtual, plugin-served);
      // an unresolved JS module means this walker misread the tree, and the
      // caller must widen rather than narrow against a graph with holes.
      else if (!external && !asset) unresolved.push({ file, spec: imp.spec, line: imp.line });
    }
    edges.set(file, out);
  }
  return { edges, unresolved };
}

export { pathResolve };
