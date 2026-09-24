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
 * @param {number | (() => number | Promise<number>)} [cfg.maxHosts] the fleet's ceiling, or a function of the moment
 * @param {{ hosts(): Promise<{ id: string, state: string, launchedAt: number, pool?: boolean }[]>, launch(tokens: string[]): Promise<string[]>, start(ids: string[]): Promise<string[]> }} cfg.ec2
 */
export const MAX_ATTEMPTS = 3;

/**
 * Where a spot launch is tried, in order: every region's pools (type@subnet)
 * holding fewer than `perPool` live hosts, region by region. Only when no
 * region has a pool below the cap does each region come back whole, because
 * a job waiting costs more than a crowded pool.
 * @param {string[]} regions in preference order (regionOrder)
 * @param {Map<string, { InstanceType: string, SubnetId: string }[]>} offered pools per region
 * @param {Map<string, number>} inPool live hosts per `type@subnet` (subnet ids are unique across regions)
 * @returns {{ region: string, overrides: { InstanceType: string, SubnetId: string }[] }[]}
 */
export function spotAttempts(regions, offered, inPool, perPool) {
  const pools = (r) => offered.get(r) ?? [];
  const room = regions.map((region) => ({
    region, overrides: pools(region).filter((o) => (inPool.get(`${o.InstanceType}@${o.SubnetId}`) ?? 0) < perPool),
  })).filter((a) => a.overrides.length);
  return room.length ? room : regions.map((region) => ({ region, overrides: pools(region) })).filter((a) => a.overrides.length);
}

/**
 * Regions in the order a launch tries them. AWS's spot placement score (1-10)
 * says how likely a request is to be filled and to stay filled; it is read in
 * three tiers (7+ likely, 4-6 maybe, 1-3 unlikely) so that a one-point
 * difference does not send the fleet to a dearer region. Within a tier the
 * configured order (cheapest first) decides. A region without a score (the
 * call failed) is treated as likely: the configured order alone then decides.
 * @param {string[]} regions configured preference order
 * @param {Map<string, number>} scores
 */
export function regionOrder(regions, scores) {
  const tier = (r) => {
    const s = scores.get(r);
    return s === undefined || s >= 7 ? 2 : s >= 4 ? 1 : 0;
  };
  return regions.map((r, i) => ({ r, i })).sort((a, b) => tier(b.r) - tier(a.r) || a.i - b.i).map((x) => x.r);
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
    // A function when the cap moves (the daily budget, budget.mjs).
    const cap = typeof maxHosts === "function" ? await maxHosts() : maxHosts;
    const [listed, idle, hosts] = await Promise.all([github.queuedJobs(label), github.idleRunners(label), ec2.hosts()]);
    const queued = Math.max(listed, delivered);
    const live = hosts.filter((h) => h.state === "pending" || h.state === "running");
    // A host that has not registered its runners yet is capacity on the way.
    const booting = live.filter((h) => h.state === "pending" || now() - h.launchedAt < bootSeconds * 1000);
    const deficit = queued - idle - booting.length * slotsPerHost;
    const room = Math.max(0, cap - live.length);
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
    const decision = { queued, idle, hosts: live.length, booting: booting.length, started: started.length, launched: launched.length, cap };
    console.log(JSON.stringify(decision));
    if (deficit > 0 && room === 0) console.log(`at the ${cap}-host cap; ${deficit} job(s) wait`);
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
