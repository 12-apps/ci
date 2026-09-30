/**
 * Bounded Vite import.meta.glob dependencies. This is intentionally a subset,
 * not a second general-purpose glob engine: unsupported syntax stays blind.
 * See https://vite.dev/guide/features#glob-import and Vite's importMetaGlob.ts.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";

/** Read static call arguments without evaluating consumer code. */
export function globArguments(source) {
  let at = 0;
  const whitespace = () => { while (/\s/.test(source[at] ?? "") && at < source.length) at++; };
  const take = (character) => { whitespace(); if (source[at] !== character) return false; at++; return true; };
  const string = () => {
    whitespace();
    const quote = source[at];
    if (quote !== "'" && quote !== '"') throw new Error("nonliteral glob");
    const start = ++at;
    while (at < source.length && source[at] !== quote) {
      if (source[at] === "\\" || /[\r\n]/.test(source[at])) throw new Error("escaped glob literal");
      at++;
    }
    if (at === source.length) throw new Error("unfinished glob literal");
    return source.slice(start, at++);
  };
  try {
    whitespace();
    // The consumer uses glob<ArticleModule>(...). More complex type syntax is
    // recognized as a glob by the caller but remains conservatively blind.
    if (source[at] === "<") {
      const type = /^<[A-Za-z_$][\w$]*(?:\[\])?>/.exec(source.slice(at));
      if (!type) return null;
      at += type[0].length;
    }
    if (!take("(")) return null;
    const patterns = [];
    if (take("[")) {
      if (!take("]")) {
        do {
          patterns.push(string());
          if (take("]")) break;
          if (!take(",")) return null;
          if (take("]")) break;
        } while (at < source.length);
      }
    } else patterns.push(string());
    const options = Object.create(null);
    if (take(",") && !take(")")) {
      if (!take("{")) return null;
      while (!take("}")) {
        whitespace();
        let key;
        if (source[at] === "'" || source[at] === '"') key = string();
        else {
          const name = /^[A-Za-z_$][\w$]*/.exec(source.slice(at));
          if (!name) return null;
          key = name[0]; at += key.length;
        }
        if (Object.hasOwn(options, key) || !take(":")) return null;
        whitespace();
        let value;
        const boolean = /^(true|false)\b/.exec(source.slice(at));
        if (boolean) { value = boolean[0] === "true"; at += boolean[0].length; }
        else value = string();
        options[key] = value;
        if (take("}")) break;
        if (!take(",")) return null;
      }
      take(",");
      if (!take(")")) return null;
    } else if (source[at - 1] !== ")" && !take(")")) return null;
    for (const [key, value] of Object.entries(options)) {
      if (key === "eager" && typeof value === "boolean") continue;
      if (key === "import" && typeof value === "string" && value.length > 0) continue;
      if (key === "query" && ["?raw", "?url"].includes(value)) continue;
      if (key === "exhaustive" && value === false) continue;
      if (key === "caseSensitive" && value === true) continue;
      return null; // includes base, spreads, computed options and plugin queries
    }
    return patterns.length ? { patterns, terminal: Boolean(options.query) } : null;
  } catch { return null; }
}

const escape = (text) => text.replace(/[.+^$|()[\]{}\\]/g, "\\$&");

/** A relative, case-sensitive *, ?, ** pattern, resolved within this repo. */
function compile(pattern, importer) {
  const negative = pattern.startsWith("!");
  const raw = negative ? pattern.slice(1) : pattern;
  if (!/^(\.\/|\.\.\/)/.test(raw) || /[\\[\]{}()!\0]/.test(raw)) return null;
  const original = raw.split("/");
  const firstMagic = original.findIndex((part) => /[*?]/.test(part));
  if (firstMagic !== -1 && original.slice(firstMagic).some((part) => part === "..")) return null;
  const normalized = posix.normalize(posix.join(posix.dirname(importer), raw));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".git" || part === "node_modules" || (part.includes("**") && part !== "**"))) return null;
  let regex = "^";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const last = i === parts.length - 1;
    if (part === "**") regex += last ? "(?:(?!\\.)[^/]+/)*(?!\\.)[^/]+" : "(?:(?!\\.)[^/]+/)*";
    else {
      regex += (part.startsWith(".") ? "" : "(?!\\.)") + escape(part).replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
      if (!last) regex += "/";
    }
  }
  regex += "$";
  const magic = parts.findIndex((part) => /[*?]/.test(part));
  const anchor = parts.slice(0, magic === -1 ? -1 : magic).join("/");
  return { negative, re: new RegExp(regex), anchor };
}

/**
 * Resolve current membership and keep the matcher for added/deleted paths.
 * Matching sources become graph nodes; assets/raw imports are terminal bytes.
 * Symlinks and read errors refuse a bounded claim rather than hiding targets.
 */
export function resolveGlob(repoRoot, importer, glob) {
  const patterns = glob.patterns.map((pattern) => compile(pattern, importer));
  if (patterns.some((pattern) => pattern === null) || !patterns.some((pattern) => !pattern.negative)) return null;
  const positive = patterns.filter((pattern) => !pattern.negative);
  const negative = patterns.filter((pattern) => pattern.negative);
  const matches = (file) => file !== importer && !file.split("/").includes("node_modules") &&
    positive.some(({ re }) => re.test(file)) && !negative.some(({ re }) => re.test(file));
  const files = new Set();
  const visited = new Set();
  const walk = (dir) => {
    if (visited.has(dir)) return;
    visited.add(dir);
    let entries;
    try { entries = readdirSync(join(repoRoot, dir), { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const file = posix.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("glob reaches a symlink");
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && matches(file)) files.add(file);
    }
  };
  try {
    for (const { anchor } of positive) {
      // readdir follows a symlink in its starting directory; check each part.
      let path = "";
      for (const part of anchor.split("/").filter(Boolean)) {
        path = posix.join(path, part);
        try { if (lstatSync(join(repoRoot, path)).isSymbolicLink()) return null; }
        catch (error) { if (error.code === "ENOENT") break; throw error; }
      }
      walk(anchor);
    }
  } catch { return null; }
  return { files: [...files].sort(), matches };
}
