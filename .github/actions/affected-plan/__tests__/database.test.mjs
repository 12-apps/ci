/**
 * The database router, through the CLI a lane actually runs.
 *
 * The case this exists for: a migration used to route to the client entry,
 * which every database test loads, so ANY migration selected every one of
 * them. Each test below pins one half of the replacement — a migration or a
 * schema edit selects the tests that can observe what it changed, and only
 * those — and the refusals that keep it honest: an undeclared migration stops
 * the plan, and a migration nothing can observe still runs the `always` suite.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "plan.mjs");

const CONFIG = {
  workspaces: [],
  ignore: String.raw`\.md$`,
  sourceRoots: ["src", "db"],
  // The old answer, kept to prove the database block overrides it.
  routes: [{ match: String.raw`\.prisma$|migration\.sql$`, entry: ["src/client.ts"] }],
  database: {
    registry: "db/domains.json",
    schema: ["db/schema"],
    migrations: String.raw`^db/migrations/[^/]+/migration\.sql$`,
    schemaFiles: String.raw`^db/schema/[^/]+\.prisma$`,
    global: ["src/client.ts"],
    readerMarker: String.raw`["'/]migrations["'/]`,
    carriers: ["src/template.ts"],
    always: ["src/replay.test.ts"],
    lanes: { unit: "effects" },
  },
  lanes: { unit: { roots: ["src"], test: String.raw`\.test\.ts$` } },
};

const SCHEMA = `
model Client {
  id        String  @id
  name      String
  cancelRoles Json? @map("cancel_roles")
  orders    Order[]
  @@map("clients")
}
model Order {
  id       String @id
  clientId String @map("client_id")
  status   String
  client   Client @relation(fields: [clientId], references: [id])
  @@map("orders")
}
`;

const REGISTRY = {
  domains: {
    tenancy: { description: "", tables: ["clients"] },
    orders: { description: "", tables: ["orders"] },
  },
};

/** Source every "real" repo has: a client entry every test loads, and repositories. */
const SOURCE = {
  "src/client.ts": "export const prisma = {} as any;\n",
  "src/template.ts": `import { readdirSync } from "node:fs";\nexport const replay = () => readdirSync("db/migrations/");\n`,
  "src/tenant.ts": `import { prisma } from "./client";
export async function findTenant(slug: string) {
  return prisma.client.findUnique({ where: { id: slug } });
}
export async function cancelRolesOf(id: string) {
  const row = await prisma.client.findUnique({ where: { id } });
  return row?.cancelRoles ?? null;
}
`,
  "src/orders.ts": `import { prisma } from "./client";
export async function listOrders(clientId: string) {
  return prisma.order.findMany({ where: { clientId } });
}
export function label(status: string) {
  return status.toUpperCase();
}
`,
  "src/client.test.ts": `import { prisma } from "./client";\n`,
  "src/tenant.test.ts": `import { findTenant } from "./tenant";\n`,
  "src/cancel-roles.test.ts": `import { cancelRolesOf } from "./tenant";\n`,
  "src/orders.test.ts": `import { listOrders } from "./orders";\n`,
  "src/label.test.ts": `import { label } from "./orders";\n`,
  "src/replay.test.ts": `import { replay } from "./template";\n`,
  "src/sql-text.test.ts": `import { readFileSync } from "node:fs";\nconst dir = "db/migrations/";\n`,
  "src/backfill.test.ts": `const file = "20260102000000_backfill";\n`,
  "db/domains.json": JSON.stringify(REGISTRY),
  "db/schema/schema.prisma": SCHEMA,
  "db/migrations/20260101000000_init/migration.sql": `-- @domains: orders, tenancy
CREATE TABLE "clients" ("id" TEXT NOT NULL, "name" TEXT NOT NULL, "cancel_roles" JSONB);
CREATE TABLE "orders" ("id" TEXT NOT NULL, "client_id" TEXT NOT NULL, "status" TEXT NOT NULL);
`,
};

function repo(changes) {
  const root = mkdtempSync(join(tmpdir(), "affected-plan-db-"));
  const git = (...args) => spawnSync("git", args, { cwd: root, stdio: "ignore" });
  const put = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  put(".affected-plan.json", JSON.stringify(CONFIG));
  for (const [path, body] of Object.entries(SOURCE)) put(path, body);
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  for (const [path, body] of Object.entries(changes)) put(path, body);
  git("add", "-A");
  git("commit", "-qm", "head");
  return { root, base };
}

