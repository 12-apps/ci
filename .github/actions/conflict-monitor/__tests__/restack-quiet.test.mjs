import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { ConfigError, parseRestackConfig } from "../lib/config.mjs";
import { BOT } from "../lib/restack.mjs";
import { commitStamp, quietReason } from "../restack.mjs";

// `restack.quietMinutes`: the bot leaves a draft alone while its head commit is
// younger than that, so it never pushes a merge under an author who is in the
// middle of a fix round.

const NOW = 1_800_000_000;
const restack = (quietMinutes) => ({ push: true, ignoreHeads: [], command: null, quietMinutes });
const minutesAgo = (m) => NOW - m * 60;

test("a draft pushed to inside the quiet period is left alone, with the reason", () => {
  const why = quietReason({ draft: true }, { restack: restack(15), headTime: minutesAgo(4), now: NOW });
  assert.match(why, /a draft pushed to 4 min ago \(quiet for 15\)/);
});

test("a draft whose head is older than the quiet period is re-stacked", () => {
  assert.equal(quietReason({ draft: true }, { restack: restack(15), headTime: minutesAgo(15), now: NOW }), null);
  assert.equal(quietReason({ draft: true }, { restack: restack(15), headTime: minutesAgo(90), now: NOW }), null);
});

test("a ready pull request is never held back, however fresh its head", () => {
  assert.equal(quietReason({ draft: false }, { restack: restack(15), headTime: minutesAgo(1), now: NOW }), null);
});

test("zero, or a config written before the key existed, turns the quiet period off", () => {
  assert.equal(quietReason({ draft: true }, { restack: restack(0), headTime: minutesAgo(1), now: NOW }), null);
  assert.equal(quietReason({ draft: true }, { restack: { push: true, ignoreHeads: [] }, headTime: minutesAgo(1), now: NOW }), null);
});

test("a head whose time could not be read is not held back", () => {
  assert.equal(quietReason({ draft: true }, { restack: restack(15), headTime: Number.NaN, now: NOW }), null);
});

test("a head committed in the future (a skewed clock) is held, never a negative age", () => {
  assert.match(quietReason({ draft: true }, { restack: restack(15), headTime: NOW + 120, now: NOW }), /0 min ago/);
});

test("a head the bot itself wrote is never held: it is nobody's fix round", () => {
  assert.equal(quietReason({ draft: true }, { restack: restack(15), headTime: minutesAgo(1), headEmail: BOT.email, now: NOW }), null);
  assert.match(quietReason({ draft: true }, { restack: restack(15), headTime: minutesAgo(1), headEmail: "a@b.c", now: NOW }), /quiet for 15/);
});

test("commitStamp reads a commit's committer time and e-mail, and answers NaN for what is not one", () => {
  const dir = mkdtempSync(join(tmpdir(), "restack-quiet-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args) =>
    spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_COMMITTER_DATE: `${NOW} +0000`, GIT_AUTHOR_DATE: `${NOW} +0000` },
    });
  run("init", "-q", "-b", "main");
  run("commit", "-q", "--allow-empty", "-m", "one");
  const sha = run("rev-parse", "HEAD").stdout.trim();
  assert.deepEqual(commitStamp(sha, dir), { headTime: NOW, headEmail: "t@t" });
  assert.ok(Number.isNaN(commitStamp("0".repeat(40), dir).headTime));
});

test("the config takes quietMinutes, defaults it to zero and refuses what is not minutes", () => {
  assert.equal(parseRestackConfig({ quietMinutes: 15 }, "restack").quietMinutes, 15);
  assert.equal(parseRestackConfig({}, "restack").quietMinutes, 0);
  for (const bad of [-1, "15", Number.NaN, true]) {
    assert.throws(() => parseRestackConfig({ quietMinutes: bad }, "restack"), ConfigError);
  }
});
