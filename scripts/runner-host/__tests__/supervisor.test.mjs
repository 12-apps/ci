import { strict as assert } from "node:assert";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, closeSync, mkdtempSync, openSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// What one runner slot actually does against GitHub and Docker.
//
// `supervisor.sh` is the only code between a host and a job, and each thing it
// can get wrong is quiet: a runner registered without the label never gets a
// job (CI just queues), a JIT config on `docker run`'s argv sits in the host's
// `ps` for the length of the job, a container without a big /dev/shm crashes
// Chromium mid-suite, a cleanup that matches too loosely deregisters the
// neighbouring slot's live runner, and a job that never ends holds its slot for
// ever. So iterations are run for real here, with `curl` and `docker` replaced
// by stubs that record what they were asked, and each property is asserted on
// the record.
//
// Dependency-free (node: builtins + bash + jq + openssl) so it runs in
// self-test.yml, which has no install step.

const SCRIPT = fileURLToPath(new URL("../supervisor.sh", import.meta.url));
const JIT = "SECRET-JIT-CONFIG-VALUE";
const INSTALL_TOKEN = "ghs_INSTALLATION_TOKEN_VALUE";

/**
 * Stub `curl` and `docker` on PATH. Each appends {bin, argv, jit} to a log.
 * docker: `inspect ...Running` answers true for `runPolls` calls, then false;
 * `logs` prints `logs`. That is how a job's life is simulated.
 */
function stubs({ jitFails = false, runPolls = 0, logs = "" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "supervisor-"));
  const log = path.join(dir, "calls.jsonl");
  const record = (bin) => `#!/usr/bin/env bash
jq -cn --arg bin ${bin} --arg jit "\${RUNNER_JITCONFIG:-}" '{bin:$bin, argv:$ARGS.positional, jit:$jit}' --args -- "$@" >> "${log}"
`;
  writeFileSync(
    path.join(dir, "curl"),
    `${record("curl")}
url=""
for a in "$@"; do case "$a" in https://*) url="$a";; esac; done
case "$url" in
  */generate-jitconfig)
    prev=""; for a in "$@"; do [[ "$prev" == -d ]] && jq -r .name <<<"$a" > "${dir}/registered"; prev="$a"; done
    ${jitFails ? "exit 22" : `echo '{"encoded_jit_config":"${JIT}"}'`} ;;
  */repos/acme/app/installation) echo '{"id":42}' ;;
  */app/installations/42/access_tokens) echo '{"token":"${INSTALL_TOKEN}"}' ;;
  */actions/runners\\?*) jq -n --arg mine "$(cat "${dir}/registered" 2>/dev/null)" '{runners: ([
      {id:7, name:"host-1-1700000000", status:"offline"},
      {id:8, name:"host-1-1700000001", status:"online"},
      {id:9, name:"host-10-1700000002", status:"offline"},
      {id:10, name:"other-1-1", status:"offline"}]
      + (if $mine == "" then [] else [{id:99, name:$mine, status:"online"}] end))}' ;;
  *) echo '{}' ;;
esac
`,
  );
  const counter = path.join(dir, "polls");
  writeFileSync(counter, "0");
  writeFileSync(path.join(dir, "logs.txt"), logs);
  writeFileSync(
    path.join(dir, "docker"),
    `${record("docker")}
case "$1" in
  inspect)
    if [[ "$*" == *Running* ]]; then
      n=$(cat "${counter}"); echo $((n + 1)) > "${counter}"
      if (( n < ${runPolls} )); then echo true; else echo false; fi
    else echo 4242; fi ;;
  logs) cat "${path.join(dir, "logs.txt")}" ;;
  run) echo cid ;;
esac
exit 0
`,
  );
  for (const bin of ["curl", "docker"]) chmodSync(path.join(dir, bin), 0o755);
  return { dir, log };
}

