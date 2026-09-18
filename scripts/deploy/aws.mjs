#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execute = promisify(execFile);
const fail = message => { throw new Error(message); };
export function argumentsFor(argv) {
  const [action, ...args] = argv;
  if (!["plan", "provision", "status", "deploy", "rollback"].includes(action)) fail("Choose plan, provision, status, deploy or rollback. No destroy operation is provided.");
  const options = { action, container: "application", mount: "/srv/application/data", destination: "/var/lib/application", port: "8787", health: "/readyz", timeout: "180", "ready-file": "/var/lib/12-apps-controller-ready" };
  const keys = new Set(["profile", "region", "expected-account", "stack", "template", "parameters", "image", "container", "mount", "destination", "port", "health", "timeout", "command-id", "ready-file"]);
  const supplied = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, "");
    if (!args[index]?.startsWith("--") || !keys.has(key) || !args[index + 1] || args[index + 1].startsWith("--")) fail("Invalid or incomplete argument.");
    if (supplied.has(key)) fail("Repeated options are not allowed.");
    supplied.add(key);
    options[key] = args[index + 1];
  }
  if (!/^\d{12}$/.test(options["expected-account"] || "")) fail("--expected-account must be an explicit 12-digit AWS account.");
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(options.region || "")) fail("--region is required.");
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(options.stack || "")) fail("--stack must be a CloudFormation stack name.");
  if (options.profile && !/^[A-Za-z0-9_.@+-]{1,100}$/.test(options.profile)) fail("Invalid AWS profile.");
  if (!["plan", "provision"].includes(action) && (options.template || options.parameters)) fail("Template/parameters are accepted only for plan/provision.");
  if (action === "provision" && !options.template) fail("Explicit provision requires --template.");
  if (action === "deploy" && !options.image) fail("Deploy requires --image with an immutable ECR sha256 digest.");
  if (options.image && action !== "deploy") fail("--image is accepted only for deploy.");
  if (options["command-id"] && action !== "status") fail("--command-id is accepted only for status.");
  if (options.image && !/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/.test(options.image)) fail("Image must be an immutable private ECR repository@sha256 digest, never a mutable tag.");
  if (!/^[a-z][a-z0-9_-]{0,45}$/.test(options.container)) fail("Invalid container name.");
  for (const key of ["mount", "destination"]) if (!/^\/(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_-]+$/.test(options[key]) || options[key].startsWith("/run/") || options[key].startsWith("/etc/")) fail("Data mounts must be explicit, non-root, multi-component absolute paths.");
  if (!/^\/var\/lib\/[A-Za-z0-9_-]+$/.test(options["ready-file"])) fail("Bootstrap ready marker must be an explicit file in /var/lib.");
  if (!/^\d+$/.test(options.port) || +options.port < 1024 || +options.port > 65535) fail("Invalid application port.");
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(options.health)) fail("Invalid readiness path.");
  if (!/^\d+$/.test(options.timeout) || +options.timeout < 10 || +options.timeout > 600) fail("Readiness timeout must be 10–600 seconds.");
  if (options["command-id"] && !/^[a-f0-9-]{36}$/.test(options["command-id"])) fail("Invalid SSM command ID.");
  return options;
}

