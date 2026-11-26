// Runs the action's entry script against a local fake of the GitHub API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../assign.mjs", import.meta.url).pathname;
const registry = {
  control: [0, 1],
  experiments: [{ name: "probe", start: "2026-11-27T15:00:00-03:00", allocation: [{ from: "2026-11-27T15:00:00-03:00", digits: [9] }] }],
};

function fakeApi(routes) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const hit = routes[req.url.split("?")[0]];
    if (!hit) {
      res.statusCode = 404;
      return res.end("{}");
    }
    res.setHeader("content-type", "application/json");
    res.end(typeof hit === "string" ? hit : JSON.stringify(hit));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

function run(vars) {
  const dir = mkdtempSync(join(tmpdir(), "bucket-"));
  const out = join(dir, "out");
  const childVars = {
    PATH: process.env.PATH,
    GITHUB_OUTPUT: out,
    GH_TOKEN: "t",
    REPO: "o/r",
    FILE: ".github/ci-experiments.json",
    DEFAULT_BRANCH: "main",
    EVENT: "pull_request",
    OFF: "",
    ...vars,
  };
  return new Promise((resolve) =>
    execFile("node", [script], { env: childVars }, (err, stdout) => {
      let written = "";
      try {
        written = readFileSync(out, "utf8");
      } catch {}
      resolve({ err, stdout, out: written });
    }),
  );
}

test("reads the registry from the default branch and the run's creation time", async () => {
  const api = await fakeApi({
    "/repos/o/r/actions/runs/1239": { created_at: "2026-11-28T12:00:00Z" },
    "/repos/o/r/contents/.github/ci-experiments.json": JSON.stringify(registry),
  });
  const r = await run({ GITHUB_API_URL: api.url, RUN_ID: "1239" });
  api.server.close();
  assert.equal(r.err, null);
  assert.match(r.out, /^experiment=probe$/m);
  assert.match(r.out, /^digit=9$/m);
  assert.match(r.stdout, /ci-experiment run=1239 digit=9 experiment=probe/);
  const contents = api.seen.find((s) => s.url.startsWith("/repos/o/r/contents/"));
  assert.match(contents.url, /\?ref=main$/);
  assert.equal(contents.auth, "Bearer t");
});

test("an unreadable registry leaves the run in control, warns, and exits 0", async () => {
  const api = await fakeApi({ "/repos/o/r/actions/runs/1239": { created_at: "2026-11-28T12:00:00Z" } });
  const r = await run({ GITHUB_API_URL: api.url, RUN_ID: "1239" });
  api.server.close();
  assert.equal(r.err, null);
  assert.match(r.out, /^experiment=$/m);
  assert.match(r.stdout, /::warning title=CI experiment bucket::HTTP 404/);
});

test("an API that is down leaves the run in control and exits 0", async () => {
  const r = await run({ GITHUB_API_URL: "http://127.0.0.1:9", RUN_ID: "1239" });
  assert.equal(r.err, null);
  assert.match(r.out, /^experiment=$/m);
});
