import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { runBlock } from "./run-block.mjs";

// iac.yml: the reusable OpenTofu plan/apply (FUT-3934).
//
// Every way it can go wrong is quiet. A plan that fails red for a missing
// credential blocks every infra PR until the owner's manual items exist; a
// plan that skips while the credential IS there reports green on a root
// nobody planned; an apply reachable from a pull request applies unreviewed
// code; a cancelled apply leaves a root half-applied. None of these shows up as
// a broken run, so each is asserted over the workflow text, and the credential
// gate is EXECUTED with the environments it must tell apart.
//
// Dependency-free like the rest of this folder: raw text plus bash.

const FILE = fileURLToPath(new URL("../iac.yml", import.meta.url));
const source = readFileSync(FILE, "utf8");

/** The text of one job, from its key to the next job key. */
function jobText(name) {
  const lines = source.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `iac.yml has no job ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

/** Runs a job's "Check credentials" block with this environment. */
function gate(job, env) {
  const dir = mkdtempSync(path.join(tmpdir(), "iac-gate-"));
  try {
    const script = path.join(dir, "gate.sh");
    writeFileSync(script, runBlock(jobText(job), "Check credentials"));
    const out = path.join(dir, "out");
    const summary = path.join(dir, "summary");
    writeFileSync(out, "");
    writeFileSync(summary, "");
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync("bash", [script], {
        env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, IAC_PHASE: job, IAC_WORKDIR: "infra/envs/prod", IAC_ENVIRONMENT: "infra-plan", ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      status = error.status;
      stdout = error.stdout;
    }
    return { status, stdout, output: readFileSync(out, "utf8"), summary: readFileSync(summary, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EXPORTED = "HOSTINGER_API_TOKEN,CLOUDFLARE_API_TOKEN";
const ALL = { REQUIRED_SECRETS: "HOSTINGER_API_TOKEN", IAC_EXPORTED: EXPORTED, HOSTINGER_API_TOKEN: "x", IAC_AWS_ROLE_ARN: "arn:aws:iam::1:role/r" };

test("it is reusable and declares the three inputs the caller passes", () => {
  assert.match(source, /^ {2}workflow_call:/m);
  for (const input of ["working_directory", "plan_environment", "apply_environment"]) {
    assert.match(source, new RegExp(`^ {6}${input}:`, "m"), `input ${input} is not declared`);
  }
  assert.match(source, /^ {6}plan_environment:[\s\S]*?default: infra-plan$/m, "the plan environment does not default to infra-plan");
});

test("the checks run with no environment and no secret", () => {
  const check = jobText("check");
  assert.doesNotMatch(check, /environment:|secrets\./, "a check that needs a credential cannot run before the credentials exist");
  assert.match(check, /tofu fmt -check -recursive/);
  assert.match(check, /tofu init -backend=false/);
  assert.match(check, /tofu validate/);
});

test("plan runs only on a pull request, under the plan environment, after the checks", () => {
  const plan = jobText("plan");
  assert.match(plan, /needs: check/);
  assert.match(plan, /if: \$\{\{ github\.event_name == 'pull_request' && inputs\.apply_environment != '' \}\}/);
  assert.match(plan, /environment: \$\{\{ inputs\.plan_environment \}\}/);
  assert.match(plan, /-lock=false/, "a read-only plan role cannot write the lock object");
});

test("apply runs only on a push to the default branch, serialized per root and never cancelled", () => {
  const apply = jobText("apply");
  assert.match(apply, /github\.event_name == 'push' && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.doesNotMatch(apply, /pull_request/, "apply must not be reachable from a pull request");
  assert.match(apply, /environment: \$\{\{ inputs\.apply_environment \}\}/);
  assert.match(apply, /concurrency:\n\s+group: iac-\$\{\{ inputs\.working_directory \}\}\n\s+cancel-in-progress: false/);
});

test("every step that touches a provider or the state waits for the credential gate", () => {
  for (const job of ["plan", "apply"]) {
    const steps = jobText(job).split(/\n {6}- /).slice(1);
    for (const step of steps.filter((s) => /tofu (init|plan|apply)|configure-aws-credentials|Install OpenTofu/.test(s) && !/tofu init -backend=false/.test(s))) {
      assert.match(step, /if: \$\{\{ steps\.creds\.outputs\.ready == 'true'/, `${job}: a step runs without the gate:\n${step.slice(0, 200)}`);
    }
  }
});

test("the two jobs gate on the same credential check", () => {
  assert.equal(runBlock(jobText("plan"), "Check credentials"), runBlock(jobText("apply"), "Check credentials"));
});

test("no credential: the gate SKIPS, green, with a notice naming what is missing", () => {
  const r = gate("plan", { REQUIRED_SECRETS: "HOSTINGER_API_TOKEN", IAC_EXPORTED: EXPORTED });
  assert.equal(r.status, 0, "a missing credential must not fail the job");
  assert.match(r.output, /^ready=false$/m);
  assert.match(r.stdout, /^::notice title=IaC plan skipped \(infra\/envs\/prod\)::.*secret HOSTINGER_API_TOKEN.*variable IAC_AWS_ROLE_ARN/m);
  assert.match(r.summary, /plan skipped/);
});

test("only the state role missing still skips, and names it", () => {
  const r = gate("plan", { ...ALL, IAC_AWS_ROLE_ARN: "" });
  assert.equal(r.status, 0);
  assert.match(r.output, /^ready=false$/m);
  assert.match(r.output, /^missing=variable IAC_AWS_ROLE_ARN$/m);
});

test("every credential present: the gate lets the plan run", () => {
  const r = gate("plan", ALL);
  assert.equal(r.status, 0);
  assert.match(r.output, /^ready=true$/m);
  assert.doesNotMatch(r.stdout, /::notice/);
});

test("a required secret the workflow does not pass to tofu is an error, not a skip", () => {
  const r = gate("apply", { ...ALL, REQUIRED_SECRETS: "HOSTINGER_API_TOKEN,DO_API_TOKEN" });
  assert.equal(r.status, 1, "a name the workflow never exports would skip forever while the secret exists");
  assert.match(r.stdout, /::error::apply needs DO_API_TOKEN, which iac.yml does not pass to tofu in this job/);
});

/** The comma list a job's gate step sets as IAC_EXPORTED. */
const exportedBy = (job) => /IAC_EXPORTED: ([A-Z_,]+)/.exec(jobText(job))[1].split(",");

test("each secret a job's gate accepts is exported to the step that runs tofu", () => {
  for (const [job, step] of [["plan", "Plan"], ["apply", "Apply"]]) {
    const run = jobText(job).split(/\n {6}- /).find((s) => s.startsWith(`name: ${step}\n`));
    for (const name of exportedBy(job)) assert.match(run, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`), `${job} does not pass ${name} to tofu`);
  }
});

