/**
 * What a migration file DECLARES, and what its SQL actually DOES.
 *
 * The two answers exist to be compared. A migration names the domains it
 * affects in one comment line:
 *
 *     -- @domains: orders, payments
 *
 * and the gate proves that sentence against the statements underneath it: every
 * table the SQL changes must belong to a declared domain. A declaration nothing
 * checks is a comment, and a comment is exactly what the next person copies
 * from the migration above without reading it.
 *
 * The same parse feeds test SELECTION, at a finer grain than the declaration:
 * not "this migration is about `clients`" but "this migration rewrites
 * `clients.comanda_cancel_answer_roles`". On a multi-tenant schema that
 * difference is the whole game — nearly every test reads `clients`, and almost
 * none of them reads that column.
 *
 * ## What "changes" means
 *
 * A table is TOUCHED when a statement changes its shape (CREATE, ALTER, DROP,
 * an index, a trigger ON it, a COMMENT) or its rows (INSERT, UPDATE, DELETE,
 * TRUNCATE). A table a statement only READS is not: `REFERENCES clients(id)` on
 * a new tenant-scoped table, or `UPDATE orders … FROM clients`, would make every
 * migration in a multi-tenant schema declare the tenancy domain, and the
 * declaration would stop saying anything.
 *
 * Each touched table also carries an EFFECT — what code could observe:
 *
 *   `"*"`        the whole table: new or deleted rows, a new trigger, a column
 *                every INSERT must now supply, anything not parsed precisely
 *   `Set(cols)`  only these columns: values rewritten, a column added with a
 *                default, a constraint over them
 *   `Set()`      nothing observable: a COMMENT, a non-unique index
 *
 * Every uncertainty answers `"*"`. The failure this must never produce is a
 * narrow answer the SQL did not earn.
 *
 * Function bodies and `DO $$ … $$` blocks are parsed like top-level SQL. A
 * trigger function that bumps `clients.catalog_version` touches `clients`, and
 * the migration that installs it has to say so.
 *
 * ## What it cannot see
 *
 * Dynamic SQL — `EXECUTE format('ALTER TABLE %I …', t)` — has no table name to
 * read. The result says `dynamic: true`, and callers fall back on the
 * DECLARATION for it: the gate accepts a declared domain it cannot see touched,
 * and selection treats every table of such a domain as `"*"`.
 */

/** `-- @domains: a, b` — one line, anywhere in the file. */
const DECLARATION = /^[ \t]*--[ \t]*@domains[ \t]*:(.*)$/gm;

/** A domain id: lower-case, digits and dashes — the shape a registry key takes. */
export const DOMAIN_ID = /^[a-z][a-z0-9-]*$/;

/**
 * The domains a migration declares.
 *
 * @param {string} sql
 * @returns {{ domains: string[] | null, line: number, problems: string[] }}
 *   `domains` is null when the file declares nothing. `line` is 1-based, 0 when
 *   absent. `problems` names every way the declaration itself is malformed.
 */
export function readDeclaration(sql) {
  const found = [...sql.matchAll(DECLARATION)];
  if (found.length === 0) return { domains: null, line: 0, problems: [] };
  const problems = [];
  if (found.length > 1) problems.push(`declares @domains ${found.length} times — one line, listing every domain`);
  const first = found[0];
  const line = sql.slice(0, first.index).split("\n").length;
  const domains = first[1]
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  if (domains.length === 0) problems.push("@domains is empty — name at least one domain");
  for (const d of domains) if (!DOMAIN_ID.test(d)) problems.push(`"${d}" is not a domain id (lower-case, digits, dashes)`);
  const seen = new Set();
  for (const d of domains) {
    if (seen.has(d)) problems.push(`"${d}" is declared twice`);
    seen.add(d);
  }
  return { domains, line, problems };
}

/** The declaration line as a migration should carry it. */
export function formatDeclaration(domains) {
  return `-- @domains: ${[...domains].join(", ")}`;
}