function runOnce(env = {}, opts = {}) {
  const { dir, log } = stubs(opts);
  // stderr goes to a FILE: on timeout spawnSync closes its pipes, and the
  // stopping supervisor's own log line would die of SIGPIPE — journald, what
  // it writes to in production, never goes away under it.
  const errPath = path.join(dir, "stderr.txt");
  const errFd = openSync(errPath, "w");
  const result = spawnSync("bash", [SCRIPT, "1"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", errFd],
    timeout: opts.stopAfterMs ?? 30_000,
    killSignal: "SIGTERM",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      CI_RUNNER_TOKEN: "pat",
      CI_RUNNER_SCOPE: "repos/acme/app",
      CI_RUNNER_LABELS: "acme-ci, gpu ,",
      CI_RUNNER_NAME: "host",
      CI_RUNNER_API: "https://api.test",
      CI_RUNNER_ONCE: "1",
      CI_RUNNER_STATE_DIR: dir,
      CI_RUNNER_POLL_SECONDS: "0.2",
      ...env,
    },
  });
  closeSync(errFd);
  result.stderr = readFileSync(errPath, "utf8");
  let calls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    // no calls recorded
  }
  const statePath = path.join(dir, "slot-1.json");
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
  return { ...result, calls, state, dir };
}

const argAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];
const dockerRun = (calls) => calls.find((c) => c.bin === "docker" && c.argv[0] === "run");

test("registers a JIT runner with the labels, group and a slot-scoped name", () => {
  const { status, stderr, calls } = runOnce();
  assert.equal(status, 0, stderr);
  const url = "https://api.test/repos/acme/app/actions/runners/generate-jitconfig";
  const post = calls.find((c) => c.bin === "curl" && c.argv.some((arg) => arg === url));
  assert.ok(post, "no generate-jitconfig call was made on the configured scope");
  assert.equal(argAfter(post.argv, "-X"), "POST");
  const body = JSON.parse(argAfter(post.argv, "-d"));
  // Whitespace and empty entries are dropped: a label GitHub stores as " gpu "
  // is a label `runs-on: gpu` never matches, and the job queues forever.
  assert.deepEqual(body.labels, ["acme-ci", "gpu"]);
  assert.equal(body.runner_group_id, 1);
  assert.match(body.name, /^host-1-\d+$/);
});

test("starts the job container isolated, capped, sized for Chromium, without the JIT on argv", () => {
  const { calls } = runOnce({ CI_RUNNER_MEMORY: "6000m", CI_RUNNER_CPUS: "2.5", CI_RUNNER_IMAGE: "img:tag" });
  const run = dockerRun(calls);
  assert.ok(run, "the job container was never started");
  const a = run.argv;
  assert.ok(a.includes("--privileged"), "the job's own dockerd needs --privileged");
  assert.equal(argAfter(a, "--shm-size"), "2g");
  assert.equal(argAfter(a, "--volume"), "/var/lib/docker");
  assert.equal(argAfter(a, "--memory"), "6000m");
  assert.equal(argAfter(a, "--memory-swap"), "6000m");
  assert.equal(argAfter(a, "--cpus"), "2.5");
  assert.equal(argAfter(a, "--log-driver"), "journald");
  assert.equal(argAfter(a, "--log-opt"), "tag=ci-runner-1");
  assert.equal(a.at(-1), "img:tag");
  assert.equal(argAfter(a, "--env"), "RUNNER_JITCONFIG", "the JIT must be passed by name");
  assert.ok(!a.some((x) => x.includes(JIT)), "the JIT config leaked onto docker's argv");
  assert.equal(run.jit, JIT, "docker did not receive the JIT config through its environment");
});

