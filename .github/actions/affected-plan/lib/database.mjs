/**
 * Database-aware routing: a migration or a schema edit selects the tests that
 * can OBSERVE it — not every test that loads the database client.
 *
 * ## Why a route to the client entry is the wrong answer
 *
 * A migration and a `.prisma` file are not source, so the selector used to
 * route both to the one source file carrying "the database": the client entry.
 * Every integration test loads that entry, so every migration ran the whole
 * integration suite. Measured on the change that motivated this: one data
 * backfill of ONE column on `clients` — `UPDATE clients SET
 * comanda_cancel_answer_roles = …` — selected 256 of 282 integration files
 * across 7 shards, because `packages/prisma/src/index.ts` was seeded as
 * changed and 249 of them import it.
 *
 * The entry did not change. The DATABASE did, and only in the tables and
 * columns the migration names. So the useful question is the one this module
 * asks: which code reads or writes THOSE?
 *
 * ## How it answers
 *
 * 1. **What changed in the database.** A migration is parsed
 *    (migration-domains/lib/sql.mjs) into per-table effects: the whole table
 *    (`"*"` — new rows, a trigger, a new NOT NULL column every INSERT must now
 *    supply) or a set of columns (a backfill, a column added with a default, a
 *    constraint over them), or nothing observable (a comment, a plain index).
 *    A schema file is diffed block by block into changed models and fields. A
 *    migration whose SQL did not change — only its comments — changes nothing.
 * 2. **Where code touches it.** Prisma code reaches a table through its
 *    delegate — `prisma.order.findMany(`, `tx.order.update(` — or through raw
 *    SQL naming the table, or through a relation field in another model's
 *    `include` / nested write. A column is reached through its field name. A
 *    field name that many models share (`name`, `clientId`, `archivedAt`) is
 *    only counted in a file that ALSO touches the model, or every file in the
 *    repo would match.
 * 3. **Which exported symbols hold it.** A hit is attributed to the top-level
 *    declaration containing it, then to the exports that can see that
 *    declaration (exports-dataflow.mjs). The route is `file#a,b`, so the walk
 *    starts from those symbols — not from every export of a repository module
 *    that happens to hold one query against the table.
 * 4. **Who reads the migration FILES.** A test that opens one migration by name
 *    runs when that migration changes; one that lists the whole folder runs
 *    when any does. The modules that only REPLAY migrations to build a database
 *    (the template, the provisioner) are carriers, named in the config: the
 *    database they build differs exactly where step 1 says, and no further.
 *
 * ## What it refuses
 *
 * A migration that declares no domains is left UNROUTED, which makes it an
 * unclassified path and stops the plan in red — the same verdict the
 * migration-domains gate gives it, so the two cannot disagree. For dynamic SQL
 * the parse cannot see into, the declared domains stand in for it: every
 * table of a declared domain the parse saw nothing of is treated as `"*"`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { changedBlocks, changedFields, schemaBlocks, schemaModels, delegateOf } from "../../migration-domains/lib/prisma-schema.mjs";
import { loadRegistry } from "../../migration-domains/lib/registry.mjs";
import { migrationEffects, readDeclaration, stripSql, walkMigrations } from "../../migration-domains/lib/sql.mjs";
import { declarationsOf, reachableExports } from "./exports-dataflow.mjs";
import { stripComments } from "./modules.mjs";

/** Every Prisma delegate operation — a property access followed by one of these is a query. */
const OPS = [
  "findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow",
  "create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn",
  "upsert", "delete", "deleteMany", "count", "aggregate", "groupBy",
].join("|");

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const camel = (snake) => snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const IMPORT_LINE = /^\s*(?:import\b|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\b).*$/gm;

/** How many times `re` matches `text` (global copy, so callers' lastIndex is untouched). */
const count = (re, text) => (text.match(new RegExp(re.source, `${re.flags.replace("g", "")}g`)) ?? []).length;

/**
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {object} options.config        the `database` block of .affected-plan.json
 * @param {string} options.lane
 * @param {string[]} options.changed
 * @param {string[]} options.deleted
 * @param {(path:string)=>string|null} options.readBase
 * @param {string[]} options.trackedFiles every committed path (git ls-files)
 * @param {string[]} options.sourceFiles  the lane's graph files
 * @param {(f:string)=>boolean} options.isTest
 * @returns {{ handles: (path:string)=>boolean, routes: Map<string,{entries:string[], why:string}>, problems: Map<string,string> }}
 */
