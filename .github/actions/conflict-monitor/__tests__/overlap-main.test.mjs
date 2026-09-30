import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { githubClient } from "../lib/github.mjs";
import { cleanupWorlds, own, pair, serveApi, stubApi } from "./overlap-world.mjs";

// The overlap mode as the action runs it: `node overlap.mjs`, the real REST
// client, a real HTTP server in front of the stubbed GitHub. What only this
// level can show: the exit code, the `::error::` lines, the stats the log line
// reports, and the status a real failed request carries.

const dir = mkdtempSync(join(tmpdir(), "cm-overlap-main-"));
after(() => {
  cleanupWorlds();
  rmSync(dir, { recursive: true, force: true });
});
const OVERLAP = fileURLToPath(new URL("../overlap.mjs", import.meta.url));
const CONFIG = join(dir, "conflict-monitor.json");
writeFileSync(CONFIG, JSON.stringify({ buckets: [], overlap: { ignorePaths: ["pnpm-lock.yaml"] } }));

/** Run the entry point against `w`'s checkout and a served `api`; resolves to { status, stdout, summary }. */
async function runMain(w, api) {
  w.baseSha();
  const served = await serveApi(api);
  const summaryPath = join(dir, `summary-${Date.now()}-${Math.random()}.md`);
  writeFileSync(summaryPath, "");
  try {
    const child = spawn(process.execPath, [OVERLAP], {
      cwd: w.local.dir,
      env: {
        PATH: process.env.PATH,
        CONFIG_PATH: CONFIG,
        GITHUB_REPOSITORY: "o/r",
        BASE_BRANCH: "main",
        GITHUB_API_URL: served.url,
        GITHUB_TOKEN: "t",
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stdout += c));
    const status = await new Promise((resolve) => child.on("close", resolve));
    return { status, stdout, summary: readFileSync(summaryPath, "utf8") };
  } finally {
    await served.close();
  }
}

test("the real client counts its calls, keeps the rate headers, and a failed request carries its status", async () => {
  const w = pair();
  const served = await serveApi(stubApi(w));
  try {
    const api = githubClient({ token: "t", apiUrl: served.url });
    assert.equal((await api.paginate("/repos/o/r/pulls?state=open&base=main")).length, 3);
    await assert.rejects(api.request("GET", "/repos/o/r/pulls/999"), (err) => err.status === 404 && /→ 404/.test(err.message));
    assert.deepEqual(api.stats, { reads: 2, writes: 0, rateLimit: 1000, rateUsed: 2 });
  } finally {
    await served.close();
  }
});

test("a good run exits 0, writes both comments, and prints the log line with the real client's counts", async () => {
  const w = pair();
  const api = stubApi(w);
  const { status, stdout, summary } = await runMain(w, api);
  assert.equal(status, 0, stdout);
  assert.deepEqual(api.writes.sort(), [["create", 1], ["create", 2]]);
  const line = stdout.split("\n").find((l) => l.startsWith("overlap-pairs "));
  const rec = JSON.parse(line.slice("overlap-pairs ".length));
  assert.deepEqual(rec.r2, [[1, 2, ["a.txt"]]]);
  // 1 list page + 3 files lists + 3 comment lists; the writes are not reads.
  assert.equal(rec.reads, 7);
  assert.equal(rec.rateLimit, 1000);
  assert.equal(rec.rateUsed, 9, "the used count of the LAST response: 7 reads and 2 writes");
  assert.match(summary, /Predicted conflicts/);
  assert.equal(own(api, 1).length, 1);
});

test("a failed write fails the run, naming the PR", async () => {
  const w = pair();
  const api = stubApi(w);
  api.fail.write = (method) => method === "POST";
  const { status, stdout } = await runMain(w, api);
  assert.equal(status, 1);
  assert.match(stdout, /::error::could not write the overlap comment on #1, #2/);
});

test("every PR skipped fails the run: 'read none' is not 'nothing overlaps'", async () => {
  const w = pair();
  for (const n of [1, 2, 3]) w.remote.git("update-ref", "-d", `refs/pull/${n}/head`);
  const { status, stdout } = await runMain(w, stubApi(w));
  assert.equal(status, 1);
  assert.match(stdout, /::error::read none of 3 open PR\(s\)/);
});

test("a partner's 404, through the real client, is a partner that is gone: its rows are dropped", async () => {
  const w = pair();
  const api = stubApi(w);
  await runMain(w, api);
  w.pull(2).state = "closed";
  api.writes.length = 0;
  const { status, stdout } = await runMain(w, api);
  assert.equal(status, 0, stdout);
  assert.deepEqual(api.writes, [["update", 1]]);
  assert.match(own(api, 1)[0].body, /No open PR overlaps this one any more/);
});
