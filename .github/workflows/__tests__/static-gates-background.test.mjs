import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// FUT-5383: Static Gates starts jscpd and knip in the background and their own
// steps wait for them. This runs the three REAL `run:` blocks of quality.yml
// the way GitHub runs `shell: bash` (bash --noprofile --norc -eo pipefail),
// with a fake `pnpm` on PATH, and checks that each wait step exits with its
// gate's own exit code. The first version lost a failing gate's code under
// -e (future-pay#5407, job 136070789963): the step still went red, but said
// the process was killed. A refactor that drops the `|| rc=$?` fails here.

const WORKFLOW = new URL("../quality.yml", import.meta.url);
const STEPS = {
  start: "Start jscpd and knip in the background",
  jscpd: "Copy-paste detection (jscpd)",
  knip: "Unused files/exports/deps (knip)",
};

/** The `run: |` block of the step with this exact name, dedented. */
export function runBlock(text, name) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trimStart() === `- name: ${name}`);
  assert.ok(at >= 0, `quality.yml has no step named "${name}"`);
  const stepIndent = lines[at].indexOf("-");
  let i = at + 1;
  while (i < lines.length && !/^\s*run: \|\s*$/.test(lines[i])) {
    const ind = lines[i].search(/\S/);
    assert.ok(ind === -1 || ind > stepIndent, `step "${name}" has no run: | block`);
    i++;
  }
  const body = [];
  let indent = -1;
  for (i += 1; i < lines.length; i++) {
    const line = lines[i];
    const ind = line.search(/\S/);
    if (ind === -1) { body.push(""); continue; }
    if (indent === -1) indent = ind;
    if (ind < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n").trimEnd() + "\n";
}

const FAKE_PNPM = `#!/bin/bash
case "$1" in
  quality:dup) sleep 1; echo "jscpd report"; exit "\${DUP_RC:-0}";;
  quality:knip) if [ -n "$KNIP_HANG" ]; then echo partial; sleep 30; fi; echo "knip report"; exit "\${KNIP_RC:-0}";;
  *) echo "unexpected pnpm $*" >&2; exit 99;;
esac
`;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "static-gates-bg-"));
  const text = readFileSync(WORKFLOW, "utf8");
  for (const [key, name] of Object.entries(STEPS)) writeFileSync(join(dir, `${key}.sh`), runBlock(text, name));
  writeFileSync(join(dir, "pnpm"), FAKE_PNPM);
  chmodSync(join(dir, "pnpm"), 0o755);
  const env = (extra) => ({ ...process.env, PATH: `${dir}:${process.env.PATH}`, RUN_KNIP: "true", ...extra });
  const bash = (script, extra = {}) =>
    spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(dir, script)], { cwd: dir, env: env(extra), encoding: "utf8", timeout: 20000 });
  return { dir, bash, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function scenario(extra, between = () => {}) {
  const h = harness();
  try {
    const start = h.bash("start.sh", extra);
    assert.equal(start.status, 0, start.stderr);
    between(h);
    return { jscpd: h.bash("jscpd.sh"), knip: h.bash("knip.sh") };
  } finally {
    spawnSync("pkill", ["-f", "sleep 30"]);
    h.cleanup();
  }
}

test("both gates pass: both wait steps exit 0 and print their logs", () => {
  const r = scenario({});
  assert.equal(r.jscpd.status, 0);
  assert.equal(r.knip.status, 0);
  assert.match(r.jscpd.stdout, /jscpd report/);
  assert.match(r.knip.stdout, /knip report/);
});

test("a failing gate's own exit code reaches its step under bash -e", () => {
  const r = scenario({ KNIP_RC: "3", DUP_RC: "2" });
  assert.equal(r.knip.status, 3, r.knip.stdout);
  assert.equal(r.jscpd.status, 2, r.jscpd.stdout);
  assert.match(r.knip.stdout, /knip report/);
  assert.doesNotMatch(r.knip.stdout, /without writing its exit code/);
});

test("one gate failing leaves the other's step green", () => {
  const r = scenario({ KNIP_RC: "1" });
  assert.equal(r.jscpd.status, 0);
  assert.equal(r.knip.status, 1);
});

test("a gate whose process is killed fails its step with a message, without hanging", () => {
  const r = scenario({ KNIP_HANG: "1" }, (h) => {
    spawnSync("sleep", ["0.5"]);
    const pid = readFileSync(join(h.dir, "knip.pid"), "utf8").trim();
    spawnSync("kill", ["-9", pid]);
  });
  assert.equal(r.knip.status, 1);
  assert.match(r.knip.stdout, /partial/);
  assert.match(r.knip.stdout, /::error::knip ended without writing its exit code/);
});

test("run-knip false starts no knip", () => {
  const h = harness();
  try {
    const start = h.bash("start.sh", { RUN_KNIP: "false" });
    assert.equal(start.status, 0);
    assert.match(start.stdout, /started jscpd/);
    assert.doesNotMatch(start.stdout, /started knip/);
    assert.equal(h.bash("jscpd.sh").status, 0);
  } finally {
    h.cleanup();
  }
});
