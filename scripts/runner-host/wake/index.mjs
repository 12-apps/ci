// Lambda entry point: wake.mjs with the real EC2 client. Configuration is the
// function's environment (deploy.sh sets it): WEBHOOK_SECRET, INSTANCE_ID,
// RUNNER_LABEL, REPOSITORY.
import { DescribeInstancesCommand, EC2Client, StartInstancesCommand } from "@aws-sdk/client-ec2";
import { makeHandler } from "./wake.mjs";

const client = new EC2Client({});

export const handler = makeHandler({
  secret: process.env.WEBHOOK_SECRET,
  instanceId: process.env.INSTANCE_ID,
  label: process.env.RUNNER_LABEL,
  repo: process.env.REPOSITORY,
  ec2: {
    async state(id) {
      const out = await client.send(new DescribeInstancesCommand({ InstanceIds: [id] }));
      return out.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? "missing";
    },
    async start(id) {
      await client.send(new StartInstancesCommand({ InstanceIds: [id] }));
    },
  },
});
