// Regression proofs for omitted runtime inputs and false zero-shard fallbacks.
// Exercise the real planner and green-manifest decision across multiple pushes.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { INPUTS_VERSION, testInputs } from "../lib/inputs.mjs";
import { decide } from "../../skip-green/filter.mjs";
import { nextManifest } from "../../skip-green/record.mjs";

const CLI = process.env.SAFETY_INPUTS_CLI ?? fileURLToPath(new URL("../plan.mjs", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "affected-safe-inputs-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let sequence = 0;
const CONFIG = {
  workspaces: [], ignore: String.raw`\.md$`, sourceRoots: ["src"],
  lanes: { unit: { roots: ["src"], test: String.raw`\.test\.mjs$`, skipGreen: { globals: [] } } },
};
const TESTS = {
  "src/a.test.mjs": "console.log(globalThis.setupValue);\n",
  "src/b.test.mjs": "console.log('b');\n",
};
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function commit(root, files) {
  for (const [file, body] of Object.entries(files)) {
    if (body === null) { git(root, "rm", "-q", "--", file); continue; }
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), body);
    git(root, "add", "--", file);
  }
  git(root, "commit", "-qm", "fixture");
  return git(root, "rev-parse", "HEAD");
}
function repo(files = TESTS, config = CONFIG) {
  const root = join(TMP, String(++sequence));
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "commit.gpgsign", "false");
  const base = commit(root, { ".affected-plan.json": JSON.stringify(config), ...files });
  return { root, base };
}
function plan(root, base, args = [], expectedStatus = 0) {
  const output = join(root, "outputs.txt");
  writeFileSync(output, "");
  const result = spawnSync(process.execPath, [CLI, "--base", base, "--out", "plan.json", "--explain", "false", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "" },
  });
  const doc = JSON.parse(readFileSync(join(root, "plan.json"), "utf8"));
  const outputs = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => {
    const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
  }));
  assert.equal(result.status, expectedStatus, result.stderr);
  return { doc, outputs };
}
const record = (doc, root) => nextManifest({ lane: "unit", plan: doc, laneResult: "success", headSha: git(root, "rev-parse", "HEAD"), runId: "1" }).manifest;
const filter = (doc, manifest) => decide({ plan: doc, manifest, always: new Set(), policy: "enforce", maxShards: 4, perShard: 40 });
const selectAll = (root, files) => commit(root, Object.fromEntries(Object.entries(files).filter(([file]) => file.endsWith(".test.mjs")).map(([file, body]) => [file, `${body}console.log('first push');\n`])));

for (const scenario of ["missing config", "missing lane", "missing base"]) test(`full fallback schedules positive shards: ${scenario}`, () => {
  const { root, base } = repo();
  const args = ["--max-shards", "3"];
  if (scenario === "missing config") args.push("--config", "missing.json");
  if (scenario === "missing lane") args.push("--lane", "absent");
  const { doc, outputs } = plan(root, scenario === "missing base" ? "no-such-ref" : base, args);
  assert.equal(doc.mode, "full");
  assert.deepEqual(doc.tests, []);
  assert.equal(doc.counts.shardTotal, 3);
  assert.equal(outputs["shard-total"], "3");
  assert.equal(outputs.shards, "[1,2,3]");
});

test("invalid shard limits cannot turn a full fallback into an empty matrix", () => {
  const { root, base } = repo();
  for (const limit of ["0", "-2", "Infinity", "NaN"]) {
    assert.ok(plan(root, base, ["--config", "missing.json", "--max-shards", limit]).doc.counts.shardTotal > 0);
  }
});

test("the new input construction invalidates the previous hash format", () => {
  assert.equal(INPUTS_VERSION, "test-inputs-v2");
});

