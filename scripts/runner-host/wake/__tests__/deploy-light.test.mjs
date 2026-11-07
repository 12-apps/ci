import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { liveSettings } from "../live-settings.mjs";

// FUT-4536: a light pool is a second deploy of the same scaler from the same
// image, with its own label (HOST_LABELS rewrites the image's at boot) and a
// webhook secret the owner keeps in SSM (WEBHOOK_SECRET_PARAMETER). Every
// setting is optional, and a deploy that sets neither must hand AWS exactly
// what it handed it before: that is the existing fleet's whole guarantee.
// The blocks of deploy.sh run here for real, against fakes, like
// deploy-package.test.mjs's queue-table block.

const here = path.dirname(fileURLToPath(import.meta.url));
const deployPath = path.join(here, "..", "deploy.sh");
const deploy = spawnSync("cat", [deployPath], { encoding: "utf8" }).stdout;

function block(from, to) {
  const start = deploy.indexOf(from);
  const end = deploy.indexOf(to, start);
  assert.ok(start !== -1 && end !== -1, `deploy.sh still has the block from ${JSON.stringify(from)}`);
  return deploy.slice(start, end);
}
const bash = (script) => spawnSync("bash", ["-c", `set -euo pipefail\n${script}`], { encoding: "utf8" });

