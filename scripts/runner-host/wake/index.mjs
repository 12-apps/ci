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

const fleet = {
  async hosts() {
    const out = await ec2.send(new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${FLEET_TAG}`, Values: [env.RUNNER_LABEL] },
        { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
      ],
    }));
    return (out.Reservations ?? []).flatMap((r) => r.Instances ?? [])
      .map((i) => ({ id: i.InstanceId, state: i.State?.Name, launchedAt: new Date(i.LaunchTime).getTime() }));
  },
  // Spot capacity for one type can run out; the next type in INSTANCE_TYPES
  // (same size class) is tried before the queue is left waiting.
  async launch(n) {
    const types = (env.INSTANCE_TYPES ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    let lastError;
    for (const type of types.length ? types : [undefined]) {
      try {
        const out = await ec2.send(new RunInstancesCommand({
          LaunchTemplate: { LaunchTemplateName: env.LAUNCH_TEMPLATE, Version: "$Default" },
          ...(type ? { InstanceType: type } : {}),
          MinCount: 1,
          MaxCount: n,
        }));
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

export const handler = (env.MODE ?? "scale") === "wake"
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
