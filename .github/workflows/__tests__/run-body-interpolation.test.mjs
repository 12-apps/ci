import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// No `run:` script may interpolate a secret, or an attacker-influenced GitHub
// context, into its own source.
//
// A `${{ … }}` expression is not a shell variable. It is substituted as TEXT
// into the script before bash ever sees the line, so the VALUE becomes part of
// the program. Two things follow, and this repo has had both:
//
//   1. A credential written into a command line is a credential in an argument
//      list. `deploy-digitalocean.yml` passed GITHUB_TOKEN and DOPPLER_TOKEN
//      positionally to `ssh … 'bash -s' -- "$TOKEN" …`, which put both in the
//      REMOTE host's process table — readable by any local user through `ps`
//      for the life of the session. The design goal stated in that block (no
//      secret-bearing `.env` on the droplet) held; the tokens simply took a
//      different route to the same box.
//
//   2. A value containing a quote stops being data. `deploy-cloudflare.yml`
//      tested `[ -z "${{ secrets.CLOUDFLARE_API_TOKEN }}" ]` — a token with an
//      apostrophe in it turns that presence check into a syntax error, and a
//      token chosen less kindly turns it into a command.
//
// `env:` closes both. The runner puts the value in the process environment and
// the script reads `"$NAME"`, so it is data on every path — never argv, never
// program text. It is also the only form the runner's log masking can rely on.
//
// SCOPE, and why it is not "no expressions in run: at all": a reusable
// workflow's `inputs.*` are how a consumer passes it a COMMAND to run
// (`pre-command`, `build-command`, `retry-gate-command`). Those are meant to be
// program text — that is the whole feature — and twenty-seven of them are load-
// bearing here. What is asserted instead is the set that is either a credential
// or writable by someone who is not the consumer: `secrets.*`, and the
// `github.*` contexts carrying user-supplied strings.
//
// Dependency-free on purpose (node: builtins, raw-text scan rather than a YAML
// parse), matching the other tests in this folder: they run in self-test.yml's
// `action-scripts` job, which deliberately has no install step.

// …/.github/workflows/__tests__/ -> the repo root, three levels up.
const ROOT = path.join(fileURLToPath(new URL("../../../", import.meta.url)));

/**
 * Anything that must not be pasted into a script body.
 *
 * `github.actor`, `github.head_ref` and everything under `github.event.` are
 * the classic script-injection carriers: a branch name, a PR title or an issue
 * body is written by whoever opened it, and lands here as source.
 */
const FORBIDDEN =
  /\$\{\{\s*(secrets\.[A-Za-z0-9_]+|github\.(?:event\.[A-Za-z0-9_.]+|actor|actor_id|head_ref|triggering_actor))/;

/** Every workflow and composite action in the repo, as [relative path, source]. */
function sourceFiles() {
  const out = [];
  const wf = path.join(ROOT, ".github/workflows");
  for (const f of readdirSync(wf).filter((f) => /\.ya?ml$/.test(f))) {
    out.push([`.github/workflows/${f}`, readFileSync(path.join(wf, f), "utf8")]);
  }
  const actions = path.join(ROOT, ".github/actions");
  for (const dir of readdirSync(actions, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of ["action.yml", "action.yaml"]) {
      const p = path.join(actions, dir.name, f);
      try {
        out.push([`.github/actions/${dir.name}/${f}`, readFileSync(p, "utf8")]);
      } catch {
        /* the other extension */
      }
    }
  }
  return out;
}

/**
 * Every `run:` script in one file, as {line, body}.
 *
 * A block scalar's body is the run-on lines indented deeper than the `run:` key
 * itself; an inline `run: cmd` is its own single-line body. Read from raw text
 * rather than a YAML parse — see the note at the top of the file — so the
 * indentation rule is the parser.
 */
export function runBodies(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    // `script:` too — actions/github-script takes a JS block scalar under
    // `with:`, and an expression pasted into it is the same class of defect as
    // one pasted into a shell body. This repo has two such steps.
    const m = /^(\s*(?:-\s+)?)(run|script):(.*)$/.exec(lines[i]);
    if (!m) continue;
    // The indent is the column of the KEY, never of the leading dash. On
    // `      - run: |` the dash sits at 6 and the key at 8, and sibling keys of
    // the step (`env:`, `with:`) sit at 8 too — so measuring from the dash made
    // the body scan swallow the step's own `env:` block, and the test then
    // flagged the exact remediation its failure message prescribes.
    const indent = m[1].length;
    const inline = m[3].trim();
    if (inline && !/^[|>]/.test(inline)) {
      found.push({ line: i + 1, body: inline });
      continue;
    }
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === "") {
        body.push(lines[j]);
        continue;
      }
      const ind = lines[j].length - lines[j].trimStart().length;
      if (ind <= indent) break;
      body.push(lines[j]);
    }
    found.push({ line: i + 1, body: body.join("\n") });
  }
  return found;
}

