import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { makeScaler } from "../scale.mjs";

// The fleet grows to the queue and never past the cap. Getting it wrong one
// way leaves PRs waiting for a slot; the other way bills idle machines.

const SECRET = "s3cret";
const NOW = 1_800_000_000_000;

function fleet({ queued, idle, hosts = [], startFails = false }) {
  const launches = [];
  const tokens = [];
  const starts = [];
  const scaler = makeScaler({
    secret: SECRET, label: "fp-ci", repo: "acme/app", slotsPerHost: 3, maxHosts: 5, bootSeconds: 180, now: () => NOW,
    github: { queuedJobs: async () => queued, idleRunners: async () => idle },
    ec2: {
      hosts: async () => hosts,
      launch: async (n, token) => { launches.push(n); tokens.push(token); return Array.from({ length: n }, (_, i) => `i-new${i}`); },
      start: async (ids) => {
        if (startFails) throw Object.assign(new Error("no spot capacity"), { name: "InsufficientInstanceCapacity" });
        starts.push(...ids);
        return ids;
      },
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
  return { deliver, launches, tokens, starts };
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

test("two evaluations that reach the same answer at once launch with the same idempotency token", async () => {
  const { deliver, tokens } = fleet({ queued: 6, idle: 0 });
  await deliver();
  await deliver();
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0], tokens[1], "EC2 would launch twice");
  assert.match(tokens[0], /^fleet-fp-ci-\d+-2$/);
});

const parked = (id, state = "stopped") => ({ id, state, launchedAt: NOW - 86_400_000, pool: true });

test("stopped pool hosts are started before anything is launched", async () => {
  const { deliver, launches, starts } = fleet({ queued: 4, idle: 0, hosts: [parked("p1"), parked("p2"), parked("p3")] });
  const r = await deliver();
  assert.deepEqual(starts, ["p1", "p2"], "4 jobs need 2 hosts; the pool has them");
  assert.deepEqual(launches, []);
  assert.equal(r.started, 2);
});

test("a queue bigger than the pool starts all of it and launches the rest", async () => {
  const { deliver, launches, starts } = fleet({ queued: 12, idle: 0, hosts: [parked("p1"), parked("p2")] });
  await deliver();
  assert.deepEqual(starts, ["p1", "p2"]);
  assert.deepEqual(launches, [2]);
});

test("a pool host that cannot start is launched instead, so the queue still gets its slots", async () => {
  const { deliver, launches } = fleet({ queued: 6, idle: 0, hosts: [parked("p1"), parked("p2")], startFails: true });
  const r = await deliver();
  assert.deepEqual(launches, [2]);
  assert.equal(r.started, 0);
});

test("a pool host still stopping is not started, and a running one is capacity like any other", async () => {
  const { deliver, launches, starts } = fleet({ queued: 3, idle: 0, hosts: [parked("p1", "stopping"), { ...parked("p2", "running"), launchedAt: NOW - 30_000 }] });
  assert.equal((await deliver()).launched, 0, "p2 is booting and brings 3 slots");
  assert.deepEqual(starts, []);
  assert.deepEqual(launches, []);
});

test("a queued delivery counts itself even before the jobs API lists it", async () => {
  const { deliver, launches } = fleet({ queued: 0, idle: 0, hosts: [up(600)] });
  assert.equal((await deliver()).launched, 1, "GitHub delivered the job; it is waiting somewhere");
  assert.deepEqual(launches, [1]);
});

test("a completed delivery adds no demand of its own", async () => {
  const { deliver, launches } = fleet({ queued: 0, idle: 0, hosts: [up(600)] });
  assert.equal((await deliver({ action: "completed" })).launched, 0);
  assert.deepEqual(launches, []);
});
