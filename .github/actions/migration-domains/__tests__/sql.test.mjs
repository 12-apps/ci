/**
 * The parse that both the gate and the selector trust.
 *
 * Two failure directions, and only one is loud. A table the parse MISSES lets a
 * migration under-declare and, worse, lets the selector skip the tests that
 * touch it — green over a change nothing ran. A table it INVENTS only costs a
 * declaration line or a few extra tests. So most cases here pin a table or a
 * column being SEEN, and the rest pin grammar that looks like a write and is
 * not (`ON UPDATE CASCADE`, a string literal), because those are what would
 * make the gate demand nonsense.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { formatDeclaration, migrationEffects, readDeclaration, stripSql, walkMigrations, withoutDeclaration } from "../lib/sql.mjs";

const effect = (sql, state) => {
  const out = {};
  for (const [t, e] of migrationEffects(sql, state).effects) out[t] = e === "*" ? "*" : [...e].sort();
  return out;
};

test("reads a declaration, wherever the line sits", () => {
  const d = readDeclaration("-- a comment\n-- @domains: orders, payments\nALTER TABLE x ADD COLUMN y INT;");
  assert.deepEqual(d.domains, ["orders", "payments"]);
  assert.equal(d.line, 2);
  assert.deepEqual(d.problems, []);
});

test("no declaration is null, not an empty list — the gate must tell them apart", () => {
  assert.equal(readDeclaration("ALTER TABLE x ADD COLUMN y INT;").domains, null);
});

test("a malformed declaration names what is wrong with it", () => {
  assert.match(readDeclaration("-- @domains:\n").problems.join(), /empty/);
  assert.match(readDeclaration("-- @domains: Orders\n").problems.join(), /not a domain id/);
  assert.match(readDeclaration("-- @domains: a, a\n").problems.join(), /twice/);
  assert.match(readDeclaration("-- @domains: a\n-- @domains: b\n").problems.join(), /2 times/);
});

test("formatDeclaration and withoutDeclaration round-trip a plugin copy", () => {
  const body = "-- original header\nCREATE TABLE t (id TEXT);\n";
  const copy = `${formatDeclaration(["orders"])}\n${body}`;
  assert.equal(withoutDeclaration(copy), body);
});

test("a string literal is data: its words never name a table", () => {
  assert.doesNotMatch(stripSql("CHECK (k IN ('UPDATE orders SET x', 'DELETE FROM users'))"), /orders|users/);
  assert.deepEqual(effect("ALTER TABLE t ADD CONSTRAINT c CHECK (k IN ('INSERT INTO payments'));"), { t: "*" });
});

test("a column added WITH a default is that column; without one and NOT NULL it is every INSERT", () => {
  assert.deepEqual(effect(`ALTER TABLE "orders" ADD COLUMN "tip" INTEGER NOT NULL DEFAULT 0;`), { orders: ["tip"] });
  assert.deepEqual(effect(`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "note" TEXT;`), { orders: ["note"] });
  assert.deepEqual(effect(`ALTER TABLE "orders" ADD COLUMN "must" TEXT NOT NULL;`), { orders: "*" });
});

test("several actions in one ALTER TABLE are each read", () => {
  assert.deepEqual(effect(`ALTER TABLE orders ADD COLUMN a TEXT, DROP COLUMN b, ALTER COLUMN c TYPE BIGINT;`), {
    orders: ["a", "b", "c"],
  });
});

test("requiring a value, or removing its default, reaches every INSERT", () => {
  assert.deepEqual(effect(`ALTER TABLE orders ALTER COLUMN "c" SET NOT NULL;`), { orders: "*" });
  assert.deepEqual(effect(`ALTER TABLE orders ALTER COLUMN "c" DROP DEFAULT;`), { orders: "*" });
});

test("a backfill is the columns it SETS, not the tables it reads", () => {
  const sql = `UPDATE "clients" AS c SET "roles" = (SELECT jsonb_agg(r."id") FROM "roles" AS r) WHERE c."roles" IS NULL;`;
  assert.deepEqual(effect(sql), { clients: ["roles"] });
});

test("ON UPDATE CASCADE, FOR UPDATE and an upsert's DO UPDATE are not writes to another table", () => {
  const sql = `
    ALTER TABLE items ADD CONSTRAINT items_order_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE;
    SELECT 1 FROM carts FOR UPDATE;
    INSERT INTO flags (k) VALUES ('') ON CONFLICT (k) DO UPDATE SET k = EXCLUDED.k;`;
  assert.deepEqual(effect(sql), { items: ["order_id"], flags: "*" });
});

test("INSERT, DELETE, TRUNCATE and DROP TABLE are the whole table", () => {
  assert.deepEqual(effect(`INSERT INTO roles (id) SELECT id FROM users; DELETE FROM carts WHERE x; TRUNCATE a, "b"; DROP TABLE IF EXISTS old;`), {
    roles: "*",
    carts: "*",
    a: "*",
    b: "*",
    old: "*",
  });
});

test("a comment and a plain index change nothing observable, but still TOUCH the table", () => {
  const r = migrationEffects(`COMMENT ON COLUMN "orders"."x" IS 'why'; CREATE INDEX "orders_x_idx" ON "orders"("x");`);
  assert.deepEqual([...r.touched], ["orders"]);
  assert.deepEqual([...r.effects.get("orders")], []);
});

test("a UNIQUE index constrains exactly its columns", () => {
  assert.deepEqual(effect(`CREATE UNIQUE INDEX "u" ON "orders"("client_id", "number") WHERE "archived_at" IS NULL;`, { columnsOf: () => new Set(["client_id", "number", "archived_at"]) }), {
    orders: ["archived_at", "client_id", "number"],
  });
});

test("a DROP INDEX resolves to the table an EARLIER migration created it on", () => {
  const out = walkMigrations([
    { name: "1", sql: `CREATE UNIQUE INDEX "orders_ref_key" ON "orders"("ref");` },
    { name: "2", sql: `DROP INDEX "orders_ref_key";` },
    { name: "3", sql: `DROP INDEX IF EXISTS "mystery_idx";` },
  ]);
  assert.deepEqual([...out.get("2").effects.get("orders")], ["ref"]);
  assert.deepEqual(out.get("3").unresolved, ["mystery_idx"]);
});

test("an index nothing recorded is attributed by Postgres's own naming", () => {
  const r = migrationEffects(`DROP INDEX IF EXISTS "realtime_outbox_events_published_at_idx";`, {
    tables: new Set(["realtime_outbox_events", "realtime"]),
  });
  assert.equal(r.effects.get("realtime_outbox_events"), "*");
  assert.deepEqual(r.unresolved, []);
});

test("a CHECK is attributed to the columns it names, known from earlier migrations", () => {
  const out = walkMigrations([
    { name: "1", sql: `CREATE TABLE "order_items" ("id" TEXT NOT NULL, "flow_status" TEXT);` },
    { name: "2", sql: `ALTER TABLE "order_items" ADD CONSTRAINT "order_items_flow_status_check" CHECK ("flow_status" IN ('A','B'));` },
    { name: "3", sql: `ALTER TABLE "order_items" DROP CONSTRAINT "order_items_flow_status_check";` },
  ]);
  assert.deepEqual([...out.get("2").effects.get("order_items")], ["flow_status"]);
  assert.deepEqual([...out.get("3").effects.get("order_items")], ["flow_status"]);
});

test("a trigger on UPDATE OF columns is those columns; any INSERT or DELETE event is the table", () => {
  assert.deepEqual(effect(`CREATE TRIGGER t AFTER UPDATE OF "name", "kind" ON "roles" FOR EACH ROW EXECUTE FUNCTION f();`), { roles: ["kind", "name"] });
  assert.deepEqual(effect(`CREATE TRIGGER t BEFORE INSERT OR UPDATE ON "clients" FOR EACH ROW EXECUTE FUNCTION f();`), { clients: "*" });
});

test("a function body and a DO block are read like top-level SQL", () => {
  const sql = `
    CREATE OR REPLACE FUNCTION bump() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE "clients" SET "catalog_version" = "catalog_version" + 1 WHERE "id" = NEW."client_id";
      RETURN NEW;
    END;
    $$;
    DO $$ BEGIN
      ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_price_check" CHECK ("price" >= 0);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;`;
  assert.deepEqual(effect(sql, { columnsOf: () => new Set(["price"]) }), { clients: ["catalog_version"], menu_items: ["price"] });
});

test("dynamic SQL is flagged, so the declaration stands in for what the parse cannot read", () => {
  assert.equal(migrationEffects(`DO $$ BEGIN EXECUTE format('ALTER TABLE %I ADD COLUMN x INT', 't'); END $$;`).dynamic, true);
  assert.equal(migrationEffects(`CREATE TRIGGER t AFTER INSERT ON a FOR EACH ROW EXECUTE FUNCTION f();`).dynamic, false);
});

test("a table rename touches both names", () => {
  assert.deepEqual(effect(`ALTER TABLE "saved_views" RENAME TO "saved_filters";`), { saved_views: "*", saved_filters: "*" });
});

test("schema-qualified and quoted names normalize to the table", () => {
  assert.deepEqual(effect(`ALTER TABLE "public"."Orders" ADD COLUMN x INT; ALTER TABLE public.carts ADD COLUMN y INT;`), {
    Orders: ["x"],
    carts: ["y"],
  });
});

test("a FROM inside parentheses belongs to its expression — the SET list goes on past it", () => {
  const sql = `UPDATE "order_items" SET "product_name" = (SELECT "name" FROM "menu_items" WHERE "id" = 1), "discount_cents" = 0 WHERE true;`;
  assert.deepEqual(effect(sql), { order_items: ["discount_cents", "product_name"] });
  assert.deepEqual(effect(`UPDATE t SET a = trim(both ' ' FROM a), b = EXTRACT(YEAR FROM c);`), { t: ["a", "b"] });
});

test("an E'…' literal's backslash escape does not re-open SQL inside the data", () => {
  assert.deepEqual(effect(`INSERT INTO notes (b) VALUES (E'it\\'s DELETE FROM clients'); UPDATE users SET name = 'x';`), {
    notes: "*",
    users: ["name"],
  });
});

test("a dollar-quote tag with digits is still a tag", () => {
  assert.deepEqual(effect(`CREATE FUNCTION f() RETURNS trigger AS $fn1$ BEGIN UPDATE clients SET v = 1; RETURN NEW; END $fn1$ LANGUAGE plpgsql;`), {
    clients: ["v"],
  });
});
