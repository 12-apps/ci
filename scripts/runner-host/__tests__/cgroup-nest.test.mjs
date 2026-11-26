import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The job's containers get the slot's cgroup controllers (FUT-5708), read from
// a fake cgroup. On future-pay's fleet an empty cgroup.subtree_control left
// every container the job started at `0B / 0B` in `docker stats`. The
// entrypoint runs this before anything else, so a failure must leave the slot
// as it was and exit 0.

const SCRIPT = fileURLToPath(new URL("../cgroup-nest.sh", import.meta.url));
const HERE = path.dirname(SCRIPT);

function cgroup(files) {
  const cg = path.join(mkdtempSync(path.join(tmpdir(), "cgroup-nest-")), "cg");
  mkdirSync(cg, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    if (body === "<dir>") mkdirSync(path.join(cg, name));
    else writeFileSync(path.join(cg, name), body);
  }
  return cg;
}

const run = (cg) => spawnSync("bash", [SCRIPT], { env: { ...process.env, CI_RUNNER_CGROUP: cg }, encoding: "utf8" });

test("cgroup v2: the processes move to init and every controller is delegated", () => {
  const cg = cgroup({ "cgroup.controllers": "cpuset cpu io memory pids\n", "cgroup.procs": "1\n27\n", "cgroup.subtree_control": "" });
  const r = run(cg);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(path.join(cg, "cgroup.subtree_control"), "utf8"), "+cpuset +cpu +io +memory +pids\n");
  assert.equal(readFileSync(path.join(cg, "init", "cgroup.procs"), "utf8"), "27\n", "each pid is written to the leaf");
});

test("cgroup v1 (no cgroup.controllers): nothing is touched", () => {
  const cg = cgroup({ "cgroup.procs": "1\n" });
  const r = run(cg);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(path.join(cg, "init")), false);
  assert.equal(existsSync(path.join(cg, "cgroup.subtree_control")), false);
});

test("a refused delegation warns and still exits 0, so it never costs a job", () => {
  const cg = cgroup({ "cgroup.controllers": "memory\n", "cgroup.procs": "1\n", "cgroup.subtree_control": "<dir>" });
  const r = run(cg);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /could not enable 'memory' for the job's containers/);
});

test("the image installs it and the entrypoint runs it before the sampler and dockerd", () => {
  const dockerfile = readFileSync(path.join(HERE, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^COPY cgroup-nest\.sh \/usr\/local\/bin\/ci-runner-cgroup-nest$/m);
  const entry = readFileSync(path.join(HERE, "entrypoint.sh"), "utf8");
  const at = (re) => entry.search(re);
  assert.ok(at(/^ci-runner-cgroup-nest$/m) > 0, "the entrypoint calls it");
  assert.ok(at(/^ci-runner-cgroup-nest$/m) < at(/^ci-runner-job-usage sample/m), "before the usage sampler");
  assert.ok(at(/^ci-runner-cgroup-nest$/m) < at(/^dockerd /m), "before dockerd");
});
