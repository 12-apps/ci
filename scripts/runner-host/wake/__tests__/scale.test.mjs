import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { makeScaler } from "../scale.mjs";

// The fleet grows to the queue and never past the cap. Getting it wrong one
// way leaves PRs waiting for a slot; the other way bills idle machines.

const SECRET = "s3cret";
const NOW = 1_800_000_000_000;

function fleet({ queued, idle, hosts = [] }) {
  const launches = [];
  const scaler = makeScaler({
    secret: SECRET, label: "fp-ci", repo: "acme/app", slotsPerHost: 3, maxHosts: 5, bootSeconds: 180, now: () => NOW,
    github: { queuedJobs: async () => queued, idleRunners: async () => idle },
    ec2: {
      hosts: async () => hosts,
      launch: async (n) => { launches.push(n); return Array.from({ length: n }, (_, i) => `i-new${i}`); },
    },
  });
  const deliver = async ({ action = "queued", labels = ["fp-ci"], repo = "acme/app", sig } = {}) => {
    const body = JSON.stringify({ action, repository: { full_name: repo }, workflow_job: { labels } });
    const res = await scaler({
      headers: { "x-github-event": "workflow_job", "x-hub-signature-256": sig ?? `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}` },
      body,
    });
    return { status: res.statusCode, ...JSON.parse(res.body) };
  };
  return { deliver, launches };
}

const up = (ageSeconds) => ({ id: "i-x", state: "running", launchedAt: NOW - ageSeconds * 1000 });

test("a queue with no free slot launches enough hosts for all of it, at once", async () => {
  const { deliver, launches } = fleet({ queued: 10, idle: 0 });
  const r = await deliver();
  assert.equal(r.launched, 4, "10 jobs / 3 slots = 4 hosts");
  assert.deepEqual(launches, [4]);
});

test("idle runners absorb the queue first", async () => {
  const { deliver, launches } = fleet({ queued: 3, idle: 3, hosts: [up(600)] });
  assert.equal((await deliver()).launched, 0);
  assert.deepEqual(launches, []);
});

test("hosts still booting count as capacity, so a burst of deliveries does not over-launch", async () => {
  const { deliver } = fleet({ queued: 6, idle: 0, hosts: [up(30), { id: "i-p", state: "pending", launchedAt: NOW }] });
  assert.equal((await deliver()).launched, 0, "2 booting hosts already bring 6 slots");
});

test("a host up past the boot window with no idle runner is busy, not incoming", async () => {
  const { deliver } = fleet({ queued: 3, idle: 0, hosts: [up(600)] });
  assert.equal((await deliver()).launched, 1);
});

test("the fleet never grows past the cap", async () => {
  const { deliver } = fleet({ queued: 100, idle: 0, hosts: [up(600), up(600)] });
  assert.equal((await deliver()).launched, 3, "cap 5, 2 running");
});

test("stopped and terminated hosts do not count", async () => {
  const { deliver } = fleet({ queued: 3, idle: 0, hosts: [{ id: "a", state: "stopped", launchedAt: NOW }, { id: "b", state: "terminated", launchedAt: NOW }] });
  assert.equal((await deliver()).launched, 1);
});

test("a completed job re-evaluates, so backlog left by the cap is picked up", async () => {
  const { deliver } = fleet({ queued: 4, idle: 0 });
  assert.equal((await deliver({ action: "completed" })).launched, 2);
});

test("unsigned, foreign or unrelated deliveries launch nothing", async () => {
  for (const opts of [{ sig: "sha256=00" }, { repo: "evil/fork" }, { labels: ["ubuntu-latest"] }, { action: "in_progress" }]) {
    const { deliver, launches } = fleet({ queued: 50, idle: 0 });
    await deliver(opts);
    assert.deepEqual(launches, [], JSON.stringify(opts));
  }
});
