import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { makeScaler, regionOrder, spotAttempts } from "../scale.mjs";

// The fleet grows to the queue and never past the cap. Getting it wrong one
// way leaves PRs waiting for a slot; the other way bills idle machines.

const SECRET = "s3cret";
const NOW = 1_800_000_000_000;

function fleet({ queued, idle, hosts = [], startFails = false, lost = 0, issued = new Map() }) {
  const reruns = [];
  const launches = [];
  const tokens = [];
  const starts = [];
  const scaler = makeScaler({
    secret: SECRET, label: "fp-ci", repo: "acme/app", slotsPerHost: 3, maxHosts: 5, bootSeconds: 180, now: () => NOW,
    github: {
      queuedJobs: async () => queued, idleRunners: async () => idle,
      lostJobs: async () => lost, rerunFailed: async (id) => { reruns.push(id); },
    },
    ec2: {
      hosts: async () => hosts,
      // EC2's ClientToken: a token already used returns its host, not a new one.
      launch: async (batch) => {
        launches.push(batch.length);
        tokens.push(...batch);
        return batch.map((t) => (issued.has(t) ? issued.get(t) : issued.set(t, `i-${issued.size}`).get(t)));
      },
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
  const finish = async ({ conclusion = "failure", attempt = 1, repo = "acme/app", action = "completed" } = {}) => {
    const body = JSON.stringify({ action, repository: { full_name: repo }, workflow_run: { id: 77, conclusion, run_attempt: attempt } });
    const res = await scaler({
      headers: { "x-github-event": "workflow_run", "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}` },
      body,
    });
    return { status: res.statusCode, ...JSON.parse(res.body) };
  };
  return { deliver, finish, launches, tokens, starts, reruns, issued, scaler };
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

test("two evaluations that reach the same answer at once launch it once", async () => {
  const issued = new Map();
  const a = fleet({ queued: 6, idle: 0, issued });
  const b = fleet({ queued: 6, idle: 0, issued });
  await Promise.all([a.deliver(), b.deliver()]);
  assert.equal(issued.size, 2, "6 jobs / 3 slots = 2 hosts, launched once");
  assert.deepEqual(a.tokens.map((t) => t.replace(/-\d+-/, "-W-")), ["fleet-fp-ci-W-1", "fleet-fp-ci-W-2"]);
});

test("overlapping evaluations that see different queues launch the larger answer, not the sum", async () => {
  // Future-pay #1978's re-run: 16 and 17 queued jobs, seen a moment apart,
  // launched 8 + 9 hosts under per-answer tokens.
  const issued = new Map();
  // Here: 10 and 13 queued at 3 slots a host want 4 and 5 hosts.
  const a = fleet({ queued: 10, idle: 0, issued });
  const b = fleet({ queued: 13, idle: 0, issued });
  await Promise.all([a.deliver(), b.deliver()]);
  assert.equal(issued.size, 5, "max(4, 5) hosts, not 4 + 5");
});

test("the next position after hosts already running gets a new token", async () => {
  const issued = new Map();
  await fleet({ queued: 3, idle: 0, issued }).deliver();
  await fleet({ queued: 3, idle: 0, hosts: [up(600)], issued }).deliver();
  assert.equal(issued.size, 2, "position 1, then position 2 once the first host is live and busy");
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

test("a failed run that lost a job to a reclaimed host re-runs its failed jobs", async () => {
  const { finish, reruns } = fleet({ queued: 0, idle: 0, lost: 2 });
  const r = await finish();
  assert.equal(r.status, 200);
  assert.deepEqual(reruns, [77]);
});

test("a run that failed on its own merits is not re-run", async () => {
  const { finish, reruns } = fleet({ queued: 0, idle: 0, lost: 0 });
  await finish();
  assert.deepEqual(reruns, []);
});

test("re-runs stop at the attempt cap, successes and foreign runs are ignored", async () => {
  for (const opts of [{ attempt: 3 }, { conclusion: "success" }, { conclusion: "cancelled" }, { repo: "evil/fork" }, { action: "requested" }]) {
    const { finish, reruns } = fleet({ queued: 0, idle: 0, lost: 5 });
    await finish(opts);
    assert.deepEqual(reruns, [], JSON.stringify(opts));
  }
});

const pools = (...names) => names.map((n) => ({ InstanceType: n.split("@")[0], SubnetId: n.split("@")[1] }));
const plan = (attempts) => attempts.map((a) => `${a.region}: ${a.overrides.map((p) => `${p.InstanceType}@${p.SubnetId}`).join(" ")}`);

test("a pool at the cap is skipped, so a burst spreads across pools", () => {
  const offered = new Map([["ohio", pools("m7a@a", "m7a@b", "r7a@a")]]);
  const inPool = new Map([["m7a@a", 2], ["m7a@b", 1]]);
  assert.deepEqual(plan(spotAttempts(["ohio"], offered, inPool, 2)), ["ohio: m7a@b r7a@a"]);
});

test("a region whose pools are all at the cap is passed over for the next one", () => {
  const offered = new Map([["ohio", pools("m7a@a")], ["virginia", pools("m7a@x", "r7a@y")]]);
  assert.deepEqual(plan(spotAttempts(["ohio", "virginia"], offered, new Map([["m7a@a", 2]]), 2)), ["virginia: m7a@x r7a@y"]);
});

test("when every pool of every region is at the cap, all of them stay open: a waiting job costs more", () => {
  const offered = new Map([["ohio", pools("m7a@a", "r7a@a")], ["virginia", pools("m7a@x")], ["nowhere", []]]);
  const inPool = new Map([["m7a@a", 2], ["r7a@a", 5], ["m7a@x", 2]]);
  assert.deepEqual(plan(spotAttempts(["ohio", "virginia", "nowhere"], offered, inPool, 2)), ["ohio: m7a@a r7a@a", "virginia: m7a@x"]);
});

test("regions go by placement tier, then by the configured (cheapest-first) order", () => {
  const regions = ["us-east-2", "eu-north-1", "us-east-1"];
  assert.deepEqual(regionOrder(regions, new Map([["us-east-2", 9], ["eu-north-1", 9], ["us-east-1", 9]])), regions);
  // One point is noise: Ohio at 7 still beats Virginia at 9.
  assert.deepEqual(regionOrder(regions, new Map([["us-east-2", 7], ["eu-north-1", 8], ["us-east-1", 9]])), regions);
  // A crowded Ohio drops behind both.
  assert.deepEqual(regionOrder(regions, new Map([["us-east-2", 3], ["eu-north-1", 5], ["us-east-1", 9]])), ["us-east-1", "eu-north-1", "us-east-2"]);
});

test("without scores the configured order decides", () => {
  assert.deepEqual(regionOrder(["b", "a"], new Map()), ["b", "a"]);
  assert.deepEqual(regionOrder(["b", "a"], new Map([["a", 2]])), ["b", "a"]);
});