// ── user data ─────────────────────────────────────────────────────────────
function userData({ store = "off", labels = "" } = {}) {
  const r = bash(`idle_minutes=2 pnpm_store=${store} host_labels='${labels}'
${block('store_cmd=""', "\n# gp3's baseline")}
printf '%s' "$user_data" | base64 -d`);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("without HOST_LABELS the user data is what it was: no labels line", () => {
  for (const store of ["off", "on"]) {
    const ud = userData({ store });
    assert.doesNotMatch(ud, /CI_RUNNER_LABELS/);
    // The three lines (two with the store on) every fleet host has booted with.
    const lines = ud.trimEnd().split("\n");
    assert.equal(lines[0], "#cloud-config");
    assert.equal(lines[1], "bootcmd:");
    assert.match(lines[2], /CI_RUNNER_IDLE_MINUTES=2\//);
    assert.match(lines[3], /CI_RUNNER_NAME=/);
    if (store === "off") {
      assert.equal(lines.length, 5);
      assert.match(lines[4], /CI_RUNNER_PNPM_STORE=\//);
    } else {
      assert.equal(lines.length, 4);
    }
  }
});

test("HOST_LABELS rewrites the image's labels at boot, with the store off or on", () => {
  const off = userData({ labels: "future-pay-ci-light" });
  assert.match(off, /CI_RUNNER_PNPM_STORE=\/' \/etc\/ci-runner\/env"\]\n {2}- \[sh, -c, "sed -i 's\/\^CI_RUNNER_LABELS=\.\*\/CI_RUNNER_LABELS=future-pay-ci-light\/' \/etc\/ci-runner\/env"\]\n/);
  const on = userData({ store: "on", labels: "future-pay-ci-light" });
  assert.doesNotMatch(on, /CI_RUNNER_PNPM_STORE/);
  assert.match(on, /^ {2}- \[sh, -c, "sed -i 's\/\^CI_RUNNER_LABELS=\.\*\/CI_RUNNER_LABELS=future-pay-ci-light\/'/m);
});

test("live-settings reads HOST_LABELS back from the user data, and nothing when there is none", () => {
  const lambda = { RUNNER_LABEL: "future-pay-ci-light", REPOSITORY: "o/r", REGIONS: "us-east-1", DAILY_BUDGET: "3", WEBHOOK_SECRET_PARAMETER: "/ci-runner/webhook-secret-future-pay-ci-light" };
  const template = (ud) => ({ UserData: Buffer.from(ud).toString("base64") });
  const light = liveSettings(lambda, template(userData({ labels: "future-pay-ci-light" })));
  assert.equal(light.env.HOST_LABELS, "future-pay-ci-light");
  assert.equal(light.env.WEBHOOK_SECRET_PARAMETER, "/ci-runner/webhook-secret-future-pay-ci-light");
  assert.equal(light.env.PNPM_STORE, "off");
  const { WEBHOOK_SECRET_PARAMETER, ...main } = lambda;
  const plain = liveSettings({ ...main, WEBHOOK_SECRET: "s" }, template(userData()));
  assert.equal(plain.env.HOST_LABELS, undefined);
  assert.equal(plain.env.WEBHOOK_SECRET_PARAMETER, undefined);
  assert.equal(plain.secret, "s");
});

test("the live-settings CLI needs no secret file for a scaler whose secret is in SSM", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "live-light-"));
  writeFileSync(path.join(dir, "env.json"), JSON.stringify({ RUNNER_LABEL: "l", REPOSITORY: "o/r", REGIONS: "us-east-1", DAILY_BUDGET: "3", WEBHOOK_SECRET_PARAMETER: "/p" }));
  writeFileSync(path.join(dir, "lt.json"), JSON.stringify({ UserData: "" }));
  const r = spawnSync("node", [path.join(here, "..", "live-settings.mjs"), path.join(dir, "env.json"), path.join(dir, "lt.json"), "0", path.join(dir, "secret")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^export WEBHOOK_SECRET_PARAMETER='\/p'$/m);
  assert.equal(spawnSync("test", ["-e", path.join(dir, "secret")]).status, 1, "no secret file written");
});

// ── the scaler's environment and role ───────────────────────────────────────
function lambdaEnv(secretParam) {
  const dir = mkdtempSync(path.join(tmpdir(), "deploy-env-"));
  writeFileSync(path.join(dir, "secret"), "file-secret\n");
  const r = bash(`work='${dir}' secret_file='${dir}/secret' secret_param='${secretParam}' label=l repo=o/r template=t param=/p types=m7a.large \\
live_regions=us-east-1 slots=2 max_hosts=10 daily_budget=3 degraded_max_hosts=1 budget_utc_offset=-3 alert_param=/a spot_strategy=capacity-optimized settle_seconds=30
${block('(umask 077; jq -n --rawfile s "$secret_file"', "\ncp ")}
cat '${dir}/env.json'`);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).Variables;
}

test("without WEBHOOK_SECRET_PARAMETER the scaler's environment carries the secret, as before", () => {
  const env = lambdaEnv("");
  assert.equal(env.WEBHOOK_SECRET, "file-secret");
  assert.equal(env.WEBHOOK_SECRET_PARAMETER, undefined);
  assert.deepEqual(Object.keys(env).sort(), [
    "ALERT_PARAMETER", "BUDGET_UTC_OFFSET", "DAILY_BUDGET", "DEGRADED_MAX_HOSTS", "INSTANCE_TYPES", "LAUNCH_TEMPLATE", "MAX_HOSTS",
    "MODE", "REGIONS", "REPOSITORY", "RUNNER_LABEL", "SETTLE_SECONDS", "SLOTS_PER_HOST", "SPOT_STRATEGY", "TOKEN_PARAMETER", "WEBHOOK_SECRET",
  ]);
});

test("with WEBHOOK_SECRET_PARAMETER the scaler's environment names the parameter and never holds the value", () => {
  const env = lambdaEnv("/ci-runner/webhook-secret-l");
  assert.equal(env.WEBHOOK_SECRET_PARAMETER, "/ci-runner/webhook-secret-l");
  assert.equal(env.WEBHOOK_SECRET, undefined);
  assert.ok(!JSON.stringify(env).includes("file-secret"));
});

function rolePolicy(secretParam) {
  const r = bash(`template_arns=arn:lt host_role=arn:role label=l region=us-east-1 account=1 param=/p alert_param=/a \\
fn=f queue_table=q secret_param='${secretParam}'
${block("policy=$(jq -n", "\naws iam put-role-policy")}
printf '%s' "$policy"`);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).Statement.find((st) => st.Action === "ssm:GetParameter").Resource;
}

test("the role may read the webhook secret's parameter only when there is one", () => {
  assert.deepEqual(rolePolicy(""), ["arn:aws:ssm:us-east-1:1:parameter/p", "arn:aws:ssm:us-east-1:1:parameter/a"]);
  assert.deepEqual(rolePolicy("/ci-runner/webhook-secret-l"), [
    "arn:aws:ssm:us-east-1:1:parameter/p", "arn:aws:ssm:us-east-1:1:parameter/a",
    "arn:aws:ssm:us-east-1:1:parameter/ci-runner/webhook-secret-l",
  ]);
});

// ── the secret read itself ──────────────────────────────────────────────────
function secretBlock(secretParam, answer) {
  const dir = mkdtempSync(path.join(tmpdir(), "deploy-secret-"));
  const r = bash(`secret_param='${secretParam}' secret_file='${dir}/local' HOME='${dir}'
aws() { echo "$*" >> '${dir}/calls'; ${answer}; }
openssl() { echo generated; }
${block("work=$(mktemp -d)\ntrap 'rm -rf \"$work\"' EXIT", "\n(umask 077; jq -n")}
printf 'file=%s\\n' "$secret_file"; stat -c %a "$secret_file"; wc -c < "$secret_file"
cat '${dir}/calls' 2>/dev/null || true`);
  return { ...r, dir };
}

test("a secret in SSM is read into a private file; the local secret file is never made", () => {
  const r = secretBlock("/ci-runner/webhook-secret-l", "echo from-ssm");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /file=.*\/webhook-secret\n600\n9\n/, "the value and its newline, which jq and $(cat) trim");
  assert.match(r.stdout, /ssm get-parameter --name \/ci-runner\/webhook-secret-l --with-decryption --query Parameter\.Value/);
  assert.ok(!r.stdout.includes("from-ssm"), "the value is never printed");
  assert.equal(spawnSync("test", ["-e", path.join(r.dir, "local")]).status, 1);
});

test("a secret parameter that cannot be read, or is empty, stops the deploy", () => {
  const missing = secretBlock("/x", "return 254");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read the webhook secret \/x/);
  const empty = secretBlock("/x", "return 0");
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /\/x is empty/);
});

