import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Every workflow in this repo must declare a top-level `permissions:` block,
// and every job that CALLS a reusable workflow must declare its own.
//
// A workflow with no block does not run at "no permissions" — it runs at
// whatever the context hands it. For a reusable workflow that is the CALLER's
// job grant, which is the part this repo cannot see: the engine ships the
// workflow, a consumer writes the `uses:` line, and a consumer that grants
// broadly (or leaves the repository default at read-write) hands that scope
// straight into code written here. CONSUMING.md asks consumers to pin
// `contents: read`; a document cannot enforce itself, and six workflows —
// twenty-three jobs, including every test lane and both deploy adapters —
// declared nothing at all while eleven of their siblings did.
//
// The declaration is a CEILING, not a grant. It cannot give a job anything the
// caller withheld; the effective permission is the intersection. So adding one
// can only ever narrow, which is why it is safe to require everywhere and why
// the fix for a consumer that forgets belongs here rather than in prose.
//
// The SECOND assertion is the one that is easy to get wrong in the other
// direction. A job whose body is `uses:` another reusable workflow passes its
// own grant down, and a job-level block REPLACES the workflow default rather
// than adding to it. So the moment this file's first rule is satisfied by a
// read-only default, every nested call is silently capped at that default —
// cd.yml's two vendor adapters would lose `packages: read` (the droplet's GHCR
// pull) and `actions: write` (the post-cd dispatch), and both failures land at
// the far end of an ssh session or as a 403 in a job nobody reruns. Requiring
// an explicit block at the call site makes that cap a decision rather than a
// side effect of tidying the parent.
//
// Dependency-free on purpose (node: builtins, raw-text scan rather than a YAML
// parse), matching the other tests in this folder: they run in self-test.yml's
// `action-scripts` job, which deliberately has no install step.

const WORKFLOWS = path.join(fileURLToPath(new URL("../", import.meta.url)));

/** Every `<name>.yml` in .github/workflows, as [name, source]. */
function workflowFiles() {
  return readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, readFileSync(path.join(WORKFLOWS, f), "utf8")]);
}

/**
 * A top-level `permissions:` key — column zero, so a job's four-space one and a
 * `permissions:` appearing inside a comment or a heredoc never count. Matches
 * both shapes GitHub accepts: a mapping on following lines, and the inline
 * `permissions: read-all` / `permissions: {}` form.
 */
function topLevelPermissions(source) {
  const m = /^permissions:(.*)$/m.exec(source);
  if (!m) return undefined;
  const inline = m[1].trim();
  if (inline) return inline;
  // The mapping that follows: every more-indented line until the next
  // column-zero key.
  const rest = source.slice(m.index + m[0].length + 1);
  const body = [];
  for (const line of rest.split("\n")) {
    if (/^[^\s#]/.test(line)) break;
    if (/^\s+\S/.test(line) && !/^\s*#/.test(line)) body.push(line.trim());
  }
  return body.join(", ");
}

/**
 * The jobs of one workflow. Same shape rules as job-timeouts.test.mjs: a job
 * key is indented exactly two spaces under `jobs:`, and `uses:`/`runs-on:`/
 * `permissions:` are read at the job's OWN indent — a `uses:` under `steps:` is
 * deeper and must not make every action step look like a reusable call.
 */
function jobsOf(source) {
  const lines = source.split("\n");
  const start = lines.indexOf("jobs:");
  if (start === -1) return [];

  const jobs = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[^\s#]/.test(lines[i])) break;
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (key) jobs.push({ name: key[1], line: i + 1, body: [] });
    else if (jobs.length > 0) jobs.at(-1).body.push(lines[i]);
  }

  return jobs.map((job) => ({
    name: job.name,
    line: job.line,
    definesRunner: job.body.some((l) => /^ {4}runs-on:/.test(l)),
    callsReusable: job.body.some((l) => /^ {4}uses:/.test(l)),
    declaresPermissions: job.body.some((l) => /^ {4}permissions:/.test(l)),
  }));
}

const files = workflowFiles();
const all = files.flatMap(([file, source]) =>
  jobsOf(source).map((job) => ({ ...job, file })),
);

// --- the parser must actually parse ----------------------------------------
// Every assertion below is a filter over these two lists, so an empty list is a
// clean report rather than a failure. That is the direction a permissions gate
// fails silently in, so it is pinned first.

test("the sweep sees this repo's workflows and their jobs", () => {
  assert.ok(files.length >= 20, `expected the sweep to see this repo's workflows, saw ${files.length}`);
  assert.ok(all.length >= 40, `expected the sweep to see this repo's jobs, saw ${all.length}`);
  assert.ok(
    all.some((j) => j.file === "monorepo-tests.yml" && j.name === "unit-tests"),
    "the sweep did not find monorepo-tests.yml's unit-tests job, so it is not reading job bodies",
  );
  assert.ok(
    all.some((j) => j.callsReusable && !j.definesRunner),
    "the sweep found no nested reusable-call job, so the call-site assertion below is vacuous",
  );
});

test("topLevelPermissions reads a block without reading a job's", () => {
  assert.equal(
    topLevelPermissions(["on:", "  push:", "permissions:", "  contents: read", "jobs:"].join("\n")),
    "contents: read",
  );
  assert.equal(topLevelPermissions(["permissions: read-all", "jobs:"].join("\n")), "read-all");
  // A job's four-space block must not be mistaken for the workflow's.
  assert.equal(
    topLevelPermissions(["jobs:", "  a:", "    permissions:", "      contents: read"].join("\n")),
    undefined,
  );
});

// --- the sweep -------------------------------------------------------------

test("every workflow declares a top-level permissions block", () => {
  const undeclared = files
    .filter(([, source]) => topLevelPermissions(source) === undefined)
    .map(([file]) => file);

  assert.deepEqual(
    undeclared,
    [],
    "these workflows run at whatever the caller — or the repository default —\n" +
      "happens to grant. The block is a ceiling and can only narrow, so there is no\n" +
      "case where leaving it off is the safer choice:\n  " +
      undeclared.join("\n  "),
  );
});

test("a job that calls a reusable workflow declares its own permissions", () => {
  // A job block REPLACES the workflow default, so a nested call inherits the
  // parent's read-only floor unless it says otherwise — and the resulting 403
  // surfaces inside the CALLED workflow, far from the line that caused it.
  const inherited = all
    .filter((job) => job.callsReusable && !job.definesRunner && !job.declaresPermissions)
    .map((job) => `${job.file}:${job.line} ${job.name}`);

  assert.deepEqual(
    inherited,
    [],
    "these jobs hand the workflow's default grant to a workflow that needs its own\n" +
      "scopes. State the grant at the call site so narrowing the parent cannot\n" +
      "silently cap the child:\n  " +
      inherited.join("\n  "),
  );
});

test("no declared permissions block is empty", () => {
  // `permissions:` with nothing under it parses, and reads as "grant nothing" —
  // which is a valid choice but never an intentional one here, and is what a
  // half-finished edit leaves behind.
  const empty = files
    .filter(([, source]) => topLevelPermissions(source) === "")
    .map(([file]) => file);

  assert.deepEqual(
    empty,
    [],
    "a `permissions:` key with no scopes under it grants nothing at all. Write the\n" +
      "scopes, or remove the key and let the assertion above catch it:\n  " +
      empty.join("\n  "),
  );
});
