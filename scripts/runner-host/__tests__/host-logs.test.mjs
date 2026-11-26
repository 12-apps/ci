import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// What a host ships to CloudWatch Logs while it runs, so the reason it died is
// still readable once it is gone (FUT-5281).
//
// host-logs.py is run for real, against a fake instance metadata service and a
// fake CloudWatch Logs endpoint on one local port, with `journalctl` replaced
// by a stub that serves a fixture journal after the cursor it is given. Each
// property is asserted on what reached the fake endpoint: which lines (and
// which never), where (group, stream, region), signed with what, and that the
// final flush on SIGTERM carries the last lines, which are the ones a lost
// runner is about.
//
// Dependency-free (node: builtins + python3) so it runs in self-test.yml.

const SCRIPT = fileURLToPath(new URL("../host-logs.py", import.meta.url));
const INSTANCE = "i-0123456789abcdef0";
const SESSION_TOKEN = "fake-imds-session-credential";
// Token-shaped fixtures are assembled at run time, so no file in the repo
// carries a string a secret scanner would flag.
const shaped = (...parts) => parts.join("");
const KEY_ID = shaped("AS", "IA", "EXAMPLEINSTANCE1");

// The fixture journal starts an hour before the run, in whole seconds. It was a
// fixed date, and once that date was more than 23 h behind the clock the
// shipper's own lines (stamped with the real time) went into a batch of their
// own, as `put` splits any batch spanning over 23 h (CloudWatch refuses 24 h):
// the SIGTERM case began failing a day after it landed (FUT-5677).
const t0 = Math.floor((Date.now() - 3600_000) / 1000) * 1000;
let seq = 0;
/** One journal entry as `journalctl -o json` prints it. */
function entry(fields, offsetS = 0) {
  seq += 1;
  return { __CURSOR: `s=boot;i=${seq}`, __REALTIME_TIMESTAMP: String((t0 + offsetS * 1000) * 1000), ...fields };
}
const kernel = (msg, s, priority = "6") => entry({ _TRANSPORT: "kernel", PRIORITY: priority, SYSLOG_IDENTIFIER: "kernel", MESSAGE: msg }, s);
const unitLine = (unit, msg, s) => entry({ _TRANSPORT: "stdout", _SYSTEMD_UNIT: unit, SYSLOG_IDENTIFIER: unit.replace(/@.*|\.service$/g, ""), MESSAGE: msg }, s);
const pid1 = (unit, msg, s) => entry({ _TRANSPORT: "journal", _SYSTEMD_UNIT: "init.scope", SYSLOG_IDENTIFIER: "systemd", UNIT: unit, MESSAGE: msg }, s);
const ident = (id, msg, s) => entry({ _TRANSPORT: "journal", SYSLOG_IDENTIFIER: id, MESSAGE: msg }, s);
const runner = (slot, msg, s) => entry({ _TRANSPORT: "journal", _SYSTEMD_UNIT: "docker.service", CONTAINER_TAG: `ci-runner-${slot}`, SYSLOG_IDENTIFIER: `ci-runner-${slot}`, CONTAINER_NAME: `ci-runner-${slot}`, MESSAGE: msg }, s);