function plan(root, base) {
  const r = spawnSync(
    "node",
    [CLI, "--lane", "unit", "--base", base, "--config", ".affected-plan.json", "--out", "plan.json", "--explain", "false"],
    { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" } },
  );
  return { code: r.status, err: r.stderr, doc: JSON.parse(readFileSync(join(root, "plan.json"), "utf8")) };
}

test("a one-column backfill selects the code that reads that column — not every test of the table", () => {
  const { root, base } = repo({
    "db/migrations/20260102000000_backfill/migration.sql": `-- @domains: tenancy\nUPDATE "clients" SET "cancel_roles" = '[]' WHERE "cancel_roles" IS NULL;\n`,
  });
  const { code, doc, err } = plan(root, base);
  assert.equal(code, 0, err);
  assert.deepEqual(doc.tests, ["src/backfill.test.ts", "src/cancel-roles.test.ts", "src/replay.test.ts", "src/sql-text.test.ts"]);
  // Not the client entry, and not the other export of the same repository.
  assert.equal(doc.tests.includes("src/client.test.ts"), false);
  assert.equal(doc.tests.includes("src/tenant.test.ts"), false);
  assert.deepEqual(doc.affectedSymbols["src/tenant.ts"], ["cancelRolesOf"]);
});

test("a whole-table effect selects every symbol that queries the table, and only that table's", () => {
  const { root, base } = repo({
    "db/migrations/20260102000000_trigger/migration.sql": `-- @domains: orders\nCREATE TRIGGER t BEFORE INSERT ON "orders" FOR EACH ROW EXECUTE FUNCTION f();\n`,
  });
  const { doc } = plan(root, base);
  assert.deepEqual(doc.tests, ["src/orders.test.ts", "src/replay.test.ts", "src/sql-text.test.ts"]);
  assert.equal(doc.tests.includes("src/label.test.ts"), false);
});

test("a shared, one-word field only counts beside its model — `status` alone is not orders.status", () => {
  const { root, base } = repo({
    "db/migrations/20260102000000_status/migration.sql": `-- @domains: orders\nUPDATE "orders" SET "status" = 'NEW' WHERE "status" = 'new';\n`,
  });
  const { doc } = plan(root, base);
  assert.equal(doc.tests.includes("src/label.test.ts"), false, "label() mentions `status` but never touches the model");
});

test("a migration whose SQL did not change — a comment, a declaration — changes nothing it builds", () => {
  const { root, base } = repo({
    "db/migrations/20260101000000_init/migration.sql": `${SOURCE["db/migrations/20260101000000_init/migration.sql"]}-- explained\n`,
  });
  const { doc } = plan(root, base);
  // Only the suite that reads migration TEXT.
  assert.deepEqual(doc.tests, ["src/sql-text.test.ts"]);
});

test("a migration nothing can observe still runs the `always` suite that proves it applies", () => {
  const { root, base } = repo({
    "db/migrations/20260102000000_index/migration.sql": `-- @domains: orders\nCREATE INDEX "orders_status_idx" ON "orders"("status");\n`,
  });
  const { doc } = plan(root, base);
  assert.deepEqual(doc.tests, ["src/replay.test.ts", "src/sql-text.test.ts"]);
});

test("an undeclared migration is UNCLASSIFIED — the plan stops in red, it is never routed to everything", () => {
  const { root, base } = repo({
    "db/migrations/20260102000000_bare/migration.sql": `ALTER TABLE "orders" ADD COLUMN "tip" INT;\n`,
  });
  const { code, doc, err } = plan(root, base);
  assert.equal(code, 1);
  assert.equal(doc.mode, "unclassified");
  assert.match(err, /declares no valid `-- @domains:` line/);
});

test("a schema edit selects the code reading the changed field", () => {
  const { root, base } = repo({
    "db/schema/schema.prisma": SCHEMA.replace("cancelRoles Json? @map(\"cancel_roles\")", "cancelRoles Json? @map(\"cancel_roles\") @default(\"[]\")"),
  });
  const { doc } = plan(root, base);
  assert.deepEqual(doc.tests, ["src/cancel-roles.test.ts", "src/replay.test.ts"]);
});

test("a schema edit that only moves comments selects nothing but the replay", () => {
  const { root, base } = repo({ "db/schema/schema.prisma": SCHEMA.replace("model Order {", "// why\nmodel Order {") });
  const { doc } = plan(root, base);
  assert.deepEqual(doc.tests, ["src/replay.test.ts"]);
});

test("a generator edit reaches the whole client, honestly, through `global`", () => {
  const { root, base } = repo({ "db/schema/schema.prisma": `generator client {\n  provider = "prisma-client-js"\n}\n${SCHEMA}` });
  const { doc } = plan(root, base);
  assert.ok(doc.tests.includes("src/client.test.ts"));
});

test("dynamic SQL widens every declared-domain table the parse did not see, even beside one it did", () => {
  const { root, base } = repo({
    "db/migrations/20260102000000_dyn/migration.sql": `-- @domains: orders, tenancy
DO $$ BEGIN EXECUTE format('ALTER TABLE %I ADD COLUMN x INT', 'clients'); END $$;
UPDATE "orders" SET "status" = 'x' WHERE false;
`,
  });
  const { doc } = plan(root, base);
  // clients was never named, so every client query runs — not just the status reader.
  assert.ok(doc.tests.includes("src/tenant.test.ts"), JSON.stringify(doc.tests));
  assert.ok(doc.tests.includes("src/cancel-roles.test.ts"));
});
