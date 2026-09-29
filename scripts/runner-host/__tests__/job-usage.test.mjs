import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// What one job used, read from a fake cgroup.
//
// The line this prints is what decides a job's slot size, so the arithmetic is
// checked against numbers worked out by hand. And because the runner fails the
// JOB when a hook fails, a hook with nothing to read must still exit 0.

const SCRIPT = fileURLToPath(new URL("../job-usage.sh", import.meta.url));
const MiB = 1024 * 1024;

function cgroup(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "job-usage-"));
  const cg = path.join(root, "cg");
  const dir = path.join(root, "usage");
  spawnSync("mkdir", ["-p", cg, dir]);
  const files = {
    "memory.current": String(3000 * MiB),
    "memory.peak": String(9000 * MiB),
    "memory.max": String(14000 * MiB),
    "memory.stat": `anon ${2000 * MiB}\nfile ${6000 * MiB}\ninactive_file ${1000 * MiB}\nshmem 0\n`,
    "memory.events": "low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n",
    "cpu.stat": "usage_usec 1000000\nuser_usec 800000\nsystem_usec 200000\n",
    "cpuset.cpus.effective": "0-3",
    "cpu.pressure": "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    "memory.pressure": "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    "io.pressure": "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    "io.stat": "259:0 rbytes=0 wbytes=0 rios=0 wios=0 dbytes=0 dios=0\n",
    ...overrides,
  };
  for (const [name, body] of Object.entries(files)) if (body !== null) writeFileSync(path.join(cg, name), body);
  const uptime = path.join(root, "uptime");
  writeFileSync(uptime, "120.55 400.00\n");
  const netdev = path.join(root, "netdev");
  const env = {
    PATH: process.env.PATH,
    CI_USAGE_CGROUP: cg,
    CI_USAGE_DIR: dir,
    CI_USAGE_UPTIME: uptime,
    CI_USAGE_NETDEV: netdev,
    RUNNER_NAME: "us-east-2a-ip-10-0-1-5-2",
  };
  // Atomic, as the kernel serves a cgroup file: the sampler reads while the
  // test writes, and a half-written file is not something a real cgroup shows.
  const set = (name, body) => {
    writeFileSync(path.join(cg, `.${name}.tmp`), body);
    renameSync(path.join(cg, `.${name}.tmp`), path.join(cg, name));
  };
  const net = (eth0, docker0) =>
    writeFileSync(
      netdev,
      "Inter-|   Receive                                                |  Transmit\n" +
        " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n" +
        `    lo: ${50 * MiB} 10 0 0 0 0 0 0 ${50 * MiB} 10 0 0 0 0 0 0\n` +
        `  eth0: ${eth0[0]} 100 0 0 0 0 0 0 ${eth0[1]} 100 0 0 0 0 0 0\n` +
        `docker0: ${docker0} 5 0 0 0 0 0 0 ${docker0} 5 0 0 0 0 0 0\n` +
        `veth12ab: ${docker0} 5 0 0 0 0 0 0 ${docker0} 5 0 0 0 0 0 0\n`,
    );
  net([10 * MiB, 1 * MiB], 0);
  const run = (mode) => spawnSync("bash", [SCRIPT, mode], { env, encoding: "utf8" });
  return { cg, dir, env, set, net, run };
}

const psi = (some, full = 0) =>
  `some avg10=0.00 avg60=0.00 avg300=0.00 total=${some}\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=${full}\n`;

function usageLine(stdout) {
  const line = stdout.split("\n").find((l) => l.startsWith("ci-runner-usage {"));
  assert.ok(line, `a ci-runner-usage line in:\n${stdout}`);
  return JSON.parse(line.slice("ci-runner-usage ".length));
}

