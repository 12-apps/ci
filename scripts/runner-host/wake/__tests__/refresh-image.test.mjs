import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// refresh-image.sh starts on-demand m7a.2xlarge hosts; the promise that every
// one of them is terminated on exit is what makes a weekly unattended run safe.
// The first real run broke it: `golden=$(launch …)` ran launch in a subshell,
// its `started+=` never reached the EXIT trap, and both hosts outlived the run.
//
// The script runs for real against a fake `aws` that logs every call and fails
// on any call whose arguments contain one of the given strings, so the test sees
// exactly what the script asked AWS to do.

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "refresh-image.sh");
const workflow = path.join(here, "..", "..", "..", "..", ".github", "workflows", "runner-image-refresh.yml");

const lambdaEnv = {
  WEBHOOK_SECRET: "s3cr3t", RUNNER_LABEL: "future-pay-ci", REPOSITORY: "12-apps/future-pay",
  REGIONS: "us-east-1", DAILY_BUDGET: "20", TOKEN_PARAMETER: "/ci-runner/live-key", SLOTS_PER_HOST: "2",
};
const templateData = {
  ImageId: "ami-base",
  UserData: Buffer.from("#cloud-config\nbootcmd: []\n").toString("base64"),
  BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeSize: 72, Iops: 6000, Throughput: 500 } }],
};

function run(...failOn) {
  return runWith({}, ...failOn);
}

function runWith(overrides, ...failOn) {
  const dir = mkdtempSync(path.join(tmpdir(), "refresh-image-"));
  const calls = path.join(dir, "calls.log");
  writeFileSync(path.join(dir, "lambda.json"), JSON.stringify(lambdaEnv));
  writeFileSync(path.join(dir, "template.json"), JSON.stringify(templateData));
  writeFileSync(
    path.join(dir, "aws"),
    `#!/usr/bin/env bash
echo "$*" >> "${calls}"
for f in ${failOn.map((f) => `'${f}'`).join(" ")}; do
  [[ "$*" == *"$f"* ]] && { echo "fake failure" >&2; exit 254; }
done
case " $* " in
  *" get-function-configuration "*) cat "${dir}/lambda.json" ;;
  *" describe-launch-template-versions "*) cat "${dir}/template.json" ;;
  *" describe-instances "*) echo 0 ;;
  *" describe-images "*"RootDeviceName"*) echo /dev/sda1 ;;
  *" describe-images "*"VolumeSize"*) echo 72 ;;
  *" describe-images "*"State"*) echo available ;;
  *" run-instances "*) n=$(grep -c run-instances "${calls}"); echo "i-fake$n" ;;
  *" describe-instance-information "*) echo Online ;;
  *" send-command "*) echo cmd-1 ;;
  *" get-command-invocation "*"Status"*) echo Success ;;
  *" get-command-invocation "*) echo ok ;;
  *" create-image "*) echo ami-new ;;
esac
`,
  );
  chmodSync(path.join(dir, "aws"), 0o755);
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    AWS_REGION: "us-east-1",
    CI_REF: "abc",
    REFRESH_ID: "run-42",
    SUBNET_ID: "subnet-x",
    SECURITY_GROUP_ID: "sg-x",
    INSTANCE_PROFILE_ARN: "arn:aws:iam::1:instance-profile/x",
    RUNNER_LABEL: "future-pay-ci",
    FUNCTION_NAME: "ci-runner-scale",
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  // `sleep` is real in the script; the fake answers every poll on its first try.
  const res = spawnSync("bash", [script], { env, encoding: "utf8", timeout: 60_000 });
  const log = (existsSync(calls) ? readFileSync(calls, "utf8") : "").trim().split("\n");
  const sent = log
    .filter((l) => l.includes("send-command"))
    .map((l) => Buffer.from(/echo (\S+) \| base64 -d/.exec(l)[1], "base64").toString("utf8"));
  return { status: res.status, stderr: res.stderr, log, sent, terminated: log.filter((l) => l.includes("terminate-instances")) };
}

