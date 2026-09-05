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
// The declaration is a CEILING, not a grant: it cannot give a job anything the
// caller withheld. So adding one can only ever narrow, which is why it is safe
// to require everywhere and why the fix for a consumer that forgets belongs here
// rather than in prose.
//
// (This repo currently disagrees with ITSELF about what happens when a caller
// grants LESS than a workflow declares. README.md says the run is rejected at
// startup; mcp-contract.yml says the scope is simply intersected away. Nothing
// here depends on which is true — every block added was derived from what the
// workflow already ran with — but a caller-side gate cannot be written until
// somebody settles it.)
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
 * A mapping key, tolerant of the shapes YAML allows and a hand-written regex
 * usually forgets: optional quoting, trailing whitespace, and a TRAILING
 * COMMENT.
 *
 * The comment case is not cosmetic. `  deploy:   # the vendor adapter` failed
 * the old `/^ {2}(\w+):\s*$/`, so no job record was created and every following
 * line was appended to the PREVIOUS job's body — moving that job's `uses:` onto
 * a neighbour that has `runs-on:`, which the nested-call assertion then filters
 * out. A reusable-call job with no permissions block passed the gate, one
 * keystroke away in a repo that comments nearly every key.
 */
const KEY = /^(\s*)(?:"([\w.-]+)"|'([\w.-]+)'|([\w.-]+)):[ \t]*(?:#.*)?$/;

/**
 * The jobs of one workflow. Returns `null` when no readable `jobs:` mapping is
 * present — the caller turns that into a failure rather than an empty result,
 * because zero jobs reads as zero violations.
 *
 * The job indent is DISCOVERED from the first key rather than assumed to be
 * two spaces, and `uses:`/`runs-on:`/`permissions:` are read one level deeper —
 * so a `uses:` under `steps:` still cannot make an action step look like a
 * reusable call, and a four-space file is read instead of silently skipped.
 */
function jobsOf(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^jobs:[ \t]*(?:#.*)?$/.test(l));
  if (start === -1) return null;

  let indent = null;
  const jobs = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[^\s#]/.test(lines[i])) break;
    if (lines[i].trim() === "" || /^\s*#/.test(lines[i])) continue;
    const m = KEY.exec(lines[i]);
    const width = m ? m[1].length : null;
    if (m && (indent === null || width === indent)) {
      if (indent === null) indent = width;
      jobs.push({ name: m[2] ?? m[3] ?? m[4], line: i + 1, body: [] });
    } else if (jobs.length > 0) {
      jobs.at(-1).body.push(lines[i]);
    }
  }
  if (jobs.length === 0) return null;

  const at = (key) => new RegExp(`^ {${indent * 2}}${key}:`);
  return jobs.map((job) => {
    const permIdx = job.body.findIndex((l) => at("permissions").test(l));
    // An empty `permissions:` grants NOTHING. On a nested call that caps the
    // callee at nothing, which is the worst outcome this file exists to prevent
    // — so it must not read as "declared".
    const scopes =
      permIdx === -1
        ? []
        : job.body
            .slice(permIdx + 1)
            .filter((l) => l.trim() !== "" && !/^\s*#/.test(l))
            .reduce((acc, l) => {
              const w = l.length - l.trimStart().length;
              if (acc.done || w <= indent * 2) return { ...acc, done: true };
              acc.list.push(l.trim());
              return acc;
            }, { list: [], done: false }).list;
    return {
      name: job.name,
      line: job.line,
      definesRunner: job.body.some((l) => at("runs-on").test(l)),
      callsReusable: job.body.some((l) => at("uses").test(l)),
      declaresPermissions: permIdx !== -1,
      permissionScopes: scopes.length,
    };
  });
}

const files = workflowFiles();
const parsed = files.map(([file, source]) => [file, source, jobsOf(source)]);
const all = parsed
  .filter(([, , jobs]) => jobs)
  .flatMap(([file, , jobs]) => jobs.map((job) => ({ ...job, file })));

// --- the parser must actually parse ----------------------------------------
// Every assertion below is a filter over these two lists, so an empty list is a
// clean report rather than a failure. That is the direction a permissions gate
// fails silently in, so it is pinned first.

test("parses every workflow file", () => {
  // The load-bearing tripwire, and the one the first draft of this file lacked:
  // a file this parser cannot read contributes zero jobs, and zero unscoped jobs
  // reads as a clean estate. An unreadable file has to fail HERE rather than pass
  // silently in the sweeps below.
  const unreadable = parsed.filter(([, , jobs]) => !jobs).map(([file]) => file);
  assert.deepEqual(
    unreadable,
    [],
    "no `jobs:` mapping could be read out of these files, so their jobs are not\n" +
      "being checked at all:\n  " +
      unreadable.join("\n  "),
  );
});

test("the job-key regex survives a trailing comment", () => {
  // The evasion this parser was rewritten for: a comment after the job key made
  // the job invisible AND spliced its body onto the previous job, so a nested
  // reusable call with no permissions block passed the gate.
  const jobs = jobsOf(
    [
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "  deploy:   # the vendor adapter",
      "    uses: ./.github/workflows/x.yml",
    ].join("\n"),
  );
  assert.deepEqual(
    jobs.map((j) => [j.name, j.callsReusable, j.definesRunner]),
    [
      ["build", false, true],
      ["deploy", true, false],
    ],
    "a trailing comment on a job key must not merge two jobs",
  );
  assert.equal(jobsOf("on:\n  push:\n"), null, "a file with no jobs mapping must refuse, not return []");
});

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

test("no job-level permissions block is empty", () => {
  // An empty `permissions:` on a job grants NOTHING — and on a nested call that
  // caps the called workflow at nothing, which is the worst outcome this file's
  // header describes. The file-level check below never looked at job blocks.
  const empty = all
    .filter((job) => job.declaresPermissions && job.permissionScopes === 0)
    .map((job) => `${job.file}:${job.line} ${job.name}`);

  assert.deepEqual(
    empty,
    [],
    "these jobs declare `permissions:` with no scopes under it, which grants nothing\n" +
      "at all — on a `uses:` job it caps the called workflow at nothing:\n  " +
      empty.join("\n  "),
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
