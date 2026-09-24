import { strict as assert } from "node:assert";
import { test } from "node:test";
import { accrue, dayStart, hostCap, localDay } from "../budget.mjs";
import { makeScaler } from "../scale.mjs";

// The daily budget guard. Getting it wrong one way lets a runaway day bill
// without limit; the other way starves CI of hosts on a day that was cheap.

const MIN = 60_000;
const HOUR = 60 * MIN;
// 2026-09-24 12:00 in Brasília (UTC-3).
const noon = Date.parse("2026-09-24T15:00:00Z");
const opts = { utcOffsetHours: -3, idleCapMs: 10 * MIN };
const host = (id, launchedAt, rate = 1) => ({ id, launchedAt, rate });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("the local day starts at local midnight", () => {
  assert.equal(localDay(Date.parse("2026-09-25T02:59:00Z"), -3), "2026-09-24");
  assert.equal(localDay(Date.parse("2026-09-25T03:00:00Z"), -3), "2026-09-25");
  assert.equal(dayStart("2026-09-25", -3), Date.parse("2026-09-25T03:00:00Z"));
});

test("a host is billed by the second from launch at its hourly rate", () => {
  const s1 = accrue(null, [host("a", noon - 30 * MIN, 2)], noon, opts);
  close(s1.spent, 1); // half an hour at $2/h
  const s2 = accrue(s1, [host("a", noon - 30 * MIN, 2)], noon + 15 * MIN, opts);
  close(s2.spent, 1.5);
  assert.deepEqual(s2.live.a, [noon + 15 * MIN, 2]);
});

test("a host that is gone is charged at most the idle window past its last sighting", () => {
  const s1 = accrue(null, [host("a", noon, 6)], noon, opts);
  // Gone two hours later: it powered off within minutes, not two hours on.
  const s2 = accrue(s1, [], noon + 2 * HOUR, opts);
  close(s2.spent, 1); // 10 minutes at $6/h
  assert.deepEqual(s2.live, {});
  // Gone sooner than the window: charged only until now.
  const s3 = accrue(s1, [], noon + 5 * MIN, opts);
  close(s3.spent, 0.5);
});

test("a host up since yesterday is billed to today from midnight only", () => {
  const lateLastNight = Date.parse("2026-09-24T02:00:00Z"); // 23:00 on the 23rd, local
  const s = accrue(null, [host("a", lateLastNight, 1)], Date.parse("2026-09-24T04:00:00Z"), opts);
  assert.equal(s.day, "2026-09-24");
  close(s.spent, 1); // 03:00Z (local midnight) to 04:00Z
});

test("local midnight resets the total and the alert, and carries live hosts over", () => {
  const evening = Date.parse("2026-09-25T02:30:00Z");
  const s1 = { ...accrue(null, [host("a", evening - HOUR, 1), host("b", evening - HOUR, 1)], evening, opts), alerted: true };
  const s2 = accrue(s1, [host("a", evening - HOUR, 1)], Date.parse("2026-09-25T03:30:00Z"), opts);
  assert.equal(s2.day, "2026-09-25");
  assert.equal(s2.alerted, false);
  close(s2.spent, 0.5); // a: from midnight (03:00Z) to 03:30Z; b's leftovers stay in yesterday
  assert.deepEqual(Object.keys(s2.live), ["a"]);
});

test("the cap drops to the trickle once the budget is spent, and only then", () => {
  const cfg = { budget: 10, maxHosts: 30, degradedMaxHosts: 2 };
  assert.equal(hostCap(null, cfg), 30);
  assert.equal(hostCap({ spent: 9.99 }, cfg), 30);
  assert.equal(hostCap({ spent: 10 }, cfg), 2);
  assert.equal(hostCap({ spent: 50 }, { ...cfg, budget: 0 }), 30, "a budget of 0 turns the guard off");
});

test("over budget, a queue of twenty launches only up to the trickle", async () => {
  let spent = 12;
  const launched = [];
  const scaler = makeScaler({
    secret: "s", label: "l", repo: "o/r", slotsPerHost: 2,
    maxHosts: () => hostCap({ spent }, { budget: 10, maxHosts: 30, degradedMaxHosts: 2 }),
    github: { queuedJobs: async () => 20, idleRunners: async () => 0 },
    ec2: { hosts: async () => [], start: async () => [], launch: async (t) => { launched.push(...t); return t; } },
  });
  const sign = async (body) => {
    const { createHmac } = await import("node:crypto");
    return `sha256=${createHmac("sha256", "s").update(body).digest("hex")}`;
  };
  const body = JSON.stringify({ action: "queued", repository: { full_name: "o/r" }, workflow_job: { labels: ["l"] } });
  const call = async () => scaler({ body, headers: { "x-github-event": "workflow_job", "x-hub-signature-256": await sign(body) } });
  await call();
  assert.equal(launched.length, 2);
  // Under budget the same queue gets its ten hosts.
  spent = 3;
  launched.length = 0;
  await call();
  assert.equal(launched.length, 10);
});
