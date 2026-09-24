// Lambda entry point. MODE=scale (default) sizes a fleet of throwaway hosts
// to the queue (scale.mjs); MODE=wake starts one stoppable host (wake.mjs).
// deploy.sh sets the environment:
//   WEBHOOK_SECRET, RUNNER_LABEL, REPOSITORY          both modes
//   INSTANCE_ID                                       wake
//   LAUNCH_TEMPLATE, REGIONS, INSTANCE_TYPES, TOKEN_PARAMETER, SLOTS_PER_HOST, MAX_HOSTS   scale
import {
  CreateFleetCommand, DescribeInstanceTypeOfferingsCommand, DescribeInstancesCommand, DescribeSubnetsCommand,
  EC2Client, GetSpotPlacementScoresCommand, StartInstancesCommand,
} from "@aws-sdk/client-ec2";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { makeScaler, regionOrder, spotAttempts } from "./scale.mjs";
import { makeHandler } from "./wake.mjs";

const env = process.env;
const ec2 = new EC2Client({});
const FLEET_TAG = "ci-runner-fleet";
const POOL_TAG = "ci-runner-pool";

let token;
async function githubToken() {
  token ??= (await new SSMClient({}).send(new GetParameterCommand({ Name: env.TOKEN_PARAMETER, WithDecryption: true })))
    .Parameter.Value.trim();
  return token;
}

