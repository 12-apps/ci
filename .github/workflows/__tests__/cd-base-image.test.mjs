import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// cd.yml's base image: a stage built once per content of its inputs and reused
// until they change. The key decides whether a deploy reuses a dependency tree
// or rebuilds it, so a key that misses a change serves a STALE base, and one
// that moves without a change throws the saving away. The "Resolve the base
// image" step is lifted out of the workflow and run in a real git repo with a
// fake `docker`, so what is tested is what ships.

const here = path.dirname(fileURLToPath(import.meta.url));
const yaml = readFileSync(path.join(here, "..", "cd.yml"), "utf8");

function resolveScript() {
  const lines = yaml.split("\n");
  const at = lines.findIndex((l) => /^\s+- name: Resolve the base image\s*$/.test(l));
  assert.ok(at > 0, "cd.yml has a 'Resolve the base image' step");
  const run = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  const indent = lines[run + 1].match(/^\s*/)[0].length;
  const body = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() && l.match(/^\s*/)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join("\n");
}

function repo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "base-key-"));
  const git = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), body);
  }
  git("add", "-A");
  const bin = path.join(dir, ".bin");
  mkdirSync(bin);
  const run = ({ exists = false, inputs = ["pnpm-lock.yaml", "**/package.json"], target = "runner-base" } = {}) => {
    writeFileSync(path.join(bin, "docker"), `#!/bin/sh\nexit ${exists ? 0 : 1}\n`);
    chmodSync(path.join(bin, "docker"), 0o755);
    const out = path.join(dir, ".out");
    writeFileSync(out, "");
    const r = spawnSync("bash", ["-c", resolveScript()], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: out,
        REF: "ghcr.io/o/r-web",
        DOCKERFILE: "Dockerfile",
        BASE_TARGET: target,
        BASE_INPUTS: JSON.stringify(inputs),
      },
    });
    const kv = Object.fromEntries(
      readFileSync(out, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("=", 2)),
    );
    return { ...r, ...kv };
  };
  const edit = (f, body) => {
    writeFileSync(path.join(dir, f), body);
    git("add", "-A");
  };
  return { run, edit };
}

const FILES = {
  Dockerfile: "FROM x AS runner-base\n",
  "pnpm-lock.yaml": "lock: 1\n",
  "apps/web/package.json": '{"name":"web"}\n',
  "apps/web/src/server.ts": "export {}\n",
};

test("the key is stable for the same inputs, and names the image by it", () => {
  const r = repo(FILES);
  const a = r.run();
  const b = r.run();
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.ref, /^ghcr\.io\/o\/r-web:base-[0-9a-f]{16}$/);
  assert.equal(a.ref, b.ref);
});

test("a change to an input, the Dockerfile or the target is a new key; any other file is not", () => {
  const r = repo(FILES);
  const before = r.run().ref;
  r.edit("apps/web/src/server.ts", "export const x = 1\n");
  assert.equal(r.run().ref, before, "a source change must reuse the base");
  r.edit("pnpm-lock.yaml", "lock: 2\n");
  const afterLock = r.run().ref;
  assert.notEqual(afterLock, before, "a lockfile change must rebuild the base");
  r.edit("apps/web/package.json", '{"name":"web","dependencies":{"a":"1"}}\n');
  const afterManifest = r.run().ref;
  assert.notEqual(afterManifest, afterLock, "a nested package.json matched by the glob must rebuild the base");
  r.edit("Dockerfile", "FROM y AS runner-base\n");
  const afterDockerfile = r.run().ref;
  assert.notEqual(afterDockerfile, afterManifest, "a Dockerfile change must rebuild the base");
  assert.notEqual(r.run({ target: "other" }).ref, afterDockerfile, "another target is another base");
});

test("an existing base is reused, a missing one is built", () => {
  const r = repo(FILES);
  assert.equal(r.run({ exists: true }).exists, "true");
  assert.equal(r.run({ exists: false }).exists, "false");
});

test("an input that matches no tracked file fails instead of silently leaving it out of the key", () => {
  const r = repo(FILES);
  const res = r.run({ inputs: ["pnpm-lock.yaml", "patches/"] });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /base input 'patches\/' matches no tracked file/);
});

test("the main build gets the base as its build arg only when the image declares one", () => {
  const expr = /\$\{\{ (matrix\.base && format\('\{0\}=\{1\}', matrix\.base\.arg, steps\.base\.outputs\.ref\) \|\| '') \}\}/.exec(yaml);
  assert.ok(expr, "cd.yml passes the base to the build as a build arg");
  const evaluate = (base, ref) =>
    Function("matrix", "steps", "format", `"use strict"; return (${expr[1].replace(/'([^']*)'/g, (_, s) => JSON.stringify(s))});`)(
      { base },
      { base: { outputs: { ref } } },
      (f, a, b) => f.replace("{0}", a).replace("{1}", b),
    );
  assert.equal(evaluate({ arg: "RUNNER_BASE" }, "ghcr.io/o/r-web:base-1"), "RUNNER_BASE=ghcr.io/o/r-web:base-1");
  assert.equal(evaluate(null, ""), "");
  assert.match(yaml, /- name: Build & push the base image\n\s+if: matrix\.base && steps\.base\.outputs\.exists == 'false'/);
});