/** The file with its declaration line removed — what a plugin's copy is compared by. */
export function withoutDeclaration(sql) {
  return sql.replace(/^[ \t]*--[ \t]*@domains[ \t]*:.*(?:\r?\n|$)/gm, "");
}

/**
 * The SQL with comments removed and single-quoted literals emptied.
 *
 * Dollar-quoted bodies are KEPT (tags dropped): they are function bodies and
 * `DO` blocks, and the statements inside them change tables like any other. A
 * literal is emptied because its words are data — `CHECK (kind IN ('UPDATE',
 * 'DELETE'))` names no table.
 *
 * Double-quoted identifiers are kept verbatim, which is where table names live.
 */
export function stripSql(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      out += " ";
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") break;
        j += 1;
      }
      out += "''";
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      const stop = end === -1 ? n : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const stop = close === -1 ? n : close;
        // `;` closes the statement that OPENED the body, so the body's own
        // statements are separated from it and from each other.
        out += ` ; ${stripSql(sql.slice(i + tag[0].length, stop))} ; `;
        i = close === -1 ? n : close + tag[0].length;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

const NAME = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const IDENT = String.raw`(?:${NAME}\s*\.\s*)?${NAME}`;

/** `"Public"."orders"` / `public.orders` / `orders` → `orders`. */
export function normalizeIdent(raw) {
  const parts = raw.trim().match(/"[^"]+"|[^.\s"]+/g) ?? [raw];
  const last = parts[parts.length - 1];
  return last.startsWith('"') ? last.slice(1, -1) : last.toLowerCase();
}