test("without a parameter the local secret file is used (and made once), as before", () => {
  const r = secretBlock("", "echo never");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /file=.*\/local\n/);
  assert.doesNotMatch(r.stdout, /get-parameter/);
});

// ── early refusals, before any AWS call ─────────────────────────────────────
const fleet = { ALLOW_STALE: "1", AWS_REGION: "us-east-1", REPOSITORY: "o/r", RUNNER_LABEL: "future-pay-ci-light", FUNCTION_NAME: "f" };
const run = (env) => spawnSync("bash", [deployPath], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, ...fleet, ...env }, timeout: 30_000 });

for (const [env, message] of [
  [{ HOST_LABELS: "future-pay-ci" }, /HOST_LABELS 'future-pay-ci' must include RUNNER_LABEL 'future-pay-ci-light'/],
  [{ HOST_LABELS: "a b" }, /HOST_LABELS must be comma-separated runner labels/],
  [{ HOST_LABELS: "x/' /etc/passwd #" }, /HOST_LABELS must be comma-separated runner labels/],
  [{ WEBHOOK_SECRET_PARAMETER: "no-slash" }, /WEBHOOK_SECRET_PARAMETER must be an SSM parameter name/],
]) {
  test(`${JSON.stringify(env)} stops the deploy before any AWS call`, () => {
    const r = run(env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, message);
  });
}

// ── old images: another fleet's template holds its image ───────────────────
test("prune holds the image every other fleet template launches, and adds nothing without one", () => {
  const fn = block("other_fleet_images() {", "\nprune_region() {");
  const answer = (templates) => bash(`template=ci-runner-fleet-future-pay-ci
in_region() {
  shift
  case "$*" in
    *describe-launch-templates*) echo "${templates}" ;;
    *"--launch-template-name ci-runner-fleet-future-pay-ci-light"*) echo ami-light ;;
    *) echo "unexpected: $*" >&2; return 1 ;;
  esac
}
${fn}
other_fleet_images us-east-1`);
  const alone = answer("ci-runner-fleet-future-pay-ci");
  assert.equal(alone.status, 0, alone.stderr);
  assert.equal(alone.stdout.trim(), "");
  const two = answer("ci-runner-fleet-future-pay-ci\tci-runner-fleet-future-pay-ci-light");
  assert.equal(two.status, 0, two.stderr);
  assert.equal(two.stdout.trim(), "ami-light");
  assert.match(deploy, /others=\$\(other_fleet_images "\$r"\) \|\| return 1\n {2}live="\$\{live\} \$\{others\}"/);
});
