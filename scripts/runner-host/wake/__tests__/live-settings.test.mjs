import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { liveSettings } from "../live-settings.mjs";

// A redeploy that only wants a new image must pass the settings the fleet runs
// with today, or deploy.sh's defaults come back: a $10 budget for a $20 one,
// the pnpm store mounted again, a rotated webhook secret.

// The scaler's environment as it stood on 2026-09-26, secret replaced.
const lambdaEnv = {
  MODE: "scale", WEBHOOK_SECRET: "s3cr3t", RUNNER_LABEL: "future-pay-ci", REPOSITORY: "12-apps/future-pay",
  LAUNCH_TEMPLATE: "ci-runner-fleet-future-pay-ci", TOKEN_PARAMETER: "/ci-runner/github-app-key",
  INSTANCE_TYPES: "m7a.2xlarge,m6a.2xlarge", REGIONS: "eu-north-1,us-east-2,us-east-1", SLOTS_PER_HOST: "2",
  MAX_HOSTS: "30", DAILY_BUDGET: "20", DEGRADED_MAX_HOSTS: "2", BUDGET_UTC_OFFSET: "-3",
  ALERT_PARAMETER: "/ci-runner/budget-alert", SPOT_STRATEGY: "capacity-optimized",
};
// deploy.sh's launch template data, with and without the pnpm-store blanking line.
const template = (store) => ({
  UserData: Buffer.from(userData(store)).toString("base64"),
  BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeSize: 72, VolumeType: "gp3", Iops: 6000, Throughput: 500 } }],
});
const userData = (store) => `#cloud-config
bootcmd:
  - [sh, -c, "sed -i 's/^CI_RUNNER_IDLE_MINUTES=.*/CI_RUNNER_IDLE_MINUTES=2/' /etc/ci-runner/env"]
  - [sh, -c, "t=$(curl -s -m 5 -X PUT http://169.254.169.254/latest/api/token); echo"]
${store === "off" ? `  - [sh, -c, "sed -i 's/^CI_RUNNER_PNPM_STORE=.*/CI_RUNNER_PNPM_STORE=/' /etc/ci-runner/env"]\n` : ""}`;

test("every setting deploy.sh would otherwise default comes from the live fleet", () => {
  const { env, secret } = liveSettings(lambdaEnv, template("off"), 1);
  assert.deepEqual(env, {
    REGIONS: "eu-north-1,us-east-2,us-east-1", DAILY_BUDGET: "20", DEGRADED_MAX_HOSTS: "2", BUDGET_UTC_OFFSET: "-3",
    ALERT_PARAMETER: "/ci-runner/budget-alert", SPOT_STRATEGY: "capacity-optimized", INSTANCE_TYPES: "m7a.2xlarge,m6a.2xlarge",
    MAX_HOSTS: "30", SLOTS_PER_HOST: "2", TOKEN_PARAMETER: "/ci-runner/github-app-key", REPOSITORY: "12-apps/future-pay",
    RUNNER_LABEL: "future-pay-ci", IDLE_MINUTES: "2", PNPM_STORE: "off",
    ROOT_IOPS: "6000", ROOT_THROUGHPUT: "500", POOL_SIZE: "1",
  });
  assert.equal(secret, "s3cr3t");
});

test("the pnpm store switch follows the user data, whichever way it is set", () => {
  assert.equal(liveSettings(lambdaEnv, template("off")).env.PNPM_STORE, "off");
  assert.equal(liveSettings(lambdaEnv, template("on")).env.PNPM_STORE, "on");
});

test("a fleet that does not say its budget or regions is refused, never redeployed on defaults", () => {
  const { DAILY_BUDGET, ...noBudget } = lambdaEnv;
  assert.throws(() => liveSettings(noBudget, template("off")), /DAILY_BUDGET/);
  assert.throws(() => liveSettings({ ...lambdaEnv, REGIONS: "" }, template("off")), /REGIONS/);
});

test("the CLI writes the secret to a private file, never to stdout, and quotes every value for eval", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "live-"));
  const odd = { ...lambdaEnv, ALERT_PARAMETER: "/it's/quoted" };
  writeFileSync(path.join(dir, "env.json"), JSON.stringify(odd));
  writeFileSync(path.join(dir, "lt.json"), JSON.stringify(template("off")));
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "live-settings.mjs");
  const out = execFileSync("node", [cli, path.join(dir, "env.json"), path.join(dir, "lt.json"), "0", path.join(dir, "secret")], { encoding: "utf8" });
  assert.ok(!out.includes("s3cr3t"), "the secret is never printed");
  assert.equal(readFileSync(path.join(dir, "secret"), "utf8"), "s3cr3t\n");
  assert.equal(statSync(path.join(dir, "secret")).mode & 0o777, 0o600);
  const alert = execFileSync("bash", ["-c", `${out}\nprintf '%s' "$ALERT_PARAMETER"`], { encoding: "utf8" });
  assert.equal(alert, "/it's/quoted");
});

test("a live warm pool is kept, and a pool size that is not a count is refused", () => {
  assert.equal(liveSettings(lambdaEnv, template("off"), 3).env.POOL_SIZE, "3");
  assert.equal(liveSettings(lambdaEnv, template("off")).env.POOL_SIZE, "0");
  const dir = mkdtempSync(path.join(tmpdir(), "live-"));
  writeFileSync(path.join(dir, "env.json"), JSON.stringify(lambdaEnv));
  writeFileSync(path.join(dir, "lt.json"), JSON.stringify(template("off")));
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "live-settings.mjs");
  assert.throws(() => execFileSync("node", [cli, path.join(dir, "env.json"), path.join(dir, "lt.json"), "", path.join(dir, "s")], { stdio: "pipe" }));
});