/** Split on commas that sit at parenthesis depth zero. */
function topLevel(text, separator = ",") {
  const out = [];
  let depth = 0;
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    if (quoted) continue;
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === separator && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The text inside the first balanced `( … )` at or after `from`. */
function parenthesized(text, from = 0) {
  const open = text.indexOf("(", from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Every identifier-shaped word in an expression, normalized. */
const identifiersIn = (text) => new Set((text.match(/"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*/g) ?? []).map(normalizeIdent));

/**
 * The columns of `table` an expression mentions — `"*"` when the table's
 * columns are unknown or the expression names none of them, since a narrow
 * answer there would be a guess.
 */
function columnsIn(expression, table, columnsOf) {
  const known = columnsOf(table);
  if (!known) return "*";
  const hit = [...identifiersIn(expression)].filter((id) => known.has(id));
  return hit.length > 0 ? new Set(hit) : "*";
}

/** Split into statements, `;` at depth zero, after {@link stripSql}. */
export function statementsOf(text) {
  return topLevel(text, ";");
}

const RX = (source) => new RegExp(source, "i");
const CREATE_TABLE = RX(String.raw`\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})`);
const ALTER_TABLE = RX(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${IDENT})\s*`);
const DROP_TABLE = RX(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${IDENT}(?:\s*,\s*${IDENT})*)`);
const TRUNCATE = RX(String.raw`\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?(${IDENT}(?:\s*,\s*${IDENT})*)`);
const COMMENT = RX(String.raw`\bCOMMENT\s+ON\s+(TABLE|COLUMN)\s+(${IDENT})`);
const CREATE_INDEX = RX(String.raw`\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:(${NAME})\s+)?ON\s+(?:ONLY\s+)?(${IDENT})`);
const DROP_INDEX = RX(String.raw`\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(${IDENT}(?:\s*,\s*${IDENT})*)`);
const ALTER_INDEX = RX(String.raw`\bALTER\s+INDEX\s+(?:IF\s+EXISTS\s+)?(${IDENT})\s+RENAME\s+TO\s+(${NAME})`);
const CREATE_TRIGGER = RX(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+${NAME}\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\s+([\s\S]*?)\bON\s+(${IDENT})`);
const DROP_TRIGGER = RX(String.raw`\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?${NAME}\s+ON\s+(${IDENT})`);
const INSERT = RX(String.raw`\bINSERT\s+INTO\s+(${IDENT})`);
const DELETE = RX(String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?(${IDENT})`);
// `UPDATE t SET` — never `ON UPDATE CASCADE`, `FOR UPDATE`, a trigger's
// `AFTER INSERT OR UPDATE ON t`, `UPDATE OF col`, or an upsert's `DO UPDATE SET`.
const UPDATE = RX(String.raw`(?<!\b(?:ON|FOR|OR|BEFORE|AFTER|DO|OF|KEY|SHARE)\s+)\bUPDATE\s+(?:ONLY\s+)?(${IDENT})(?:\s+(?:AS\s+)?(?!SET\b)${NAME})?\s+SET\b`);
const DYNAMIC = /\bEXECUTE\s+(?!PROCEDURE\b|FUNCTION\b)/i;

/**
 * Parse one migration.
 *
 * @param {string} sql  the migration file
 * @param {object} [state]  carried across migrations walked IN ORDER, so a later
 *   `DROP INDEX x` / `DROP CONSTRAINT y` resolves to what an earlier one created
 * @param {Map<string,{table:string,columns:Set<string>|"*",unique:boolean}>} [state.indexes]
 * @param {Map<string,{table:string,columns:Set<string>|"*"}>} [state.constraints]
 * @param {(table:string)=>Set<string>|null} [state.columnsOf]  a table's known
 *   columns, for attributing a CHECK expression; null → unknown
 * @param {Map<string,Set<string>>} [state.columns]  columns the migrations so far
 *   created, per table — filled in as this one adds, renames and creates
 * @param {Set<string>} [state.tables]  every known table, to attribute an index
 *   nothing recorded by its `<table>_…` name — Postgres's own naming
 * @returns {{
 *   effects: Map<string, "*" | Set<string>>,
 *   touched: Set<string>,
 *   dynamic: boolean,
 *   unresolved: string[],
 * }}
 */
export function migrationEffects(sql, state = {}) {
  const indexes = state.indexes ?? new Map();
  const constraints = state.constraints ?? new Map();
  const tables = state.tables ?? new Set();
  // Columns as the migrations THEMSELVES built them, so a CHECK over a table
  // the schema has since retired can still be attributed column by column.
  const history = state.columns ?? new Map();
  const given = state.columnsOf ?? (() => null);
  const columnsOf = (table) => {
    const known = new Set([...(history.get(table) ?? []), ...(given(table) ?? [])]);
    return known.size > 0 ? known : null;
  };
  const text = stripSql(sql);
  const effects = new Map();
  const unresolved = [];

  /** Merge an effect into the running answer — `"*"` absorbs everything. */
  const mark = (table, effect) => {
    const current = effects.get(table);
    if (current === "*") return;
    if (effect === "*") return effects.set(table, "*");
    const merged = new Set(current ?? []);
    for (const c of effect) merged.add(c);
    effects.set(table, merged);
  };

  /** An index or constraint nothing recorded: `<table>_<cols>_idx` → `<table>`. */
  const byPrefix = (name) => {
    let best = null;
    for (const t of tables) if (name.startsWith(`${t}_`) && (!best || t.length > best.length)) best = t;
    return best;
  };

  for (const statement of statementsOf(text)) {
    let m;
    if ((m = CREATE_TABLE.exec(statement))) {
      const table = normalizeIdent(m[1]);
      mark(table, "*");
      tables.add(table);
      rememberTableConstraints(statement, table, indexes, constraints, history);
      continue;
    }
    if ((m = CREATE_INDEX.exec(statement))) {
      const unique = Boolean(m[1]);
      const table = normalizeIdent(m[3]);
      const tail = statement.slice(m.index + m[0].length);
      const list = parenthesized(tail);
      const where = /\bWHERE\b([\s\S]*)$/i.exec(tail);
      // A plain column list names its columns outright; an expression (or a
      // partial index's WHERE) is attributed through the table's known columns.
      const plain = list && topLevel(list.inner).every((item) => new RegExp(String.raw`^${NAME}(?:\s+(?:ASC|DESC|NULLS\s+(?:FIRST|LAST)))*$`, "i").test(item));
      const columns = !list
        ? "*"
        : plain && !where
          ? new Set(topLevel(list.inner).map((item) => normalizeIdent(item.split(/\s+/)[0])))
          : columnsIn(`${list.inner} ${where?.[1] ?? ""}`, table, columnsOf);
      if (m[2]) indexes.set(normalizeIdent(m[2]), { table, columns, unique });
      // A non-unique index changes what a read COSTS, never what it returns.
      mark(table, unique ? columns : new Set());
      continue;
    }
    if ((m = DROP_INDEX.exec(statement))) {
      for (const raw of topLevel(m[1])) {
        const name = normalizeIdent(raw);
        const known = indexes.get(name) ?? constraints.get(name);
        if (known) mark(known.table, known.unique === false ? new Set() : known.columns);
        else {
          const table = byPrefix(name);
          if (table) mark(table, "*");
          else unresolved.push(name);
        }
        indexes.delete(name);
      }
      continue;
    }
    if ((m = ALTER_INDEX.exec(statement))) {
      const from = normalizeIdent(m[1]);
      const known = indexes.get(from);
      const table = known?.table ?? byPrefix(from);
      if (table) mark(table, new Set());
      else unresolved.push(from);
      if (known) {
        indexes.delete(from);
        indexes.set(normalizeIdent(m[2]), known);
      }
      continue;
    }
    if ((m = CREATE_TRIGGER.exec(statement))) {
      // `AFTER UPDATE OF a, b ON t` fires only when code writes a or b; any
      // INSERT or DELETE event, or a bare UPDATE, fires on every write.
      const only = /^UPDATE\s+OF\s+([\s\S]+?)\s*$/i.exec(m[1].trim());
      mark(normalizeIdent(m[2]), only ? new Set(topLevel(only[1]).map(normalizeIdent)) : "*");
      continue;
    }
    if ((m = DROP_TRIGGER.exec(statement))) {
      mark(normalizeIdent(m[1]), "*");
      continue;
    }
    if ((m = DROP_TABLE.exec(statement))) {
      for (const raw of topLevel(m[1])) mark(normalizeIdent(raw), "*");
      continue;
    }
    if ((m = TRUNCATE.exec(statement))) {
      for (const raw of topLevel(m[1])) mark(normalizeIdent(raw), "*");
      continue;
    }
    if ((m = COMMENT.exec(statement))) {
      const target = normalizeIdent(m[1].toUpperCase() === "COLUMN" ? m[2].replace(/\s*\.\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)$/, "") : m[2]);
      mark(target, new Set());
      continue;
    }
    if ((m = ALTER_TABLE.exec(statement))) {
      const table = normalizeIdent(m[1]);
      const actions = topLevel(statement.slice(m.index + m[0].length));
      for (const action of actions) alterAction(action, table, { mark, indexes, constraints, columnsOf, tables, history });
      continue;
    }
    // Row writes can appear inside a larger statement (a CTE, a function body),
    // so every occurrence is searched rather than one anchored at the start.
    for (const re of [INSERT, DELETE])
      for (const hit of statement.matchAll(new RegExp(re.source, "gi"))) mark(normalizeIdent(hit[1]), "*");
    for (const update of statement.matchAll(new RegExp(UPDATE.source, "gi"))) {
      const table = normalizeIdent(update[1]);
      const set = statement.slice(update.index + update[0].length);
      const clause = set.split(/\b(?:FROM|WHERE|RETURNING)\b/i)[0];
      const targets = new Set();
      let precise = true;
      for (const item of topLevel(clause)) {
        const single = new RegExp(String.raw`^(${NAME})\s*=`, "i").exec(item);
        const multi = /^\(([^)]*)\)\s*=/.exec(item);
        if (single) targets.add(normalizeIdent(single[1]));
        else if (multi) for (const c of topLevel(multi[1])) targets.add(normalizeIdent(c));
        else precise = false;
      }
      mark(table, precise && targets.size > 0 ? targets : "*");
    }
  }

  return { effects, touched: new Set(effects.keys()), dynamic: DYNAMIC.test(text), unresolved };
}

/** One `ALTER TABLE t <action>` clause. */
function alterAction(action, table, { mark, indexes, constraints, columnsOf, tables, history }) {
  const columns = () => {
    if (!history.has(table)) history.set(table, new Set());
    return history.get(table);
  };
  const column = new RegExp(String.raw`^(?:COLUMN\s+)?(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(${NAME})`, "i");
  let m;
  if ((m = /^ADD\s+(?:CONSTRAINT\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s+)?(CHECK|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|EXCLUDE)\b/i.exec(action))) {
    const kind = m[2].toUpperCase().replace(/\s+/g, " ");
    const body = parenthesized(action, m.index + m[0].length);
    let columns = "*";
    if (body) {
      if (kind === "CHECK" || kind === "EXCLUDE") columns = columnsIn(body.inner, table, columnsOf);
      else columns = new Set(topLevel(body.inner).map(normalizeIdent));
    }
    // A new primary key rewrites what every INSERT must satisfy.
    if (kind === "PRIMARY KEY") columns = "*";
    if (m[1]) {
      const name = normalizeIdent(m[1]);
      constraints.set(name, { table, columns, unique: kind !== "CHECK" && kind !== "FOREIGN KEY" ? true : undefined });
      if (kind === "UNIQUE" || kind === "PRIMARY KEY" || kind === "EXCLUDE") indexes.set(name, { table, columns, unique: true });
    }
    mark(table, columns);
    return;
  }
  if ((m = /^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/i.exec(action))) {
    const name = normalizeIdent(m[1]);
    const known = constraints.get(name) ?? indexes.get(name);
    mark(table, known && known.table === table ? known.columns : impliedColumns(name, table, columnsOf));
    constraints.delete(name);
    indexes.delete(name);
    return;
  }
  if ((m = /^VALIDATE\s+CONSTRAINT\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/i.exec(action))) {
    const known = constraints.get(normalizeIdent(m[1]));
    mark(table, known && known.table === table ? known.columns : "*");
    return;
  }
  if ((m = /^RENAME\s+CONSTRAINT\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s+TO\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/i.exec(action))) {
    const from = normalizeIdent(m[1]);
    const to = normalizeIdent(m[2]);
    for (const map of [constraints, indexes])
      if (map.has(from)) {
        map.set(to, map.get(from));
        map.delete(from);
      }
    mark(table, new Set());
    return;
  }
  if ((m = /^RENAME\s+TO\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/i.exec(action))) {
    const to = normalizeIdent(m[1]);
    mark(table, "*");
    mark(to, "*");
    tables.add(to);
    history.set(to, history.get(table) ?? new Set());
    for (const map of [constraints, indexes]) for (const entry of map.values()) if (entry.table === table) entry.table = to;
    return;
  }
  if ((m = new RegExp(String.raw`^RENAME\s+(?:COLUMN\s+)?(${NAME})\s+TO\s+(${NAME})`, "i").exec(action))) {
    mark(table, new Set([normalizeIdent(m[1]), normalizeIdent(m[2])]));
    columns().delete(normalizeIdent(m[1]));
    columns().add(normalizeIdent(m[2]));
    return;
  }
  if (/^ADD\b/i.test(action)) {
    const rest = action.replace(/^ADD\s+/i, "");
    const col = column.exec(rest);
    if (!col) return mark(table, "*");
    const name = normalizeIdent(col[1]);
    columns().add(name);
    const definition = rest.slice(col[0].length);
    // A NOT NULL column with nothing to fill it breaks every INSERT that does
    // not name it — which is every INSERT written before it existed.
    const breaksInserts = /\bNOT\s+NULL\b/i.test(definition) && !/\bDEFAULT\b|\bGENERATED\b/i.test(definition);
    if (/\bPRIMARY\s+KEY\b/i.test(definition)) return mark(table, "*");
    mark(table, breaksInserts ? "*" : new Set([name]));
    const unique = /\bUNIQUE\b/i.test(definition);
    if (unique) indexes.set(`${table}_${name}_key`, { table, columns: new Set([name]), unique: true });
    return;
  }
  if (/^DROP\b/i.test(action)) {
    const col = column.exec(action.replace(/^DROP\s+/i, ""));
    return mark(table, col ? new Set([normalizeIdent(col[1])]) : "*");
  }
  if (/^ALTER\b/i.test(action)) {
    const rest = action.replace(/^ALTER\s+/i, "");
    const col = column.exec(rest);
    if (!col) return mark(table, "*");
    const change = rest.slice(col[0].length);
    // Requiring a value, or taking away the one supplied for you, changes every
    // INSERT that omits the column — not just the code that names it.
    if (/\bSET\s+NOT\s+NULL\b|\bDROP\s+DEFAULT\b|\bADD\s+GENERATED\b/i.test(change)) return mark(table, "*");
    if (/\bSET\s+STATISTICS\b|\bSET\s+STORAGE\b|\bSET\s+COMPRESSION\b/i.test(change)) return mark(table, new Set());
    return mark(table, new Set([normalizeIdent(col[1])]));
  }
  if (/^(?:OWNER\s+TO|SET\s*\(|RESET\s*\(|SET\s+(?:TABLESPACE|LOGGED|UNLOGGED|WITHOUT))/i.test(action)) return mark(table, new Set());
  mark(table, "*");
}

/**
 * A constraint nothing recorded by name — Postgres names an inline one
 * `<table>_<column>_check|key|fkey`, so the column can be read back out of it.
 * Anything else is `"*"`.
 */
function impliedColumns(name, table, columnsOf) {
  const m = new RegExp(`^${table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(.+)_(?:check|key|fkey|excl)$`).exec(name);
  const known = columnsOf(table);
  if (!m || !known) return "*";
  return known.has(m[1]) ? new Set([m[1]]) : "*";
}

/** Constraints declared inline in a CREATE TABLE, remembered by name. */
function rememberTableConstraints(statement, table, indexes, constraints, history) {
  indexes.set(`${table}_pkey`, { table, columns: "*", unique: true });
  const body = parenthesized(statement);
  if (!body) return;
  const columns = new Set(history.get(table) ?? []);
  for (const part of topLevel(body.inner)) {
    const def = /^("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s/.exec(part);
    if (def && !/^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE)$/i.test(def[1])) columns.add(normalizeIdent(def[1]));
  }
  history.set(table, columns);
  for (const part of topLevel(body.inner)) {
    const m = /^CONSTRAINT\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s+(CHECK|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|EXCLUDE)\b/i.exec(part);
    if (!m) continue;
    const name = normalizeIdent(m[1]);
    const kind = m[2].toUpperCase().replace(/\s+/g, " ");
    const inner = parenthesized(part, m.index + m[0].length);
    const columns = inner && kind !== "CHECK" && kind !== "EXCLUDE" ? new Set(topLevel(inner.inner).map(normalizeIdent)) : "*";
    constraints.set(name, { table, columns });
    if (kind === "UNIQUE" || kind === "PRIMARY KEY" || kind === "EXCLUDE") indexes.set(name, { table, columns, unique: true });
  }
}

/**
 * Walk migrations in order and parse each one against the state the earlier
 * ones left — the only way `DROP INDEX x` can be attributed to a table.
 *
 * @param {{ name: string, sql: string }[]} migrations  sorted by name
 * @param {{ columnsOf?: (table:string)=>Set<string>|null, tables?: Iterable<string> }} [options]
 * @returns {Map<string, ReturnType<typeof migrationEffects>>}
 */
export function walkMigrations(migrations, options = {}) {
  const state = {
    indexes: new Map(),
    constraints: new Map(),
    columns: new Map(),
    columnsOf: options.columnsOf ?? (() => null),
    tables: new Set(options.tables ?? []),
  };
  const out = new Map();
  for (const { name, sql } of migrations) out.set(name, migrationEffects(sql, state));
  return out;
}
