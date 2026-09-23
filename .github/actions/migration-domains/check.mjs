#!/usr/bin/env node
/* global console, process */
/**
 * `migration-domains` — every migration declares the domains it affects, and
 * the declaration is TRUE.
 *
 *   node check.mjs --registry prisma/domains.json [--schema prisma/schema] [--write]
 *
 * A migration names its domains in one comment line:
 *
 *     -- @domains: orders, payments
 *
 * and this refuses the tree — every migration in it, not only the ones a diff
 * touched — unless all of the following hold:
 *
 *   1. every migration carries exactly one well-formed declaration;
 *   2. every domain it declares exists in the registry;
 *   3. every table its SQL changes belongs to a declared domain (see
 *      lib/sql.mjs for what "changes" means and what the parse cannot see);
 *   4. every declared domain is one the SQL visibly changes — unless the file
 *      holds dynamic SQL, where the parse is blind and the declaration stands;
 *   5. the registry places every table in exactly one domain, covers every
 *      table any migration ever touched and every table the schema maps, and
 *      names nothing that is neither — a stale entry is a failure too.
 *
 * It is meant to run FIRST, before any test lane exists. A migration that does
 * not say what it affects cannot be selected for, so the honest outcome is not
 * a wide run — it is no run, in red, naming the file.
 *
 * `--write` adds the computed declaration to every migration that has none
 * (never rewrites one that exists), for adopting the rule on an existing tree.
 * It refuses a file whose SQL it cannot fully read, since a guessed declaration
 * is exactly what this gate exists to stop.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { loadRegistry } from "./lib/registry.mjs";
import { schemaModels } from "./lib/prisma-schema.mjs";
import { formatDeclaration, readDeclaration, walkMigrations } from "./lib/sql.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const root = resolve(arg("root", process.cwd()));
const registryPath = arg("registry");
/**
 * The migrations to read, as a path GLOB — `**` any depth, `*` one segment.
 * A glob rather than a regex on purpose: the value arrives on the command line
 * from a caller's workflow input, and compiling it verbatim would hand that
 * caller the regex engine. Every character but the two wildcards is escaped.
 */
const escapeSegment = (part) => part.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
const globToRegExp = (glob) =>
  new RegExp(
    `^${glob
      .split("**/")
      .map((chunk) => chunk.split("**").map(escapeSegment).join(".*"))
      .join("(?:.*/)?")}$`,
  );
const pattern = globToRegExp(arg("migrations", "**/prisma/migrations/*/migration.sql"));
const schemaDirs = (arg("schema", "") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const write = argv.includes("--write");

if (!registryPath) {
  console.error("::error::migration-domains: --registry is required (the JSON mapping each domain to its tables)");
  process.exit(1);
}

const problems = [];
const fail = (file, line, message) => problems.push({ file, line, message });

/** Committed migration files, so an untracked scratch file never decides a verdict. */
function migrationFiles() {
  let listed;
  try {
    listed = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
      .split("\0")
      .filter(Boolean);
  } catch {
    listed = null;
  }
  const files = (listed ?? walk(root)).filter((f) => pattern.test(f) && !f.includes("node_modules/"));
  // Timestamp order across every set, so an index created in one migration is
  // known when a later one drops it by name.
  const dirOf = (f) => f.split("/").at(-2);
  return files.sort((a, b) => dirOf(a).localeCompare(dirOf(b)) || a.localeCompare(b));
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(relative(root, path));
  }
  return out;
}

const registry = loadRegistry(resolve(root, registryPath));
for (const message of registry.problems) fail(registryPath, 1, message);

// The schema, when given: which table each model maps to, and its columns.
const schemaTexts = [];
for (const dir of schemaDirs) {
  const abs = resolve(root, dir);
  if (!existsSync(abs)) {
    fail(dir, 1, `schema path ${dir} does not exist`);
    continue;
  }
  const files = statSync(abs).isDirectory()
    ? readdirSync(abs).filter((f) => f.endsWith(".prisma")).map((f) => join(abs, f))
    : [abs];
  for (const f of files) schemaTexts.push(readFileSync(f, "utf8"));
}
const models = schemaModels(schemaTexts);
const schemaTables = new Set([...models.values()].map((m) => m.table));

