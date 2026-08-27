import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Every `uses: 12-apps/ci/...@vN` this repo DOCUMENTS must pin the major this
// repo actually supports.
//
// The two drifted apart and nothing noticed (FUT-956). `release-major-tag.yml`
// advanced every live major independently, stopping each before the first
// breaking commit — and since nothing had carried a `!` marker or a
// `BREAKING CHANGE:` footer since `v2` was cut, nothing ever stopped `v1`. It
// was dragged the whole way, so `v1`, `v2` and the newest point tag were ONE
// COMMIT: `@v1` was not the v1 line, it was the current v2 wearing a v1 label,
// and twenty-nine commits reached `@v1` consumers with nothing to review.
//
// The docs split accordingly, and that split is the readable symptom: README.md
// told consumers `@v2` in ten places while CONSUMING.md used `@v1` in twenty.
// Nothing in the repo compared them, so a consumer's pin depended on which page
// they opened — and the consumer that read both ended up on both, which is how
// future-pay came to run nine calls on one major and one on the other.
//
// That is harmless only while the tags are the same commit. The moment a
// breaking change lands, `v1` correctly freezes and `v2` keeps moving, and a
// consumer split across the two is running two engine versions with nothing
// reporting it. So the pin a reader copies is checked against the declaration
// the release workflow reads, in `.github/majors.json` — one source of truth,
// rather than two documents and a tag list that can each be right on their own.
//
// PROSE mentions of `@v1` are deliberately out of scope. The versioning section
// has to be able to say the word while explaining that the tag is frozen, and a
// sweep that could not tell a policy sentence from a copyable pin would make
// documenting the policy impossible. Only a REFERENCE — `12-apps/ci/…@vN` — is
// something a reader pastes into their own workflow.

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const DECLARED = path.join(REPO, ".github/majors.json");

/** Directories with nothing a consumer would copy a pin out of. */
const SKIP = new Set(["node_modules", ".git"]);

/** Every markdown file in the repo. */
function markdownFiles(dir = REPO) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.isFile() && entry.name.endsWith(".md") ? [full] : [];
  });
}

/**
 * Every `12-apps/ci/...@vN` reference in `source`, with its 1-based line.
 *
 * Matches the REFERENCE rather than the line, so an inline mention inside a
 * sentence counts exactly as much as a `uses:` in a fenced block — both are
 * things a reader copies. A bare `@v1` with no path before it does not match,
 * which is what keeps the prose exemption above honest.
 */
export function majorPins(source) {
  const found = [];
  source.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/12-apps\/ci\/[^\s`"']*@(v\d+)\b/g)) {
      found.push({ line: i + 1, ref: m[0], major: m[1] });
    }
  });
  return found;
}

const declared = JSON.parse(readFileSync(DECLARED, "utf8"));

// --- the declaration itself ------------------------------------------------

test("the declaration names exactly one supported major", () => {
  assert.match(
    declared.supported,
    /^v\d+$/,
    "`supported` in .github/majors.json must be a bare major like `v2`",
  );
});

test("a major is supported or frozen, never both", () => {
  // release-major-tag.yml checks frozen FIRST, so a major in both would be
  // silently frozen while this file read as though it were advancing.
  assert.equal(
    Object.keys(declared.frozen ?? {}).includes(declared.supported),
    false,
    `${declared.supported} is both supported and frozen`,
  );
});

test("every frozen major carries a written reason", () => {
  // A label is not an argument. Retiring a major strands whichever consumers
  // pin it, and the next person to read this file needs to know what was
  // decided and why rather than inferring it from a key.
  const unexplained = Object.entries(declared.frozen ?? {})
    .filter(([, why]) => typeof why !== "string" || why.trim().length < 40)
    .map(([tag]) => tag);
  assert.deepEqual(unexplained, []);
});

// --- the detector must actually detect -------------------------------------
// A sweep that stopped recognising a pin would report a clean estate, invite no
// fix, and never be red at any point — the same failure shape as the docs drift
// it exists to catch. These pin it in both directions.

test("majorPins finds a reusable-workflow and an action reference", () => {
  assert.deepEqual(
    majorPins("    uses: 12-apps/ci/.github/workflows/quality.yml@v1\n"),
    [{ line: 1, ref: "12-apps/ci/.github/workflows/quality.yml@v1", major: "v1" }],
  );
  assert.equal(
    majorPins("  - uses: 12-apps/ci/.github/actions/fetch-base@v3\n")[0].major,
    "v3",
  );
});

test("majorPins finds a reference inside prose and inside backticks", () => {
  assert.equal(majorPins("call `12-apps/ci/.github/workflows/cd.yml@v1` here").length, 1);
  assert.equal(majorPins("(`uses: 12-apps/ci/.github/actions/discover@v1`), which").length, 1);
});

test("majorPins finds several references on one line", () => {
  const line = "12-apps/ci/.github/actions/a@v1 and 12-apps/ci/.github/actions/b@v2";
  assert.deepEqual(majorPins(line).map((p) => p.major), ["v1", "v2"]);
});

test("majorPins ignores prose about a tag and other repos' actions", () => {
  const src = [
    "`@v1` and `@v2` freeze rather than advancing across one.",
    "      - uses: actions/checkout@v4",
    "every repo pinned to `@v1` inherits the break",
  ].join("\n");
  assert.deepEqual(majorPins(src), []);
});

// --- the sweep -------------------------------------------------------------

test("every documented pin is on the supported major", () => {
  const offenders = [];

  for (const file of markdownFiles()) {
    const rel = path.relative(REPO, file);
    for (const { line, ref, major } of majorPins(readFileSync(file, "utf8"))) {
      if (major !== declared.supported) offenders.push(`${rel}:${line}  ${ref}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `.github/majors.json says the supported major is \`${declared.supported}\`, ` +
      "but these documented references pin a different one. A reader copies " +
      "whichever page they opened, so a doc on the wrong major puts a consumer " +
      "on a tag this repo may stop advancing:\n  " +
      offenders.join("\n  "),
  );
});

test("the sweep actually reads this repo's documentation", () => {
  // Guards the silent direction: a walk that matched no files, or a detector
  // that recognised nothing, reports zero offenders and passes. The two files
  // named are the ones that disagreed with each other.
  const files = markdownFiles();
  assert.ok(files.length >= 5, `expected the sweep to see the docs, saw ${files.length}`);

  const pinned = files.filter((f) => majorPins(readFileSync(f, "utf8")).length > 0);
  const names = pinned.map((f) => path.relative(REPO, f));
  assert.ok(names.includes("README.md"), `README.md documents no pin; saw ${names}`);
  assert.ok(names.includes("CONSUMING.md"), `CONSUMING.md documents no pin; saw ${names}`);
});

test("the declaration is where release-major-tag.yml reads it from", () => {
  // The two halves of this change are only one source of truth while they read
  // the same path. A moved or renamed file would leave this suite asserting
  // about a document the release workflow no longer consults.
  const workflow = readFileSync(
    path.join(REPO, ".github/workflows/release-major-tag.yml"),
    "utf8",
  );
  assert.match(workflow, /\.github\/majors\.json/);
  assert.ok(statSync(DECLARED).isFile());
});
