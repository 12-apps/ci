import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Every `ssh` invocation this repo ships MUST set `ServerAliveInterval`.
//
// A deploy runs one ssh session across pull, rollout, healthcheck wait and
// fixture seed, and several of those phases produce no output for minutes.
// Without a keepalive nothing travels the connection meanwhile, something in
// the path reaps it as idle, and the session dies on
// `client_loop: send disconnect: Broken pipe` — exit 255, usually AFTER the
// work it was carrying had already succeeded.
//
// Four failures in 12-apps/future-pay, each the same error preceded by
// silence: 265s, 269s, and 307s. The first two landed in the demo seed and
// were answered three times in the CONSUMER — a timer, then a worker thread,
// then an EAGAIN-tolerant writer, each one making that phase chatter. All
// three were correct and none generalised, because they keep one phase noisy
// and the drop just moves to the next silent one. The third landed between
// the last image pull and the rollout, where no consumer heartbeat reaches.
//
// So the rule is asserted over the text, at the transport, for every call
// site: a keepalive is free on a short command and load-bearing on a long
// one, which makes "all of them" the only threshold with no judgement in it.
// It is also exactly the option a new ssh line gets copied without.

const ROOT = path.join(fileURLToPath(new URL("../../../", import.meta.url)));

/** Files that can contain an ssh invocation: the workflows and the scripts. */
function scanned() {
  const files = [];
  const walk = (dir, exts) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, exts);
      else if (exts.some((e) => entry.endsWith(e))) files.push(full);
    }
  };
  walk(path.join(ROOT, ".github/workflows"), [".yml", ".yaml"]);
  walk(path.join(ROOT, "scripts"), [".sh"]);
  return files;
}

/**
 * Every ssh COMMAND in `source`, as `{ line, text }` with continuations joined.
 *
 * Three things are deliberately not invocations. `ssh-keygen` / `ssh-keyscan` /
 * `sshd` are different programs; an `ssh …` inside a quoted string is a hint
 * printed for a human to copy (`create-server.sh` ends by telling the operator
 * how to connect, and a keepalive there would be noise in a message rather
 * than an option on a session); and a COMMENT is prose. This repo explains
 * itself at length and says the word "ssh" in six comments that describe the
 * very failure this rule prevents — counting those would make the gate
 * unpassable while proving nothing.
 */
export function sshCommands(source) {
  const lines = source.split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*#/.test(lines[i])) continue;
    for (const m of [...lines[i].matchAll(/\bssh\b/g)]) {
      const after = lines[i].slice(m.index + 3);
      if (/^(-keygen|-keyscan|d\b)/.test(after)) continue;
      const before = lines[i].slice(0, m.index);
      // Odd quote count => the token sits inside a string, not at a command
      // position. Cheap, and it is the only in-string case this repo has.
      if ((before.match(/"/g) ?? []).length % 2 === 1) continue;
      if ((before.match(/'/g) ?? []).length % 2 === 1) continue;
      // COMMAND POSITION. `ssh` has to be the thing being run, not a substring
      // of an argument — this file is called `ssh-keepalive.test.mjs`, so the
      // step that runs it names a path containing the token and would
      // otherwise count as an invocation with no keepalive. (Found exactly
      // that way, on the run right after this gate was wired into self-test.)
      if (!/(^|[|&;(){]|\b(if|then|do|else)\s)\s*$/.test(before)) continue;
      // Join `\`-continued lines so options on the next physical line count.
      let text = lines[i];
      let j = i;
      while (/\\\s*$/.test(lines[j]) && j + 1 < lines.length) {
        j += 1;
        text += " " + lines[j].trim();
      }
      found.push({ line: i + 1, text });
    }
  }
  return found;
}

test("every ssh invocation sets a keepalive", () => {
  const naked = [];
  let total = 0;
  for (const file of scanned()) {
    for (const cmd of sshCommands(readFileSync(file, "utf8"))) {
      total += 1;
      if (!/ServerAliveInterval=/.test(cmd.text)) {
        naked.push(`${path.relative(ROOT, file)}:${cmd.line}  ${cmd.text.trim().slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(naked, [], `ssh invocation(s) with no ServerAliveInterval:\n  ${naked.join("\n  ")}`);
  // A scan that found nothing would report nothing missing — the failure mode
  // this whole file exists to make impossible.
  assert.ok(total >= 5, `only ${total} ssh invocation(s) found — the scan has stopped seeing them`);
});

test("a keepalive-less invocation is detected, and a printed hint is not", () => {
  // Mutation cover for both halves of the rule, so neither can rot into a
  // matcher that finds everything or one that finds nothing.
  const naked = sshCommands('  ssh -i /k -o LogLevel=ERROR root@host "uptime"');
  assert.equal(naked.length, 1);
  assert.ok(!/ServerAliveInterval=/.test(naked[0].text));

  const continued = sshCommands('} | ssh -i /k \\\n      -o ServerAliveInterval=30 \\\n      root@h');
  assert.equal(continued.length, 1);
  assert.ok(/ServerAliveInterval=/.test(continued[0].text), "continuation lines must be joined");

  assert.equal(sshCommands('echo "  ssh -i $KEY root@$IP"').length, 0, "a printed hint is not an invocation");
  assert.equal(sshCommands("ssh-keygen -t ed25519").length, 0, "ssh-keygen is a different program");
  // Found by this gate on its own first run: six comments here discuss ssh,
  // including the one explaining this rule.
  assert.equal(sshCommands("  # rides one ssh session, and it goes quiet").length, 0, "a comment is prose");
  assert.equal(
    sshCommands("        run: node --test .github/workflows/__tests__/ssh-keepalive.test.mjs").length,
    0,
    "a PATH containing the token is not an invocation",
  );
  assert.equal(sshCommands('    if ssh -o ServerAliveInterval=30 root@h "true"; then').length, 1);
});
