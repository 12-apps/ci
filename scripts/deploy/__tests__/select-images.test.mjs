import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The CD planner decides which images a push rebuilds. A missed rebuild ships
// stale code silently; a needless one rebuilds every SPA because an API route
// changed, which is what future-pay's `apps/web/app/` global input did to
// almost every deploy on 2026-09-25 (seven images for a test file). An image's
// own `inputs` rebuild that image alone.
//
// The planner runs for real, in a throwaway git repo, discovered by
// discover.sh from real deploy/config.json files. Only turbo is faked: it
// answers `ls` with the packages and `ls --affected` with FAKE_AFFECTED.

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, "..");

const configs = {
  "apps/web": { name: "web", targets: [{ provider: "digitalocean", build: { type: "container", image: "web", dockerfile: "apps/web/Dockerfile" } }] },
  "apps/docs": {
    name: "docs",
    targets: [{ provider: "digitalocean", build: { type: "container", image: "docs", dockerfile: "apps/docs/Dockerfile", inputs: ["apps/web/app/", "apps/web/lib/mcp/", "mcp/manifest.json"] } }],
  },
  "apps/admin": { name: "admin", targets: [{ provider: "digitalocean", build: { type: "container", image: "admin", dockerfile: "apps/admin/Dockerfile" } }] },
};

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const write = (root, file, body = "x\n") => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), body); };
const outputs = (file) => Object.fromEntries(readFileSync(file, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), "select-images-"));
  git(root, "init", "-q", "-b", "main");
  write(root, "package.json", '{"name":"root","private":true}\n');
  write(root, "turbo.json", "{}\n");
  for (const [dir, cfg] of Object.entries(configs)) {
    write(root, `${dir}/package.json`, JSON.stringify({ name: cfg.name }));
    write(root, `${dir}/deploy/config.json`, JSON.stringify(cfg));
    write(root, `${dir}/Dockerfile`, "FROM scratch\n");
  }
  write(root, "apps/web/app/api/menu/route.ts");
  write(root, "apps/web/lib/mcp/tools.ts");
  write(root, "mcp/manifest.json", "{}\n");
  const all = JSON.stringify({ packages: { items: Object.entries(configs).map(([p, c]) => ({ name: c.name, path: p })) } });
  write(root, "node_modules/.bin/turbo", `#!/usr/bin/env bash
case " $* " in
  *" --affected "*) printf '{"packages":{"items":[%s]}}' "$(for p in $FAKE_AFFECTED; do printf '{"name":"%s","path":"%s"},' "\${p##*/}" "$p"; done | sed 's/,$//')" ;;
  *) printf '%s' '${all}' ;;
esac
`);
  chmodSync(path.join(root, "node_modules/.bin/turbo"), 0o755);
  write(root, ".gitignore", "node_modules/\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

function plan(changes, affected) {
  const { root, base } = repo();
  for (const f of changes) write(root, f, "changed\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "head");
  const head = git(root, "rev-parse", "HEAD");
  const disc = path.join(root, "discover.out");
  execFileSync("bash", [path.join(scripts, "discover.sh")], { cwd: root, env: { ...process.env, GITHUB_REPOSITORY: "o/r", GITHUB_OUTPUT: disc }, stdio: "pipe" });
  const images = outputs(disc).images;
  const out = path.join(root, "select.out");
  const env = { ...process.env, IMAGES: images, BASE_SHA: base, HEAD_SHA: head, PROBE_SOURCE_TAGS: "0", GITHUB_OUTPUT: out, FAKE_AFFECTED: affected.join(" ") };
  execFileSync("bash", [path.join(scripts, "select-images.sh")], { cwd: root, env, stdio: "pipe" });
  const o = outputs(out);
  const names = (j) => JSON.parse(j).map((i) => i.image).sort();
  return { build: names(o.build_images), reuse: names(o.reuse_images), images: JSON.parse(images), reason: o.selection_reason };
}

test("discover carries an image's declared inputs into its descriptor", () => {
  const { images } = plan(["apps/admin/src/a.ts"], ["apps/admin"]);
  assert.deepEqual(images.find((i) => i.image === "docs").inputs, ["apps/web/app/", "apps/web/lib/mcp/", "mcp/manifest.json"]);
  assert.deepEqual(images.find((i) => i.image === "web").inputs, [], "no inputs declared is an empty list");
});

test("a route change rebuilds the API and the image that declares it, not the other SPAs", () => {
  // The commit from the screenshot: one test file under apps/web/app.
  const { build, reuse } = plan(["apps/web/app/api/admin/nav-badges/__tests__/route.test.ts"], ["apps/web"]);
  assert.deepEqual(build, ["docs", "web"]);
  assert.deepEqual(reuse, ["admin"]);
});

test("a directory input matches below it, an exact input only itself", () => {
  assert.deepEqual(plan(["apps/web/lib/mcp/registry/menu.ts"], ["apps/web"]).build, ["docs", "web"]);
  assert.deepEqual(plan(["mcp/manifest.json"], []).build, ["docs"], "a root file no package owns");
  assert.deepEqual(plan(["mcp/other.json"], []).build, [], "a sibling of an exact input is not a match");
});

test("an image whose inputs did not change is reused, and one package's change stays its own", () => {
  const { build, reuse } = plan(["apps/admin/src/page.tsx"], ["apps/admin"]);
  assert.deepEqual(build, ["admin"]);
  assert.deepEqual(reuse, ["docs", "web"]);
});

test("the global list still rebuilds everything", () => {
  const { build, reason } = plan(["pnpm-lock.yaml"], []);
  assert.deepEqual(build, ["admin", "docs", "web"]);
  assert.match(reason, /'pnpm-lock\.yaml' is a global build input/);
});
