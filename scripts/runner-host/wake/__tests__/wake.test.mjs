import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { makeHandler, signatureValid } from "../wake.mjs";

// The only thing that brings a stopped CI host back. If it ignores a job
// meant for the host, that job waits until somebody notices; if it can be
// driven by anybody, anybody can run up the bill.

const SECRET = "s3cret";
const sign = (body) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

function fakeEc2(states) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async state(id) {
      calls.push(["state", id]);
      return states[Math.min(i++, states.length - 1)];
    },
    async start(id) {
      calls.push(["start", id]);
    },
  };
}

function deliver(handler, { event = "workflow_job", action = "queued", labels = ["future-pay-ci"], repo = "acme/app", signature, base64 = false } = {}) {
  const body = JSON.stringify({ action, repository: { full_name: repo }, workflow_job: { id: 1, name: "build", labels } });
  return handler({
    headers: { "X-GitHub-Event": event, "X-Hub-Signature-256": signature ?? sign(body) },
    body: base64 ? Buffer.from(body).toString("base64") : body,
    isBase64Encoded: base64,
  });
}

const setup = (states) => {
  const ec2 = fakeEc2(states);
  const handler = makeHandler({ secret: SECRET, instanceId: "i-1", label: "future-pay-ci", repo: "acme/app", ec2, waitMs: 200, pollMs: 10 });
  return { ec2, handler };
};

test("a queued job for this host starts it when it is stopped", async () => {
  const { ec2, handler } = setup(["stopped"]);
  const res = await deliver(handler);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(ec2.calls, [["state", "i-1"], ["start", "i-1"]]);
});

test("a host already up is left alone", async () => {
  for (const state of ["running", "pending"]) {
    const { ec2, handler } = setup([state]);
    assert.equal((await deliver(handler)).statusCode, 200);
    assert.ok(!ec2.calls.some(([c]) => c === "start"), `started a host that was ${state}`);
  }
});

test("a host still powering itself off is started once it has stopped", async () => {
  const { ec2, handler } = setup(["stopping", "stopping", "stopped"]);
  assert.equal((await deliver(handler)).statusCode, 200);
  assert.deepEqual(ec2.calls.at(-1), ["start", "i-1"]);
});

test("a host stuck stopping past the wait is reported, not retried for ever", async () => {
  const { ec2, handler } = setup(["stopping"]);
  assert.equal((await deliver(handler)).statusCode, 503);
  assert.ok(!ec2.calls.some(([c]) => c === "start"));
});

test("a body signed with the wrong secret, or not signed, never touches EC2", async () => {
  for (const signature of ["sha256=deadbeef", "", "sha1=abc"]) {
    const { ec2, handler } = setup(["stopped"]);
    assert.equal((await deliver(handler, { signature })).statusCode, 401);
    assert.deepEqual(ec2.calls, []);
  }
});

test("jobs for other runners, other actions and other repositories are ignored", async () => {
  const cases = [
    [{ labels: ["ubuntu-latest"] }, 202],
    [{ action: "completed" }, 202],
    [{ action: "in_progress" }, 202],
    [{ event: "push" }, 202],
    [{ repo: "evil/fork" }, 403],
  ];
  for (const [opts, code] of cases) {
    const { ec2, handler } = setup(["stopped"]);
    assert.equal((await deliver(handler, opts)).statusCode, code, JSON.stringify(opts));
    assert.deepEqual(ec2.calls, [], JSON.stringify(opts));
  }
});

test("GitHub's ping is answered", async () => {
  const { handler } = setup(["stopped"]);
  assert.equal((await deliver(handler, { event: "ping" })).statusCode, 200);
});

test("a base64-encoded body (how function URLs deliver some payloads) is verified on its bytes", async () => {
  const { ec2, handler } = setup(["stopped"]);
  assert.equal((await deliver(handler, { base64: true })).statusCode, 200);
  assert.deepEqual(ec2.calls.at(-1), ["start", "i-1"]);
});

test("signatureValid rejects a missing secret", () => {
  assert.equal(signatureValid("", Buffer.from("x"), sign("x")), false);
});
