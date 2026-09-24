import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// When the host powers itself off, and that it never does so on a job.
//
// idle-stop.sh runs every minute. A wrong answer either keeps an idle machine
// billing all night, or stops one while a job is starting on it — the second
// is the one that costs a deploy. `systemctl`, the power-off and the
// supervisor's release are stubs that record what they were asked.

const SCRIPT = fileURLToPath(new URL("../idle-stop.sh", import.meta.url));

function host({ phases, idleFor = null, busySlot = null }) {
  const dir = mkdtempSync(path.join(tmpdir(), "idle-stop-"));
  const log = path.join(dir, "calls.log");
  phases.forEach((phase, i) =>
    writeFileSync(path.join(dir, `slot-${i + 1}.json`), JSON.stringify({ slot: String(i + 1), phase })),
  );
  if (idleFor !== null) {
    const f = path.join(dir, "last-busy");
    writeFileSync(f, "");
    const t = new Date(Date.now() - idleFor * 1000);
    utimesSync(f, t, t);
  }
  const stub = (name, body) => {
    const p = path.join(dir, name);
    writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const env = {
    PATH: process.env.PATH,
    CI_RUNNER_STATE_DIR: dir,
    CI_RUNNER_SYSTEMCTL: stub("systemctl", ""),
    CI_RUNNER_POWEROFF: stub("poweroff", ""),
    // The release answers 3 (a job was just handed over) for busySlot only.
    CI_RUNNER_SUPERVISOR: stub("supervisor", `[[ "$1" == "${busySlot}" ]] && exit 3; exit 0`),
  };
  const run = (extra = {}) => {
    const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...env, ...extra } });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
    return { ...r, calls, dir };
  };
  return { run, dir };
}


test("a slot running a job keeps the host up and restarts the idle clock", () => {
  const { run, dir } = host({ phases: ["running", "idle"], idleFor: 3600 });
  const { status, calls } = run();
  assert.equal(status, 0);
  assert.deepEqual(calls, []);
  const age = Date.now() - Number(spawnSync("stat", ["-c", "%Y", path.join(dir, "last-busy")], { encoding: "utf8" }).stdout) * 1000;
  assert.ok(age < 5000, "the clock was not restarted by a running job");
});

test("idle for less than the threshold does nothing", () => {
  const { run } = host({ phases: ["idle", "idle"], idleFor: 19 * 60 });
  assert.deepEqual(run().calls, []);
});

test("the first run after a boot starts the clock instead of stopping", () => {
  const { run, dir } = host({ phases: ["idle", "idle"] });
  assert.deepEqual(run().calls, []);
  assert.ok(existsSync(path.join(dir, "last-busy")));
});

test("idle past the threshold releases every runner, stops every slot, then powers off", () => {
  const { run } = host({ phases: ["idle", "idle"], idleFor: 21 * 60 });
  const { status, calls } = run();
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    "supervisor 1",
    "systemctl stop ci-runner@1.service",
    "supervisor 2",
    "systemctl stop ci-runner@2.service",
    "poweroff",
  ]);
});

test("a runner handed a job during the stop aborts it and brings the stopped slots back", () => {
  const { run } = host({ phases: ["idle", "idle"], idleFor: 21 * 60, busySlot: "2" });
  const { calls } = run();
  assert.deepEqual(calls, [
    "supervisor 1",
    "systemctl stop ci-runner@1.service",
    "supervisor 2",
    "systemctl start ci-runner@1.service",
  ]);
  assert.ok(!calls.some((c) => c.startsWith("poweroff")), "powered off with a job starting");
});

test("CI_RUNNER_IDLE_MINUTES=0 never powers off", () => {
  const { run } = host({ phases: ["idle"], idleFor: 99 * 3600 });
  assert.deepEqual(run({ CI_RUNNER_IDLE_MINUTES: "0" }).calls, []);
});

test("the threshold is configurable", () => {
  const { run } = host({ phases: ["idle"], idleFor: 6 * 60 });
  assert.ok(run({ CI_RUNNER_IDLE_MINUTES: "5" }).calls.some((c) => c.startsWith("poweroff")));
});