async function gh(path, method = "GET") {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${await githubToken()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${method} ${path}`);
  return res.status === 204 || res.status === 201 ? {} : res.json();
}

const github = {
  // Jobs waiting for a runner with this label, across every run that has one.
  async queuedJobs(label) {
    let count = 0;
    for (const status of ["queued", "in_progress"]) {
      const { workflow_runs: runs } = await gh(`/repos/${env.REPOSITORY}/actions/runs?status=${status}&per_page=100`);
      for (const run of runs) {
        const { jobs } = await gh(`/repos/${env.REPOSITORY}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
        count += jobs.filter((j) => j.status === "queued" && j.labels.includes(label)).length;
      }
    }
    return count;
  },
  // Failed jobs of this attempt that lost their runner. When the host goes
  // (spot reclaim, a crash), GitHub closes the job as a failure but leaves
  // the step it was in unfinished; a job that fails on its own finishes every
  // step it ran. The Actions API alone tells them apart, so this holds after
  // EC2 has forgotten the host: a terminated instance has no private address
  // left to look it up by, which is how the first version of this missed
  // future-pay #1985's two lost jobs.
  async lostJobs(runId, attempt) {
    const { jobs } = await gh(`/repos/${env.REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
    return jobs.filter((j) => j.conclusion === "failure" && j.labels.includes(env.RUNNER_LABEL)
      && (j.steps ?? []).some((s) => s.status !== "completed")).length;
  },
  // Needs Actions: Read and write on the token.
  async rerunFailed(runId) {
    await gh(`/repos/${env.REPOSITORY}/actions/runs/${runId}/rerun-failed-jobs`, "POST");
  },
  async idleRunners(label) {
    const { runners } = await gh(`/repos/${env.REPOSITORY}/actions/runners?per_page=100`);
    return runners.filter((r) => r.status === "online" && !r.busy && r.labels.some((l) => l.name === label)).length;
  },
};

// A burst of deliveries is a burst of launch calls, and a new account's
// request bucket is small. A throttled call is retried with the same
// ClientToken, so two evaluations that aim at the same fleet size still
// launch it once.
async function throttled(call) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (e.name !== "RequestLimitExceeded" || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt * (0.5 + Math.random() / 2)));
    }
  }
}

// The fleet spans REGIONS, cheapest first (deploy.sh copies the AMI and the
// launch template, same name, into each). A spot pool's price and its odds of
// being reclaimed move with the local working day, so a launch goes where AWS
// says a request is most likely to be filled and kept (regionOrder), and falls
// through region by region. A host anywhere reads its token from the home
// region's SSM (CI_RUNNER_REGION is baked into the image), so nothing on the
// host changes.
const list = (v) => (v ?? "").split(",").map((t) => t.trim()).filter(Boolean);
const regions = list(env.REGIONS).length ? list(env.REGIONS) : [env.AWS_REGION];
const types = list(env.INSTANCE_TYPES);
const clients = new Map(regions.map((r) => [r, new EC2Client({ region: r })]));
const client = (r) => clients.get(r) ?? ec2;

// The (type, subnet) pairs each region offers, one default subnet per zone.
// A type a zone lacks makes an instant fleet refuse the whole request
// (InvalidFleetConfiguration: m7i-flex in us-east-1e), so only offered pairs
// are listed. Read once per container; a region that cannot be read is left
// out of this evaluation and read again next time.
let offered;
async function offerings() {
  if (offered) return offered;
  const found = new Map();
  await Promise.all(regions.map(async (r) => {
    try {
      const { Subnets: subnets = [] } = await client(r).send(new DescribeSubnetsCommand({ Filters: [{ Name: "default-for-az", Values: ["true"] }] }));
      const { InstanceTypeOfferings: offers = [] } = await client(r).send(new DescribeInstanceTypeOfferingsCommand({
        LocationType: "availability-zone", MaxResults: 1000, Filters: [{ Name: "instance-type", Values: types }],
      }));
      found.set(r, offers.flatMap((o) => subnets.filter((sn) => sn.AvailabilityZone === o.Location)
        .map((sn) => ({ InstanceType: o.InstanceType, SubnetId: sn.SubnetId }))));
    } catch (e) {
      console.log(`fleet: ${r}: cannot list pools: ${e.name} ${e.message}`);
    }
  }));
  if (regions.every((r) => found.has(r))) offered = found;
  return found;
}

// Spot placement scores, read at most every five minutes. The request is the
// same every time (fixed capacity, the same types), because AWS limits how
// many different configurations an account may score in a day.
let scores = { at: 0, byRegion: new Map() };
async function placementScores() {
  if (regions.length < 2 || Date.now() - scores.at < 5 * 60_000) return scores.byRegion;
  let byRegion = new Map();
  try {
    const out = await ec2.send(new GetSpotPlacementScoresCommand({
      InstanceTypes: types, TargetCapacity: 10, TargetCapacityUnitType: "units", RegionNames: regions, SingleAvailabilityZone: false,
    }));
    byRegion = new Map((out.SpotPlacementScores ?? []).map((p) => [p.Region, p.Score]));
    console.log(`fleet: placement scores ${[...byRegion].map(([r, n]) => `${r}=${n}`).join(" ")}`);
  } catch (e) {
    console.log(`fleet: placement scores unavailable (${e.name}); configured order`);
  }
  scores = { at: Date.now(), byRegion };
  return byRegion;
}

const liveFilter = (states) => [
  { Name: `tag:${FLEET_TAG}`, Values: [env.RUNNER_LABEL] },
  { Name: "instance-state-name", Values: states },
];
const instancesIn = async (r, states) => (await client(r).send(new DescribeInstancesCommand({ Filters: liveFilter(states) })))
  .Reservations?.flatMap((res) => res.Instances ?? []) ?? [];
// Which region each host was last seen in, for start().
const regionOf = new Map();

// No spot capacity in a region, or no quota left there: the next region, then on-demand.
const NO_ROOM = new Set([
  "InsufficientInstanceCapacity", "UnfulfillableCapacity", "MaxSpotInstanceCountExceeded", "SpotMaxPriceTooLow",
  "VcpuLimitExceeded", "InstanceLimitExceeded",
]);

const fleet = {
  async hosts() {
    const all = await Promise.all(regions.map(async (r) => {
      try {
        return (await instancesIn(r, ["pending", "running", "stopping", "stopped"])).map((i) => ({ r, i }));
      } catch (e) {
        console.log(`fleet: ${r}: cannot list hosts: ${e.name} ${e.message}`);
        return [];
      }
    }));
    return all.flat().map(({ r, i }) => {
      regionOf.set(i.InstanceId, r);
      return {
        id: i.InstanceId, state: i.State?.Name, launchedAt: new Date(i.LaunchTime).getTime(),
        pool: (i.Tags ?? []).some((t) => t.Key === POOL_TAG),
      };
    });
  },
  // One call per host: a spot host with no capacity to start fails alone, and
  // the scaler launches a fresh host for it.
  async start(ids) {
    const started = [];
    for (const id of ids) {
      try {
        await client(regionOf.get(id)).send(new StartInstancesCommand({ InstanceIds: [id] }));
        started.push(id);
      } catch (e) {
        console.log(`start of pool host ${id} failed: ${e.name} ${e.message}`);
      }
    }
    if (started.length) console.log(`started ${started.length}/${ids.length} pool hosts: ${started.join(" ")}`);
    return started;
  },
  // One instant EC2 Fleet request per host, across every offered type and
  // zone of a region. The price-capacity-optimized strategy puts the host in
  // the spot pool least likely to be reclaimed: on the first real burst,
  // every host sat in one zone on one type, and that pool was both out of
  // capacity and the one AWS reclaimed a host from, mid-job.
  async launch(tokens) {
    const byRegion = await offerings();
    const order = regionOrder(regions, await placementScores()).filter((r) => byRegion.get(r)?.length);
    // At most MAX_PER_POOL live hosts in one spot pool (type + zone). Each
    // position is its own request, so without a cap every host of a burst goes
    // to whichever pool looks best at that second: on 2026-09-24 seven landed
    // in m7i-flex/us-east-1b, and AWS reclaimed nine hosts from that one pool.
    const perPool = Number(env.MAX_PER_POOL ?? 2);
    const inPool = new Map();
    const add = (type, subnet, n) => inPool.set(`${type}@${subnet}`, (inPool.get(`${type}@${subnet}`) ?? 0) + n);
    await Promise.all(order.map(async (r) => {
      for (const i of await instancesIn(r, ["pending", "running"]).catch(() => [])) add(i.InstanceType, i.SubnetId, 1);
    }));
    // A ClientToken is unique per region, so the same token is reused across
    // regions: a region that refused it launched nothing under it.
    const request = (r, clientToken, market, allowed) => throttled(() => client(r).send(new CreateFleetCommand({
      Type: "instant",
      ClientToken: clientToken.slice(0, 64),
      TargetCapacitySpecification: { TotalTargetCapacity: 1, DefaultTargetCapacityType: market },
      ...(market === "spot"
        ? { SpotOptions: { AllocationStrategy: "price-capacity-optimized", InstanceInterruptionBehavior: "terminate" } }
        : { OnDemandOptions: { AllocationStrategy: "lowest-price" } }),
      LaunchTemplateConfigs: [{
        LaunchTemplateSpecification: { LaunchTemplateName: env.LAUNCH_TEMPLATE, Version: "$Default" },
        Overrides: allowed,
      }],
    })));
    // Regions this evaluation has seen refuse: full (spot, then on-demand) or
    // broken (anything else, which on-demand would hit too).
    const spotFull = new Set();
    const onDemandFull = new Set();
    const broken = new Set();
    const TAKEN = Symbol("taken");
    const attempt = async (r, clientToken, market, allowed) => {
      try {
        const out = await request(r, clientToken, market, allowed);
        for (const i of out.Instances ?? []) {
          const o = i.LaunchTemplateAndOverrides?.Overrides ?? {};
          add(o.InstanceType, o.SubnetId, i.InstanceIds?.length ?? 0);
        }
        const ids = (out.Instances ?? []).flatMap((i) => i.InstanceIds ?? []);
        if (ids.length) return ids;
        const why = [...new Set((out.Errors ?? []).map((e) => e.ErrorCode))];
        if (why.length && why.every((c) => NO_ROOM.has(c))) (market === "spot" ? spotFull : onDemandFull).add(r);
        else broken.add(r);
        console.log(`fleet: ${clientToken}: ${r} ${market}: nothing launched (${why.join(", ") || "no error"}): ${out.Errors?.[0]?.ErrorMessage ?? ""}`);
        return [];
      } catch (e) {
        // Another evaluation is launching this very position right now, or
        // already launched it with a different pool list.
        if (e.name === "IdempotentCallInProgress" || e.name === "IdempotentParameterMismatch") return TAKEN;
        console.log(`fleet: ${clientToken}: ${r} ${market}: ${e.name} ${e.message}`);
        broken.add(r);
        return [];
      }
    };
    const one = async (clientToken) => {
      const usable = (set) => order.filter((r) => !set.has(r) && !broken.has(r));
      for (const { region, overrides } of spotAttempts(usable(spotFull), byRegion, inPool, perPool)) {
        const ids = await attempt(region, clientToken, "spot", overrides);
        if (ids === TAKEN) return [];
        if (ids.length) {
          if (region !== order[0]) console.log(`fleet: ${clientToken}: spot in ${region}`);
          return ids;
        }
      }
      // When no spot pool anywhere has capacity, a job waiting costs more
      // than an on-demand host: measured, every one of 25 spot pools in
      // us-east-1 refused at once on 2026-09-24 while seven future-pay jobs
      // queued. The on-demand host terminates when idle like any other. Only
      // regions whose spot was merely full are tried.
      for (const r of usable(onDemandFull).filter((x) => spotFull.has(x))) {
        const ids = await attempt(r, `${clientToken}-od`, "on-demand", byRegion.get(r));
        if (ids === TAKEN) return [];
        if (ids.length) {
          console.log(`fleet: ${clientToken}: no spot capacity; on-demand in ${r}: ${ids.join(" ")}`);
          return ids;
        }
      }
      return [];
    };
    // One at a time, so each launch sees where the previous ones landed.
    const ids = [];
    for (const t of tokens) ids.push(...(await one(t)));
    console.log(`launched ${ids.length}/${tokens.length} (${order.join(" > ")}): ${ids.join(" ")}`);
    return ids;
  },
};

// Called by deploy.sh with `aws lambda invoke` (IAM-authorised; never reachable
// through the public URL, whose events always carry requestContext.http):
// create or update the repository webhook that points at this function.
async function ensureWebhook(url) {
  const token = await githubToken();
  const call = async (method, path, body) => {
    const res = await fetch(`https://api.github.com/repos/${env.REPOSITORY}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      body: body && JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${method} ${path}: ${await res.text()}`);
    return res.json();
  };
  const hook = {
    name: "web", active: true, events: ["workflow_job", "workflow_run"],
    config: { url, content_type: "json", insecure_ssl: "0", secret: env.WEBHOOK_SECRET },
  };
  const existing = (await call("GET", "/hooks?per_page=100")).find((h) => h.config?.url === url);
  const saved = existing ? await call("PATCH", `/hooks/${existing.id}`, hook) : await call("POST", "/hooks", hook);
  return { webhook: existing ? "updated" : "created", id: saved.id };
}

const serve = (env.MODE ?? "scale") === "wake"
  ? makeHandler({
      secret: env.WEBHOOK_SECRET, instanceId: env.INSTANCE_ID, label: env.RUNNER_LABEL, repo: env.REPOSITORY,
      ec2: {
        async state(id) {
          const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [id] }));
          return out.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? "missing";
        },
        async start(id) { await ec2.send(new StartInstancesCommand({ InstanceIds: [id] })); },
      },
    })
  : makeScaler({
      secret: env.WEBHOOK_SECRET, label: env.RUNNER_LABEL, repo: env.REPOSITORY, github, ec2: fleet,
      slotsPerHost: Number(env.SLOTS_PER_HOST ?? 2), maxHosts: Number(env.MAX_HOSTS ?? 30),
    });

export const handler = async (event) =>
  event?.setup === "webhook" && !event.requestContext ? ensureWebhook(event.url) : serve(event);
