// Size the runner fleet to the queue: no job waits for a slot.
//
// EC2 bills by the second, so ten hosts for ten minutes cost what one host
// costs for a hundred. The fleet therefore grows to whatever the queue needs
// at once, and every host terminates itself when idle (idle-stop.sh), so
// nothing is billed while nothing runs.
//
// Called for every `workflow_job` delivery. `queued` and `completed` both
// re-evaluate: the first adds demand, the second is the moment a burst that
// arrived faster than hosts boot is noticed again. Evaluations can overlap (a
// new account cannot reserve Lambda concurrency), so a launch carries an EC2
// ClientToken made of the 30-second window and the fleet size it aims for:
// two evaluations that reach the same answer at once launch it once. Hosts
// still booting count as capacity, so a burst of a hundred deliveries
// launches what the queue needs, not a hundred hosts.
//
//   deficit = queued jobs − idle runners − slots on hosts still booting
//   launch  = ceil(deficit / slotsPerHost), capped at maxHosts
//
// A host launched from the AMI reads its disk from the snapshot block by
// block, so the first boot takes ~90 s and the runner another minute to take
// a job. A small warm pool of STOPPED hosts (tagged `pool`) keeps disks that
// have booted before: those are started first and take a job in well under a
// minute. Only the remainder is launched, and a pool host that cannot start
// (spot capacity) is launched instead.
//
// Pure logic: index.mjs wires `github` and `ec2`, the tests fake them.
import { signatureValid } from "./wake.mjs";

const reply = (statusCode, message, extra = {}) => ({ statusCode, body: JSON.stringify({ message, ...extra }) });

/**
 * @param {object} cfg
 * @param {{ queuedJobs(label: string): Promise<number>, idleRunners(label: string): Promise<number> }} cfg.github
 * @param {{ hosts(): Promise<{ id: string, state: string, launchedAt: number, pool?: boolean }[]>, launch(n: number, token: string): Promise<string[]>, start(ids: string[]): Promise<string[]> }} cfg.ec2
 */
export function makeScaler({ secret, label, repo, github, ec2, slotsPerHost = 3, maxHosts = 30, bootSeconds = 180, now = () => Date.now() }) {
  async function startPool(ids) {
    try {
      return await ec2.start(ids);
    } catch (e) {
      console.log(`starting pool hosts ${ids.join(" ")} failed (${e.name}: ${e.message}); launching instead`);
      return [];
    }
  }

  async function evaluate() {
    const [queued, idle, hosts] = await Promise.all([github.queuedJobs(label), github.idleRunners(label), ec2.hosts()]);
    const live = hosts.filter((h) => h.state === "pending" || h.state === "running");
    // A host that has not registered its runners yet is capacity on the way.
    const booting = live.filter((h) => h.state === "pending" || now() - h.launchedAt < bootSeconds * 1000);
    const deficit = queued - idle - booting.length * slotsPerHost;
    const room = Math.max(0, maxHosts - live.length);
    const launch = Math.min(room, Math.max(0, Math.ceil(deficit / slotsPerHost)));
    const parked = hosts.filter((h) => h.pool && h.state === "stopped").slice(0, launch).map((h) => h.id);
    const started = parked.length ? await startPool(parked) : [];
    const rest = launch - started.length;
    const token = `fleet-${label}-${Math.floor(now() / 30_000)}-${live.length + launch}`;
    const launched = rest > 0 ? await ec2.launch(rest, token) : [];
    const decision = { queued, idle, hosts: live.length, booting: booting.length, started: started.length, launched: launched.length };
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
