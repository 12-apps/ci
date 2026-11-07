import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// FUT-4536: a light pool launches the main fleet's image under a template of
// its own, so a refresh that rebuilt the image for the main fleet alone would
// leave the light hosts on a runner GitHub stops accepting. LIGHT_FUNCTION_NAME
// redeploys the light scaler with the same image and ITS live settings.
//
// refresh-image.sh runs for real here, from a copy whose deploy.sh is a fake
// that records the settings each deploy was handed, against a fake `aws` (the
// refresh-image.test.mjs pattern). Without LIGHT_FUNCTION_NAME there must be
// exactly one deploy, handed what it was handed before.

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
const userData = (labels) => Buffer.from(`#cloud-config
bootcmd:
  - [sh, -c, "sed -i 's/^CI_RUNNER_IDLE_MINUTES=.*/CI_RUNNER_IDLE_MINUTES=${labels ? 5 : 2}/' /etc/ci-runner/env"]
  - [sh, -c, "sed -i 's/^CI_RUNNER_PNPM_STORE=.*/CI_RUNNER_PNPM_STORE=/' /etc/ci-runner/env"]
${labels ? `  - [sh, -c, "sed -i 's/^CI_RUNNER_LABELS=.*/CI_RUNNER_LABELS=${labels}/' /etc/ci-runner/env"]\n` : ""}`).toString("base64");
const template = (labels, throughput) => ({
  ImageId: "ami-base", UserData: userData(labels),
  BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeSize: 64, Iops: 3000, Throughput: throughput } }],
});

// The settings each deploy is handed, one JSON line per deploy.
const RECORDED = ["AMI_ID", "FUNCTION_NAME", "RUNNER_LABEL", "REPOSITORY", "REGIONS", "DAILY_BUDGET", "INSTANCE_TYPES", "MAX_HOSTS",
  "SLOTS_PER_HOST", "SETTLE_SECONDS", "TOKEN_PARAMETER", "IDLE_MINUTES", "PNPM_STORE", "ROOT_THROUGHPUT", "HOST_LABELS",
  "WEBHOOK_SECRET_PARAMETER", "CREATE_WEBHOOK", "POOL_SIZE"];

