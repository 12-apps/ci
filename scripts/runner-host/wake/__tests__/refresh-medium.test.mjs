import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// FUT-4944: a medium pool, like the light pool (refresh-light.test.mjs),
// launches the main fleet's image under a template of its own, so the weekly
// refresh redeploys it too when MEDIUM_FUNCTION_NAME names its scaler. Unset,
// the refresh is exactly what it was (refresh-light.test.mjs pins that).
//
// refresh-image.sh runs for real, from a copy whose deploy.sh records what each
// deploy was handed, against a fake `aws` that knows three scalers.

const here = path.dirname(fileURLToPath(import.meta.url));
const wake = path.join(here, "..");
const workflow = path.join(wake, "..", "..", "..", ".github", "workflows", "runner-image-refresh.yml");

const main = {
  WEBHOOK_SECRET: "main-secret", RUNNER_LABEL: "future-pay-ci", REPOSITORY: "12-apps/future-pay", REGIONS: "us-east-2,us-east-1",
  DAILY_BUDGET: "20", TOKEN_PARAMETER: "/ci-runner/github-app-key", SLOTS_PER_HOST: "2", MAX_HOSTS: "30", SETTLE_SECONDS: "30",
  INSTANCE_TYPES: "m7a.2xlarge,m6a.2xlarge",
};
const light = {
  WEBHOOK_SECRET_PARAMETER: "/ci-runner/webhook-secret-future-pay-ci-light", RUNNER_LABEL: "future-pay-ci-light",
  REPOSITORY: "12-apps/future-pay", REGIONS: "us-east-1", DAILY_BUDGET: "3", SLOTS_PER_HOST: "2", MAX_HOSTS: "10",
  INSTANCE_TYPES: "m7a.large,m6a.large",
};
const medium = {
  WEBHOOK_SECRET_PARAMETER: "/ci-runner/webhook-secret-future-pay-ci-medium", RUNNER_LABEL: "future-pay-ci-medium",
  REPOSITORY: "12-apps/future-pay", REGIONS: "us-east-1", DAILY_BUDGET: "4", SLOTS_PER_HOST: "1", MAX_HOSTS: "12",
  INSTANCE_TYPES: "r7a.large,r6a.large,r7i.large,r6i.large",
};
const userData = (labels, slots) => Buffer.from(`#cloud-config
bootcmd:
  - [sh, -c, "sed -i 's/^CI_RUNNER_IDLE_MINUTES=.*/CI_RUNNER_IDLE_MINUTES=${labels ? 5 : 2}/' /etc/ci-runner/env"]
  - [sh, -c, "sed -i 's/^CI_RUNNER_PNPM_STORE=.*/CI_RUNNER_PNPM_STORE=/' /etc/ci-runner/env"]
${labels ? `  - [sh, -c, "sed -i 's/^CI_RUNNER_LABELS=.*/CI_RUNNER_LABELS=${labels}/' /etc/ci-runner/env"]\n` : ""}\
${slots ? `  - [sh, -c, "sed -i 's/^CI_RUNNER_SLOTS=.*/CI_RUNNER_SLOTS=${slots}/' /etc/ci-runner/env"]\n` : ""}`).toString("base64");
const template = (labels, throughput, slots = "") => ({
  ImageId: "ami-base", UserData: userData(labels, slots),
  BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeSize: 64, Iops: 3000, Throughput: throughput } }],
});

const RECORDED = ["AMI_ID", "FUNCTION_NAME", "RUNNER_LABEL", "REGIONS", "DAILY_BUDGET", "INSTANCE_TYPES", "MAX_HOSTS",
  "SLOTS_PER_HOST", "SETTLE_SECONDS", "TOKEN_PARAMETER", "HOST_LABELS", "HOST_SLOTS", "WEBHOOK_SECRET_PARAMETER", "CREATE_WEBHOOK"];

