import { strict as assert } from "node:assert";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The ratchet keeps an MCP test-coverage exemptions list from growing and
// makes a PR that touches an exempt tool's code write its test. It moved out
// of mcp-test-coverage.yml into this action so package-gates.yml can run it
// too; these run the action's own script, as a pull request would, in a
// throwaway repo with a real `origin`. Only pnpm is a shim: it answers
// `mcp:test-coverage --exempt-files` with the files backing the tools the
// exemptions file still lists.

const here = path.dirname(fileURLToPath(import.meta.url));
const action = readFileSync(path.join(here, "..", "action.yml"), "utf8");
const script = action.slice(action.indexOf("      run: |\n") + "      run: |\n".length)
  .split("\n").map((l) => l.replace(/^ {8}/, "")).join("\n");

const FILE = "apps/web/mcp/mcp-test-exemptions";
// tool name -> the file backing it
const TOOLS = { "menu.list": "apps/web/app/api/menu/route.ts", "orders.get": "apps/web/app/api/orders/route.ts" };

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const write = (root, f, body) => { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), body); };

/**
 * @param {{ base?: string | null, head?: string | null, touch?: string[], shimFails?: boolean }} o
 *   base/head: the exemptions file's content at each side (null = absent)
 */
function ratchet({ base = "menu.list\n", head, touch = [], shimFails = false }) {
  const root = mkdtempSync(path.join(tmpdir(), "ratchet-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work], { stdio: "ignore" });
  for (const f of Object.values(TOOLS)) write(work, f, "export {}\n");
  write(work, "apps/web/package.json", "{}\n");
  if (base !== null) write(work, FILE, `# MCP tools without a test\n${base}`);
  git(work, "add", "-A"); git(work, "commit", "-qm", "base"); git(work, "push", "-q", "origin", "HEAD:main");
  git(work, "checkout", "-qb", "pr");
  const final = head === undefined ? base : head;
  if (final === null) rmSync(path.join(work, FILE), { force: true });
  else write(work, FILE, `# MCP tools without a test\n${final}`);
  for (const f of touch) write(work, f, `export const touched = ${JSON.stringify(f)}\n`);
  git(work, "add", "-A"); git(work, "commit", "-qm", "pr", "--allow-empty");
  // The shim maps the tools the file lists NOW to their backing files.
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const listed = (final ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  write(root, "exempt-files.txt", listed.map((t) => TOOLS[t] ?? `unknown/${t}`).join("\n") + (listed.length ? "\n" : ""));
  write(bin, "pnpm", shimFails
    ? "#!/usr/bin/env bash\necho 'boom: cannot load the registry' >&2\nexit 3\n"
    : `#!/usr/bin/env bash\ncat ${JSON.stringify(path.join(root, "exempt-files.txt"))}\n`);
  chmodSync(path.join(bin, "pnpm"), 0o755);
  const r = spawnSync("bash", ["-e", "-c", script], { cwd: work, encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BASE_REF: "main", EXEMPTIONS_FILE: FILE, PKG_DIR: "apps/web" } });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

test("a PR that neither grows the list nor touches an exempt tool passes", () => {
  const r = ratchet({ touch: ["apps/web/app/api/other/route.ts"] });
  assert.ok(r.ok, r.out);
  assert.match(r.out, /exemptions ratchet OK/);
});

test("an added entry fails: the list may only shrink", () => {
  const r = ratchet({ head: "menu.list\norders.get\n" });
  assert.ok(!r.ok);
  assert.match(r.out, /may only shrink, never grow[\s\S]*\+ orders\.get/);
});

test("touching the code behind a still-exempt tool fails, and passes once its entry is removed", () => {
  const bad = ratchet({ touch: ["apps/web/app/api/menu/route.ts"] });
  assert.ok(!bad.ok);
  assert.match(bad.out, /still exempt[\s\S]*apps\/web\/app\/api\/menu\/route\.ts/);
  const good = ratchet({ head: "", touch: ["apps/web/app/api/menu/route.ts"] });
  assert.ok(good.ok, good.out);
});

test("the PR that adopts the file is accepted as the baseline", () => {
  const r = ratchet({ base: null, head: "menu.list\norders.get\n" });
  assert.ok(r.ok, r.out);
  assert.match(r.out, /new at this merge base/);
});

test("a file with comments only, or no file, has nothing to enforce", () => {
  assert.match(ratchet({ base: "", head: "" }).out, /no entries \(comments only\)/);
  assert.match(ratchet({ base: null, head: null }).out, /nothing to enforce/);
});

test("a mapping that errors fails rather than being trusted", () => {
  const r = ratchet({ shimFails: true });
  assert.ok(!r.ok);
  assert.match(r.out, /--exempt-files exited 3/);
});
