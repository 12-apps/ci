// Lambda entry point. MODE=scale (default) sizes a fleet of throwaway hosts
// to the queue (scale.mjs); MODE=wake starts one stoppable host (wake.mjs).
// deploy.sh sets the environment:
//   WEBHOOK_SECRET, RUNNER_LABEL, REPOSITORY          both modes
//   INSTANCE_ID                                       wake
//   LAUNCH_TEMPLATE, INSTANCE_TYPES, SUBNETS, TOKEN_PARAMETER, SLOTS_PER_HOST, MAX_HOSTS   scale
import { CreateFleetCommand, DescribeInstancesCommand, EC2Client, StartInstancesCommand } from "@aws-sdk/client-ec2";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { makeScaler } from "./scale.mjs";
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
  // Failed jobs of this attempt whose host AWS reclaimed. A runner is named
  // after its host (`ip-172-31-30-61-<slot>-<epoch>`), so the name gives the
  // private address, and EC2 keeps a terminated instance's state reason for
  // about an hour.
  async lostJobs(runId, attempt) {
    const { jobs } = await gh(`/repos/${env.REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
    const ips = new Map();
    for (const j of jobs) {
      const m = j.conclusion === "failure" && j.labels.includes(env.RUNNER_LABEL) && /^ip-(\d+)-(\d+)-(\d+)-(\d+)-/.exec(j.runner_name ?? "");
      if (m) ips.set(m.slice(1, 5).join("."), (ips.get(m.slice(1, 5).join(".")) ?? 0) + 1);
    }
    if (ips.size === 0) return 0;
    const out = await ec2.send(new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${FLEET_TAG}`, Values: [env.RUNNER_LABEL] },
        { Name: "private-ip-address", Values: [...ips.keys()] },
        { Name: "state-reason-code", Values: ["Server.SpotInstanceTermination"] },
      ],
    }));
    const reclaimed = (out.Reservations ?? []).flatMap((r) => r.Instances ?? []).map((i) => i.PrivateIpAddress);
    return [...new Set(reclaimed)].reduce((n, ip) => n + (ips.get(ip) ?? 0), 0);
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

const fleet = {
  async hosts() {
    const out = await ec2.send(new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${FLEET_TAG}`, Values: [env.RUNNER_LABEL] },
        { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
      ],
    }));
    return (out.Reservations ?? []).flatMap((r) => r.Instances ?? [])
      .map((i) => ({
        id: i.InstanceId, state: i.State?.Name, launchedAt: new Date(i.LaunchTime).getTime(),
        pool: (i.Tags ?? []).some((t) => t.Key === POOL_TAG),
      }));
  },
  // One call per host: a spot host with no capacity to start fails alone, and
  // the scaler launches a fresh host for it.
  async start(ids) {
    const started = [];
    for (const id of ids) {
      try {
        await ec2.send(new StartInstancesCommand({ InstanceIds: [id] }));
        started.push(id);
      } catch (e) {
        console.log(`start of pool host ${id} failed: ${e.name} ${e.message}`);
      }
    }
    if (started.length) console.log(`started ${started.length}/${ids.length} pool hosts: ${started.join(" ")}`);
    return started;
  },
  // One instant EC2 Fleet request per host, across every type in INSTANCE_TYPES and
  // every subnet in SUBNETS (one per availability zone). The
  // price-capacity-optimized strategy puts the hosts in the spot pools least
  // likely to be reclaimed: on the first real burst, every host sat in one
  // zone on one type, and that pool was both out of capacity and the one
  // AWS reclaimed a host from, mid-job.
  async launch(tokens) {
    const list = (v) => (v ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    const types = list(env.INSTANCE_TYPES);
    const subnets = list(env.SUBNETS);
    const overrides = (types.length ? types : [undefined]).flatMap((type) =>
      (subnets.length ? subnets : [undefined]).map((subnet) => ({
        ...(type ? { InstanceType: type } : {}), ...(subnet ? { SubnetId: subnet } : {}),
      })));
    const one = async (clientToken) => {
      try {
        const out = await throttled(() => ec2.send(new CreateFleetCommand({
          Type: "instant",
          ClientToken: clientToken.slice(0, 64),
          TargetCapacitySpecification: { TotalTargetCapacity: 1, DefaultTargetCapacityType: "spot" },
          SpotOptions: { AllocationStrategy: "price-capacity-optimized", InstanceInterruptionBehavior: "terminate" },
          LaunchTemplateConfigs: [{
            LaunchTemplateSpecification: { LaunchTemplateName: env.LAUNCH_TEMPLATE, Version: "$Default" },
            Overrides: overrides,
          }],
        })));
        const ids = (out.Instances ?? []).flatMap((i) => i.InstanceIds ?? []);
        if (ids.length === 0) {
          const e = out.Errors?.[0];
          console.log(`fleet: ${clientToken}: nothing launched (${e?.ErrorCode ?? "no error"}: ${e?.ErrorMessage ?? ""})`);
        }
        return ids;
      } catch (e) {
        // Another evaluation is launching this very position right now.
        if (e.name === "IdempotentCallInProgress") return [];
        console.log(`fleet: ${clientToken}: ${e.name} ${e.message}`);
        return [];
      }
    };
    // A few at a time: a new account's CreateFleet request bucket is small.
    const ids = [];
    for (let i = 0; i < tokens.length; i += 5) {
      ids.push(...(await Promise.all(tokens.slice(i, i + 5).map(one))).flat());
    }
    console.log(`launched ${ids.length}/${tokens.length}: ${ids.join(" ")}`);
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
