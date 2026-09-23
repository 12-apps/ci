/**
 * The gate, end to end, over throwaway repos.
 *
 * Every refusal it can issue is exercised here, because a gate only ever seen
 * passing is a gate nobody has tested: the whole point of it is the red run
 * that stops a pipeline before a single test lane is scheduled.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CHECK = join(dirname(fileURLToPath(import.meta.url)), "..", "check.mjs");

const REGISTRY = {
  domains: {
    orders: { description: "orders", tables: ["orders", "order_items"] },
    tenancy: { description: "the store", tables: ["clients"] },
  },
};

const SCHEMA = `
model Client {
  id String @id
  @@map("clients")
}
model Order {
  id String @id
  @@map("orders")
}
model OrderItem {
  id String @id
  @@map("order_items")
}
`;

/** A repo with the given migrations (name → SQL), not a git checkout. */
function repo(migrations, { registry = REGISTRY, schema = SCHEMA } = {}) {
  const root = mkdtempSync(join(tmpdir(), "migration-domains-"));
  writeFileSync(join(root, "domains.json"), JSON.stringify(registry));
  mkdirSync(join(root, "schema"));
  writeFileSync(join(root, "schema", "schema.prisma"), schema);
  for (const [name, sql] of Object.entries(migrations)) {
    const dir = join(root, "prisma", "migrations", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "migration.sql"), sql);
  }
  return root;
}

const run = (root, ...extra) =>
  spawnSync(process.execPath, [CHECK, "--root", root, "--registry", "domains.json", "--schema", "schema", ...extra], {
    encoding: "utf8",
  });

const BASE = {
  "20260101000000_init": `-- @domains: orders, tenancy
CREATE TABLE "clients" ("id" TEXT NOT NULL);
CREATE TABLE "orders" ("id" TEXT NOT NULL, "client_id" TEXT NOT NULL REFERENCES "clients"("id"));
CREATE TABLE "order_items" ("id" TEXT NOT NULL);`,
};

test("a tree where every migration declares truthfully passes", () => {
  const r = run(repo(BASE));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /every migration declares what it affects/);
});

test("a migration with no declaration fails, naming the file and what it should say", () => {
  const r = run(repo({ ...BASE, "20260102000000_tip": `ALTER TABLE "orders" ADD COLUMN "tip" INT;` }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error file=prisma\/migrations\/20260102000000_tip\/migration\.sql,line=1::declares no domains/);
  assert.match(r.stdout, /-- @domains: orders/);
});

test("an OLD migration is held to the rule too — the whole history, not the diff", () => {
  const r = run(repo({ ...BASE, "20250101000000_ancient": `CREATE TABLE "orders_archive" ("id" TEXT);` }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /20250101000000_ancient/);
});

test("under-declaring fails: every table the SQL changes needs its domain", () => {
  const r = run(repo({ ...BASE, "20260102000000_x": `-- @domains: orders\nUPDATE "clients" SET "name" = 'x';` }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /changes "clients" \(domain "tenancy"\) but does not declare "tenancy"/);
});

test("over-declaring fails: a domain the SQL visibly does not change is not declared", () => {
  const r = run(repo({ ...BASE, "20260102000000_x": `-- @domains: orders, tenancy\nALTER TABLE "orders" ADD COLUMN "tip" INT;` }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /declares "tenancy" but its SQL changes no table in it/);
});

test("…unless the SQL is dynamic, where the parse is blind and the declaration stands", () => {
  const sql = `-- @domains: orders, tenancy
ALTER TABLE "orders" ADD COLUMN "tip" INT;
DO $$ BEGIN EXECUTE format('ALTER TABLE %I ADD COLUMN y INT', 'clients'); END $$;`;
  const r = run(repo({ ...BASE, "20260102000000_x": sql }));
  assert.equal(r.status, 0, r.stdout);
});

test("reading a table is not changing it — REFERENCES and FROM need no declaration", () => {
  const sql = `-- @domains: orders
ALTER TABLE "order_items" ADD COLUMN "order_id" TEXT REFERENCES "orders"("id");
UPDATE "order_items" i SET "order_id" = o."id" FROM "clients" c, "orders" o WHERE c."id" = o."client_id";`;
  const r = run(repo({ ...BASE, "20260102000000_x": sql }));
  assert.equal(r.status, 0, r.stdout);
});

test("an unknown domain fails", () => {
  const r = run(repo({ ...BASE, "20260102000000_x": `-- @domains: payments\nALTER TABLE "orders" ADD COLUMN "tip" INT;` }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /declares "payments", which is not a domain/);
});

test("a table in no domain fails at the migration that touches it", () => {
  const r = run(repo({ ...BASE, "20260102000000_x": `-- @domains: orders\nCREATE TABLE "refunds" ("id" TEXT);` }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /changes table "refunds", which belongs to no domain/);
});

test("the registry is checked too: one owner per table, and nothing stale", () => {
  const twice = { domains: { ...REGISTRY.domains, extra: { description: "", tables: ["orders"] } } };
  assert.match(run(repo(BASE, { registry: twice })).stdout, /belongs to both "orders" and "extra"/);

  const stale = { domains: { ...REGISTRY.domains, ghosts: { description: "", tables: ["never_created"] } } };
  assert.match(run(repo(BASE, { registry: stale })).stdout, /"never_created" \(domain "ghosts"\) is created by no migration/);
});

test("a table the schema maps must have a domain even before a migration names it", () => {
  const schema = `${SCHEMA}\nmodel Refund {\n  id String @id\n  @@map("refunds")\n}\n`;
  const r = run(repo(BASE, { schema }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /table "refunds" is mapped by the schema but belongs to no domain/);
});

test("no migrations at all is a failure, not a vacuous pass", () => {
  const r = run(repo({}));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /the gate would pass having checked nothing/);
});

test("--write adopts the rule: it adds the computed line and never rewrites one that exists", () => {
  const root = repo({ ...BASE, "20260102000000_tip": `ALTER TABLE "orders" ADD COLUMN "tip" INT;` });
  const r = run(root, "--write");
  assert.equal(r.status, 0, r.stdout);
  const file = join(root, "prisma/migrations/20260102000000_tip/migration.sql");
  assert.match(readFileSync(file, "utf8"), /^-- @domains: orders\nALTER TABLE/);
  assert.equal(readFileSync(join(root, "prisma/migrations/20260101000000_init/migration.sql"), "utf8"), BASE["20260101000000_init"]);
});

test("--write refuses to guess for SQL it cannot fully read", () => {
  const sql = `DO $$ BEGIN EXECUTE format('ALTER TABLE %I ADD COLUMN y INT', 'orders'); END $$;\nALTER TABLE "orders" ADD COLUMN z INT;`;
  const r = run(repo({ ...BASE, "20260102000000_dyn": sql }), "--write");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /20260102000000_dyn.*declares no domains/);
});

test("--migrations is a glob: regex syntax in it is literal, never compiled", () => {
  const root = repo(BASE);
  // As a regex this would be a syntax error; as a glob it names no file.
  const r = run(root, "--migrations", "prisma/migrations/(*/migration.sql");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /the gate would pass having checked nothing/);
  // And the default glob reaches a migration at any depth.
  assert.equal(run(root, "--migrations", "**/prisma/migrations/*/migration.sql").status, 0);
});
