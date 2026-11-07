import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { makeScaler } from "../scale.mjs";

// FUT-4536: a light pool is a second fleet, the same scaler deployed again
// under its own label, function, queue table, budget and webhook (README, "A
// light pool"). Its webhook secret is one the owner creates by hand and keeps
// in SSM, so the scaler takes the secret as a function that reads it. Two
// scalers on one repository each receive every job; each must act on its own
// label only, or a burst of short jobs would launch big hosts and the other way
// round.

const NOW = 1_800_000_000_000;
const sign = (secret, body) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function fleet({ label, secret, queued = 4 }) {
  const launches = [];
  const handler = makeScaler({
    secret, label, repo: "acme/app", slotsPerHost: 2, maxHosts: 10, now: () => NOW,
    github: { queuedJobs: async () => queued, idleRunners: async () => 0, lostJobs: async () => 0, rerunFailed: async () => {} },
    ec2: { hosts: async () => [], launch: async (t) => { launches.push(t.length); return t.map((_, i) => `i-${i}`); }, start: async (ids) => ids },
  });
  const deliver = async (labels, key) => {
    const body = JSON.stringify({ action: "queued", repository: { full_name: "acme/app" }, workflow_job: { id: 1, labels } });
    const res = await handler({ headers: { "x-github-event": "workflow_job", "x-hub-signature-256": sign(key, body) }, body });
    return { status: res.statusCode, ...JSON.parse(res.body) };
  };
  return { deliver, launches };
}

test("a secret read from a function signs deliveries exactly as a string does", async () => {
  let reads = 0;
  const light = fleet({ label: "fp-ci-light", secret: async () => { reads += 1; return "from-ssm"; } });
  const ok = await light.deliver(["fp-ci-light"], "from-ssm");
  assert.equal(ok.status, 200);
  assert.equal(ok.launched, 2, "4 queued / 2 slots");
  assert.ok(reads >= 1);
  const bad = await light.deliver(["fp-ci-light"], "something-else");
  assert.equal(bad.status, 401);
});

test("a string secret is unchanged: today's fleet", async () => {
  const main = fleet({ label: "fp-ci", secret: "s3cret" });
  assert.equal((await main.deliver(["fp-ci"], "s3cret")).status, 200);
  assert.equal((await main.deliver(["fp-ci"], "from-ssm")).status, 401);
});

test("a secret function that yields nothing refuses every delivery", async () => {
  const light = fleet({ label: "fp-ci-light", secret: async () => "" });
  assert.equal((await light.deliver(["fp-ci-light"], "")).status, 401);
});

test("each fleet acts on its own label only", async () => {
  const main = fleet({ label: "fp-ci", secret: "a" });
  const light = fleet({ label: "fp-ci-light", secret: async () => "b" });
  // A short job queued for the light pool: the main fleet launches nothing.
  assert.match((await main.deliver(["fp-ci-light"], "a")).message, /not for this fleet/);
  assert.deepEqual(main.launches, []);
  // A heavy job queued for the main fleet: the light pool launches nothing.
  assert.match((await light.deliver(["fp-ci"], "b")).message, /not for this fleet/);
  assert.deepEqual(light.launches, []);
  // Each still answers its own.
  assert.equal((await light.deliver(["fp-ci-light"], "b")).launched, 2);
  assert.equal((await main.deliver(["fp-ci"], "a")).launched, 2);
});

test("index.mjs reads the secret from WEBHOOK_SECRET_PARAMETER only when it is set", () => {
  const index = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  assert.match(index, /if \(!env\.WEBHOOK_SECRET_PARAMETER\) return env\.WEBHOOK_SECRET;/);
  assert.match(index, /GetParameterCommand\(\{ Name: env\.WEBHOOK_SECRET_PARAMETER, WithDecryption: true \}\)/);
  assert.match(index, /secret: env\.WEBHOOK_SECRET_PARAMETER \? secret : env\.WEBHOOK_SECRET,/);
});

test("a light pool's types are priced at their own on-demand rate, not the dearest 2xlarge", () => {
  const index = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  for (const type of ["m7a.large", "m6a.large", "m7i.large", "m6i.large", "r7a.large", "r6a.large", "r7i.large", "r6i.large"]) {
    assert.match(index, new RegExp(`"${type.replace(".", "\\.")}": 0\\.\\d+`), type);
  }
});
