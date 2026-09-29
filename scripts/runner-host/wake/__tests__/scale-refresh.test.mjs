import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { makeScaler } from "../scale.mjs";

// A `completed` delivery only re-reads the queue; it brings no job. When the
// queue was just read, or the GitHub allowance is running out, it is skipped,
// so the deliveries that do bring jobs still find requests left.

const SECRET = "s3cret";

function scaler({ allowance } = {}) {
  let clock = 1_800_000_000_000;
  let reads = 0;
  const handler = makeScaler({
    secret: SECRET, label: "fp-ci", repo: "acme/app", slotsPerHost: 2, maxHosts: 5, now: () => clock,
    allowance: allowance ?? (() => undefined),
    github: {
      queuedJobs: async () => { reads++; return 0; }, idleRunners: async () => 0,
      lostJobs: async () => 0, rerunFailed: async () => {},
    },
    ec2: { hosts: async () => [], launch: async (t) => t.map((_, i) => `i-${i}`), start: async (ids) => ids },
  });
  const deliver = async (action) => {
    const body = JSON.stringify({ action, repository: { full_name: "acme/app" }, workflow_job: { labels: ["fp-ci"] } });
    const res = await handler({
      headers: { "x-github-event": "workflow_job", "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}` },
      body,
    });
    return { status: res.statusCode, ...JSON.parse(res.body) };
  };
  return { deliver, reads: () => reads, advance: (s) => { clock += s * 1000; } };
}

test("a completed delivery right after a read of the queue does not read it again", async () => {
  const s = scaler();
  assert.equal((await s.deliver("queued")).status, 200);
  s.advance(5);
  const skipped = await s.deliver("completed");
  assert.equal(skipped.status, 202);
  assert.match(skipped.message, /^refresh skipped: queue read 5s ago$/);
  assert.equal(s.reads(), 1);
});

test("a completed delivery after the refresh interval reads the queue", async () => {
  const s = scaler();
  await s.deliver("queued");
  s.advance(15);
  assert.equal((await s.deliver("completed")).status, 200);
  assert.equal(s.reads(), 2);
});

test("the first completed delivery of a container reads the queue", async () => {
  const s = scaler();
  assert.equal((await s.deliver("completed")).status, 200);
  assert.equal(s.reads(), 1);
});

test("a queued delivery always reads the queue, however recent the last read", async () => {
  const s = scaler();
  await s.deliver("queued");
  assert.equal((await s.deliver("queued")).status, 200);
  assert.equal(s.reads(), 2);
});

test("with less than a fifth of the allowance left, only queued deliveries read the queue", async () => {
  const s = scaler({ allowance: () => ({ remaining: 999, limit: 5000 }) });
  const skipped = await s.deliver("completed");
  assert.equal(skipped.status, 202);
  assert.match(skipped.message, /999 of 5000 GitHub requests left/);
  assert.equal((await s.deliver("queued")).status, 200);
  assert.equal(s.reads(), 1);
});

test("with a fifth or more of the allowance left, a completed delivery reads the queue", async () => {
  const s = scaler({ allowance: () => ({ remaining: 1000, limit: 5000 }) });
  assert.equal((await s.deliver("completed")).status, 200);
});