test("report: CPU, waits and disk are the deltas since the job started", () => {
  const c = cgroup();
  assert.equal(c.run("start").status, 0);
  // Pretend the job ran: move every counter forward by a known amount.
  const [t0] = readFileSync(path.join(c.dir, "start"), "utf8").split(" ").map(Number);
  writeFileSync(path.join(c.dir, "start"), `${t0 - 10_000} 1000000 0 0 0 0 0 0 ${10 * MiB} ${1 * MiB}\n`);
  // 700 MiB down, 250 MiB up on eth0; the inner bridge's own 900 MiB is not counted again.
  c.net([710 * MiB, 251 * MiB], 900 * MiB);
  c.set("cpu.stat", "usage_usec 21000000\n"); // 20 CPU-seconds in ~10 s
  c.set("cpu.pressure", psi(5_000_000)); // 5 s of CPU wait in 10 s
  c.set("memory.pressure", psi(1_000_000, 500_000));
  c.set("io.pressure", psi(2_500_000));
  c.set("io.stat", `259:0 rbytes=${300 * MiB} wbytes=${100 * MiB} rios=7000 wios=3000 dbytes=0 dios=0\n`);
  writeFileSync(path.join(c.dir, "peaks"), `${5000 * MiB} ${4000 * MiB} 3500 2400 180\n`);

  const r = c.run("report");
  assert.equal(r.status, 0, r.stderr);
  const u = usageLine(r.stdout);
  assert.equal(u.runner, "us-east-2a-ip-10-0-1-5-2");
  assert.ok(u.wallMs >= 10_000 && u.wallMs < 12_000, `wallMs ${u.wallMs}`);
  assert.equal(u.cpuSec, 20);
  assert.ok(u.avgCores > 1.6 && u.avgCores <= 2.0, `avgCores ${u.avgCores}`);
  assert.ok(u.cpuWaitPct > 40 && u.cpuWaitPct <= 50, `cpuWaitPct ${u.cpuWaitPct}`);
  assert.ok(u.memStallPct > 4 && u.memStallPct <= 5, `memStallPct ${u.memStallPct}`);
  assert.ok(u.ioWaitPct > 20 && u.ioWaitPct <= 25, `ioWaitPct ${u.ioWaitPct}`);
  assert.equal(u.cpus, 4);
  assert.equal(u.limitMiB, 14000);
  assert.equal(u.peakWorkingSetMiB, 5000);
  assert.equal(u.peakAnonMiB, 4000);
  assert.equal(u.peakMiB, 9000);
  assert.equal(u.peakCores, 3.5);
  assert.equal(u.peakIops, 2400);
  assert.equal(u.peakDiskMiBps, 180);
  assert.equal(u.diskIos, 10_000);
  assert.equal(u.diskMiB, 400);
  assert.equal(u.oomKills, 1);
  assert.equal(u.netRxMiB, 700);
  assert.equal(u.netTxMiB, 250);
  // The script takes boot as the job's END second minus the uptime it read (120.55 → 120).
  // floor(start) + round(wall) is off by one whenever the two fractions straddle a second.
  assert.equal(u.hostBootS, Math.floor((u.startMs + u.wallMs) / 1000) - 120);
});

test("report: an unlimited cgroup and a missing cpuset read as null, not as a number", () => {
  const c = cgroup({ "memory.max": "max\n", "cpuset.cpus.effective": null });
  c.run("start");
  const u = usageLine(c.run("report").stdout);
  assert.equal(u.limitMiB, null);
  assert.equal(u.cpus, null);
});

test("report: cpuset lists of ranges and single cores are counted", () => {
  const c = cgroup({ "cpuset.cpus.effective": "0-1,4,6-7\n" });
  c.run("start");
  assert.equal(usageLine(c.run("report").stdout).cpus, 5);
});

test("every mode exits 0 with no cgroup to read: a hook must never fail the job", () => {
  const env = {
    PATH: process.env.PATH,
    CI_USAGE_CGROUP: "/nonexistent/cg",
    CI_USAGE_DIR: mkdtempSync(path.join(tmpdir(), "job-usage-empty-")),
    CI_USAGE_UPTIME: "/nonexistent/uptime",
  };
  for (const mode of ["start", "report"]) {
    const r = spawnSync("bash", [SCRIPT, mode], { env, encoding: "utf8" });
    assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
  }
});

