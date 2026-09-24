/**
 * Key routing, through the CLI a lane actually runs.
 *
 * The case this exists for: an e2e suite's seeders are modules no test
 * imports, so a harness change either reached nothing or ran every test. Each
 * case below pins one answer — a record change selects the tests naming it, a
 * comment selects nothing, a renamed key still reaches the tests written
 * against the old one — and the refusals that keep it honest: setup logic in a
 * runner script widens to the runner, and a record no test names is traced as
 * source rather than read as unobserved.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { analyseLines, isKey, keyedChange } from "../lib/keys.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "plan.mjs");

const CONFIG = {
  workspaces: [],
  ignore: String.raw`\.md$`,
  sourceRoots: ["apps", "e2e", "runner.config.ts"],
  lanes: {
    e2e: {
      roots: ["apps", "e2e", "runner.config.ts"],
      test: String.raw`\.e2e\.ts$|^e2e/steps/|^runner\.config\.ts$|^e2e/seed/provision\.mjs$`,
      ignore: String.raw`\.feature$`,
      routes: [
        { match: String.raw`^e2e/seed/(?!provision|orphans).+\.mjs$`, keys: { search: "^(apps|e2e)/", logic: "records" } },
        { match: String.raw`^e2e/seed/orphans\.mjs$`, keys: { search: "^(apps|e2e)/", logic: "records", unnamed: "none" } },
        { match: String.raw`^e2e/seed/provision\.mjs$`, keys: { search: "^(apps|e2e)/", logic: ["runner.config.ts"] } },
      ],
    },
  },
};

const USERS = `export const USERS = [
  // the buyer every checkout spec signs in as
  { id: "e2e-buyer", email: "buyer@shop.test", name: "Ana" },
  { id: "e2e-waiter", email: "waiter@shop.test", name: "Beto" },
];
`;
const STORES = `import { seedHistory } from "./history.mjs";
const STORES = {
  mesaSai: {
    slug: "jornada-mesa-sai",
    clientId: "e2e-jornada-mesa-sai",
  },
  balcao: {
    slug: "jornada-balcao",
    clientId: "e2e-jornada-balcao",
  },
};
export async function seedStores(db) {
  for (const s of Object.values(STORES)) await db.insert(s.clientId, s.slug);
  await seedHistory(db, "e2e-jornada-balcao");
}
`;

const SOURCE = {
  "runner.config.ts": `export default { command: "node ./e2e/seed/provision.mjs" };\n`,
  "e2e/seed/users.mjs": USERS,
  "e2e/seed/stores.mjs": STORES,
  "e2e/seed/crypto.mjs": `export const seal = (x) => x.split("").reverse().join("");\n`,
  "e2e/seed/history.mjs": `export async function seedHistory(db, id) {\n  for (let d = 0; d < 3; d += 1) await db.insert(id, d);\n}\n`,
  "e2e/seed/orphans.mjs": `export const DEMO = [{ id: "demo-owner", email: "owner@demo.test" }];\n`,
  "e2e/seed/provision.mjs": `import { USERS } from "./users.mjs";\nimport { seal } from "./crypto.mjs";\nimport { DEMO } from "./orphans.mjs";\nimport { seedStores } from "./stores.mjs";\nawait seedStores({ insert: async () => [...USERS, ...DEMO].map(seal) });\n`,
  "e2e/helpers/tables.ts": `export const TABLES = { mesaSai: "e2e-jornada-mesa-sai-table" };\nexport const other = 1;\n`,
  "apps/shop/src/checkout.e2e.ts": `const user = "buyer@shop.test";\n`,
  "apps/shop/src/waiter.e2e.ts": `const user = "waiter@shop.test";\n`,
  "apps/shop/src/unrelated.e2e.ts": `const x = "nothing-seeded-here";\n`,
  "e2e/steps/mesa.steps.ts": `import { TABLES } from "../helpers/tables";\nexport const table = TABLES.mesaSai;\n`,
  "e2e/steps/balcao.steps.ts": `const STORE = "jornada-balcao";\n`,
  "e2e/features/mesa.feature": `Feature: mesa\n  Scenario: x\n    Given a buyer at "jornada-mesa-sai"\n`,
};

function repo(changes) {
  const root = mkdtempSync(join(tmpdir(), "affected-plan-keys-"));
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
    [CLI, "--lane", "e2e", "--base", base, "--config", ".affected-plan.json", "--out", "plan.json", "--explain", "false"],
    { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" } },
  );
  return { code: r.status, err: r.stderr, doc: JSON.parse(readFileSync(join(root, "plan.json"), "utf8")) };
}

test("adding one user selects the spec that signs in as them — not every spec", () => {
  const { root, base } = repo({
    "e2e/seed/users.mjs": USERS.replace("];", `  { id: "e2e-waiter-2", email: "waiter@shop.test", name: "Caio" },\n];`),
  });
  const { code, doc, err } = plan(root, base);
  assert.equal(code, 0, err);
  assert.deepEqual(doc.tests, ["apps/shop/src/waiter.e2e.ts"]);
  assert.equal(doc.keys["e2e/seed/users.mjs"].kind, "keys");
});

test("a comment in a seeder selects nothing", () => {
  const { root, base } = repo({ "e2e/seed/users.mjs": USERS.replace("the buyer every", "the one buyer every") });
  const { code, doc, err } = plan(root, base);
  assert.equal(code, 0, err);
  assert.deepEqual(doc.tests, []);
  assert.equal(doc.keys["e2e/seed/users.mjs"].kind, "none");
});

test("a renamed key reaches the tests written against the OLD key", () => {
  const { root, base } = repo({ "e2e/seed/users.mjs": USERS.replace('email: "buyer@shop.test"', 'email: "buyer2@shop.test"') });
  const { doc } = plan(root, base);
  assert.deepEqual(doc.tests, ["apps/shop/src/checkout.e2e.ts"]);
});

test("a record filed under a name reaches a helper that reads it by that name, and a .feature naming its slug", () => {
  const { root, base } = repo({ "e2e/seed/stores.mjs": STORES.replace('clientId: "e2e-jornada-mesa-sai",', 'clientId: "e2e-jornada-mesa-sai",\n    tables: true,') });
  const { doc } = plan(root, base);
  assert.deepEqual(doc.tests, ["e2e/steps/mesa.steps.ts"], JSON.stringify(doc.keys));
  assert.deepEqual(doc.keys["e2e/seed/stores.mjs"].hits, ["e2e/features/mesa.feature"]);
  assert.equal(doc.tests.includes("e2e/steps/balcao.steps.ts"), false, "the sibling store's steps do not run");
});

test("setup logic in a seeder reaches every record it holds — and nothing it does not", () => {
  const { root, base } = repo({ "e2e/seed/stores.mjs": STORES.replace("await db.insert(s.clientId, s.slug);", "await db.insert(s.clientId, s.slug, true);") });
  const { doc } = plan(root, base);
  assert.deepEqual(doc.tests, ["e2e/steps/balcao.steps.ts", "e2e/steps/mesa.steps.ts"]);
  assert.equal(doc.tests.includes("apps/shop/src/checkout.e2e.ts"), false);
});

test("setup logic in the provisioner the runner launches reaches the runner", () => {
  const { root, base } = repo({ "e2e/seed/provision.mjs": `${SOURCE["e2e/seed/provision.mjs"]}console.log("done");\n` });
  const { doc } = plan(root, base);
  assert.deepEqual(doc.tests, ["runner.config.ts"]);
  assert.equal(doc.keys["e2e/seed/provision.mjs"].kind, "logic");
});

test("a record no test names is traced as source, never read as unobserved", () => {
  const { root, base } = repo({
    "e2e/seed/users.mjs": USERS.replace("];", `  { id: "e2e-nobody", email: "nobody@shop.test", name: "Zé" },\n];`),
  });
  const { doc } = plan(root, base);
  assert.equal(doc.keys["e2e/seed/users.mjs"].kind, "logic");
  // The table's importer is the provisioner, a root of the lane: reaching it
  // is reaching the runner, which is the honest answer for a row no test names.
  assert.deepEqual(doc.tests, ["e2e/seed/provision.mjs"]);
});

test("logic in a helper a seeder calls reaches the CALLER's records — seedHistory(db, id) is keyed by who passes id", () => {
  const { root, base } = repo({ "e2e/seed/history.mjs": SOURCE["e2e/seed/history.mjs"].replace("d < 3", "d < 30") });
  const { doc } = plan(root, base);
  assert.deepEqual(doc.tests, ["e2e/steps/balcao.steps.ts", "e2e/steps/mesa.steps.ts"]);
});

test("logic in a helper with no records anywhere in its chain is plain logic — it reaches the runner", () => {
  const { root, base } = repo({ "e2e/seed/crypto.mjs": `export const seal = (x) => x;\n` });
  const { doc } = plan(root, base);
  assert.deepEqual(doc.tests, ["e2e/seed/provision.mjs"]);
  assert.equal(doc.keys["e2e/seed/crypto.mjs"].kind, "logic");
});

test("wiring a seeder into the provisioner reaches THAT seeder's records, not the runner", () => {
  const { root, base } = repo({
    "e2e/seed/waiters.mjs": `export async function seedWaiters(db) {\n  await db.insert("waiter@shop.test");\n}\n`,
    "e2e/seed/provision.mjs": `${SOURCE["e2e/seed/provision.mjs"]}import { seedWaiters } from "./waiters.mjs";\nawait seedWaiters({ insert: async () => null });\n`,
  });
  const { doc, code, err } = plan(root, base);
  assert.equal(code, 0, err);
  assert.deepEqual(doc.tests, ["apps/shop/src/waiter.e2e.ts"], JSON.stringify(doc.keys));
});

test("inline SQL in the provisioner names its rows in SQL quotes", () => {
  const { root, base } = repo({
    "e2e/seed/provision.mjs": `${SOURCE["e2e/seed/provision.mjs"]}await db.query(\n  \`INSERT INTO users (email) VALUES ('buyer@shop.test')\`,\n);\n`,
  });
  const { doc } = plan(root, base);
  assert.deepEqual(doc.tests, ["apps/shop/src/checkout.e2e.ts"], JSON.stringify(doc.keys));
});

test("a real runner change in the provisioner — its environment — reaches the runner", () => {
  const { root, base } = repo({ "e2e/seed/provision.mjs": `process.env.TZ = "UTC";\n${SOURCE["e2e/seed/provision.mjs"]}` });
  const { doc } = plan(root, base);
  assert.deepEqual(doc.tests, ["runner.config.ts"]);
});

test("`unnamed: none` — a row no test names is a row no test observes", () => {
  const { root, base } = repo({ "e2e/seed/orphans.mjs": `export const DEMO = [{ id: "demo-owner-2", email: "owner2@demo.test" }];\n` });
  const { code, doc, err } = plan(root, base);
  assert.equal(code, 0, err);
  assert.deepEqual(doc.tests, []);
  assert.equal(doc.keys["e2e/seed/orphans.mjs"].kind, "unnamed");
});

test("a line that opens a record is about that record, not the table it sits in", () => {
  const { keys, props, logic } = analyseLines(STORES, [3]);
  assert.deepEqual([...keys].sort(), ["e2e-jornada-mesa-sai", "jornada-mesa-sai"]);
  assert.deepEqual([...props], ["mesaSai"]);
  assert.deepEqual(logic, []);
});

test("a line in a function body with no keyed literal is logic", () => {
  assert.deepEqual(analyseLines(STORES, [13]).logic, [13]);
});

test("keys are ids, slugs and e-mails — not prose, numbers or paths", () => {
  for (const k of ["e2e-buyer", "buyer@shop.test", "jornada-mesa-sai", "catalog.recipes"]) assert.ok(isKey(k), k);
  for (const k of ["Ana Maria", "OWNER", "12.50", "./users.mjs", "node:fs", "utf8"]) assert.equal(isKey(k), false, k);
});

test("a change that moves only comments is none, on both sides", () => {
  const diff = "@@ -2 +2 @@\n";
  assert.deepEqual(keyedChange({ base: USERS, head: USERS.replace("the buyer", "THE buyer"), diff }), { kind: "none" });
});
