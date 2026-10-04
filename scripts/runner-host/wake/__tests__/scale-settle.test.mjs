import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { makeQueue } from "../queue.mjs";
import { makeScaler } from "../scale.mjs";

// Settling: an evaluation that would launch waits `settleSeconds`, reads the
// queue again and launches only what is still missing. Most fleet jobs last
// under a minute, so a slot usually frees inside the wait (2026-10-02: median
// queue wait 3 s, p90 39 s) and the host it would have launched is never paid.

const SECRET = "s3cret";
const NOW = 1_800_000_000_000;

// `state` is what the API answers; `during` runs inside the settle wait, the
// way jobs are picked up by freed slots while the scaler sleeps.
function scaler({ state, settleSeconds = 30, during = () => {}, queue, hosts = [] }) {
  let clock = NOW;
  const launches = [];
  const slept = [];
  const handler = makeScaler({
    secret: SECRET, label: "fp-ci", repo: "acme/app", slotsPerHost: 2, maxHosts: 10, now: () => clock, queue, settleSeconds,
    sleep: async (ms) => { slept.push(ms); clock += ms; during(state); },
    github: {
      queuedJobs: async () => state.queued, queuedJobIds: async () => state.ids ?? [],
      idleRunners: async () => state.idle, lostJobs: async () => 0, rerunFailed: async () => {},
    },
    ec2: { hosts: async () => hosts, launch: async (t) => { launches.push(t.length); return t.map((_, i) => `i-${i}`); }, start: async (ids) => ids },
  });
  const deliver = async (action = "queued", id = 1) => {
    const body = JSON.stringify({ action, repository: { full_name: "acme/app" }, workflow_job: { id, labels: ["fp-ci"] } });
    const res = await handler({
      headers: { "x-github-event": "workflow_job", "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}` },
      body,
    });
    return { status: res.statusCode, ...JSON.parse(res.body) };
  };
  return { deliver, launches, slept, advance: (s) => { clock += s * 1000; } };
}

test("a job that finds a slot while the scaler settles launches nothing", async () => {
  const s = scaler({ state: { queued: 1, idle: 0 }, during: (st) => { st.queued = 0; } });
  const r = await s.deliver();
  assert.deepEqual(s.slept, [30_000], "waited once, for settleSeconds");
  assert.equal(r.launched, 0);
  assert.deepEqual(s.launches, []);
});

test("jobs still waiting after the settle get their hosts, sized to what is left", async () => {
  // 6 queued; 2 slots free up during the wait: 4 left, 2 slots a host.
  const s = scaler({ state: { queued: 6, idle: 0 }, during: (st) => { st.queued = 4; } });
  const r = await s.deliver();
  assert.equal(r.launched, 2);
  assert.deepEqual(s.launches, [2]);
});

test("after the settle the announced job is not counted again: only the queue read decides", async () => {
  // The job this delivery announced was picked up; the API lists none.
  const s = scaler({ state: { queued: 0, idle: 0 }, during: () => {} });
  const r = await s.deliver();
  assert.equal(s.slept.length, 1, "the first evaluation counted the delivered job and settled");
  assert.equal(r.launched, 0);
});

test("nothing to launch means no wait at all", async () => {
  const s = scaler({ state: { queued: 2, idle: 2 } });
  const r = await s.deliver();
  assert.deepEqual(s.slept, []);
  assert.equal(r.launched, 0);
});

test("settleSeconds 0 launches at once, as before", async () => {
  const s = scaler({ state: { queued: 4, idle: 0 }, settleSeconds: 0 });
  const r = await s.deliver();
  assert.deepEqual(s.slept, []);
  assert.equal(r.launched, 2);
});

// Just enough of DynamoDB for the settle claim.
function fakeDynamo() {
  const items = new Map();
  const cmd = (type) => class { constructor(input) { this.type = type; this.input = input; } };
  const commands = { PutItemCommand: cmd("put"), DeleteItemCommand: cmd("delete"), ScanCommand: cmd("scan"), UpdateItemCommand: cmd("update") };
  const client = {
    async send({ type, input }) {
      if (type === "put") items.set(input.Item.id.S, input.Item);
      if (type === "delete") items.delete(input.Key.id.S);
      if (type === "scan") return { Items: [...items.values()].filter((i) => i.id.S.startsWith(input.ExpressionAttributeValues[":j"].S)) };
      if (type === "update") {
        const cur = items.get(input.Key.id.S);
        const due = Number(input.ExpressionAttributeValues[":due"].N);
        if (cur && Number(cur.at.N) >= due) throw Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });
        items.set(input.Key.id.S, { id: input.Key.id, at: input.ExpressionAttributeValues[":now"] });
      }
      return {};
    },
  };
  return { client, commands };
}

test("one evaluation settles at a time; the others leave the launch to it", async () => {
  let clock = NOW;
  const queue = makeQueue({ ...fakeDynamo(), table: "q", now: () => clock });
  assert.equal(await queue.claimSettle(30), true);
  assert.equal(await queue.claimSettle(30), false, "a second claim inside the window is refused");
  clock += 31_000;
  assert.equal(await queue.claimSettle(30), true, "the claim frees once the window passes");
});

test("a delivery that arrives while another evaluation settles does not launch", async () => {
  let clock = NOW;
  const queue = makeQueue({ ...fakeDynamo(), table: "q", now: () => clock });
  await queue.claimSettle(30); // another container is settling
  const s = scaler({ state: { queued: 3, idle: 0 }, queue });
  const r = await s.deliver("queued", 7);
  assert.equal(r.settling, "elsewhere");
  assert.equal(r.launched, 0);
  assert.deepEqual(s.slept, []);
  assert.deepEqual(s.launches, []);
});

test("a queue table that cannot be claimed settles in this evaluation instead of never launching", async () => {
  const failing = {
    claimSettle: async () => { throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }); },
    claimReconcile: async () => false, count: async () => 3, add: async () => {}, remove: async () => {},
  };
  const s = scaler({ state: { queued: 3, idle: 0 }, queue: failing });
  const r = await s.deliver("queued", 9);
  assert.equal(s.slept.length, 1);
  assert.equal(r.launched, 2);
});