function refresh({ env = {}, mediumLambda = medium } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "refresh-medium-"));
  const kit = path.join(dir, "wake");
  spawnSync("mkdir", ["-p", kit]);
  copyFileSync(path.join(wake, "refresh-image.sh"), path.join(kit, "refresh-image.sh"));
  copyFileSync(path.join(wake, "live-settings.mjs"), path.join(kit, "live-settings.mjs"));
  const deploys = path.join(dir, "deploys.log");
  writeFileSync(path.join(kit, "deploy.sh"), `node -e 'const o={};for(const k of ${JSON.stringify(RECORDED)})if(process.env[k]!==undefined)o[k]=process.env[k];
require("fs").appendFileSync(${JSON.stringify(deploys)}, JSON.stringify(o)+"\\n")'
`);
  writeFileSync(path.join(dir, "main.json"), JSON.stringify(main));
  writeFileSync(path.join(dir, "light.json"), JSON.stringify(light));
  writeFileSync(path.join(dir, "medium.json"), JSON.stringify(mediumLambda));
  writeFileSync(path.join(dir, "main-lt.json"), JSON.stringify(template("", 250)));
  writeFileSync(path.join(dir, "light-lt.json"), JSON.stringify(template("future-pay-ci-light", 125)));
  writeFileSync(path.join(dir, "medium-lt.json"), JSON.stringify(template("future-pay-ci-medium", 250, "1")));
  const calls = path.join(dir, "calls.log");
  writeFileSync(path.join(dir, "aws"), `#!/usr/bin/env bash
echo "$*" >> "${calls}"
case " $* " in
  *" get-function-configuration --function-name ci-runner-scale-light "*) cat "${dir}/light.json" ;;
  *" get-function-configuration --function-name ci-runner-scale-medium "*) cat "${dir}/medium.json" ;;
  *" get-function-configuration "*) cat "${dir}/main.json" ;;
  *"--launch-template-name ci-runner-fleet-future-pay-ci-light "*) cat "${dir}/light-lt.json" ;;
  *"--launch-template-name ci-runner-fleet-future-pay-ci-medium "*) cat "${dir}/medium-lt.json" ;;
  *" describe-launch-template-versions "*) cat "${dir}/main-lt.json" ;;
  *" describe-instances "*) echo 0 ;;
  *" describe-images "*"RootDeviceName"*) echo /dev/sda1 ;;
  *" describe-images "*"VolumeSize"*) echo 64 ;;
  *" describe-images "*"State"*) echo available ;;
  *" run-instances "*) n=$(grep -c run-instances "${calls}"); echo "i-fake$n" ;;
  *" describe-instance-information "*) echo Online ;;
  *" send-command "*) echo cmd-1 ;;
  *" get-command-invocation "*"Status"*) echo Success ;;
  *" get-command-invocation "*) echo ok ;;
  *" create-image "*) echo ami-new ;;
esac
`);
  chmodSync(path.join(dir, "aws"), 0o755);
  writeFileSync(path.join(dir, "sleep"), "#!/usr/bin/env bash\n");
  chmodSync(path.join(dir, "sleep"), 0o755);
  const res = spawnSync("bash", [path.join(kit, "refresh-image.sh")], {
    encoding: "utf8", timeout: 60_000,
    env: {
      PATH: `${dir}:${process.env.PATH}`, HOME: dir, AWS_REGION: "us-east-1", CI_REF: "abc", REFRESH_ID: "run-7",
      SUBNET_ID: "subnet-x", SECURITY_GROUP_ID: "sg-x", INSTANCE_PROFILE_ARN: "arn:aws:iam::1:instance-profile/x",
      RUNNER_LABEL: "future-pay-ci", FUNCTION_NAME: "ci-runner-scale", ...env,
    },
  });
  const log = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
  const ran = existsSync(deploys) ? readFileSync(deploys, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { status: res.status, stderr: res.stderr, log, deploys: ran };
}

