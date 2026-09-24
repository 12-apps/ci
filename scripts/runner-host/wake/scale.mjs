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
// new account cannot reserve Lambda concurrency), so every host launched
// carries an EC2 ClientToken made of the 30-second window and its position in
// the fleet: two evaluations that want the same position get one host. Hosts
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
// A spot host can be reclaimed mid-job, and the job fails with it. When a
// `workflow_run` completes as a failure, the jobs that lost their runner are
// counted (`lostJobs`: failed with a step left unfinished), and if there are
// any the run's failed jobs are re-run once more, up to MAX_ATTEMPTS attempts
// in all. A job that failed on its own merits is never the reason for a re-run.
//
// Pure logic: index.mjs wires `github` and `ec2`, the tests fake them.
import { signatureValid } from "./wake.mjs";

const reply = (statusCode, message, extra = {}) => ({ statusCode, body: JSON.stringify({ message, ...extra }) });

/**
 * @param {object} cfg
 * @param {{ queuedJobs(label: string): Promise<number>, idleRunners(label: string): Promise<number>, lostJobs(runId: number, attempt: number): Promise<number>, rerunFailed(runId: number): Promise<void> }} cfg.github
 * @param {{ hosts(): Promise<{ id: string, state: string, launchedAt: number, pool?: boolean }[]>, launch(tokens: string[]): Promise<string[]>, start(ids: string[]): Promise<string[]> }} cfg.ec2
 */
export const MAX_ATTEMPTS = 3;

/**
 * The spot pools (type@subnet) a launch may still use: those holding fewer
 * than `perPool` live hosts. When every pool is at the cap the whole list
 * comes back, because a job waiting costs more than a crowded pool.
 * @param {{ InstanceType: string, SubnetId: string }[]} overrides
 * @param {Map<string, number>} inPool live hosts per `type@subnet`
 */
export function openPools(overrides, inPool, perPool) {
  const room = overrides.filter((o) => (inPool.get(`${o.InstanceType}@${o.SubnetId}`) ?? 0) < perPool);
  return room.length ? room : overrides;
}

export function makeScaler({ secret, label, repo, github, ec2, slotsPerHost = 3, maxHosts = 30, bootSeconds = 180, now = () => Date.now() }) {
  async function recover(run) {
    if (run.conclusion !== "failure") return reply(202, `run ${run.conclusion}`);
    if ((run.run_attempt ?? 1) >= MAX_ATTEMPTS) return reply(202, `attempt ${run.run_attempt}; not re-running`);
    const lost = await github.lostJobs(run.id, run.run_attempt ?? 1);
    if (lost === 0) return reply(202, "no job lost to a reclaimed host");
    await github.rerunFailed(run.id);
    console.log(`run ${run.id}: ${lost} job(s) lost to a reclaimed spot host; re-running its failed jobs`);
    return reply(200, "re-run", { run: run.id, lost });
  }

  async function startPool(ids) {
    try {
      return await ec2.start(ids);
    } catch (e) {
      console.log(`starting pool hosts ${ids.join(" ")} failed (${e.name}: ${e.message}); launching instead`);
      return [];
    }
  }

  // `delivered` is the job this delivery announces: GitHub can deliver it a
  // few seconds before its jobs API lists it as queued, so a `queued`
  // delivery counts as at least one job waiting.
  async function evaluate(delivered) {
    const [listed, idle, hosts] = await Promise.all([github.queuedJobs(label), github.idleRunners(label), ec2.hosts()]);
    const queued = Math.max(listed, delivered);
    const live = hosts.filter((h) => h.state === "pending" || h.state === "running");
    // A host that has not registered its runners yet is capacity on the way.
    const booting = live.filter((h) => h.state === "pending" || now() - h.launchedAt < bootSeconds * 1000);
    const deficit = queued - idle - booting.length * slotsPerHost;
    const room = Math.max(0, maxHosts - live.length);
    const launch = Math.min(room, Math.max(0, Math.ceil(deficit / slotsPerHost)));
    const parked = hosts.filter((h) => h.pool && h.state === "stopped").slice(0, launch).map((h) => h.id);
    const started = parked.length ? await startPool(parked) : [];
    const rest = launch - started.length;
    // One host per token, named by the fleet size it brings the fleet to. Two
    // evaluations that overlap in time see different queues (a pull request
    // fans out over seconds) and aim at different sizes: with one token per
    // ANSWER, 16 and 17 queued jobs launched 8 + 9 hosts. With one token per
    // POSITION they launch positions 6..13 and 6..14, and EC2 returns the
    // same host for each position both asked for: 9 hosts.
    const window = Math.floor(now() / 30_000);
    const tokens = Array.from({ length: rest }, (_, i) => `fleet-${label}-${window}-${live.length + started.length + i + 1}`);
    const launched = rest > 0 ? await ec2.launch(tokens) : [];
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
    if (kind !== "workflow_job" && kind !== "workflow_run") return reply(202, `ignored event ${kind}`);
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return reply(400, "body is not JSON");
    }
    if (payload.repository?.full_name !== repo) return reply(403, "not this repository");
    if (kind === "workflow_run") {
      return payload.action === "completed" && payload.workflow_run ? recover(payload.workflow_run) : reply(202, `ignored action ${payload.action}`);
    }
    if (!["queued", "completed"].includes(payload.action)) return reply(202, `ignored action ${payload.action}`);
    if (!(payload.workflow_job?.labels ?? []).includes(label)) return reply(202, "job is not for this fleet");
    return reply(200, "evaluated", await evaluate(payload.action === "queued" ? 1 : 0));
  };
}
