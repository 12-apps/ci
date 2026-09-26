import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
// at a chosen step, so the test sees exactly what cleanup asked AWS to do.

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "refresh-image.sh");

function run(failAt) {
  const dir = mkdtempSync(path.join(tmpdir(), "refresh-image-"));
  const calls = path.join(dir, "calls.log");
  writeFileSync(
    path.join(dir, "aws"),
    `#!/usr/bin/env bash
echo "$*" >> "${calls}"
[[ " $* " == *" ${failAt} "* ]] && { echo "fake failure" >&2; exit 254; }
case " $* " in
  *" describe-launch-template-versions "*) echo ami-base ;;
  *" describe-images "*"RootDeviceName"*) echo /dev/sda1 ;;
  *" describe-images "*"VolumeSize"*) echo 50 ;;
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
    SUBNET_ID: "subnet-x",
    SECURITY_GROUP_ID: "sg-x",
    INSTANCE_PROFILE_ARN: "arn:aws:iam::1:instance-profile/x",
  };
  // `sleep` is real in the script; the fake answers every poll on its first try.
  const res = spawnSync("bash", [script], { env, encoding: "utf8", timeout: 60_000 });
  const log = readFileSync(calls, "utf8").trim().split("\n");
  return { status: res.status, stderr: res.stderr, log, terminated: log.filter((l) => l.includes("terminate-instances")) };
}

test("a failure on the golden host terminates it", () => {
  const { status, terminated } = run("send-command");
  assert.notEqual(status, 0);
  assert.equal(terminated.length, 1, "cleanup terminates once");
  assert.match(terminated[0], /--instance-ids i-fake1\b/);
});

test("a failure after the smoke host started terminates both hosts", () => {
  // lambda get-function-configuration is step 3, after both launches.
  const { status, terminated, log } = run("get-function-configuration");
  assert.notEqual(status, 0);
  assert.equal(log.filter((l) => l.includes("run-instances")).length, 2);
  assert.match(terminated[0], /--instance-ids i-fake1 i-fake2\b/);
});

test("a failure launching the golden terminates nothing and stops the run", () => {
  const { status, terminated, log } = run("run-instances");
  assert.notEqual(status, 0);
  assert.deepEqual(terminated, []);
  assert.ok(!log.some((l) => l.includes("create-image")), "no image from a host that never started");
});