test("without MEDIUM_FUNCTION_NAME no medium scaler is read or deployed", () => {
  const r = refresh({ env: { LIGHT_FUNCTION_NAME: "ci-runner-scale-light" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.deploys.map((d) => d.FUNCTION_NAME), ["ci-runner-scale", "ci-runner-scale-light"]);
  assert.ok(!r.log.some((l) => l.includes("medium")), "no medium scaler is read");
});

test("with MEDIUM_FUNCTION_NAME the medium pool gets the same image with its own settings, slot count included", () => {
  const r = refresh({ env: { MEDIUM_FUNCTION_NAME: "ci-runner-scale-medium" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.deploys.map((d) => d.FUNCTION_NAME), ["ci-runner-scale", "ci-runner-scale-medium"]);
  assert.deepEqual(r.deploys[1], {
    AMI_ID: "ami-new", FUNCTION_NAME: "ci-runner-scale-medium", RUNNER_LABEL: "future-pay-ci-medium", REGIONS: "us-east-1",
    DAILY_BUDGET: "4", INSTANCE_TYPES: "r7a.large,r6a.large,r7i.large,r6i.large", MAX_HOSTS: "12", SLOTS_PER_HOST: "1",
    HOST_LABELS: "future-pay-ci-medium", HOST_SLOTS: "1", WEBHOOK_SECRET_PARAMETER: "/ci-runner/webhook-secret-future-pay-ci-medium", CREATE_WEBHOOK: "0",
  });
});

test("with both pools each is deployed after the main fleet, with nothing of the other's", () => {
  const r = refresh({ env: { LIGHT_FUNCTION_NAME: "ci-runner-scale-light", MEDIUM_FUNCTION_NAME: "ci-runner-scale-medium" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.deploys.map((d) => d.FUNCTION_NAME), ["ci-runner-scale", "ci-runner-scale-light", "ci-runner-scale-medium"]);
  assert.equal(r.deploys[1].SLOTS_PER_HOST, "2");
  assert.equal(r.deploys[1].HOST_LABELS, "future-pay-ci-light");
  assert.equal(r.deploys[1].HOST_SLOTS, undefined, "the light pool keeps the image's slots");
  assert.equal(r.deploys[0].HOST_SLOTS, undefined, "so does the main fleet");
  assert.equal(r.deploys[2].SLOTS_PER_HOST, "1");
  assert.equal(r.deploys[2].HOST_LABELS, "future-pay-ci-medium");
  assert.equal(r.deploys[2].HOST_SLOTS, "1");
  assert.equal(r.deploys[2].SETTLE_SECONDS, undefined, "the main fleet's settle does not leak in");
  // Both scalers are read before any host starts.
  const first = r.log.findIndex((l) => l.includes("run-instances"));
  for (const fn of ["ci-runner-scale-light", "ci-runner-scale-medium"]) {
    const read = r.log.findIndex((l) => l.includes(`get-function-configuration --function-name ${fn}`));
    assert.ok(read !== -1 && read < first, fn);
  }
});

for (const [why, env, mediumLambda, message] of [
  ["names the main scaler", { MEDIUM_FUNCTION_NAME: "ci-runner-scale" }, medium, /MEDIUM_FUNCTION_NAME is ci-runner-scale itself/],
  ["names the light scaler", { LIGHT_FUNCTION_NAME: "ci-runner-scale-light", MEDIUM_FUNCTION_NAME: "ci-runner-scale-light" }, medium, /MEDIUM_FUNCTION_NAME is ci-runner-scale-light, which this run already deploys/],
  ["scales the light label", { LIGHT_FUNCTION_NAME: "ci-runner-scale-light", MEDIUM_FUNCTION_NAME: "ci-runner-scale-medium" }, { ...medium, RUNNER_LABEL: "future-pay-ci-light" }, /scales 'future-pay-ci-light', not a fleet of its own/],
]) {
  test(`a medium scaler that ${why} stops the run before any host starts`, () => {
    const r = refresh({ env, mediumLambda });
    assert.equal(r.status, 64);
    assert.match(r.stderr, message);
    assert.ok(!r.log.some((l) => l.includes("run-instances")));
    assert.deepEqual(r.deploys, []);
  });
}

test("the workflow passes medium_function_name through, empty by default", () => {
  const source = readFileSync(workflow, "utf8");
  assert.match(source, /medium_function_name:\n(?: {8}.*\n)*? {8}default: ''\n/);
  assert.match(source, /MEDIUM_FUNCTION_NAME: \$\{\{ inputs\.medium_function_name \}\}/);
});