test("a failure reading the live settings stops the run before any host starts", () => {
  const { status, log, terminated } = run("get-function-configuration");
  assert.notEqual(status, 0);
  assert.ok(!log.some((l) => l.includes("run-instances")));
  assert.deepEqual(terminated, []);
});

test("a failure on the golden host terminates it", () => {
  const { status, terminated } = run("send-command");
  assert.notEqual(status, 0);
  assert.equal(terminated.length, 1, "cleanup terminates once");
  assert.match(terminated[0], /--instance-ids i-fake1$/);
});

test("a failure after the smoke host started terminates both hosts", () => {
  const { status, terminated, log } = run("--instance-ids i-fake2 --document-name");
  assert.notEqual(status, 0);
  assert.equal(log.filter((l) => l.includes("run-instances")).length, 2);
  assert.match(terminated[0], /--instance-ids i-fake1 i-fake2$/);
});

test("a failure launching the golden terminates nothing and stops the run", () => {
  const { status, terminated, log } = run("run-instances");
  assert.notEqual(status, 0);
  assert.deepEqual(terminated, []);
  assert.ok(!log.some((l) => l.includes("create-image")), "no image from a host that never started");
});

test("a terminate that fails is reported and fails the run", () => {
  const { status, stderr } = run("send-command", "terminate-instances");
  assert.notEqual(status, 0);
  assert.match(stderr, /COULD NOT TERMINATE i-fake1.*ci-runner-refresh=run-42/);
  assert.doesNotMatch(stderr, /refresh: terminated/);
});

test("every host is tagged with the run, so a killed run's hosts can be found", () => {
  const { log } = run("--instance-ids i-fake2 --document-name");
  const launches = log.filter((l) => l.includes("run-instances"));
  for (const l of launches) assert.match(l, /\{Key=ci-runner-refresh,Value=run-42\}/);
});

test("the golden host holds its slots and idle timer, and images the live token parameter", () => {
  const { sent } = run("--instance-ids i-fake2 --document-name");
  const golden = sent[0];
  const hold = golden.indexOf("refresh-hold.conf");
  const prepare = golden.indexOf("prepare-golden.sh");
  assert.ok(hold !== -1 && hold < prepare, "the hold is in place before install.sh starts anything");
  assert.match(golden, /for unit in ci-runner@\.service ci-runner-idle\.service/);
  assert.match(golden, /\/run\/systemd\/system\//, "a runtime drop-in, which the image does not capture");
  assert.match(golden, /CI_RUNNER_TOKEN_PARAMETER='\/ci-runner\/live-key' \.\/scripts\/runner-host\/wake\/prepare-golden\.sh '2'/);
});

for (const name of ["AWS_REGION", "RUNNER_LABEL", "FUNCTION_NAME"]) {
  test(`without ${name} nothing is read or launched: no default names a fleet`, () => {
    const { status, stderr, log } = runWith({ [name]: undefined });
    assert.notEqual(status, 0);
    assert.match(stderr, new RegExp(`${name}: set ${name}`));
    assert.deepEqual(log, [""], "not one AWS call");
  });
}

test("a scaler that serves another fleet stops the run before any host starts", () => {
  const { status, stderr, log } = runWith({ RUNNER_LABEL: "other-ci" });
  assert.notEqual(status, 0);
  assert.match(stderr, /ci-runner-scale scales the future-pay-ci fleet, not other-ci/);
  assert.ok(!log.some((l) => l.includes("run-instances")));
});

test("the workflow is reusable and schedules nothing: its logs belong to the consumer", () => {
  // In this public repository every run's log is public, and a refresh logs
  // the account, the fleet's subnets and regions and the scaler's URL.
  const source = readFileSync(workflow, "utf8");
  const on = /^on:\n((?: .*\n|\n)*)/m.exec(source)[1];
  assert.match(on, /^ {2}workflow_call:/m);
  assert.doesNotMatch(on, /^ {2}(schedule|workflow_dispatch|push|pull_request\w*):/m);
  assert.doesNotMatch(source, /vars\./, "every value comes from the caller's inputs");
});