const files = sourceFiles();
const scripts = files.flatMap(([file, source]) =>
  runBodies(source).map((r) => ({ ...r, file })),
);

// --- the parser must actually parse ----------------------------------------
// The assertion below is a filter over `scripts`. An empty list — a parser that
// stopped finding run: blocks — reports a clean estate, which is the direction
// this kind of gate fails silently in.

test("the sweep sees this repo's run: scripts", () => {
  assert.ok(files.length >= 20, `expected to see this repo's yaml, saw ${files.length}`);
  assert.ok(scripts.length >= 50, `expected to see this repo's run: blocks, saw ${scripts.length}`);
  assert.ok(
    scripts.some((s) => s.file.endsWith("deploy-digitalocean.yml") && /docker login ghcr\.io/.test(s.body)),
    "the sweep is not reading block-scalar bodies — it missed the ssh redeploy script",
  );
  assert.ok(
    scripts.some((s) => /\$\{\{\s*inputs\./.test(s.body)),
    "the sweep found no expression at all in any run: body, so the match below is vacuous",
  );
});

test("runBodies reads a block scalar and stops at the next key", () => {
  const src = [
    "    steps:",
    "      - name: a",
    "        run: |",
    "          echo one",
    "          echo two",
    "      - name: b",
    "        run: echo inline",
  ].join("\n");
  const got = runBodies(src);
  assert.equal(got.length, 2);
  assert.equal(got[0].body, "          echo one\n          echo two");
  assert.equal(got[1].body, "echo inline");
});

test("FORBIDDEN matches a secret and an event context, not a plain input", () => {
  assert.ok(FORBIDDEN.test('echo "${{ secrets.NPM_TOKEN }}"'));
  assert.ok(FORBIDDEN.test("git checkout ${{ github.head_ref }}"));
  assert.ok(FORBIDDEN.test("echo ${{ github.event.pull_request.title }}"));
  assert.ok(!FORBIDDEN.test("${{ inputs.build-command }}"));
  assert.ok(!FORBIDDEN.test("${{ github.sha }}"));
});

// --- the sweep -------------------------------------------------------------

test("no run: script interpolates a secret or an attacker-writable context", () => {
  const offenders = scripts
    .filter((s) => FORBIDDEN.test(s.body))
    .map((s) => `${s.file}:${s.line} -> ${FORBIDDEN.exec(s.body)[0]}`);

  assert.deepEqual(
    offenders,
    [],
    "pass these through `env:` and read them as \"$NAME\" instead. An expression is\n" +
      "substituted into the script as TEXT, so the value becomes program — which is\n" +
      "how a token reaches a process argument list, and how a quote in a value\n" +
      "reaches the parser:\n  " +
      offenders.join("\n  "),
  );
});

/**
 * Does this shell body run `ssh` with arguments handed to the REMOTE command?
 *
 * Written against the shapes, not against one spelling. The first version
 * matched `'bash -s' --` literally, and five realistic rewrites of the very line
 * this repo deleted walked straight past it — `bash -s --` unquoted, `'bash -se'`,
 * `'bash' -s`, `sh -s`, and the deleted line with the `--` simply removed.
 *
 * Line continuations are folded first, because the original was written across
 * seven of them.
 */
export function sshArgvRisk(body) {
  const flat = body.replace(/\\\n\s*/g, " ");
  return flat
    .split("\n")
    .filter((l) => /(^|[\s;|&(])ssh\s/.test(l))
    .some(
      (l) =>
        // an explicit `--` separator, whatever the remote command is quoted like
        /\s--\s+\S/.test(l) ||
        // or an argument after a stdin-reading shell (`-s`), which is the same
        // thing without the separator
        /\s-s\w*\b[^|]*?["']?\$/.test(l),
    );
}

test("no ssh invocation passes an expression as a positional argument", () => {
  // The specific shape the rule above generalises: `ssh host 'bash -s' -- "$X"`
  // puts X in the REMOTE process table. Secrets belong on that script's stdin.
  const offenders = scripts
    .filter((s) => sshArgvRisk(s.body))
    .map((s) => `${s.file}:${s.line}`);

  assert.deepEqual(
    offenders,
    [],
    "`bash -s --` hands its arguments to the remote host's process list, where any\n" +
      "local user can read them with `ps`. The script is already the remote stdin —\n" +
      "write the values onto it as assignments instead:\n  " +
      offenders.join("\n  "),
  );
});
