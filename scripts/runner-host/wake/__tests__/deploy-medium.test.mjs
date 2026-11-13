import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { liveSettings } from "../live-settings.mjs";

// FUT-4944: a medium pool is a third deploy of the scaler from the main fleet's
// image, with 2-vCPU slots; its slots per host are a parameter (one on a 2-vCPU
// host, in these cases). The image is built with two slot units, so HOST_SLOTS rewrites the image's CI_RUNNER_SLOTS at boot (the
// memory cap and the pinned cores follow it) and supervisor.sh leaves the unit
// above it down. Unset, the user data is byte for byte what it was
// (deploy-light.test.mjs pins those lines). The blocks of deploy.sh run here
// for real, like deploy-light.test.mjs.

const here = path.dirname(fileURLToPath(import.meta.url));
const deploy = readFileSync(path.join(here, "..", "deploy.sh"), "utf8");

function block(from, to) {
  const start = deploy.indexOf(from);
  const end = deploy.indexOf(to, start);
  assert.ok(start !== -1 && end !== -1, `deploy.sh still has the block from ${JSON.stringify(from)}`);
  return deploy.slice(start, end);
}
const bash = (script) => spawnSync("bash", ["-c", `set -euo pipefail\n${script}`], { encoding: "utf8" });

function userData({ store = "off", labels = "", slots = "" } = {}) {
  const r = bash(`idle_minutes=2 pnpm_store=${store} host_labels='${labels}' host_slots='${slots}'
${block('store_cmd=""', "\n# gp3's baseline")}
printf '%s' "$user_data" | base64 -d`);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const SLOTS_LINE = /^ {2}- \[sh, -c, "sed -i 's\/\^CI_RUNNER_SLOTS=\.\*\/CI_RUNNER_SLOTS=1\/' \/etc\/ci-runner\/env"\]$/m;

test("without HOST_SLOTS no slots line is written, with or without HOST_LABELS", () => {
  for (const labels of ["", "future-pay-ci-light"]) {
    for (const store of ["off", "on"]) {
      assert.equal(userData({ store, labels }), userData({ store, labels, slots: "" }));
      assert.doesNotMatch(userData({ store, labels }), /CI_RUNNER_SLOTS/);
    }
  }
});

test("HOST_SLOTS rewrites the image's slot count at boot, after the labels, with the store off or on", () => {
  const off = userData({ labels: "future-pay-ci-medium", slots: "1" });
  assert.match(off, SLOTS_LINE);
  const lines = off.trimEnd().split("\n");
  assert.match(lines.at(-2), /CI_RUNNER_LABELS=future-pay-ci-medium\//);
  assert.match(lines.at(-1), /CI_RUNNER_SLOTS=1\//);
  const on = userData({ store: "on", labels: "future-pay-ci-medium", slots: "1" });
  assert.doesNotMatch(on, /CI_RUNNER_PNPM_STORE/);
  assert.match(on, SLOTS_LINE);
  // Valid cloud-config list items: every bootcmd entry is one `  - [...]` line.
  for (const line of on.trimEnd().split("\n").slice(2)) assert.match(line, /^ {2}- \[sh, -c, ".*"\]$/);
});

function validate(env) {
  return bash(`SLOTS_PER_HOST='${env.SLOTS_PER_HOST ?? ""}' HOST_SLOTS='${env.HOST_SLOTS ?? ""}'
${block('slots="${SLOTS_PER_HOST:-2}"', "\nmax_hosts=")}
${block('host_slots="${HOST_SLOTS:-}"', 'host_labels="${HOST_LABELS:-}"')}
echo "slots=$slots host_slots=$host_slots"`);
}

test("HOST_SLOTS must be a slot count equal to SLOTS_PER_HOST, the scaler's count", () => {
  assert.equal(validate({}).stdout.trim(), "slots=2 host_slots=");
  assert.equal(validate({ SLOTS_PER_HOST: "1", HOST_SLOTS: "1" }).stdout.trim(), "slots=1 host_slots=1");
  for (const [env, message] of [
    [{ HOST_SLOTS: "1" }, /HOST_SLOTS '1' must equal SLOTS_PER_HOST '2'/],
    [{ SLOTS_PER_HOST: "1", HOST_SLOTS: "0" }, /HOST_SLOTS must be a slot count from 1 to 99, got '0'/],
    [{ SLOTS_PER_HOST: "1", HOST_SLOTS: "1;reboot" }, /HOST_SLOTS must be a slot count/],
  ]) {
    const r = validate(env);
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.match(r.stderr, message);
  }
});

test("live-settings reads HOST_SLOTS back, so a refresh keeps a medium host at one slot", () => {
  const lambda = { RUNNER_LABEL: "future-pay-ci-medium", REPOSITORY: "o/r", REGIONS: "us-east-1", DAILY_BUDGET: "4", SLOTS_PER_HOST: "1", WEBHOOK_SECRET_PARAMETER: "/p" };
  const template = (ud) => ({ UserData: Buffer.from(ud).toString("base64") });
  const medium = liveSettings(lambda, template(userData({ labels: "future-pay-ci-medium", slots: "1" })));
  assert.equal(medium.env.HOST_SLOTS, "1");
  assert.equal(medium.env.SLOTS_PER_HOST, "1");
  assert.equal(medium.env.HOST_LABELS, "future-pay-ci-medium");
  const light = liveSettings(lambda, template(userData({ labels: "future-pay-ci-light" })));
  assert.equal(light.env.HOST_SLOTS, undefined);
});