export function databaseRoutes(options) {
  const { repoRoot, config, lane, changed, deleted, readBase, trackedFiles, sourceFiles, isTest } = options;
  const migrationRe = new RegExp(config.migrations ?? String.raw`(^|/)prisma/migrations/[^/]+/migration\.sql$`);
  const schemaRe = config.schemaFiles ? new RegExp(config.schemaFiles) : null;
  const mode = config.lanes?.[lane] ?? "effects";
  const handles = (f) => mode !== "off" && (migrationRe.test(f) || Boolean(schemaRe?.test(f)));

  const routes = new Map();
  const problems = new Map();
  const all = [...changed, ...deleted];
  const dbPaths = all.filter(handles);
  if (dbPaths.length === 0) return { handles, routes, problems };

  const readHead = (file) => {
    try {
      return readFileSync(join(repoRoot, file), "utf8");
    } catch {
      return null;
    }
  };

  // ── the schema, both sides, so a model the diff REMOVED is still known ────
  const schemaFiles = trackedFiles.filter((f) => (schemaRe ? schemaRe.test(f) : false) && f.endsWith(".prisma"));
  const configuredSchema = new Set(
    trackedFiles.filter((f) => (config.schema ?? []).some((dir) => f === dir || f.startsWith(`${dir.replace(/\/$/, "")}/`)) && f.endsWith(".prisma")),
  );
  const headTexts = [...configuredSchema].map(readHead).filter(Boolean);
  const baseTexts = [...configuredSchema, ...deleted.filter((f) => f.endsWith(".prisma"))].map((f) =>
    all.includes(f) ? readBase(f) : readHead(f),
  ).filter(Boolean);
  const models = new Map([...schemaModels(baseTexts), ...schemaModels(headTexts)]);
  const tableModel = new Map([...models].map(([name, m]) => [m.table, name]));
  const fieldModels = new Map(); // field name -> how many models carry it
  for (const m of models.values()) for (const f of m.fields) fieldModels.set(f.name, (fieldModels.get(f.name) ?? 0) + 1);
  const relationsInto = (model) =>
    [...models.values()].flatMap((m) => m.relations.filter((r) => r.type === model).map((r) => r.field));

  const registry = config.registry ? loadRegistry(join(repoRoot, config.registry)) : null;

  // ── migrations walked in order once, so a DROP INDEX resolves ─────────────
  const migrationFiles = trackedFiles.filter((f) => migrationRe.test(f) && !f.includes("node_modules/"));
  const dirOf = (f) => f.split("/").at(-2);
  migrationFiles.sort((a, b) => dirOf(a).localeCompare(dirOf(b)) || a.localeCompare(b));
  const columnsOf = (table) => {
    const m = models.get(tableModel.get(table));
    return m ? new Set(m.fields.filter((f) => !f.relation).map((f) => f.column)) : null;
  };
  let walked = null;
  const headEffects = (file) => {
    walked ??= walkMigrations(
      migrationFiles.map((f) => ({ name: f, sql: readHead(f) ?? "" })),
      { columnsOf, tables: [...tableModel.keys(), ...(registry?.tableDomain.keys() ?? [])] },
    );
    return walked.get(file);
  };

  // ── readers of the migration FILES, by the configured marker ──────────────
  // `carriers` are globs: the modules and suites that REPLAY the folder to
  // build a database, or merely spell its path. Every other file matching the
  // marker reads migration TEXT and runs whenever any migration changes.
  const glob = (g) =>
    new RegExp(`^${g.split("**").map((p) => p.split("*").map(escape).join("[^/]*")).join(".*")}$`);
  const carrierRes = (config.carriers ?? []).map(glob);
  const isCarrier = (f) => carrierRes.some((re) => re.test(f));
  const markerRe = config.readerMarker ? new RegExp(config.readerMarker) : null;
  const namedRe = /\b\d{14}_[A-Za-z0-9_]+/g;
  const textCache = new Map();
  const textOf = (file) => {
    if (!textCache.has(file)) {
      const raw = readHead(file);
      textCache.set(file, raw == null ? null : stripComments(raw));
    }
    return textCache.get(file);
  };

  /** Files that open THIS migration by name, or the whole folder. */
  const migrationReaders = (file) => {
    const name = dirOf(file);
    const out = [];
    for (const f of sourceFiles) {
      const text = textOf(f);
      if (!text) continue;
      // Naming ONE migration is reading that one, carrier or not: a backfill
      // test that executes a specific file is about that file.
      const named = text.match(namedRe);
      if (named) {
        if (named.includes(name)) out.push(f);
        continue;
      }
      if (!isCarrier(f) && markerRe?.test(text)) out.push(f);
    }
    return out;
  };

  // ── scanning: which declarations of which files touch a target ────────────
  /**
   * @param {Map<string, "*" | Set<string>>} targets  model name → "*" or field names;
   *   a key `table:<name>` is a table no model maps (a dropped one)
   * @returns {string[]} entries, `file` or `file#a,b`
   */
  const scan = (targets) => {
    const specs = [];
    for (const [key, what] of targets) {
      const isTable = key.startsWith("table:");
      const model = isTable ? null : models.get(key);
      const table = isTable ? key.slice(6) : model?.table;
      const mention = [];
      if (model) {
        mention.push(String.raw`\.\s*${escape(delegateOf(key))}\s*\.\s*(?:${OPS})\s*\(`);
        for (const r of relationsInto(key)) mention.push(String.raw`\b${escape(r)}\s*:\s*(?:true\b|\{)`);
      }
      if (table) mention.push(String.raw`\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+"?${escape(table)}"?(?![\w])`);
      const mentionRe = new RegExp(mention.join("|"), "i");
      if (what === "*") {
        specs.push({ re: mentionRe, mentionRe: null });
        continue;
      }
      const typeRe = model ? new RegExp(String.raw`\b${escape(key)}\b`) : null;
      for (const field of what) {
        const specific = (fieldModels.get(field) ?? 0) < 2 && /[A-Z_]/.test(field);
        const names = [field];
        const column = model?.fields.find((f) => f.name === field)?.column;
        if (column && column !== field && column.includes("_")) names.push(column);
        const re = new RegExp(String.raw`\b(?:${names.map(escape).join("|")})\b`);
        // A shared or one-word field only counts beside the model itself.
        specs.push({ re, mentionRe: specific ? null : new RegExp(`${mentionRe.source}${typeRe ? `|${typeRe.source}` : ""}`, "i") });
      }
    }
    if (specs.length === 0) return [];

    const entries = [];
    for (const file of sourceFiles) {
      const text = textOf(file);
      if (!text) continue;
      const live = specs.filter((s) => s.re.test(text) && (!s.mentionRe || s.mentionRe.test(text)));
      if (live.length === 0) continue;
      if (isTest(file)) {
        entries.push(file);
        continue;
      }
      const decls = declarationsOf(text);
      if (decls === null) {
        entries.push(file);
        continue;
      }
      const hot = new Set();
      let inDecls = 0;
      let everywhere = 0;
      const outsideImports = text.replace(IMPORT_LINE, "");
      for (const s of live) {
        // A shared field name counts only in a declaration that ALSO touches
        // the model — `label(status)` beside `prisma.order.findMany` is not a
        // read of orders.status just because the two share a file.
        const owns = (text) => s.re.test(text) && (!s.mentionRe || s.mentionRe.test(text));
        for (const d of decls)
          if (owns(d.text)) {
            hot.add(d.name);
            inDecls += count(s.re, d.text);
          }
        everywhere += s.mentionRe ? 0 : count(s.re, outsideImports);
      }
      // A hit no declaration owns is module-level code — it can reach anything.
      if (everywhere > inDecls) {
        entries.push(file);
        continue;
      }
      const reach = reachableExports(text, hot);
      if (reach === "*") entries.push(file);
      else if (reach.size > 0) entries.push(`${file}#${[...reach].sort().join(",")}`);
    }
    return entries;
  };

  /** Merge table effects into model-keyed targets. */
  const addTableEffect = (targets, table, effect) => {
    const model = tableModel.get(table);
    const key = model ?? `table:${table}`;
    const current = targets.get(key);
    if (current === "*") return;
    if (effect === "*") return targets.set(key, "*");
    const fields = new Set(current ?? []);
    for (const column of effect) {
      const field = model ? models.get(model).fields.find((f) => f.column === column)?.name : null;
      fields.add(field ?? camel(column));
    }
    if (fields.size > 0) targets.set(key, fields);
  };

  const always = (config.always ?? []).filter((f) => isTest(f));
  let anyChange = false;

  for (const file of dbPaths) {
    const head = deleted.includes(file) ? null : readHead(file);
    const base = readBase(file);
    const entries = new Set();
    const why = [];

    if (migrationRe.test(file)) {
      const declaration = readDeclaration(head ?? base ?? "");
      if (declaration.domains === null || declaration.problems.length > 0) {
        problems.set(file, "declares no valid `-- @domains:` line — every migration must say what it affects");
        continue;
      }
      for (const f of migrationReaders(file)) entries.add(f);
      // Named outright: files that read the WHOLE folder even though they also
      // name a migration or two (a discovery test pinning known entries).
      for (const f of config.migrationReaders ?? []) entries.add(f);
      const squash = (sql) => stripSql(sql).replace(/\s+/g, " ").trim();
      const sqlChanged = head === null || base === null || squash(head) !== squash(base);
      if (!sqlChanged) why.push("comments only — the database it builds is unchanged");
      if (sqlChanged && mode === "effects") {
        anyChange = true;
        const targets = new Map();
        const seen = new Set();
        let blind = false;
        const sides = [];
        if (head !== null) sides.push(headEffects(file) ?? migrationEffects(head, { columnsOf }));
        if (base !== null) sides.push(migrationEffects(base, { columnsOf, tables: new Set(tableModel.keys()) }));
        for (const side of sides) {
          // Dynamic SQL, an index nobody created, or no table visible at all (a
          // function, an extension): the parse cannot say what it reaches.
          blind ||= side.dynamic || side.unresolved.length > 0 || side.touched.size === 0;
          for (const [table, effect] of side.effects) {
            seen.add(table);
            addTableEffect(targets, table, effect);
          }
        }
        // What the parse could not see, the declaration covers — table by
        // table. Seeing ONE table of a domain says nothing about the others:
        // `EXECUTE format('ALTER TABLE %I …', t)` over a loop is exactly how a
        // migration reaches many tables the parse never names.
        if (blind && registry)
          for (const d of declaration.domains)
            for (const t of registry.domains.get(d)?.tables ?? []) if (!seen.has(t)) addTableEffect(targets, t, "*");
        for (const e of scan(targets)) entries.add(e);
        why.push(
          [...targets].map(([k, v]) => `${models.get(k)?.table ?? k.replace(/^table:/, "")}:${v === "*" ? "*" : [...v].join("|")}`).join(" ") ||
            "no observable effect",
        );
      }
    } else {
      // A schema file: which models, and which of their fields, moved.
      anyChange = true;
      // Modules that read schema FILES (a partial-sync step) see any edit.
      for (const e of config.schemaReaders ?? []) entries.add(e);
      const { models: changedModels, enums, global } = changedBlocks(base, head);
      if (global.length > 0) {
        for (const e of config.global ?? []) entries.add(e);
        why.push(`${global.join(", ")} changed — the whole client`);
        if (!(config.global ?? []).length) {
          problems.set(file, `changes ${global.join(", ")} and the database config names no \`global\` entry for that`);
          continue;
        }
      }
      if (mode === "effects" || mode === "text") {
        const targets = new Map();
        const blocks = (text) => new Map((text ? schemaBlocks(text) : []).map((b) => [`${b.kind}:${b.name}`, b.body]));
        const before = blocks(base);
        const after = blocks(head);
        for (const model of changedModels) {
          const fields = changedFields(before.get(`model:${model}`), after.get(`model:${model}`));
          if (fields === "*" || fields.size > 0) targets.set(model, fields);
        }
        for (const e of scan(targets)) entries.add(e);
        if (enums.size > 0) {
          const re = new RegExp(String.raw`\b(?:${[...enums].map(escape).join("|")})\b`);
          for (const f of sourceFiles) if (textOf(f) && re.test(textOf(f))) entries.add(f);
        }
        why.push([...targets].map(([k, v]) => `${k}:${v === "*" ? "*" : [...v].join("|")}`).join(" ") || "no model changed");
      }
    }
    routes.set(file, { entries: [...entries], why: why.join("; ") });
  }

  // The migrations applied at all: a lane that selected nothing else still
  // proves the new SQL runs, through the tests the config says always do.
  if (anyChange && always.length > 0)
    for (const [, route] of routes) {
      for (const t of always) if (!route.entries.includes(t)) route.entries.push(t);
      break;
    }

  return { handles, routes, problems };
}
