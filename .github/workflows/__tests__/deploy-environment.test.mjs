// A consumer can deploy more than one droplet (qa, prod) by naming the GitHub
// Environment whose DEPLOY_HOST / DOPPLER_TOKEN / DO_SSH_PRIVATE_KEY_B the
// redeploy reads. Empty keeps the old repository-level behaviour.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const read = (name) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
const job = (text, name) => text.match(new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [a-z][\\w-]*:\\n|$)`))?.[0] ?? "";

test("the DigitalOcean redeploy binds to the environment it is given, empty by default", () => {
  const adapter = read("deploy-digitalocean.yml");
  assert.match(adapter, /\n      environment:\n        type: string\n        required: false\n        default: ""/);
  assert.match(job(adapter, "deploy"), /\n    environment: \$\{\{ inputs\.environment \}\}\n/);
  assert.match(job(adapter, "trigger-post-cd"), /DEPLOY_ENVIRONMENT: \$\{\{ inputs\.environment \}\}/);
});

test("cd.yml passes the environment through and queues each environment apart", () => {
  const cd = read("cd.yml");
  const digitalocean = job(cd, "digitalocean");
  assert.match(digitalocean, /environment: \$\{\{ inputs\.environment \}\}/);
  assert.match(digitalocean, /group: deploy-digitalocean\$\{\{ inputs\.environment && format\('-\{0\}', inputs\.environment\) \|\| '' \}\}/);
});