/** A fake IMDS (v2: every GET needs the session token) and CloudWatch Logs. */
async function fakeAws({ spot = null, failPuts = 0, streamExists = false } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (code, text) => { res.writeHead(code); res.end(text); };
      if (req.url.startsWith("/latest/")) {
        if (req.method === "PUT" && req.url === "/latest/api/token") return send(200, "imds-session");
        if (req.headers["x-aws-ec2-metadata-token"] !== "imds-session") return send(401, "");
        const md = {
          "/latest/meta-data/instance-id": INSTANCE,
          "/latest/meta-data/placement/region": "eu-north-1",
          "/latest/meta-data/iam/security-credentials/": "ci-runner-host",
          "/latest/meta-data/iam/security-credentials/ci-runner-host": JSON.stringify({ AccessKeyId: KEY_ID, SecretAccessKey: "fake-secret-from-imds", Token: SESSION_TOKEN, Expiration: "2099-01-01T00:00:00Z" }),
          ...(spot ? { "/latest/meta-data/spot/instance-action": spot } : {}),
        };
        return md[req.url] === undefined ? send(404, "") : send(200, md[req.url]);
      }
      const target = String(req.headers["x-amz-target"] ?? "").replace("Logs_20140328.", "");
      calls.push({ target, body: JSON.parse(body || "{}"), headers: req.headers });
      if (target === "PutLogEvents" && calls.filter((c) => c.target === "PutLogEvents").length <= failPuts) return send(503, JSON.stringify({ __type: "ServiceUnavailableException", message: "try again" }));
      if (target === "CreateLogStream" && streamExists) return send(400, JSON.stringify({ __type: "com.amazonaws.logs#ResourceAlreadyExistsException", message: "exists" }));
      return send(200, "{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, close: () => new Promise((r) => server.close(r)) };
}

/** A host: a fixture journal, the stubs, and the shipper's state directory. */
function host(entries) {
  const dir = mkdtempSync(path.join(tmpdir(), "host-logs-"));
  const journal = path.join(dir, "journal.jsonl");
  writeFileSync(journal, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
  const jctl = path.join(dir, "journalctl");
  writeFileSync(jctl, `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(path.join(dir, "journalctl.argv"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
const after = (process.argv.find((a) => a.startsWith("--after-cursor=")) || "").slice(15);
const lines = fs.readFileSync(${JSON.stringify(journal)}, "utf8").split("\\n").filter(Boolean);
// As journalctl does: a cursor it no longer has is an error, not the start.
let i = after ? lines.findIndex((l) => JSON.parse(l).__CURSOR === after) + 1 : 0;
if (after && i === 0) { process.stderr.write("Failed to seek to cursor: Invalid argument\\n"); process.exit(1); }
const since = (process.argv.find((a) => a.startsWith("--since=@")) || "").slice(9);
for (; i < lines.length; i++) {
  if (since && Number(JSON.parse(lines[i]).__REALTIME_TIMESTAMP) < Number(since) * 1e6) continue;
  process.stdout.write(lines[i] + "\\n");
}
`);
  const sysctl = path.join(dir, "systemctl");
  writeFileSync(sysctl, `#!/usr/bin/env bash\n[[ "$*" == *list-jobs* ]] && echo "812 poweroff.target start waiting"\nexit 0\n`);
  for (const f of [jctl, sysctl]) chmodSync(f, 0o755);
  return {
    dir,
    state: path.join(dir, "state"),
    jctl,
    sysctl,
    append: (more) => appendFileSync(journal, more.map((e) => JSON.stringify(e)).join("\n") + "\n"),
    jctlArgs: () => readFileSync(path.join(dir, "journalctl.argv"), "utf8").trim().split("\n").map((l) => JSON.parse(l)),
  };
}

const puts = (calls) => calls.filter((c) => c.target === "PutLogEvents");
const shipped = (calls) => puts(calls).flatMap((c) => c.body.logEvents.map((e) => e.message));

/** Run the shipper until `until(calls)` holds, then SIGTERM it; resolves with its exit. */
async function ship(h, aws, { env = {}, until = (c) => puts(c).length >= 1, beforeStop = () => {}, interval = "0.2" } = {}) {
  const child = spawn("python3", ["-B", SCRIPT], {
    env: {
      PATH: process.env.PATH,
      CI_RUNNER_LOGS_IMDS: aws.base,
      CI_RUNNER_LOGS_ENDPOINT: `${aws.base}/`,
      CI_RUNNER_LOGS_JOURNALCTL: h.jctl,
      CI_RUNNER_LOGS_SYSTEMCTL: h.sysctl,
      CI_RUNNER_LOGS_STATE_DIR: h.state,
      CI_RUNNER_LOGS_INTERVAL: interval,
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let done = false;
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((r) => child.on("exit", (code) => { done = true; r(code); }));
  const deadline = Date.now() + 15_000;
  while (!done && !until(aws.calls) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await beforeStop();
  child.kill("SIGTERM");
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 15_000))]);
  if (code === "timeout") child.kill("SIGKILL");
  return { code, stderr };
}

// A realistic minute on a host: one job ending and one starting, the idle
// timer's start/finish, a container's veth chatter, dockerd's own info lines.
function busyMinute(s) {
  return [
    unitLine("ci-runner@1.service", "ci-runner[1]: registered eu-north-1c-ip-172-31-15-157-1-1795611394; waiting for a job", s),
    runner(1, "√ Connected to GitHub", s + 1),
    runner(1, "2026-11-25 10:00:03Z: Listening for Jobs", s + 3),
    runner(1, "2026-11-25 10:00:05Z: Running job: Tests / Unit (shard 2/4)", s + 5),
    unitLine("ci-runner@1.service", "ci-runner[1]: running job 'Tests / Unit (shard 2/4)' as eu-north-1c-ip-172-31-15-157-1-1795611394", s + 6),
    kernel("br-3f2a9c1d: port 1(veth1a2b3c4) entered blocking state", s + 7),
    kernel("br-3f2a9c1d: port 1(veth1a2b3c4) entered forwarding state", s + 7),
    entry({ _TRANSPORT: "stdout", _SYSTEMD_UNIT: "docker.service", SYSLOG_IDENTIFIER: "dockerd", MESSAGE: 'time="2026-11-25T10:00:08Z" level=info msg="ignoring event" container=4f1e module=libcontainerd' }, s + 8),
    pid1("ci-runner-idle.service", "Starting ci-runner-idle.service - Power the CI host off when no job has run for CI_RUNNER_IDLE_MINUTES...", s + 10),
    pid1("ci-runner-idle.service", "ci-runner-idle.service: Deactivated successfully.", s + 10),
    pid1("ci-runner-idle.service", "Finished ci-runner-idle.service - Power the CI host off when no job has run for CI_RUNNER_IDLE_MINUTES.", s + 10),
    ident("sshd", "Connection closed by 10.0.0.1 port 22", s + 11),
    pid1("ssh.service", "Started ssh.service - OpenBSD Secure Shell server.", s + 12),
  ];
}

test("ships only the lines that explain a host's end, to its instance's stream, in its region, signed with its instance profile", async () => {
  const h = host([
    ...busyMinute(0),
    kernel("node invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=0", 30, "4"),
    kernel("Memory cgroup out of memory: Killed process 48213 (node) total-vm:9813440kB, anon-rss:7340032kB", 30, "3"),
    kernel("INFO: task jbd2/nvme0n1p1-8:412 blocked for more than 122 seconds.", 31, "3"),
    kernel("EXT4-fs warning (device loop0): ext4_dx_add_entry:2524: Directory index full!", 32, "4"),
    runner(1, "2026-11-25 10:00:40Z: Job Tests / Unit (shard 2/4) completed with result: Failed", 40),
    unitLine("ci-runner@1.service", "ci-runner[1]: job 'Tests / Unit (shard 2/4)' ended with result: Failed", 41),
    pid1("docker.service", "Stopping docker.service - Docker Application Container Engine...", 42),
    pid1("ci-runner@2.service", "ci-runner@2.service: Main process exited, code=killed, status=9/KILL", 43),
  ]);
  const aws = await fakeAws();
  try {
    const { code } = await ship(h, aws, { until: (c) => shipped(c).some((m) => m.includes("code=killed")) });
    assert.equal(code, 0);
    const create = aws.calls.find((c) => c.target === "CreateLogStream");
    assert.deepEqual(create.body, { logGroupName: "/ci-runner/hosts", logStreamName: INSTANCE }, "one stream per instance, named by its id");
    for (const p of puts(aws.calls)) assert.deepEqual([p.body.logGroupName, p.body.logStreamName], ["/ci-runner/hosts", INSTANCE]);
    const auth = String(create.headers.authorization);
    assert.ok(auth.startsWith(`AWS4-HMAC-SHA256 Credential=${KEY_ID}/`), "signed with the instance profile's key");
    assert.match(auth, /\/\d{8}\/eu-north-1\/logs\/aws4_request, SignedHeaders=[a-z0-9;-]*x-amz-security-token[a-z0-9;-]*, Signature=[0-9a-f]{64}$/);
    assert.equal(create.headers["x-amz-security-token"], SESSION_TOKEN, "the instance profile's session token, from IMDSv2");

    const got = shipped(aws.calls).filter((m) => !m.startsWith("host-logs:"));
    assert.deepEqual(got, [
      "ci-runner@1: ci-runner[1]: registered eu-north-1c-ip-172-31-15-157-1-1795611394; waiting for a job",
      "ci-runner-1: √ Connected to GitHub",
      "ci-runner-1: 2026-11-25 10:00:03Z: Listening for Jobs",
      "ci-runner-1: 2026-11-25 10:00:05Z: Running job: Tests / Unit (shard 2/4)",
      "ci-runner@1: ci-runner[1]: running job 'Tests / Unit (shard 2/4)' as eu-north-1c-ip-172-31-15-157-1-1795611394",
      "kernel: node invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=0",
      "kernel: Memory cgroup out of memory: Killed process 48213 (node) total-vm:9813440kB, anon-rss:7340032kB",
      "kernel: INFO: task jbd2/nvme0n1p1-8:412 blocked for more than 122 seconds.",
      "kernel: EXT4-fs warning (device loop0): ext4_dx_add_entry:2524: Directory index full!",
      "ci-runner-1: 2026-11-25 10:00:40Z: Job Tests / Unit (shard 2/4) completed with result: Failed",
      "ci-runner@1: ci-runner[1]: job 'Tests / Unit (shard 2/4)' ended with result: Failed",
      "systemd: Stopping docker.service - Docker Application Container Engine...",
      "systemd: ci-runner@2.service: Main process exited, code=killed, status=9/KILL",
    ]);
    const all = shipped(aws.calls).join("\n");
    for (const dropped of ["veth", "level=info", "ci-runner-idle", "sshd", "ssh.service", "Connection closed"]) {
      assert.ok(!all.includes(dropped), `'${dropped}' is noise and is never shipped`);
    }
    for (const p of puts(aws.calls)) {
      const ts = p.body.logEvents.map((e) => e.timestamp);
      assert.deepEqual(ts, [...ts].sort((a, b) => a - b), "events in time order, as PutLogEvents requires");
    }
    assert.ok(h.jctlArgs()[0].includes("-b"), "this boot only: an image's old journal is never shipped");
  } finally {
    await aws.close();
  }
});

test("the last lines are the point: on SIGTERM it reads the journal once more, names the shutdown job, and ships before it exits", async () => {
  const h = host([unitLine("ci-runner@1.service", "ci-runner[1]: running job 'Lint' as host-1-1", 0)]);
  const aws = await fakeAws();
  try {
    // A poll interval far longer than the test: only the stop's own read can
    // pick up what is appended after the first put.
    const { code } = await ship(h, aws, {
      interval: "600",
      until: (c) => puts(c).length >= 1,
      beforeStop: () => h.append([
        ident("systemd-logind", "Power key pressed short.", 100),
        ident("systemd-logind", "System is powering down.", 100),
        pid1("ci-runner@1.service", "Stopping ci-runner@1.service - GitHub Actions runner slot 1 (one job per container)...", 101),
        unitLine("ci-runner@1.service", "ci-runner[1]: deregistered host-1-1", 102),
        pid1("ci-runner@1.service", "Stopped ci-runner@1.service - GitHub Actions runner slot 1 (one job per container).", 103),
        ident("systemd", "Stopped target multi-user.target - Multi-User System.", 104),
      ]),
    });
    assert.equal(code, 0);
    const last = puts(aws.calls).at(-1).body.logEvents.map((e) => e.message);
    assert.deepEqual(last.slice(0, 6), [
      "systemd-logind: Power key pressed short.",
      "systemd-logind: System is powering down.",
      "systemd: Stopping ci-runner@1.service - GitHub Actions runner slot 1 (one job per container)...",
      "ci-runner@1: ci-runner[1]: deregistered host-1-1",
      "systemd: Stopped ci-runner@1.service - GitHub Actions runner slot 1 (one job per container).",
      "systemd: Stopped target multi-user.target - Multi-User System.",
    ]);
    assert.match(last.at(-1), /^host-logs: stopping; shutdown job queued: poweroff\.target$/);
  } finally {
    await aws.close();
  }
});

test("no token reaches CloudWatch, whatever a line carries", async () => {
  const secrets = [
    shaped("gh", "s_", "16C7e42F292c6912E7710c838347Ae178B4a"),
    shaped("github", "_pat_", "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"),
    shaped("ey", "JhbGciOiJSUzI1NiJ9", ".", "eyJpc3MiOiIxMjM0NTYiLCJleHAiOjE3MDB9", ".", "c2lnbmF0dXJlLXZhbHVl"),
    shaped("AK", "IA", "IOSFODNN7EXAMPLE"),
    shaped("eyJhZ2VudElkIjo0MiwicnVubmVyTmFtZSI6Imhvc3QtMS0xIiwic2NvcGUiOiJyZXBvcy9hY21lL2FwcCJ9", "WW91IGhhdmUgYmVlbiB3YXJuZWQ="),
    "hunter2-value",
  ];
  const h = host([
    unitLine("ci-runner@1.service", `ci-runner[1]: installation credential ${secrets[0]} minted`, 0),
    unitLine("ci-runner@1.service", `ci-runner[1]: pat ${secrets[1]}`, 1),
    runner(1, `Authorization: Bearer ${secrets[2]}`, 2),
    unitLine("ci-runner-credential.service", `aws: key ${secrets[3]}`, 3),
    unitLine("ci-runner@2.service", `ci-runner[2]: RUNNER_JITCONFIG ${secrets[4]}`, 4),
    unitLine("ci-runner@2.service", `ci-runner[2]: password=${secrets[5]} rejected`, 5),
  ]);
  const aws = await fakeAws();
  try {
    await ship(h, aws, { until: (c) => shipped(c).length >= 7 });
    const all = shipped(aws.calls).join("\n");
    assert.equal(shipped(aws.calls).filter((m) => m.includes("<redacted>")).length, 6, all);
    for (const s of secrets) assert.ok(!all.includes(s), `a secret reached CloudWatch: ${s.slice(0, 4)}…`);
  } finally {
    await aws.close();
  }
});

test("a repeat within five minutes is counted, not shipped, and the count is said at the end", async () => {
  const h = host(Array.from({ length: 50 }, (_, i) => unitLine("ci-runner@1.service", "ci-runner[1]: docker does not answer; not registering", i * 2)));
  const aws = await fakeAws();
  try {
    await ship(h, aws, { until: (c) => shipped(c).length >= 2 });
    const lines = shipped(aws.calls).filter((m) => m.includes("docker does not answer"));
    assert.deepEqual(lines, [
      "ci-runner@1: ci-runner[1]: docker does not answer; not registering",
      "ci-runner@1: ci-runner[1]: docker does not answer; not registering (repeated 49 more times, not shipped)",
    ]);
  } finally {
    await aws.close();
  }
});

test("ordinary lines stop at the hourly allowance; kernel, shutdown and _diag lines still go", async () => {
  const h = host([
    ...Array.from({ length: 40 }, (_, i) => runner(1, `Running job: distinct job ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`, i)),
    kernel("Out of memory: Killed process 777 (vitest)", 50, "3"),
    unitLine("ci-runner@1.service", "ci-runner[1]: diag Worker_20261125.log: [ERR Worker] System.IO.IOException: No space left on device", 51),
    ident("systemd-logind", "System is powering down.", 52),
  ]);
  const aws = await fakeAws();
  try {
    await ship(h, aws, { env: { CI_RUNNER_LOGS_HOURLY_BYTES: "600" }, until: (c) => shipped(c).some((m) => m.includes("powering down")) });
    const all = shipped(aws.calls);
    const ordinary = all.filter((m) => m.startsWith("ci-runner-1: Running job"));
    assert.ok(ordinary.length > 0 && ordinary.length < 10, `ordinary lines are cut at the allowance (${ordinary.length} shipped)`);
    assert.equal(all.filter((m) => m.includes("hourly byte allowance reached")).length, 1, "the cut is said, once");
    assert.ok(all.includes("kernel: Out of memory: Killed process 777 (vitest)"));
    assert.ok(all.some((m) => m.includes("diag Worker_20261125.log")));
    assert.ok(all.includes("systemd-logind: System is powering down."));
  } finally {
    await aws.close();
  }
});

test("a spot interruption notice is shipped once, as soon as the metadata shows it", async () => {
  const notice = '{"action":"terminate","time":"2026-11-25T10:02:00Z"}';
  const h = host([unitLine("ci-runner@1.service", "ci-runner[1]: running job 'Lint' as host-1-1", 0)]);
  const aws = await fakeAws({ spot: notice });
  try {
    // Several polls see the notice before the stop.
    await ship(h, aws, { until: (c) => shipped(c).some((m) => m.includes("spot")), beforeStop: () => new Promise((r) => setTimeout(r, 800)) });
    await new Promise((r) => setTimeout(r, 0));
    const spot = shipped(aws.calls).filter((m) => m.includes("spot interruption notice"));
    assert.deepEqual(spot, [`host-logs: spot interruption notice: ${notice}`]);
  } finally {
    await aws.close();
  }
});

test("a restart resumes after the last shipped entry: nothing twice, nothing lost", async () => {
  const h = host([unitLine("ci-runner@1.service", "ci-runner[1]: first life", 0)]);
  const aws = await fakeAws();
  try {
    await ship(h, aws, { until: (c) => shipped(c).some((m) => m.includes("first life")) });
    h.append([unitLine("ci-runner@1.service", "ci-runner[1]: second life", 10)]);
    const before = shipped(aws.calls).length;
    await ship(h, aws, { until: (c) => shipped(c).some((m) => m.includes("second life")) });
    const second = shipped(aws.calls).slice(before).filter((m) => !m.startsWith("host-logs:"));
    assert.deepEqual(second, ["ci-runner@1: ci-runner[1]: second life"]);
    assert.ok(h.jctlArgs().some((a) => a.some((x) => x.startsWith("--after-cursor="))), "the second life read after the saved cursor");
  } finally {
    await aws.close();
  }
});

test("a saved cursor the journal no longer has: it reads on from the newest entry's time, not from the boot's start", async () => {
  const h = host([
    unitLine("ci-runner@1.service", "ci-runner[1]: long before", 0),
    unitLine("ci-runner@1.service", "ci-runner[1]: after the rotation", 600),
  ]);
  mkdirSync(h.state, { recursive: true });
  writeFileSync(path.join(h.state, "state.json"), JSON.stringify({ cursor: "s=rotated;i=1", last_ts: t0 + 300_000 }));
  const aws = await fakeAws();
  try {
    const { stderr } = await ship(h, aws, { until: (c) => shipped(c).some((m) => m.includes("after the rotation")) });
    assert.match(stderr, /the saved journal cursor is gone/);
    assert.ok(!shipped(aws.calls).some((m) => m.includes("long before")), "nothing from before the newest entry already read");
  } finally {
    await aws.close();
  }
});

test("CloudWatch not answering: the lines are kept and shipped once it does, and an existing stream is fine", async () => {
  const h = host([kernel("Out of memory: Killed process 4242 (node)", 0, "3")]);
  const aws = await fakeAws({ failPuts: 2, streamExists: true });
  try {
    const { code } = await ship(h, aws, { until: (c) => puts(c).length >= 3 });
    assert.equal(code, 0);
    assert.ok(shipped(puts(aws.calls).slice(2)).includes("kernel: Out of memory: Killed process 4242 (node)"));
  } finally {
    await aws.close();
  }
});

test("off EC2, or with the log group off, it ships nothing and exits 0, so systemd leaves it down", async () => {
  const h = host([kernel("Out of memory: Killed process 1 (x)", 0, "3")]);
  const off = await ship(h, { base: "http://127.0.0.1:9", calls: [] }, { until: () => false });
  assert.equal(off.code, 0);
  assert.match(off.stderr, /no EC2 instance metadata; not shipping/);
  const aws = await fakeAws();
  try {
    const r = await ship(h, aws, { env: { CI_RUNNER_LOG_GROUP: "off" }, until: () => false });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /CI_RUNNER_LOG_GROUP is off/);
    assert.equal(aws.calls.length, 0);
  } finally {
    await aws.close();
  }
});

/** A busy host-hour: two slots, a job every 7 minutes each, the minute's noise. */
function busyHour() {
  const entries = [];
  for (let m = 0; m < 60; m++) {
    const s = m * 60;
    entries.push(
      pid1("ci-runner-idle.service", "Starting ci-runner-idle.service - Power the CI host off when no job has run for CI_RUNNER_IDLE_MINUTES...", s),
      pid1("ci-runner-idle.service", "ci-runner-idle.service: Deactivated successfully.", s),
      pid1("ci-runner-idle.service", "Finished ci-runner-idle.service - Power the CI host off when no job has run for CI_RUNNER_IDLE_MINUTES.", s),
    );
    if (m % 7 !== 0) continue;
    for (const slot of [1, 2]) {
      const job = `Tests / Integration (shard ${(m % 10) + 1}/10) #${m}`;
      const name = `eu-north-1c-ip-172-31-15-157-${slot}-${1795611394 + m}`;
      entries.push(
        unitLine(`ci-runner@${slot}.service`, `ci-runner[${slot}]: registered ${name}; waiting for a job`, s + 1),
        runner(slot, "√ Connected to GitHub", s + 2),
        runner(slot, "Current runner version: '2.330.0'", s + 2),
        runner(slot, `2026-11-25 10:${String(m).padStart(2, "0")}:03Z: Listening for Jobs`, s + 3),
        runner(slot, `2026-11-25 10:${String(m).padStart(2, "0")}:05Z: Running job: ${job}`, s + 5),
        unitLine(`ci-runner@${slot}.service`, `ci-runner[${slot}]: running job '${job}' as ${name}`, s + 6),
        ...Array.from({ length: 8 }, (_, k) => kernel(`br-3f2a9c1d: port ${k}(veth${k}a2b3c4) entered forwarding state`, s + 7)),
        runner(slot, `Job ${job} completed with result: Succeeded`, s + 350),
        runner(slot, "√ Removed .credentials", s + 351),
        runner(slot, "√ Removed .runner", s + 351),
      );
    }
  }
  return entries.sort((a, b) => Number(a.__REALTIME_TIMESTAMP) - Number(b.__REALTIME_TIMESTAMP));
}

test("what a busy host-hour costs: two slots, a job every 7 minutes each, every minute's noise, stays far under the allowance", async () => {
  const h = host(busyHour());
  const aws = await fakeAws();
  try {
    await ship(h, aws, { until: (c) => shipped(c).some((m) => m.includes("#56 completed")) });
    // What CloudWatch bills: each event's UTF-8 bytes plus 26.
    const events = puts(aws.calls).flatMap((p) => p.body.logEvents);
    const billed = events.reduce((n, e) => n + Buffer.byteLength(e.message) + 26, 0);
    assert.ok(billed > 2 * 1024, `the hour's jobs were shipped (${billed} bytes)`);
    // Measured 2026-11-25: 15,080 bytes in 164 events (README.md, "Host logs
    // after the host is gone"). A rise past this bound is a filter that let
    // noise through, and it bills every host-hour of the fleet.
    assert.ok(billed < 20 * 1024, `a busy host-hour bills ${billed} bytes in ${events.length} events`);
  } finally {
    await aws.close();
  }
});

// ── how it is installed ──────────────────────────────────────────────────────
// The shipper is only as good as its place in systemd's shutdown order: the
// last lines (a slot stopping, its deregistration, the shutdown job) exist
// only if every slot has stopped before the final flush, and that flush needs
// the network.

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const install = read("install.sh");
const unitText = (name) => {
  const start = install.indexOf(`/etc/systemd/system/${name} <<`);
  assert.ok(start !== -1, `install.sh writes ${name}`);
  return install.slice(start, install.indexOf("\nUNIT\n", start));
};

test("install.sh ships the script, writes the unit and enables it at boot", () => {
  const line = install.replace(/\\\n/g, " ").split("\n").find((l) => /^install -m 0755 .*"\$prefix\/"/.test(l.trim()));
  assert.match(line, /"\$here\/host-logs\.py"/);
  const unit = unitText("ci-runner-logs.service");
  assert.match(unit, /^ExecStart=\/usr\/bin\/python3 -B \$\{prefix\}\/host-logs\.py$/m, "the standard library alone: no package to install");
  assert.match(unit, /^WantedBy=multi-user\.target$/m);
  assert.match(install, /^systemctl enable [^\n]*ci-runner-logs\.service/m);
  assert.match(install, /^CI_RUNNER_LOG_GROUP=\$\{CI_RUNNER_LOG_GROUP:-\/ci-runner\/hosts\}$/m, "the group the owner made, unless told otherwise");
  // Off EC2 the script exits 0; on-failure keeps it down there, and up on EC2.
  assert.match(unit, /^Restart=on-failure$/m);
});

test("at shutdown every slot stops before the final flush, and the flush runs before the network goes", () => {
  const slot = unitText("ci-runner@.service");
  // systemd stops units in the reverse of their start order: a slot After= the
  // shipper is stopped before it.
  assert.match(slot, /^After=ci-runner-logs\.service$/m);
  assert.match(slot, /^Wants=ci-runner-logs\.service$/m);
  assert.doesNotMatch(slot, /^(Requires|BindsTo|PartOf)=ci-runner-logs\.service/m, "no log problem may stop a job");
  const unit = unitText("ci-runner-logs.service");
  assert.match(unit, /^After=network-online\.target/m, "stopped before the network it ships over");
  assert.match(unit, /^Wants=network-online\.target$/m);
  assert.doesNotMatch(unit, /^DefaultDependencies=no$/m, "an ordinary unit, stopped in the shutdown transaction");
  const stop = Number(/^TimeoutStopSec=(\d+)$/m.exec(unit)?.[1]);
  assert.ok(stop >= 15 && stop <= 60, `room for one journal read and one put, not a stuck shutdown (TimeoutStopSec=${stop})`);
  assert.match(unit, /^MemoryMax=/m);
  assert.match(unit, /^CPUQuota=/m);
});

test("the cursor lives in /run, so an image never carries one into the hosts it launches", () => {
  assert.match(read("host-logs.py"), /CI_RUNNER_LOGS_STATE_DIR", "\/run\/ci-runner-logs"/);
  const un = read("uninstall.sh");
  assert.match(un, /\/etc\/systemd\/system\/ci-runner-logs\.service/);
  assert.match(un, /\/run\/ci-runner-logs/);
});
