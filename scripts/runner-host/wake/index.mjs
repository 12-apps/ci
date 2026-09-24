// Lambda entry point. MODE=scale (default) sizes a fleet of throwaway hosts
// to the queue (scale.mjs); MODE=wake starts one stoppable host (wake.mjs).
// deploy.sh sets the environment:
//   WEBHOOK_SECRET, RUNNER_LABEL, REPOSITORY          both modes
//   INSTANCE_ID                                       wake
//   LAUNCH_TEMPLATE, TOKEN_PARAMETER, SLOTS_PER_HOST, MAX_HOSTS   scale
import { DescribeInstancesCommand, EC2Client, RunInstancesCommand, StartInstancesCommand } from "@aws-sdk/client-ec2";
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

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${await githubToken()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}`);
  return res.json();
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
  async idleRunners(label) {
    const { runners } = await gh(`/repos/${env.REPOSITORY}/actions/runners?per_page=100`);
    return runners.filter((r) => r.status === "online" && !r.busy && r.labels.some((l) => l.name === label)).length;
  },
};

// A burst of deliveries is a burst of RunInstances calls, and a new
// account's request bucket is small. A throttled call is retried with the SAME
// type, hence the same ClientToken: falling through to the next type would
// mint a new token and let two evaluations each launch the same deficit.
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
  // Spot capacity for one type can run out; the next type in INSTANCE_TYPES
  // (same size class) is tried before the queue is left waiting.
  async launch(n, clientToken) {
    const types = (env.INSTANCE_TYPES ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    let lastError;
    for (const type of types.length ? types : [undefined]) {
      try {
        const out = await throttled(() => ec2.send(new RunInstancesCommand({
          LaunchTemplate: { LaunchTemplateName: env.LAUNCH_TEMPLATE, Version: "$Default" },
          ...(type ? { InstanceType: type } : {}),
          // Idempotent per type: a retry with the next type is a new request.
          ClientToken: `${clientToken}-${type ?? "default"}`.slice(0, 64),
          MinCount: 1,
          MaxCount: n,
        })));
        const ids = (out.Instances ?? []).map((i) => i.InstanceId);
        console.log(`launched ${ids.length}/${n} ${type ?? ""}: ${ids.join(" ")}`);
        return ids;
      } catch (e) {
        lastError = e;
        console.log(`launch of ${type ?? "template type"} failed: ${e.name} ${e.message}`);
      }
    }
    throw lastError;
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
    name: "web", active: true, events: ["workflow_job"],
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
      slotsPerHost: Number(env.SLOTS_PER_HOST ?? 3), maxHosts: Number(env.MAX_HOSTS ?? 30),
    });

export const handler = async (event) =>
  event?.setup === "webhook" && !event.requestContext ? ensureWebhook(event.url) : serve(event);