test("global hashes include transitive dependencies and reject blind or untracked globals", () => {
  const edges = new Map([["runner/setup.mjs", [{ target: "shared/helper.mjs" }]], ["shared/helper.mjs", [{ target: "shared/value.json" }]]]);
  const tree = new Map([["src/a.test.mjs", "100644 a"], ["runner/setup.mjs", "100644 b"], ["shared/helper.mjs", "100644 c"], ["shared/value.json", "100644 d"]]);
  const options = { tests: ["src/a.test.mjs"], globals: [/^runner\/setup\.mjs$/], edges, tree };
  const before = testInputs(options);
  assert.deepEqual(before.globalFiles, ["runner/setup.mjs", "shared/helper.mjs", "shared/value.json"]);
  tree.set("shared/value.json", "100644 e");
  assert.notEqual(testInputs(options).inputs["src/a.test.mjs"], before.inputs["src/a.test.mjs"]);
  assert.equal(testInputs({ ...options, blind: ["shared/helper.mjs"] }).inputs["src/a.test.mjs"], null);
  tree.delete("shared/value.json");
  assert.equal(testInputs(options).inputs["src/a.test.mjs"], null);
});

test("routed reads made by a global are also global dependencies", () => {
  const tree = new Map([["src/a.test.mjs", "100644 a"], ["runner/setup.mjs", "100644 b"], ["config/value.json", "100644 c"]]);
  const options = { tests: ["src/a.test.mjs"], edges: new Map([["runner/setup.mjs", []]]), globals: [/^runner\/setup\.mjs$/], routes: [{ match: /^config\//, entries: ["runner/setup.mjs#setup"] }], tree };
  const before = testInputs(options);
  assert.equal(typeof before.inputs["src/a.test.mjs"], "string", "setup is a known parsed leaf, not a missing graph module");
  tree.set("config/value.json", "100644 changed");
  assert.notEqual(testInputs(options).inputs["src/a.test.mjs"], before.inputs["src/a.test.mjs"]);
});

const GLOBAL_CONFIG = { ...CONFIG, lanes: { unit: { ...CONFIG.lanes.unit, skipGreen: { globals: [String.raw`^runner/setup\.mjs$`] } } } };
const GLOBAL_FILES = { ...TESTS, "runner/setup.mjs": "import { value } from '../shared/helper.mjs';\nglobalThis.setupValue = value;\n", "shared/helper.mjs": "export const value = 1;\n" };
for (const [label, files] of [
  ["setup itself", { "runner/setup.mjs": "globalThis.setupValue = 2;\n" }],
  ["transitive helper outside roots", { "shared/helper.mjs": "export const value = 2;\n" }],
  ["deleted setup", { "runner/setup.mjs": null }],
]) test(`runner-loaded ${label} selects every lane test without test imports`, () => {
  const { root, base } = repo(GLOBAL_FILES, GLOBAL_CONFIG);
  commit(root, files);
  const { doc } = plan(root, base);
  assert.equal(doc.mode, "narrowed");
  assert.deepEqual(doc.tests, Object.keys(TESTS));
});

test("changed setup dependency invalidates green tests; the following unrelated push reuses them", () => {
  const { root, base } = repo(GLOBAL_FILES, GLOBAL_CONFIG);
  selectAll(root, TESTS);
  const first = plan(root, base).doc;
  const previous = record(first, root);
  commit(root, { "shared/helper.mjs": "export const value = 2;\n" });
  const second = plan(root, base).doc;
  assert.deepEqual(filter(second, previous).kept, Object.keys(TESTS));
  assert.ok(second.globalFiles.includes("shared/helper.mjs"));
  const green = record(second, root);
  commit(root, { "README.md": "unrelated\n" });
  const third = plan(root, base).doc;
  assert.deepEqual(third.inputs, second.inputs);
  assert.equal(filter(third, green).plan.mode, "none");
});

test("an unresolved global selects all tests and never supplies reusable hashes", () => {
  const { root, base } = repo({ ...GLOBAL_FILES, "runner/setup.mjs": "import './missing.mjs';\n" }, GLOBAL_CONFIG);
  commit(root, { "src/other.mjs": "export const other = 1;\n" });
  const { doc } = plan(root, base);
  assert.deepEqual(doc.tests, Object.keys(TESTS));
  assert.ok(Object.values(doc.inputs).every((value) => value === null));
});

const ORDER_MIGRATION = "db/migrations/20260102000000_orders/migration.sql";
const CLIENT_MIGRATION = "db/migrations/20260101000000_clients/migration.sql";
const ORDER_SQL = "-- @domains: orders\nUPDATE orders SET status = 'old';\n";
const DB_CONFIG = {
  ...CONFIG,
  database: {
    registry: "db/domains.json", schema: ["db/schema"], migrations: String.raw`^db/migrations/[^/]+/migration\.sql$`, schemaFiles: String.raw`^db/schema/[^/]+\.prisma$`,
    readerMarker: String.raw`["'/]migrations["'/]`, carriers: ["src/replay.mjs"],
    migrationReaders: ["src/discovery.test.mjs"], always: ["src/replay.test.mjs"], lanes: { unit: "effects" },
  },
};
const DB_FILES = {
  "db/domains.json": JSON.stringify({ domains: { orders: { tables: ["orders"] }, clients: { tables: ["clients"] } } }),
  "db/schema/schema.prisma": 'model Order {\n id String @id\n status String\n @@map("orders")\n}\nmodel Client {\n id String @id\n name String\n @@map("clients")\n}\n',
  [ORDER_MIGRATION]: ORDER_SQL,
  [CLIENT_MIGRATION]: "-- @domains: clients\nUPDATE clients SET name = 'client';\n",
  "src/client.mjs": "export const prisma = {};\n",
  "src/orders.test.mjs": "import { prisma } from './client.mjs';\nprisma.order.findMany({ where: { status: 'old' } });\n",
  "src/clients.test.mjs": "import { prisma } from './client.mjs';\nprisma.client.findMany({ where: { name: 'client' } });\n",
  "src/named.test.mjs": 'console.log("20260102000000_orders");\n',
  "src/discovery.test.mjs": 'console.log("20260101000000_clients", "20260102000000_orders");\n',
  "src/read-folder.mjs": 'import { readdirSync } from "node:fs";\nexport const list = () => readdirSync("db/migrations/");\n',
  "src/folder.test.mjs": "import { list } from './read-folder.mjs';\nlist();\n",
  "src/replay.mjs": 'import { readdirSync } from "node:fs";\nexport const replay = () => readdirSync("db/migrations/");\n',
  "src/replay.test.mjs": "import { replay } from './replay.mjs';\nreplay();\n",
};

test("persistent database inputs invalidate only migration readers and the relevant query domain", () => {
  const { root, base } = repo(DB_FILES, DB_CONFIG);
  selectAll(root, DB_FILES);
  const first = plan(root, base).doc;
  assert.equal(Object.values(first.inputs).every(Boolean), true);
  const previous = record(first, root);
  commit(root, { [ORDER_MIGRATION]: ORDER_SQL.replace("'old'", "'new'") });
  const second = plan(root, base).doc;
  assert.equal(second.inputs["src/clients.test.mjs"], first.inputs["src/clients.test.mjs"], "unrelated domain remains reusable");
  const expected = ["src/discovery.test.mjs", "src/folder.test.mjs", "src/named.test.mjs", "src/orders.test.mjs", "src/replay.test.mjs"];
  assert.deepEqual(filter(second, previous).kept, expected);
  for (const file of expected) assert.notEqual(second.inputs[file], first.inputs[file], file);
  const green = record(second, root);
  commit(root, { "README.md": "another push\n" });
  const third = plan(root, base).doc;
  assert.deepEqual(third.inputs, second.inputs, "complete HEAD dependencies do not depend on which paths just changed");
  assert.equal(filter(third, green).plan.mode, "none", "unchanged migrations retain valid reuse");
});

for (const change of ["rename", "delete", "add"]) test(`migration ${change} invalidates file readers and replay inputs`, () => {
  const { root, base } = repo(DB_FILES, DB_CONFIG);
  selectAll(root, DB_FILES);
  const first = plan(root, base).doc;
  const files = change === "delete" ? { [ORDER_MIGRATION]: null } : change === "rename"
    ? { [ORDER_MIGRATION]: null, "db/migrations/20260103000000_orders/migration.sql": ORDER_SQL }
    : { "db/migrations/20260103000000_orders/migration.sql": ORDER_SQL };
  commit(root, files);
  const second = plan(root, base).doc;
  for (const reader of ["src/discovery.test.mjs", "src/folder.test.mjs", "src/replay.test.mjs", "src/orders.test.mjs"]) {
    assert.notEqual(second.inputs[reader], first.inputs[reader], reader);
  }
  if (change !== "add") assert.notEqual(second.inputs["src/named.test.mjs"], first.inputs["src/named.test.mjs"]);
  assert.equal(second.inputs["src/clients.test.mjs"], first.inputs["src/clients.test.mjs"]);
});

test("renaming a migration also selects a reader that only names its old path", () => {
  const { root, base } = repo(DB_FILES, DB_CONFIG);
  commit(root, { [ORDER_MIGRATION]: null, "db/migrations/20260103000000_orders/migration.sql": ORDER_SQL });
  assert.ok(plan(root, base).doc.tests.includes("src/named.test.mjs"));
});

test("declared migration globals do not override precise database-owned selection", () => {
  const config = { ...DB_CONFIG, lanes: { unit: { ...CONFIG.lanes.unit, skipGreen: { globals: [String.raw`^db/migrations/`] } } } };
  const { root, base } = repo(DB_FILES, config);
  commit(root, { [ORDER_MIGRATION]: ORDER_SQL.replace("'old'", "'new'") });
  const { doc } = plan(root, base);
  assert.ok(doc.tests.includes("src/orders.test.mjs"));
  assert.equal(doc.tests.includes("src/clients.test.mjs"), false, "domain precision survives wide hash globals");
});

test("comment-only migrations still select text readers without querying the database", () => {
  const { root, base } = repo(DB_FILES, DB_CONFIG);
  commit(root, { [ORDER_MIGRATION]: `${ORDER_SQL}-- documented\n` });
  assert.deepEqual(plan(root, base).doc.tests, ["src/discovery.test.mjs", "src/folder.test.mjs", "src/named.test.mjs"]);
});


test("a command route cannot hide a failed producer behind a successful pipeline", () => {
  const config = { ...CONFIG, routes: [{ match: "^config\\.json$", command: "printf 'src/a.test.mjs\\n'; false | cat" }] };
  const { root, base } = repo({ ...TESTS, "config.json": "{}\n" }, config);
  commit(root, { "config.json": "{\"value\":1}\n" });
  const { doc } = plan(root, base, [], 1);
  assert.equal(doc.mode, "unclassified");
  assert.deepEqual(doc.unclassified, ["config.json"]);
});

for (const [before, after] of [["old", "new"], ["a b", "a  b"], ["--old", "--new"]]) {
  test(`SQL literal mutation ${JSON.stringify(before)} to ${JSON.stringify(after)} selects its domain`, () => {
    const sql = (value) => `-- @domains: orders\nUPDATE orders SET status = '${value}';\n`;
    const { root, base } = repo({ ...DB_FILES, [ORDER_MIGRATION]: sql(before) }, DB_CONFIG);
    commit(root, { [ORDER_MIGRATION]: sql(after) });
    const { doc } = plan(root, base);
    assert.ok(doc.tests.includes("src/orders.test.mjs"));
    assert.ok(doc.tests.includes("src/replay.test.mjs"));
    assert.equal(doc.tests.includes("src/clients.test.mjs"), false);
  });
}


test("SQL newline-sensitive string concatenation is not mistaken for formatting", () => {
  const before = "-- @domains: orders\nUPDATE orders SET status = 'new'\n'value';\n";
  const after = before.replace("'new'\n'value'", "'new' 'value'");
  const { root, base } = repo({ ...DB_FILES, [ORDER_MIGRATION]: before }, DB_CONFIG);
  commit(root, { [ORDER_MIGRATION]: after });
  assert.ok(plan(root, base).doc.tests.includes("src/orders.test.mjs"));
});