const files = migrationFiles();
if (files.length === 0) fail(registryPath, 1, `no migration file matches ${pattern} — the gate would pass having checked nothing`);

const sources = files.map((file) => ({ name: file, sql: readFileSync(join(root, file), "utf8") }));
const parsed = walkMigrations(sources, { tables: [...registry.tableDomain.keys()] });

const everTouched = new Set();
let written = 0;
for (const { name: file, sql } of sources) {
  const { touched, dynamic, unresolved } = parsed.get(file);
  for (const t of touched) everTouched.add(t);
  const declaration = readDeclaration(sql);

  // What the SQL proves this migration affects.
  const needed = new Map();
  for (const table of touched) {
    const domain = registry.tableDomain.get(table);
    if (!domain) {
      fail(file, declaration.line || 1, `changes table "${table}", which belongs to no domain — add it to ${registryPath}`);
      continue;
    }
    if (!needed.has(domain)) needed.set(domain, []);
    needed.get(domain).push(table);
  }
  const blind = dynamic || unresolved.length > 0;

  if (declaration.domains === null) {
    if (write && !blind && needed.size > 0 && touched.size === [...needed.values()].flat().length) {
      writeFileSync(join(root, file), `${formatDeclaration([...needed.keys()].sort())}\n${sql}`);
      written += 1;
      continue;
    }
    const hint = needed.size > 0 ? ` — its SQL changes: ${[...needed.keys()].sort().join(", ")}` : "";
    fail(file, 1, `declares no domains. Add a first line \`${formatDeclaration(needed.size ? [...needed.keys()].sort() : ["<domain>"])}\`${hint}`);
    continue;
  }
  for (const message of declaration.problems) fail(file, declaration.line, message);

  const declared = new Set(declaration.domains);
  for (const d of declared)
    if (!registry.domains.has(d)) fail(file, declaration.line, `declares "${d}", which is not a domain in ${registryPath}`);

  for (const [domain, tables] of needed)
    if (!declared.has(domain))
      fail(file, declaration.line, `changes ${tables.map((t) => `"${t}"`).join(", ")} (domain "${domain}") but does not declare "${domain}"`);

  if (!blind)
    for (const d of declared)
      if (registry.domains.has(d) && !needed.has(d))
        fail(file, declaration.line, `declares "${d}" but its SQL changes no table in it — declare only what the migration affects`);

  if (touched.size === 0 && !blind)
    fail(file, declaration.line || 1, "changes no table the parser can see — if that is wrong, the migration's SQL shape needs a rule in 12-apps/ci migration-domains/lib/sql.mjs");
}

// The registry against the migrations and the schema: complete, and not stale.
for (const table of schemaTables)
  if (!registry.tableDomain.has(table)) fail(registryPath, 1, `table "${table}" is mapped by the schema but belongs to no domain`);
for (const [table, domain] of registry.tableDomain)
  if (!everTouched.has(table) && !schemaTables.has(table))
    fail(registryPath, 1, `"${table}" (domain "${domain}") is created by no migration and mapped by no model — remove it`);

if (write && written > 0) console.log(`[migration-domains] wrote a declaration into ${written} migration(s).`);

if (problems.length > 0) {
  for (const { file, line, message } of problems) console.log(`::error file=${file},line=${line}::${message}`);
  console.error(`\n[migration-domains] ${problems.length} problem(s) across ${files.length} migration(s). No test runs until every migration declares, truthfully, the domains it affects.`);
  process.exit(1);
}
console.log(
  `[migration-domains] ${files.length} migration(s), ${registry.domains.size} domain(s), ${registry.tableDomain.size} table(s): every migration declares what it affects.`,
);
