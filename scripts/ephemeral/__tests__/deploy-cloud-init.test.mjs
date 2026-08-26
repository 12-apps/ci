import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// What `deploy-cloud-init.sh` actually SHIPS to a droplet.
//
// This script is the one-time provision path: `do-provision@v1` runs it, and
// `deploy-digitalocean.yml`'s provision job is the only thing that reaches it.
// Everything it produces is a single cloud-init document, and the failure modes
// are all silent from the caller's side — the API accepts any user-data at all,
// the droplet boots, and the run reports success either way. So the document is
// rendered here (`--print-user-data`: no token, no API call, no droplet) and
// asserted on directly.
//
// Three properties, each of which has been wrong:
//
//  1. THE DOCUMENT PARSES. `main`'s version wrote /app/.env with a heredoc body
//     at column 0 inside a `- |` block scalar. That escapes the scalar and the
//     whole user-data is invalid YAML — cloud-init runs NOTHING, the droplet
//     comes up bare, and nothing on any surface the caller can see says so.
//     Found by rendering the old script and parsing the result.
//
//  2. THE METADATA RULE IS FIRST. Whatever reaches this box does so inside
//     user-data (the provider's service token, the clone URL's GITHUB_TOKEN),
//     and the metadata endpoint serves user-data to ANY process on the droplet.
//     The egress drop has to land before the token is written, so its position
//     in the list is the security property, not merely its presence.
//
//  3. NO SECRET IS INTERPOLATED THAT DOES NOT HAVE TO BE. The service token is
//     unavoidable — user-data is the only channel a fresh droplet has, which is
//     what (2) exists to contain. An OAuth secret is NOT: it used to be
//     interpolated here for a .env that no longer exists.
//
// Dependency-free (node: builtins, no YAML parser) because it runs in
// self-test.yml, which deliberately has no install step. The parse check below
// is therefore targeted at failure mode (1) rather than being a general YAML
// validator — that is the shape of the risk, since this document is generated
// and well-formed by construction except where a heredoc breaks out of a
// scalar.

const ROOT = path.join(fileURLToPath(new URL("../../../", import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts/ephemeral/deploy-cloud-init.sh");

/** Render the user-data for one provider. Creates nothing and calls no API. */
export function render(provider, token = "") {
  return execFileSync("bash", [SCRIPT, "--print-user-data", "-n", "t", "-b", "main"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, DO_API_TOKEN: "", SECRETS_PROVIDER: provider, SECRETS_TOKEN: token },
  });
}

/**
 * Lines that sit at column 0 while not being a top-level key. In a cloud-config
 * document every such line is content that has escaped its block scalar, which
 * is exactly failure mode (1).
 */
export function escapedLines(doc) {
  return doc
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /^\S/.test(line))
    .filter(({ line }) => !/^#cloud-config\s*$/.test(line))
    .filter(({ line }) => !/^[A-Za-z_][A-Za-z0-9_-]*:/.test(line));
}

/** The `runcmd:` entries, in order. */
export function runcmd(doc) {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => /^runcmd:\s*$/.test(l));
  assert.notEqual(start, -1, "the rendered user-data has no runcmd: block");
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break;
    const entry = /^ {2}- (.*)$/.exec(lines[i]);
    if (entry) out.push(entry[1]);
  }
  return out;
}

const MODES = [
  { provider: "doppler", token: "dp.st.TESTTOKEN" },
  { provider: "none", token: "" },
];

// --- the detector must actually detect -------------------------------------
// A checker that stopped recognising an escaped line would report a clean
// document forever, which is the same silence the bug itself had.

test("escapedLines flags a heredoc body that broke out of a block scalar", () => {
  const broken = ["#cloud-config", "runcmd:", "  - |", "    cat > /app/.env << EOF", "KEY=value", "EOF"].join("\n");
  assert.deepEqual(escapedLines(broken).map((e) => e.line), ["KEY=value", "EOF"]);

  const fixed = ["#cloud-config", "runcmd:", "  - |", "    cat > /app/.env << EOF", "    KEY=value", "    EOF"].join("\n");
  assert.deepEqual(escapedLines(fixed), []);
});

