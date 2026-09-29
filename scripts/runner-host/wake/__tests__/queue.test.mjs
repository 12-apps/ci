import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { makeQueue } from "../queue.mjs";
import { makeScaler } from "../scale.mjs";

// The queue is kept from the webhooks, so counting it costs no GitHub request.
// These pin what the table holds after each delivery, the reconcile that
// repairs a lost delivery, and the fall back to the API when the table fails.

// Just enough of DynamoDB for queue.mjs: items by id, a conditional update.
function fakeDynamo({ failing = false } = {}) {
  const items = new Map();
  const cmd = (type) => class { constructor(input) { this.type = type; this.input = input; } };
  const commands = { PutItemCommand: cmd("put"), DeleteItemCommand: cmd("delete"), ScanCommand: cmd("scan"), UpdateItemCommand: cmd("update") };
  const client = {
    calls: 0,
    async send({ type, input }) {
      this.calls++;
      if (failing) throw Object.assign(new Error("no table"), { name: "ResourceNotFoundException" });
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
  return { client, commands, items };
}

function setup({ failing = false, apiQueued = [] } = {}) {
  let clock = 1_800_000_000_000;
  const db = fakeDynamo({ failing });
  const queue = makeQueue({ ...db, table: "q", now: () => clock });
  const api = { reads: 0, ids: apiQueued };
  const launches = [];
  const handler = makeScaler({
    secret: "s", label: "fp-ci", repo: "acme/app", slotsPerHost: 2, maxHosts: 10, now: () => clock, queue,
    github: {
      queuedJobIds: async () => { api.reads++; return api.ids; },
      queuedJobs: async () => { api.reads++; return api.ids.length; },
      idleRunners: async () => 0, lostJobs: async () => 0, rerunFailed: async () => {},
    },
    ec2: { hosts: async () => [], launch: async (t) => { launches.push(t.length); return t.map((_, i) => `i-${i}`); }, start: async (ids) => ids },
  });
  const deliver = async (action, id) => {
    const body = JSON.stringify({ action, repository: { full_name: "acme/app" }, workflow_job: { id, labels: ["fp-ci"] } });
    const res = await handler({ headers: { "x-github-event": "workflow_job", "x-hub-signature-256": `sha256=${createHmac("sha256", "s").update(body).digest("hex")}` }, body });
    return { status: res.statusCode, ...JSON.parse(res.body) };
  };
  return { db, queue, api, launches, deliver, advance: (s) => { clock += s * 1000; } };
}

test("queued puts the job on the table; in_progress and completed take it off", async () => {
  const s = setup();
  await s.deliver("queued", 1);
  await s.deliver("queued", 2);
  assert.equal(await s.queue.count(), 2);
  assert.equal((await s.deliver("in_progress", 1)).message, "job started");
  assert.equal(await s.queue.count(), 1);
  await s.deliver("completed", 2);
  assert.equal(await s.queue.count(), 0);
});

test("the table counts the queue: after the first reconcile no delivery reads the API", async () => {
  const s = setup();
  await s.deliver("queued", 1); // claims the reconcile: one API read
  assert.equal(s.api.reads, 1);
  for (let i = 2; i <= 6; i++) await s.deliver("queued", i);
  assert.equal(s.api.reads, 1, "five more queued deliveries, no API read");
  const last = await s.deliver("queued", 7);
  assert.equal(last.queued, 7);
});

test("a completed delivery with an empty queue does nothing", async () => {
  const s = setup();
  const r = await s.deliver("completed", 9);
  assert.equal(r.status, 202);
  assert.equal(r.message, "refresh skipped: queue empty");
  assert.equal(s.api.reads, 0);
});

test("the reconcile repairs a lost delivery, and runs once per interval", async () => {
  const s = setup({ apiQueued: [5, 6] });
  await s.deliver("queued", 5); // reconcile: the API lists 5 and 6; 6's delivery was lost
  assert.deepEqual([...s.db.items.keys()].filter((k) => k.startsWith("j#")).sort(), ["j#5", "j#6"]);
  s.api.ids = [];
  s.advance(300);
  await s.deliver("queued", 8);
  assert.equal(s.api.reads, 1, "the next reconcile is not due yet");
  s.advance(301);
  await s.deliver("queued", 9); // due: the API lists nothing; 5, 6 and 8 are older than the grace and go, 9 stays
  assert.equal(s.api.reads, 2);
  assert.deepEqual([...s.db.items.keys()].filter((k) => k.startsWith("j#")), ["j#9"]);
});

test("a reconcile keeps a job delivered moments before the API lists it", async () => {
  const s = setup({ apiQueued: [] });
  const q = s.queue;
  await q.add(42);
  assert.deepEqual(await q.replace([]), { removed: 0, added: 0 });
  s.advance(121);
  assert.deepEqual(await q.replace([]), { removed: 1, added: 0 });
});

test("when the table fails, the scaler reads the API as before and still launches", async () => {
  const s = setup({ failing: true, apiQueued: [1, 2, 3, 4] });
  const r = await s.deliver("queued", 1);
  assert.equal(r.status, 200);
  assert.equal(r.queued, 4);
  assert.deepEqual(s.launches, [2]);
});
