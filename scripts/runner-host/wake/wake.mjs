// Start the stopped CI host when GitHub queues a job for it.
//
// A repository webhook (event: Workflow jobs) posts every job's lifecycle
// here. Only a `queued` job whose labels include the host's label matters:
// the host powers itself off when idle (idle-stop.sh), so a queued job with
// nowhere to run would otherwise wait until somebody noticed.
//
// Pure logic, no AWS SDK: index.mjs wires `ec2` to the real client, and the
// tests hand it a fake. Every answer is an HTTP response for the Lambda
// function URL, and GitHub shows it under the webhook's Recent Deliveries.
import { createHmac, timingSafeEqual } from "node:crypto";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GitHub's X-Hub-Signature-256: sha256=<hex HMAC of the raw body>. */
export function signatureValid(secret, rawBody, header) {
  if (!secret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

const reply = (statusCode, message) => ({ statusCode, body: JSON.stringify({ message }) });

/**
 * @param {object} cfg
 * @param {string} cfg.secret      webhook secret
 * @param {string} cfg.instanceId  the host
 * @param {string} cfg.label       the runner label that means "this host"
 * @param {string} cfg.repo        owner/name the webhook belongs to
 * @param {{ state(id: string): Promise<string>, start(id: string): Promise<void> }} cfg.ec2
 * @param {number} [cfg.waitMs]    how long to wait for a stopping host
 * @param {number} [cfg.pollMs]
 */
export function makeHandler({ secret, instanceId, label, repo, ec2, waitMs = 75_000, pollMs = 5_000 }) {
  return async (event) => {
    const headers = Object.fromEntries(
      Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64") : Buffer.from(event.body ?? "");
    if (!signatureValid(secret, raw, headers["x-hub-signature-256"])) return reply(401, "bad signature");

    const kind = headers["x-github-event"];
    if (kind === "ping") return reply(200, "pong");
    if (kind !== "workflow_job") return reply(202, `ignored event ${kind}`);

    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return reply(400, "body is not JSON");
    }
    if (payload.repository?.full_name !== repo) return reply(403, "not this repository");
    if (payload.action !== "queued") return reply(202, `ignored action ${payload.action}`);
    const labels = payload.workflow_job?.labels ?? [];
    if (!labels.includes(label)) return reply(202, "job is not for this host");

    // A host that is powering itself off cannot be started until it is
    // stopped; that window is the one a job queued "just too late" lands in.
    const deadline = Date.now() + waitMs;
    for (;;) {
      const state = await ec2.state(instanceId);
      if (state === "running" || state === "pending") return reply(200, `host already ${state}`);
      if (state === "stopped") {
        await ec2.start(instanceId);
        console.log(`started ${instanceId} for job ${payload.workflow_job?.id} (${payload.workflow_job?.name})`);
        return reply(200, "host starting");
      }
      if (state !== "stopping" || Date.now() >= deadline) return reply(503, `host is ${state}; not started`);
      await sleep(pollMs);
    }
  };
}
