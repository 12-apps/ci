// Size the runner fleet to the queue: no job waits for a slot.
//
// EC2 bills by the second, so ten hosts for ten minutes cost what one host
// costs for a hundred. The fleet therefore grows to whatever the queue needs
// at once, and every host terminates itself when idle (idle-stop.sh), so
// nothing is billed while nothing runs.
//
// Called for every `workflow_job` delivery. `queued` and `completed` both
// re-evaluate: the first adds demand, the second is the moment a burst that
// arrived faster than hosts boot is noticed again. The function runs with a
// reserved concurrency of 1, so evaluations never overlap and a burst of a
// hundred deliveries launches what the queue needs, not a hundred hosts.
//
//   deficit = queued jobs − idle runners − slots on hosts still booting
//   launch  = ceil(deficit / slotsPerHost), capped at maxHosts
//
// Pure logic: index.mjs wires `github` and `ec2`, the tests fake them.
import { signatureValid } from "./wake.mjs";

const reply = (statusCode, message, extra = {}) => ({ statusCode, body: JSON.stringify({ message, ...extra }) });

/**
 * @param {object} cfg
 * @param {{ queuedJobs(label: string): Promise<number>, idleRunners(label: string): Promise<number> }} cfg.github
 * @param {{ hosts(): Promise<{ id: string, state: string, launchedAt: number }[]>, launch(n: number): Promise<string[]> }} cfg.ec2
 */
export function makeScaler({ secret, label, repo, github, ec2, slotsPerHost = 3, maxHosts = 30, bootSeconds = 180, now = () => Date.now() }) {
  async function evaluate() {
    const [queued, idle, hosts] = await Promise.all([github.queuedJobs(label), github.idleRunners(label), ec2.hosts()]);
    const live = hosts.filter((h) => h.state === "pending" || h.state === "running");
    // A host that has not registered its runners yet is capacity on the way.
    const booting = live.filter((h) => h.state === "pending" || now() - h.launchedAt < bootSeconds * 1000);
    const deficit = queued - idle - booting.length * slotsPerHost;
    const room = Math.max(0, maxHosts - live.length);
    const launch = Math.min(room, Math.max(0, Math.ceil(deficit / slotsPerHost)));
    const launched = launch > 0 ? await ec2.launch(launch) : [];
    const decision = { queued, idle, hosts: live.length, booting: booting.length, launched: launched.length };
    console.log(JSON.stringify(decision));
    if (deficit > 0 && room === 0) console.log(`at the ${maxHosts}-host cap; ${deficit} job(s) wait`);
    return decision;
  }

  return async (event) => {
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
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
    if (!["queued", "completed"].includes(payload.action)) return reply(202, `ignored action ${payload.action}`);
    if (!(payload.workflow_job?.labels ?? []).includes(label)) return reply(202, "job is not for this fleet");
    return reply(200, "evaluated", await evaluate());
  };
}
