import assert from "node:assert/strict";
import test from "node:test";
import { argumentsFor, AwsCli, run } from "../aws.mjs";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const account = "123456789012", region = "us-east-1", name = "example";
const stackId = `arn:aws:cloudformation:${region}:${account}:stack/${name}/fixture`;
const repository = `${account}.dkr.ecr.${region}.amazonaws.com/example`;
const digest = `sha256:${"a".repeat(64)}`, image = `${repository}@${digest}`;
const instance = "i-1234567890abcdef0", volume = "vol-1234567890abcdef0";
const args = action => [action, "--expected-account", account, "--region", region, "--stack", name];
function fixture(overrides = {}) {
  const calls = [], reports = [], sleeps = [];
  const outputs = { ControllerInstanceId: instance, ArtifactBucket: "owned-artifacts", ApplicationRepositoryUri: repository, SecretArn: `arn:aws:secretsmanager:${region}:${account}:secret:application-AbCdEf`, PublicUrl: "https://app.example.com", DataVolumeId: volume, UnrelatedSecret: "never-print-this" };
  const stack = { StackId: stackId, StackStatus: "CREATE_COMPLETE", Tags: [{ Key: "ManagedBy", Value: "12-apps-ci" }, { Key: "Application", Value: "example" }], Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
  const data = {
    "sts/get-caller-identity": { Account: account }, "cloudformation/describe-stacks": { Stacks: [stack] },
    "cloudformation/list-stack-resources": { StackResourceSummaries: [{ ResourceType: "AWS::EC2::Instance", PhysicalResourceId: instance }, { ResourceType: "AWS::EC2::Volume", PhysicalResourceId: volume }] },
    "ec2/describe-instances": { Reservations: [{ Instances: [{ State: { Name: "running" }, Tags: [{ Key: "aws:cloudformation:stack-id", Value: stackId }] }] }] },
    "ec2/describe-volumes": { Volumes: [{ Encrypted: true, Attachments: [{ InstanceId: instance, State: "attached" }] }] },
    "ecr/batch-get-image": { images: [{ imageId: { imageDigest: digest } }] },
    "ssm/describe-instance-information": { InstanceInformationList: [{ InstanceId: instance, PingStatus: "Online" }] },
    "ssm/send-command": { Command: { CommandId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } },
    "ssm/get-command-invocation": { Status: "Success", ResponseCode: 0, StandardOutputContent: "secret-output-never-print" },
    "cloudformation/validate-template": {}, "cloudformation/create-stack": {}, "cloudformation/update-stack": {},
    ...overrides,
  };
  return { calls, reports, sleeps, stack, options: {
    aws: { call: async (service, operation, values) => { const key = `${service}/${operation}`; calls.push([key, values]); const value = data[key]; if (value instanceof Error) throw value; if (typeof value === "function") return value(); if (value === undefined) assert.fail(`Unexpected AWS call ${key}`); return value; } },
    sleep: async duration => sleeps.push(duration), report: value => reports.push(value),
  } };
}
test("unsafe CLI targets and mutable tags fail before any AWS operation", () => {
  assert.throws(() => argumentsFor(["destroy"]), /No destroy/);
  for (const extra of [["--image", `${repository}:latest`], ["--container", "bad;touch"], ["--mount", "/"], ["--health", "https://evil.test"], ["--port", "22"], ["--timeout", "9000"], ["--ready-file", "/tmp/fake-ready"]]) assert.throws(() => argumentsFor([...args("deploy"), ...(extra[0] === "--image" ? [] : ["--image", image]), ...extra]));
  assert.throws(() => argumentsFor([...args("status"), "--stack", "another"]), /Repeated/);
  assert.throws(() => argumentsFor(["plan", "--region", region, "--stack", name]), /expected-account/);
});
test("AWS CLI scopes a profile without global mutation and redacts provider failures", async () => {
  const options = argumentsFor([...args("status"), "--profile", "scoped-fixture"]);
  let captured;
  const cli = new AwsCli(options, { executor: async (...args) => { captured = args; return { stdout: '{"Account":"123456789012"}' }; } });
  assert.equal((await cli.call("sts", "get-caller-identity")).Account, account);
  assert.equal(captured[0], "aws");
  assert.deepEqual(captured[1].slice(0, 4), ["--profile", "scoped-fixture", "--region", region]);
  assert.equal(captured[2].env.AWS_PAGER, "");
  for (const [service, operation, stderr, code] of [
    ["cloudformation", "describe-stacks", "ValidationError Stack does not exist private-value", "MissingStack"],
    ["cloudformation", "describe-stacks", "AccessDenied private-value", "AwsFailure"],
    ["ssm", "get-command-invocation", "InvocationDoesNotExist private-value", "NotYetVisible"],
  ]) {
    const failing = new AwsCli(options, { executor: async () => { throw Object.assign(new Error("private-value"), { stderr }); } });
    await assert.rejects(failing.call(service, operation), error => error.code === code && !error.message.includes("private-value"));
  }
});
test("parameter files fail closed on malformed shape without disclosing values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ci-aws-parameters-"));
  try {
    const filename = path.join(directory, "parameters.json");
    for (const value of [[null], ["private-value"], [{ ParameterKey: "Key", UsePreviousValue: "private-value" }], [{ ParameterKey: "Key", UsePreviousValue: true, ParameterValue: "private-value" }]]) {
      await writeFile(filename, JSON.stringify(value));
      const f = fixture();
      await assert.rejects(run(argumentsFor([...args("provision"), "--template", "fixture.json", "--parameters", filename]), f.options), error => /parameter JSON/.test(error.message) && !error.message.includes("private-value"));
      assert.equal(f.calls.some(([call]) => call.endsWith("update-stack")), false);
    }
  } finally { await rm(directory, { recursive: true }); }
});
test("AWS adapters stay off by default, prebuilt-only, scoped and pinned", async () => {
  const workflow = await readFile(new URL("../../../.github/workflows/deploy-aws.yml", import.meta.url), "utf8");
  const cd = await readFile(new URL("../../../.github/workflows/cd.yml", import.meta.url), "utf8");
  const selfTest = await readFile(new URL("../../../.github/workflows/self-test.yml", import.meta.url), "utf8");
  assert.match(workflow, /if: vars\.ENABLE_DEPLOY_AWS == 'true'/);
  assert.match(workflow, /\^\[a-f0-9\]\{40\}\$/);
  assert.match(workflow, /allowed-account-ids: \$\{\{ inputs\.expected_account \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /docker build|build-push-action|uses: \.\//);
  assert.match(cd, /if: inputs\.target != 'aws' &&/);
  assert.match(cd, /if: inputs\.target == 'aws' && vars\.ENABLE_DEPLOY_AWS == 'true'/);
  assert.equal(selfTest.match(/'scripts\/deploy\/\*\*'/g)?.length, 2, "PR and main path filters both cover the tested engine");
});
test("plan/status are read-only, hide unrelated outputs and never imply provisioning", async () => {
  for (const action of ["plan", "status"]) {
    const f = fixture(); await run(argumentsFor(args(action)), f.options);
    assert.deepEqual(f.calls.map(([call]) => call), ["sts/get-caller-identity", "cloudformation/describe-stacks"]);
    assert.equal(JSON.stringify(f.reports).includes("never-print"), false);
  }
});
test("wrong account, ownership, instance, data volume or digest cannot reach SSM mutation", async () => {
  for (const overrides of [
    { "sts/get-caller-identity": { Account: "999999999999" } },
    { "cloudformation/describe-stacks": { Stacks: [{ Tags: [] }] } },
    { "cloudformation/list-stack-resources": { StackResourceSummaries: [] } },
    { "ec2/describe-instances": { Reservations: [] } },
    { "ec2/describe-volumes": { Volumes: [{ Encrypted: false }] } },
    { "ecr/batch-get-image": { images: [] } },
    { "ssm/describe-instance-information": { InstanceInformationList: [] } },
  ]) {
    const f = fixture(overrides); await assert.rejects(run(argumentsFor([...args("deploy"), "--image", image]), f.options));
    assert.ok(!f.calls.some(([call]) => call === "ssm/send-command"));
  }
});
test("provision is explicit, preserves stack tags and only missing-stack classification permits create", async () => {
  const existing = fixture(); await run(argumentsFor([...args("provision"), "--template", "/tmp/application-template.json"]), existing.options);
  const update = existing.calls.find(([call]) => call === "cloudformation/update-stack")[1];
  assert.deepEqual(JSON.parse(update[update.indexOf("--tags") + 1]), [{ Key: "Application", Value: "example" }, { Key: "ManagedBy", Value: "12-apps-ci" }]);
  for (const code of ["AwsFailure", "MissingStack"]) {
    const f = fixture({ "cloudformation/describe-stacks": Object.assign(new Error("private provider response"), { code }) });
    if (code === "AwsFailure") await assert.rejects(run(argumentsFor([...args("provision"), "--template", "/tmp/application-template.json"]), f.options));
    else { await run(argumentsFor([...args("provision"), "--template", "/tmp/application-template.json"]), f.options); assert.ok(f.calls.find(([call]) => call === "cloudformation/create-stack")[1].includes("--enable-termination-protection")); }
  }
});
test("deploy consumes the exact ECR digest, targets one owned instance and only reports verified SSM completion", async () => {
  let polls = 0;
  const f = fixture({ "ssm/get-command-invocation": () => {
    if (++polls === 1) throw Object.assign(new Error(), { code: "NotYetVisible" });
    return { Status: polls === 2 ? "InProgress" : "Success", ResponseCode: 0, StandardOutputContent: "secret-output-never-print" };
  } });
  await run(argumentsFor([...args("deploy"), "--image", image, "--mount", "/srv/relay/data", "--destination", "/var/lib/relay"]), f.options);
  const send = f.calls.find(([call]) => call === "ssm/send-command")[1];
  assert.equal(send[send.indexOf("--instance-ids") + 1], instance);
  const remote = JSON.parse(send[send.indexOf("--parameters") + 1]).commands[0];
  const encoded = /^python3 - '([^']+)'/.exec(remote)[1], payload = JSON.parse(Buffer.from(encoded, "base64"));
  assert.equal(payload.image, image); assert.equal(payload.volume, volume); assert.equal(payload.stack, stackId);
  assert.deepEqual(f.sleeps, [5000, 5000]); assert.equal(f.reports.at(-1).state, "healthy");
  assert.equal(JSON.stringify(f.reports).includes("secret-output"), false);
});
test("failed or observation-timed-out SSM commands are never restarted or treated as success", async () => {
  for (const status of ["Failed", "InProgress"]) {
    const f = fixture({ "ssm/get-command-invocation": { Status: status, ResponseCode: -1 } });
    await assert.rejects(run(argumentsFor(args("rollback")), f.options), status === "Failed" ? /ended Failed/ : /Do not resubmit/);
    assert.equal(f.calls.filter(([call]) => call === "ssm/send-command").length, 1);
    assert.ok(f.reports.every(report => report.state !== "healthy"));
  }
});
