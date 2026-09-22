import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
// Chromium mid-suite, and a cleanup that matches too loosely deregisters the
// neighbouring slot's live runner. So one iteration is run for real here, with
// `curl` and `docker` replaced by stubs that record what they were asked, and
// every one of those properties is asserted on the record.
//
// Dependency-free (node: builtins + bash) so it runs in self-test.yml, which has
// no install step.

const SCRIPT = fileURLToPath(new URL("../supervisor.sh", import.meta.url));
const JIT = "SECRET-JIT-CONFIG-VALUE";

function stubs({ jitFails = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "supervisor-"));
  const log = path.join(dir, "calls.jsonl");
  // Each stub appends {bin, argv, jit} as one JSON line. python-free on
  // purpose: jq is already a hard dependency of the script under test.
  const record = (bin) => `#!/usr/bin/env bash
jq -cn --arg bin ${bin} --arg jit "\${RUNNER_JITCONFIG:-}" '{bin:$bin, argv:$ARGS.positional, jit:$jit}' --args -- "$@" >> "${log}"
`;
  writeFileSync(
    path.join(dir, "curl"),
    `${record("curl")}
url="\${@: -1}"
for a in "$@"; do case "$a" in */generate-jitconfig) url="$a";; esac; done
case "$url" in
  */generate-jitconfig) ${jitFails ? "exit 22" : `echo '{"encoded_jit_config":"${JIT}"}'`} ;;
  */actions/runners\\?*) echo '{"runners":[
      {"id":7,"name":"host-1-1700000000","status":"offline"},
      {"id":8,"name":"host-1-1700000001","status":"online"},
      {"id":9,"name":"host-10-1700000002","status":"offline"},
      {"id":10,"name":"other-1-1","status":"offline"}]}' ;;
  *) echo '{}' ;;
esac
`,
  );
  writeFileSync(path.join(dir, "docker"), record("docker"));
  for (const bin of ["curl", "docker"]) chmodSync(path.join(dir, bin), 0o755);
  return { dir, log };
}

function runOnce(env = {}, opts = {}) {
  const { dir, log } = stubs(opts);
  const result = spawnSync("bash", [SCRIPT, "1"], {
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      CI_RUNNER_TOKEN: "pat",
      CI_RUNNER_SCOPE: "repos/acme/app",
      CI_RUNNER_LABELS: "acme-ci, gpu ,",
      CI_RUNNER_NAME: "host",
      CI_RUNNER_API: "https://api.test",
      CI_RUNNER_ONCE: "1",
      ...env,
    },
  });
  let calls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    // no calls recorded
  }
  return { ...result, calls };
}

const argAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];

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

test("starts the job container isolated, sized for Chromium, and without the JIT on argv", () => {
  const { calls } = runOnce({ CI_RUNNER_MEMORY: "6000m", CI_RUNNER_IMAGE: "img:tag" });
  const run = calls.find((c) => c.bin === "docker" && c.argv[0] === "run");
  assert.ok(run, "the job container was never started");
  const a = run.argv;
  assert.ok(a.includes("--rm"), "the container must be removed with what the job wrote");
  assert.ok(a.includes("--privileged"), "the job's own dockerd needs --privileged");
  assert.equal(argAfter(a, "--shm-size"), "2g");
  assert.equal(argAfter(a, "--volume"), "/var/lib/docker");
  assert.equal(argAfter(a, "--memory"), "6000m");
  assert.equal(argAfter(a, "--memory-swap"), "6000m");
  assert.equal(a.at(-1), "img:tag");
  assert.equal(argAfter(a, "--env"), "RUNNER_JITCONFIG", "the JIT must be passed by name");
  assert.ok(!a.some((x) => x.includes(JIT)), "the JIT config leaked onto docker's argv");
  assert.equal(run.jit, JIT, "docker did not receive the JIT config through its environment");
});

test("removes only THIS slot's offline runners", () => {
  const { calls } = runOnce();
  const deleted = calls
    .filter((c) => c.bin === "curl" && c.argv.includes("DELETE"))
    .map((c) => c.argv.at(-1).split("/").at(-1));
  // 8 is online (a live job), 9 is slot 10 — `host-1` is a prefix of `host-10`,
  // which is why the match is on `host-1-` — and 10 is another host.
  assert.deepEqual(deleted, ["7"]);
});

test("a token GitHub refuses fails the slot instead of starting a container", () => {
  const { status, stderr, calls } = runOnce({}, { jitFails: true });
  assert.equal(status, 1);
  assert.match(stderr, /could not get a JIT config/);
  assert.ok(!calls.some((c) => c.bin === "docker" && c.argv[0] === "run"));
});

test("refuses to start without its configuration", () => {
  for (const missing of ["CI_RUNNER_TOKEN", "CI_RUNNER_SCOPE", "CI_RUNNER_LABELS"]) {
    const { status, stderr } = runOnce({ [missing]: "" });
    assert.notEqual(status, 0, `${missing} empty should fail`);
    assert.match(stderr, new RegExp(missing));
  }
});