function refresh({ env = {}, lightLambda = light, failOn = [], lightLabels = "future-pay-ci-light" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "refresh-light-"));
  const kit = path.join(dir, "wake");
  spawnSync("mkdir", ["-p", kit]);
  copyFileSync(path.join(wake, "refresh-image.sh"), path.join(kit, "refresh-image.sh"));
  copyFileSync(path.join(wake, "live-settings.mjs"), path.join(kit, "live-settings.mjs"));
  const deploys = path.join(dir, "deploys.log");
  writeFileSync(path.join(kit, "deploy.sh"), `node -e 'const o={};for(const k of ${JSON.stringify(RECORDED)})if(process.env[k]!==undefined)o[k]=process.env[k];
o.secret=require("fs").existsSync(process.env.WAKE_SECRET_FILE)?require("fs").readFileSync(process.env.WAKE_SECRET_FILE,"utf8").trim():null;
require("fs").appendFileSync(${JSON.stringify(deploys)}, JSON.stringify(o)+"\\n")'
`);
  writeFileSync(path.join(dir, "main.json"), JSON.stringify(main));
  writeFileSync(path.join(dir, "light.json"), JSON.stringify(lightLambda));
  writeFileSync(path.join(dir, "main-lt.json"), JSON.stringify(template("", 250)));
  writeFileSync(path.join(dir, "light-lt.json"), JSON.stringify(template(lightLabels, 125)));
  const calls = path.join(dir, "calls.log");
  writeFileSync(path.join(dir, "aws"), `#!/usr/bin/env bash
echo "$*" >> "${calls}"
for f in ${failOn.map((f) => `'${f}'`).join(" ")}; do [[ "$*" == *"$f"* ]] && { echo "fake failure" >&2; exit 254; }; done
case " $* " in
  *" get-function-configuration --function-name ci-runner-scale-light "*) cat "${dir}/light.json" ;;
  *" get-function-configuration "*) cat "${dir}/main.json" ;;
  *"--launch-template-name ci-runner-fleet-future-pay-ci-light "*) cat "${dir}/light-lt.json" ;;
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

test("without LIGHT_FUNCTION_NAME one deploy runs, with the main fleet's live settings, as before", () => {
  const r = refresh();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.deploys.length, 1);
  assert.deepEqual(r.deploys[0], {
    AMI_ID: "ami-new", FUNCTION_NAME: "ci-runner-scale", RUNNER_LABEL: "future-pay-ci", REPOSITORY: "12-apps/future-pay",
    REGIONS: "us-east-2,us-east-1", DAILY_BUDGET: "20", INSTANCE_TYPES: "m7a.2xlarge,m6a.2xlarge", MAX_HOSTS: "30",
    SLOTS_PER_HOST: "2", SETTLE_SECONDS: "30", TOKEN_PARAMETER: "/ci-runner/github-app-key", IDLE_MINUTES: "2",
    PNPM_STORE: "off", ROOT_THROUGHPUT: "250", POOL_SIZE: "0", secret: "main-secret",
  });
  assert.ok(!r.log.some((l) => l.includes("light")), "no light scaler is read");
});

test("with LIGHT_FUNCTION_NAME the light pool gets the same image with its own settings, and nothing of the main fleet's", () => {
  const r = refresh({ env: { LIGHT_FUNCTION_NAME: "ci-runner-scale-light" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.deploys.length, 2);
  assert.equal(r.deploys[0].FUNCTION_NAME, "ci-runner-scale");
  assert.equal(r.deploys[0].HOST_LABELS, undefined, "the main deploy is unchanged");
  assert.deepEqual(r.deploys[1], {
    AMI_ID: "ami-new", FUNCTION_NAME: "ci-runner-scale-light", RUNNER_LABEL: "future-pay-ci-light", REPOSITORY: "12-apps/future-pay",
    REGIONS: "us-east-1", DAILY_BUDGET: "3", INSTANCE_TYPES: "m7a.large,m6a.large", MAX_HOSTS: "10", SLOTS_PER_HOST: "2",
    IDLE_MINUTES: "5", PNPM_STORE: "off", ROOT_THROUGHPUT: "125", HOST_LABELS: "future-pay-ci-light",
    WEBHOOK_SECRET_PARAMETER: "/ci-runner/webhook-secret-future-pay-ci-light", CREATE_WEBHOOK: "0", POOL_SIZE: "0", secret: null,
  });
  assert.equal(r.deploys[1].SETTLE_SECONDS, undefined, "the main fleet's settle does not leak in");
  assert.equal(r.deploys[1].TOKEN_PARAMETER, undefined, "nor its token parameter");
});

test("the light scaler is read before any host starts, and a failure there launches nothing", () => {
  const ok = refresh({ env: { LIGHT_FUNCTION_NAME: "ci-runner-scale-light" } });
  const read = ok.log.findIndex((l) => l.includes("get-function-configuration --function-name ci-runner-scale-light"));
  const first = ok.log.findIndex((l) => l.includes("run-instances"));
  assert.ok(read !== -1 && read < first);
  const failed = refresh({ env: { LIGHT_FUNCTION_NAME: "ci-runner-scale-light" }, failOn: ["--function-name ci-runner-scale-light"] });
  assert.notEqual(failed.status, 0);
  assert.ok(!failed.log.some((l) => l.includes("run-instances")));
  assert.deepEqual(failed.deploys, []);
});

for (const [why, env, lightLambda, message, lightTemplate] of [
  ["names the main scaler", { LIGHT_FUNCTION_NAME: "ci-runner-scale" }, light, /LIGHT_FUNCTION_NAME is ci-runner-scale itself/],
  ["scales the main label", { LIGHT_FUNCTION_NAME: "ci-runner-scale-light" }, { ...light, RUNNER_LABEL: "future-pay-ci" }, /scales 'future-pay-ci', not a fleet of its own/],
  ["registers its hosts under the image's labels (no HOST_LABELS)", { LIGHT_FUNCTION_NAME: "ci-runner-scale-light" }, light, /hosts register as 'the image labels, no HOST_LABELS', not future-pay-ci-light; redeploy it with HOST_LABELS=future-pay-ci-light/, "no-labels"],
  ["has a settle out of range", { LIGHT_FUNCTION_NAME: "ci-runner-scale-light" }, { ...light, SETTLE_SECONDS: "120" }, /live SETTLE_SECONDS '120' is outside 0 to 90/],
]) {
  test(`a light scaler that ${why} stops the run before any host starts`, () => {
    const r = refresh({ env, lightLambda, lightLabels: lightTemplate === "no-labels" ? "" : undefined });
    assert.equal(r.status, 64);
    assert.match(r.stderr, message);
    assert.ok(!r.log.some((l) => l.includes("run-instances")));
    assert.deepEqual(r.deploys, []);
  });
}

test("the workflow passes light_function_name through, empty by default", () => {
  const source = readFileSync(workflow, "utf8");
  assert.match(source, /light_function_name:\n(?: {8}.*\n)*? {8}default: ''\n/);
  assert.match(source, /LIGHT_FUNCTION_NAME: \$\{\{ inputs\.light_function_name \}\}/);
});