// --- the properties --------------------------------------------------------

for (const { provider, token } of MODES) {
  test(`[${provider}] the rendered user-data has no line outside its block`, () => {
    const offenders = escapedLines(render(provider, token)).map((e) => `${e.n}: ${e.line}`);
    assert.deepEqual(
      offenders,
      [],
      "these lines sit at column 0 without being a top-level key, so they have escaped\n" +
        "their block scalar and the whole document is invalid YAML. cloud-init then runs\n" +
        "nothing and the droplet comes up bare, silently:\n  " +
        offenders.join("\n  "),
    );
  });

  test(`[${provider}] non-root egress to the metadata endpoint is dropped first`, () => {
    const cmds = runcmd(render(provider, token));
    assert.match(
      cmds[0],
      /^iptables -A OUTPUT -d 169\.254\.169\.254\/32 .*--uid-owner 0 -j DROP/,
      `the first runcmd must drop non-root egress to the metadata endpoint, because\n` +
        `user-data is served from there to any process on the box. Found: ${cmds[0]}`,
    );
    assert.ok(
      cmds.some((c) => /netfilter-persistent save/.test(c)),
      "the rule is not persisted, so a reboot restores non-root access to user-data",
    );
  });

  test(`[${provider}] no OAuth credential is interpolated into user-data`, () => {
    const doc = render(provider, token);
    assert.doesNotMatch(
      doc,
      /GOOGLE_CLIENT_(ID|SECRET)/,
      "an OAuth credential is back in user-data, which the metadata endpoint serves to\n" +
        "every process on the droplet. It belongs in the secrets provider's config.",
    );
  });
}

test("[doppler] secrets are injected at container start, never written to disk", () => {
  const doc = render("doppler", "dp.st.TESTTOKEN");
  const cmds = runcmd(doc);
  assert.equal(
    cmds.filter((c) => /docker compose/.test(c)).every((c) => /doppler run --/.test(c)),
    true,
    "a compose invocation runs outside the provider, so it would start with no app secrets",
  );
  assert.doesNotMatch(doc, /\/app\/\.env/, "a secret-bearing .env is being written to the droplet again");
  assert.match(doc, /chmod 600 \/root\/\.secrets-token/, "the service token is not root-only on disk");
});

test("[none] generated secrets never cross into user-data, and land root-only", () => {
  const doc = render("none", "");
  // The value must be produced ON the box: an unescaped $(openssl …) would be
  // expanded locally and the literal secret shipped inside user-data.
  assert.match(doc, /POSTGRES_PASSWORD=app_secret_\$\(openssl rand -hex 8\)/);
  assert.match(doc, /AUTH_SECRET=\$\(openssl rand -hex 32\)/);
  assert.match(doc, /chmod 600 \/app\/\.env/, "the generated .env is not root-only");
  assert.doesNotMatch(doc, /dp\.st\./, "a service token leaked into the unmanaged mode's user-data");
});

test("an unknown provider is refused rather than silently ignored", () => {
  assert.throws(
    () => render("vault", "x"),
    /status 1|Command failed/,
    "an unrecognised SECRETS_PROVIDER must fail, not fall through to a droplet with no secrets",
  );
});

test("do-provision exposes no input that can only be used unsafely", () => {
  const action = readFileSync(path.join(ROOT, ".github/actions/do-provision/action.yml"), "utf8");
  // Only the `inputs:` block matters — the prose below it explains the removal
  // and must stay free to name what it removed.
  const inputs = /^inputs:\s*$([\s\S]*?)^\S/m.exec(action);
  assert.ok(inputs, "do-provision declares no inputs block");
  assert.doesNotMatch(
    inputs[1],
    /google_client_secret/,
    "google_client_secret is back. Its only path to the droplet is cloud-init user-data,\n" +
      "which the metadata endpoint serves to every process on the box — an input that can\n" +
      "only be used unsafely should not exist.",
  );
  assert.match(inputs[1], /^ {2}secrets_provider:/m, "the secrets provider input is gone");
});
