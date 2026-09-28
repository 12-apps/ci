import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// discover.sh carries a descriptor's `reproducible` flag into the image matrix,
// and only a literal `true` turns it on: cd.yml exports such an image with every
// timestamp rewritten, which is wrong for a static server (ETag from mtime).

const SCRIPT = fileURLToPath(new URL("../discover.sh", import.meta.url));

function discover(builds) {
  const repo = mkdtempSync(path.join(tmpdir(), "discover-"));
  builds.forEach((build, i) => {
    const dir = path.join(repo, "apps", `app${i}`, "deploy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ name: `app${i}`, targets: [{ provider: "digitalocean", build }] }),
    );
  });
  const out = path.join(repo, "out.txt");
  writeFileSync(out, "");
  const r = spawnSync("bash", [SCRIPT], {
    cwd: repo,
    env: { PATH: process.env.PATH, GITHUB_REPOSITORY: "Owner/Repo", GITHUB_OUTPUT: out },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const line = readFileSync(out, "utf8").split("\n").find((l) => l.startsWith("images="));
  return JSON.parse(line.slice("images=".length)).sort((a, b) => a.app.localeCompare(b.app));
}

test("reproducible is carried into the matrix, and off unless it is literally true", () => {
  const images = discover([
    { type: "container", dockerfile: "apps/app0/Dockerfile", reproducible: true },
    { type: "container", dockerfile: "apps/app1/Dockerfile" },
    { type: "container", dockerfile: "apps/app2/Dockerfile", reproducible: "yes" },
  ]);
  assert.deepEqual(
    images.map((i) => [i.app, i.reproducible]),
    [
      ["app0", true],
      ["app1", false],
      ["app2", false],
    ],
  );
});