test("the container is removed after the job, whatever it did", () => {
  const { calls } = runOnce({}, { runPolls: 2, logs: "Running job: build\nJob build completed with result: Succeeded\n" });
  const runAt = calls.findIndex((c) => c.bin === "docker" && c.argv[0] === "run");
  const rmAfter = calls.slice(runAt + 1).some((c) => c.bin === "docker" && c.argv[0] === "rm" && c.argv.includes("ci-runner-1"));
  assert.ok(runAt >= 0 && rmAfter, "no `docker rm -f ci-runner-1` after the job ended");
});

test("removes only THIS slot's offline runners", () => {
  const { calls } = runOnce();
  const deleted = calls
    .filter((c) => c.bin === "curl" && c.argv.includes("DELETE"))
    .map((c) => c.argv.find((x) => x.startsWith("https://")).split("/").at(-1));
  // 8 is online (a live job), 9 is slot 10 — `host-1` is a prefix of `host-10`,
  // which is why the match is on `host-1-` — and 10 is another host.
  assert.deepEqual(deleted, ["7"]);
});

const deletedIds = (calls) =>
  calls
    .filter((c) => c.bin === "curl" && c.argv.includes("DELETE"))
    .map((c) => c.argv.find((x) => x.startsWith("https://")).split("/").at(-1));

test("a slot stopped while its runner waits deregisters that runner, and only it", () => {
  // systemctl stop = SIGTERM to the supervisor. The container is still up
  // (runPolls is large), so the runner is registered and waiting.
  const { status, stderr, calls, state } = runOnce({}, { runPolls: 1000, stopAfterMs: 1500 });
  // 143 is what the unit's SuccessExitStatus= expects: a stop is not a failure.
  assert.equal(status, 143, `the supervisor did not stop through its trap:\n${stderr}`);
  // 7 is swept before registering; 99 is the runner this slot registered.
  assert.deepEqual(deletedIds(calls), ["7", "99"]);
  assert.equal(state.phase, "stopped");
  const rm = calls.findLastIndex((c) => c.bin === "docker" && c.argv[0] === "rm" && c.argv.includes("ci-runner-1"));
  assert.ok(rm > calls.findIndex((c) => c.bin === "docker" && c.argv[0] === "run"), "the container outlived the stop");
});

test("a runner whose job finished is not deregistered again on exit", () => {
  const { calls } = runOnce({}, { runPolls: 2, logs: "Running job: build\nJob build completed with result: Succeeded\n" });
  assert.deepEqual(deletedIds(calls), ["7"]);
});

test("records the job, then a job that outlives its cap is killed and recorded", () => {
  const { status, calls, state } = runOnce(
    { CI_RUNNER_JOB_TIMEOUT_MINUTES: "0" },
    { runPolls: 1000, logs: "2026-09-23 10:00:00Z: Running job: e2e shard 1/3\n" },
  );
  assert.equal(status, 0);
  assert.ok(
    calls.some((c) => c.bin === "docker" && c.argv[0] === "rm" && c.argv.includes("ci-runner-1")),
    "the timed-out container was not removed",
  );
  assert.equal(state.job, "e2e shard 1/3");
  // Set by the caller of jit_config, which runs in a subshell: an assignment
  // inside it never reached the state file (found on a real Docker run).
  assert.match(state.runner, /^host-1-\d+$/);
  assert.match(state.last_failure, /job 'e2e shard 1\/3' exceeded 0s/);
  assert.equal(state.phase, "stopped");
});

test("a job that did not succeed is the slot's last failure", () => {
  const { state } = runOnce({}, { runPolls: 2, logs: "Running job: lint\nJob lint completed with result: Failed\n" });
  assert.match(state.last_failure, /job 'lint' ended with result: Failed/);
});

test("the state file carries a heartbeat and never a credential", () => {
  const { state, dir } = runOnce({}, { runPolls: 2, logs: "Running job: build\n" });
  assert.ok(Math.abs(Date.now() / 1000 - state.heartbeat) < 30, "heartbeat is not current");
  const raw = readFileSync(path.join(dir, "slot-1.json"), "utf8");
  for (const secret of ["pat", JIT, INSTALL_TOKEN]) {
    assert.ok(!raw.includes(`"${secret}"`) && !raw.includes(JIT) && !raw.includes(INSTALL_TOKEN), `state leaked ${secret}`);
  }
});