test("report without a start prints no usage line, and still exits 0", () => {
  const c = cgroup();
  const r = c.run("report");
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /ci-runner-usage \{/);
});

test("the hook names pick the mode, since the runner passes no argument", () => {
  const c = cgroup();
  const link = (name) => {
    const p = path.join(path.dirname(c.dir), name);
    spawnSync("ln", ["-s", SCRIPT, p]);
    return p;
  };
  const started = link("ci-runner-job-started.sh");
  const completed = link("ci-runner-job-completed.sh");
  assert.equal(spawnSync(started, [], { env: c.env }).status, 0);
  assert.ok(existsSync(path.join(c.dir, "start")), "the started hook wrote the t0 counters");
  const r = spawnSync(completed, [], { env: c.env, encoding: "utf8" });
  assert.equal(usageLine(r.stdout).runner, "us-east-2a-ip-10-0-1-5-2");
});

test("sample: a counter that reads 0 once (a failed read) is skipped, not billed to the next window", async () => {
  const c = cgroup({ "cpu.stat": "usage_usec 50000000000\n" }); // 50 000 CPU-seconds already used
  const proc = spawn("bash", [SCRIPT, "sample"], {
    env: { ...c.env, CI_USAGE_INTERVAL: "0.05", CI_USAGE_WINDOW_MS: "100" },
  });
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  try {
    await sleep(400);
    c.set("cpu.stat", "usage_usec 0\n");
    await sleep(400);
    c.set("cpu.stat", "usage_usec 50000100000\n"); // +0.1 CPU-second since the first read
    await sleep(600);
    const [, , mcores] = readFileSync(path.join(c.dir, "peaks"), "utf8").trim().split(" ").map(Number);
    assert.ok(mcores <= 1000, `peak milli-cores ${mcores}: a 0 read became the baseline`);
  } finally {
    proc.kill();
  }
});

test("sample: tracks the peak working set without page cache, and restarts at job start", async () => {
  const c = cgroup();
  const proc = spawn("bash", [SCRIPT, "sample"], {
    env: { ...c.env, CI_USAGE_INTERVAL: "0.05", CI_USAGE_WINDOW_MS: "100" },
  });
  const peaks = () => {
    try {
      return readFileSync(path.join(c.dir, "peaks"), "utf8").trim().split(" ").map(Number);
    } catch {
      return null;
    }
  };
  const until = async (ok) => {
    for (let i = 0; i < 100; i++) {
      const p = peaks();
      if (p && ok(p)) return p;
      await new Promise((res) => setTimeout(res, 50));
    }
    return peaks();
  };
  try {
    // Before the job: runner boot, 3000 MiB current minus 1000 MiB inactive cache.
    let p = await until((x) => x[0] === 2000 * MiB);
    assert.equal(p[0], 2000 * MiB, "working set = current - inactive_file");
    assert.equal(p[1], 2000 * MiB, "anon");

    // The job starts; memory is lower than the boot peak, and the peak restarts.
    c.set("memory.current", String(1500 * MiB));
    c.set("memory.stat", `anon ${1200 * MiB}\ninactive_file ${500 * MiB}\n`);
    c.run("start");
    p = await until((x) => x[0] === 1000 * MiB);
    assert.equal(p[0], 1000 * MiB, "the boot's peak is not billed to the job");

    // CPU and disk rates: 1 CPU-second and 500 ios in each ~100 ms window.
    let usec = 1_000_000;
    let ios = 0;
    for (let i = 0; i < 6; i++) {
      usec += 100_000 * 2;
      ios += 500;
      c.set("cpu.stat", `usage_usec ${usec}\n`);
      c.set("io.stat", `259:0 rbytes=0 wbytes=0 rios=${ios} wios=0\n`);
      await new Promise((res) => setTimeout(res, 100));
    }
    p = await until((x) => x[2] > 0 && x[3] > 0);
    assert.ok(p[2] > 500 && p[2] <= 4000, `peak milli-cores ${p[2]}`);
    assert.ok(p[3] > 1000 && p[3] <= 10_000, `peak iops ${p[3]}`);
  } finally {
    proc.kill();
  }
});