export class AwsCli {
  constructor(options, { executor = execute } = {}) { this.options = options; this.execute = executor; }
  async call(service, operation, args = [], { timeout = 90_000 } = {}) {
    const options = this.options;
    try {
      const { stdout } = await this.execute("aws", [...(options.profile ? ["--profile", options.profile] : []), "--region", options.region, "--no-cli-pager", "--output", "json", service, operation, ...args], { timeout, maxBuffer: 8_388_608, env: { ...process.env, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" } });
      return stdout.trim() ? JSON.parse(stdout) : {};
    } catch (error) {
      // Never expose raw SDK/CLI errors: parameters and provider bodies may contain secrets.
      const missingStack = service === "cloudformation" && operation === "describe-stacks" && /ValidationError/.test(error.stderr || "") && /does not exist/.test(error.stderr || "");
      const notYetVisible = service === "ssm" && operation === "get-command-invocation" && /InvocationDoesNotExist/.test(error.stderr || "");
      const unchanged = service === "cloudformation" && operation === "update-stack" && /No updates are to be performed/.test(error.stderr || "");
      throw Object.assign(new Error(`AWS ${service} ${operation} failed. Check permissions and service status; sensitive output was suppressed.`), { code: missingStack ? "MissingStack" : notYetVisible ? "NotYetVisible" : unchanged ? "Unchanged" : "AwsFailure" });
    }
  }
}

const mapOutputs = stack => Object.fromEntries((stack.Outputs || []).map(entry => [entry.OutputKey, entry.OutputValue]));
export async function guardedStack(aws, options, { optional = false } = {}) {
  const identity = await aws.call("sts", "get-caller-identity");
  if (identity.Account !== options["expected-account"]) fail("AWS identity does not match --expected-account. No changes made.");
  let stack;
  try { stack = (await aws.call("cloudformation", "describe-stacks", ["--stack-name", options.stack])).Stacks?.[0]; }
  catch (error) { if (optional && error.code === "MissingStack") return null; throw error; }
  if (!stack || !(stack.Tags || []).some(tag => tag.Key === "ManagedBy" && tag.Value === "12-apps-ci")) fail("Stack lacks ownership tag ManagedBy=12-apps-ci. Refusing to operate.");
  if (!stack.StackId?.startsWith(`arn:aws${options.region.startsWith("cn-") ? "-cn" : options.region.startsWith("us-gov-") ? "-us-gov" : ""}:cloudformation:${options.region}:${options["expected-account"]}:stack/${options.stack}/`)) fail("Stack identity does not match the requested account, region and name.");
  return stack;
}

export async function deploymentTarget(aws, options, stack) {
  if (!["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack.StackStatus)) fail("Stack is not in a stable usable state. Inspect status; do not start another operation.");
  const outputs = mapOutputs(stack);
  for (const name of ["ControllerInstanceId", "ArtifactBucket", "ApplicationRepositoryUri", "SecretArn", "PublicUrl", "DataVolumeId"]) if (!outputs[name]) fail(`Stack output ${name} is required.`);
  const account = options["expected-account"], region = options.region;
  if (!/^i-[a-f0-9]{8,17}$/.test(outputs.ControllerInstanceId) || !/^vol-[a-f0-9]{8,17}$/.test(outputs.DataVolumeId)) fail("Invalid instance or data volume output.");
  const registry = `${account}.dkr.ecr.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
  if (!outputs.ApplicationRepositoryUri.startsWith(registry + "/") || !/^[a-z0-9][a-z0-9._/-]*$/.test(outputs.ApplicationRepositoryUri.slice(registry.length + 1))) fail("ECR repository must belong to the expected account and region.");
  if (!outputs.SecretArn.startsWith(`arn:aws${region.startsWith("cn-") ? "-cn" : region.startsWith("us-gov-") ? "-us-gov" : ""}:secretsmanager:${region}:${account}:secret:`)) fail("Secret must belong to the expected account and region.");
  let publicUrl;
  try { publicUrl = new URL(outputs.PublicUrl); } catch { fail("PublicUrl must be a stable HTTPS URL without credentials."); }
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.hash || publicUrl.search) fail("PublicUrl must be a stable HTTPS URL without credentials.");
  const resources = (await aws.call("cloudformation", "list-stack-resources", ["--stack-name", stack.StackId])).StackResourceSummaries || [];
  if (!resources.some(resource => resource.ResourceType === "AWS::EC2::Instance" && resource.PhysicalResourceId === outputs.ControllerInstanceId)) fail("Controller instance is not owned by this stack.");
  if (!resources.some(resource => resource.ResourceType === "AWS::EC2::Volume" && resource.PhysicalResourceId === outputs.DataVolumeId)) fail("Data volume is not owned by this stack.");
  const instance = (await aws.call("ec2", "describe-instances", ["--instance-ids", outputs.ControllerInstanceId])).Reservations?.flatMap(entry => entry.Instances || [])[0];
  if (instance?.State?.Name !== "running" || !(instance.Tags || []).some(tag => tag.Key === "aws:cloudformation:stack-id" && tag.Value === stack.StackId)) fail("Controller instance is not running under the expected stack.");
  const volume = (await aws.call("ec2", "describe-volumes", ["--volume-ids", outputs.DataVolumeId])).Volumes?.[0];
  if (!volume?.Encrypted || !(volume.Attachments || []).some(attachment => attachment.InstanceId === outputs.ControllerInstanceId && attachment.State === "attached")) fail("Encrypted persistent data volume is not attached to this controller.");
  return { ...outputs, registry };
}

export async function run(options, { aws = new AwsCli(options), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), report = value => console.log(JSON.stringify(value)) } = {}) {
  const stack = await guardedStack(aws, options, { optional: ["plan", "provision"].includes(options.action) });
  if (["plan", "provision"].includes(options.action)) {
    if (options.template) await aws.call("cloudformation", "validate-template", ["--template-body", `file://${path.resolve(options.template)}`]);
    if (options.parameters) {
      let parameters;
      try { parameters = JSON.parse(await readFile(options.parameters, "utf8")); }
      catch { fail("Could not parse CloudFormation parameter file. Private file contents were suppressed."); }
      if (!Array.isArray(parameters) || parameters.some(value => !value || typeof value !== "object" || typeof value.ParameterKey !== "string" || (value.UsePreviousValue !== undefined && typeof value.UsePreviousValue !== "boolean") || (value.UsePreviousValue === true ? value.ParameterValue !== undefined : typeof value.ParameterValue !== "string") || Object.keys(value).some(key => !["ParameterKey", "ParameterValue", "UsePreviousValue"].includes(key)))) fail("Parameters must be an AWS CloudFormation parameter JSON array.");
    }
    if (options.action === "plan") return report({ action: "plan", account: options["expected-account"], region: options.region, stack: options.stack, exists: Boolean(stack), changesMade: false, warning: "Provision is explicit and may create billable resources. This plan does not create a change set." });
    if (stack && !["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack.StackStatus)) fail("Stack operation is not stable. Inspect status before provisioning again.");
    const operation = stack ? "update-stack" : "create-stack";
    const tags = [...(stack?.Tags || []).filter(tag => tag.Key !== "ManagedBy"), { Key: "ManagedBy", Value: "12-apps-ci" }];
    const args = ["--stack-name", options.stack, "--template-body", `file://${path.resolve(options.template)}`, "--capabilities", "CAPABILITY_NAMED_IAM", "--tags", JSON.stringify(tags), ...(stack ? [] : ["--enable-termination-protection"]), ...(options.parameters ? ["--parameters", `file://${path.resolve(options.parameters)}`] : [])];
    try { await aws.call("cloudformation", operation, args); }
    catch (error) { if (error.code === "Unchanged") return report({ action: "provision", stack: options.stack, unchanged: true }); throw error; }
    report({ action: "provision", stack: options.stack, state: "submitted", next: "status", warning: "Do not resubmit while CloudFormation is in progress." });
    return;
  }
  if (options.action === "status") {
    const outputs = mapOutputs(stack);
    const summary = { action: "status", stack: options.stack, stackStatus: stack.StackStatus, outputs: Object.fromEntries(["ControllerInstanceId", "ArtifactBucket", "ApplicationRepositoryUri", "SecretArn", "PublicUrl", "DataVolumeId"].filter(key => outputs[key]).map(key => [key, outputs[key]])) };
    if (options["command-id"]) {
      const invocation = await aws.call("ssm", "get-command-invocation", ["--command-id", options["command-id"], "--instance-id", summary.outputs.ControllerInstanceId]);
      summary.command = { id: options["command-id"], status: invocation.Status, exitCode: invocation.ResponseCode };
    }
    return report(summary);
  }
  const target = await deploymentTarget(aws, options, stack);
  if (options.action === "deploy") {
    if (options.image.split("@")[0] !== target.ApplicationRepositoryUri) fail("Image is not from this stack's application repository.");
    const digest = options.image.split("@")[1];
    const images = await aws.call("ecr", "batch-get-image", ["--repository-name", target.ApplicationRepositoryUri.slice(target.registry.length + 1), "--image-ids", `imageDigest=${digest}`]);
    if (!images.images?.some(image => image.imageId?.imageDigest === digest)) fail("Immutable image digest is unavailable in the stack repository.");
  }
  const managed = await aws.call("ssm", "describe-instance-information", ["--filters", `Key=InstanceIds,Values=${target.ControllerInstanceId}`]);
  if (!managed.InstanceInformationList?.some(instance => instance.InstanceId === target.ControllerInstanceId && instance.PingStatus === "Online")) fail("Controller SSM agent is not online yet. Retry status, not provisioning.");
  const payload = { action: options.action, region: options.region, stack: stack.StackId, image: options.image || null, container: options.container, mount: options.mount, destination: options.destination, port: Number(options.port), health: options.health, timeout: Number(options.timeout), secret: target.SecretArn, registry: target.registry, volume: target.DataVolumeId, readyFile: options["ready-file"] };
  const script = await readFile(new URL("./aws-rollout.py", import.meta.url), "utf8");
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  const commands = [`python3 - '${encoded}' <<'TWELVE_APPS_AWS_ROLLOUT'\n${script}\nTWELVE_APPS_AWS_ROLLOUT`];
  const sent = await aws.call("ssm", "send-command", ["--document-name", "AWS-RunShellScript", "--instance-ids", target.ControllerInstanceId, "--timeout-seconds", "600", "--parameters", JSON.stringify({ commands, executionTimeout: ["1800"] }), "--cloud-watch-output-config", "CloudWatchOutputEnabled=false", "--comment", "12-apps-ci immutable container rollout"]);
  const commandId = sent.Command?.CommandId;
  if (!/^[a-f0-9-]{36}$/.test(commandId || "")) fail("SSM did not return a command handle. Inspect AWS before submitting another deployment.");
  report({ action: options.action, commandId, instanceId: target.ControllerInstanceId, state: "submitted" });
  for (let attempt = 0; attempt < 360; attempt++) {
    let invocation;
    try { invocation = await aws.call("ssm", "get-command-invocation", ["--command-id", commandId, "--instance-id", target.ControllerInstanceId]); }
    catch (error) { if (error.code === "NotYetVisible") { await sleep(5000); continue; } throw error; }
    if (invocation.Status === "Success" && invocation.ResponseCode === 0) return report({ action: options.action, commandId, state: "healthy", publicUrl: target.PublicUrl });
    if (!["Pending", "InProgress", "Delayed"].includes(invocation.Status)) fail(`SSM rollout ${commandId} ended ${invocation.Status}. Previous container recovery was attempted; inspect status without resubmitting blindly. Sensitive remote output suppressed.`);
    await sleep(5000);
  }
  fail(`Observation timed out for live SSM command ${commandId}. Do not resubmit or restart it; inspect status --command-id ${commandId}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await run(argumentsFor(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