test("a GitHub App mints a signed JWT, a narrowed installation token, and registers with it", () => {
  const keyDir = mkdtempSync(path.join(tmpdir(), "app-key-"));
  const key = path.join(keyDir, "app.pem");
  const pub = path.join(keyDir, "app.pub");
  execFileSync("openssl", ["genrsa", "-out", key, "2048"], { stdio: "ignore" });
  execFileSync("openssl", ["rsa", "-in", key, "-pubout", "-out", pub], { stdio: "ignore" });

  const { status, stderr, calls } = runOnce({ CI_RUNNER_TOKEN: "", CI_RUNNER_APP_ID: "123456", CI_RUNNER_APP_KEY_FILE: key });
  assert.equal(status, 0, stderr);

  const bearer = (c) => (c.argv.find((x) => x.startsWith("Authorization: Bearer ")) ?? "").slice(22);
  const lookup = calls.find((c) => c.bin === "curl" && c.argv.some((arg) => arg === "https://api.test/repos/acme/app/installation"));
  assert.ok(lookup, "the installation was not looked up on the scope");
  const [h, p, s] = bearer(lookup).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  assert.equal(claims.iss, "123456");
  assert.ok(claims.exp - claims.iat <= 600, "GitHub rejects an App JWT that lives longer than 10 minutes");
  // The signature verifies against the App's public key.
  const sigFile = path.join(keyDir, "sig");
  writeFileSync(sigFile, Buffer.from(s, "base64url"));
  const verified = spawnSync("openssl", ["dgst", "-sha256", "-verify", pub, "-signature", sigFile], { input: `${h}.${p}` });
  assert.equal(verified.status, 0, "the JWT signature does not verify with the App's public key");

  const mint = calls.find((c) => c.bin === "curl" && c.argv.some((arg) => arg === "https://api.test/app/installations/42/access_tokens"));
  assert.ok(mint, "no installation token was minted");
  assert.deepEqual(JSON.parse(argAfter(mint.argv, "-d")), { repositories: ["app"], permissions: { administration: "write" } });

  const jit = calls.find((c) => c.bin === "curl" && c.argv.some((x) => x.endsWith("/generate-jitconfig")));
  assert.equal(bearer(jit), INSTALL_TOKEN, "registration did not use the installation token");
  const keyText = readFileSync(key, "utf8").split("\n")[1];
  assert.ok(!calls.some((c) => c.argv.some((x) => x.includes(keyText))), "the App private key reached an argv");
});

test("a credential GitHub refuses fails the slot instead of starting a container", () => {
  const { status, stderr, calls, state } = runOnce({}, { jitFails: true });
  assert.equal(status, 1);
  assert.match(stderr, /could not register a runner/);
  assert.ok(!dockerRun(calls));
  assert.equal(state.phase, "stopped");
  assert.match(state.last_failure, /could not register/);
});

test("refuses to start without its configuration", () => {
  for (const [key, pattern] of [
    ["CI_RUNNER_SCOPE", /CI_RUNNER_SCOPE/],
    ["CI_RUNNER_LABELS", /CI_RUNNER_LABELS/],
    ["CI_RUNNER_TOKEN", /CI_RUNNER_APP_ID|CI_RUNNER_TOKEN/],
  ]) {
    const { status, stderr } = runOnce({ [key]: "" });
    assert.notEqual(status, 0, `${key} empty should fail`);
    assert.match(stderr, pattern);
  }
  const noKey = runOnce({ CI_RUNNER_TOKEN: "", CI_RUNNER_APP_ID: "1", CI_RUNNER_APP_KEY_FILE: "/nonexistent" });
  assert.equal(noKey.status, 64);
});
