/**
 * Just enough of a Prisma schema to answer two questions: which TABLE each
 * model lives in, and which models CHANGED between two versions of a file.
 *
 * Not a Prisma parser. It brackets top-level blocks (`model`, `enum`, `view`,
 * `type`, `generator`, `datasource`) by brace depth and reads three attributes
 * out of a model: `@@map`, each field's type, and whether a field is a relation.
 * That is the whole surface the selector and the gate need, and every block it
 * cannot bracket is reported rather than guessed at.
 */

const BLOCK = /^[ \t]*(model|enum|view|type|generator|datasource)[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\{/gm;

/** Remove `//` comments (Prisma has no block comments outside `///` docs). */
const stripComments = (text) => text.replace(/\/\/.*$/gm, "");

/**
 * Every top-level block in one schema file.
 *
 * @param {string} text
 * @returns {{ kind: string, name: string, body: string }[]}
 */
export function schemaBlocks(text) {
  const clean = stripComments(text);
  const blocks = [];
  for (const m of clean.matchAll(BLOCK)) {
    let depth = 0;
    let end = -1;
    for (let i = m.index + m[0].length - 1; i < clean.length; i += 1) {
      if (clean[i] === "{") depth += 1;
      else if (clean[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    blocks.push({ kind: m[1], name: m[2], body: clean.slice(m.index + m[0].length, end) });
  }
  return blocks;
}

const SCALARS = new Set(["String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes", "Unsupported"]);

/**
 * Models across a set of schema files: name, table, fields, relation fields.
 *
 * @param {string[]} texts  every `.prisma` file of one schema
 * @returns {Map<string, {
 *   table: string,
 *   fields: { name: string, column: string, type: string, relation: boolean }[],
 *   relations: { field: string, type: string }[],
 * }>}
 */
export function schemaModels(texts) {
  const blocks = texts.flatMap(schemaBlocks);
  const modelNames = new Set(blocks.filter((b) => b.kind === "model").map((b) => b.name));
  const models = new Map();
  for (const block of blocks) {
    if (block.kind !== "model") continue;
    const map = /@@map\(\s*(?:name\s*:\s*)?"([^"]+)"\s*\)/.exec(block.body);
    const fields = [];
    const relations = [];
    for (const line of block.body.split("\n")) {
      const field = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?\??/.exec(line);
      if (!field) continue;
      const relation = modelNames.has(field[2]);
      const column = /@map\(\s*(?:name\s*:\s*)?"([^"]+)"\s*\)/.exec(line)?.[1] ?? field[1];
      fields.push({ name: field[1], column, type: field[2], relation });
      if (relation) relations.push({ field: field[1], type: field[2] });
    }
    models.set(block.name, { table: map ? map[1] : block.name, fields, relations });
  }
  return models;
}

/**
 * What changed INSIDE one model between two versions of its block.
 *
 * @returns {"*" | Set<string>}  the changed field names, or `"*"` when a
 *   block-level attribute that reshapes the whole table moved (`@@map`, `@@id`,
 *   `@@schema`) or the model was added or removed.
 */
export function changedFields(baseBody, headBody) {
  if (baseBody == null || headBody == null) return "*";
  const lines = (body) =>
    new Map(
      body
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .map((l) => [l.startsWith("@@") ? l : l.split(" ")[0], l]),
    );
  const before = lines(baseBody);
  const after = lines(headBody);
  const out = new Set();
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) === after.get(key)) continue;
    if (!key.startsWith("@@")) {
      out.add(key);
      continue;
    }
    // `@@unique([a, b])` / `@@index([a, b])` constrain exactly those fields;
    // anything else at block level reshapes the table.
    const listed = /^@@(?:unique|index)\(\s*(?:fields\s*:\s*)?\[([^\]]*)\]/.exec(key);
    if (!listed) return "*";
    for (const f of listed[1].split(",")) out.add(f.replace(/\(.*$/, "").trim());
  }
  return out;
}

/** Whitespace-insensitive identity of a block's body. */
const normalized = (body) => body.replace(/\s+/g, " ").trim();

/**
 * Which blocks differ between two versions of one schema file.
 *
 * @param {string|null} base  the file at the merge base (null = added)
 * @param {string|null} head  the file at HEAD (null = deleted)
 * @returns {{ models: Set<string>, enums: Set<string>, global: string[] }}
 *   `global` names changed `generator` / `datasource` blocks — a change to one
 *   of those alters the whole client, and no per-model answer is honest.
 */
export function changedBlocks(base, head) {
  const index = (text) => new Map((text ? schemaBlocks(text) : []).map((b) => [`${b.kind}:${b.name}`, b]));
  const before = index(base);
  const after = index(head);
  const models = new Set();
  const enums = new Set();
  const global = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(key);
    const b = after.get(key);
    if (a && b && normalized(a.body) === normalized(b.body)) continue;
    const { kind, name } = a ?? b;
    if (kind === "model" || kind === "view") models.add(name);
    else if (kind === "enum" || kind === "type") enums.add(name);
    else global.push(`${kind} ${name}`);
  }
  return { models, enums, global };
}

/** Prisma's client property for a model: `MenuItem` → `menuItem`. */
export const delegateOf = (model) => model.charAt(0).toLowerCase() + model.slice(1);