test("the reviewer-less plan never receives a token that can change anything", () => {
  const plan = jobText("plan");
  // Hostinger has no read-only token: it buys and cancels machines.
  assert.doesNotMatch(plan, /secrets\.HOSTINGER_API_TOKEN/, "the plan job reads the Hostinger token");
  assert.deepEqual(exportedBy("plan"), ["CLOUDFLARE_API_TOKEN"]);
  assert.match(plan, /REQUIRED_SECRETS: \$\{\{ inputs\.plan_secrets \}\}/, "the plan gate must check plan_secrets, not apply's required_secrets");
  assert.match(plan, /HOSTINGER_API_TOKEN: plan-runs-without-provider-credentials/);
  assert.match(plan, /tofu plan [^\n]*-refresh=false/, "with no provider token the plan must not refresh");
  assert.match(source, /^ {6}plan_secrets:[\s\S]*?default: ''$/m, "plan_secrets must default to none");
});

test("a Hostinger root's plan gate does not wait for a Hostinger token", () => {
  const r = gate("plan", { REQUIRED_SECRETS: "", IAC_EXPORTED: "CLOUDFLARE_API_TOKEN", IAC_AWS_ROLE_ARN: "arn:aws:iam::1:role/r" });
  assert.equal(r.status, 0);
  assert.match(r.output, /^ready=true$/m);
  const refused = gate("plan", { REQUIRED_SECRETS: "HOSTINGER_API_TOKEN", IAC_EXPORTED: "CLOUDFLARE_API_TOKEN", HOSTINGER_API_TOKEN: "x", IAC_AWS_ROLE_ARN: "r" });
  assert.equal(refused.status, 1, "plan_secrets naming the Hostinger token must be refused, not satisfied");
});

test("a newer push replaces an older plan; a running apply is never replaced", () => {
  assert.match(jobText("plan"), /concurrency:\n\s+group: iac-plan-\$\{\{ github\.event\.pull_request\.number \}\}-\$\{\{ inputs\.working_directory \}\}\n\s+cancel-in-progress: true/);
});

test("the actions that hold the OIDC token and the PR write scope are pinned by sha", () => {
  const refs = [...source.matchAll(/uses: ((?:aws-actions|actions\/github-script)[^\s@]*)@(\S+)/g)];
  assert.ok(refs.length >= 3);
  for (const [, action, ref] of refs) assert.match(ref, /^[0-9a-f]{40}$/, `${action}@${ref} is a mutable tag`);
});

test("the plan comment is ONE per root, updated in place", () => {
  const plan = jobText("plan");
  assert.match(plan, /<!-- iac-plan:\$IAC_WORKDIR -->/);
  assert.match(plan, /c\.body\.startsWith\(marker\)/);
  assert.match(plan, /updateComment/);
});

test("the OpenTofu download is checked against the release's own checksums", () => {
  const installs = source.split("- name: Install OpenTofu").slice(1);
  assert.equal(installs.length, 3);
  for (const step of installs) assert.match(step, /SHA256SUMS" \| sha256sum -c -/);
});

// GitHub runs `shell: bash` as `bash --noprofile --norc -eo pipefail {0}`, so
// the Plan block is executed that way, against a stub tofu. A plan with changes
// (exit 2) once ended the step before its output was printed: the DNS plan of
// 12-apps/future-pay#5914 failed red with nothing to read (FUT-3934).
function planStep(planExit) {
  const dir = mkdtempSync(path.join(tmpdir(), "iac-plan-"));
  try {
    const bin = path.join(dir, "bin");
    execFileSync("mkdir", [bin]);
    writeFileSync(path.join(bin, "tofu"), `#!/usr/bin/env bash\nif [ "$1" = plan ]; then echo "Plan: 1 to add, 0 to change, 0 to destroy."; exit ${planExit}; fi\necho init ok\n`, { mode: 0o755 });
    const script = path.join(dir, "plan.sh");
    writeFileSync(script, runBlock(jobText("plan"), "Plan"));
    const out = path.join(dir, "out");
    writeFileSync(out, "");
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
        env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out, RUNNER_TEMP: dir },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      status = error.status;
      stdout = error.stdout;
    }
    return { status, stdout, output: readFileSync(out, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [planExit, meaning] of [[0, "no changes"], [2, "changes"], [1, "a failed plan"]]) {
  test(`under bash -e, a plan exiting ${planExit} (${meaning}) is printed and its code recorded`, () => {
    const r = planStep(planExit);
    assert.equal(r.status, 0, "the Plan step itself must not fail; the later steps judge the code");
    assert.match(r.stdout, /Plan: 1 to add/);
    assert.match(r.output, new RegExp(`^exit=${planExit}$`, "m"));
  });
}
