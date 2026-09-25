#!/usr/bin/env node
// Every registry package a pnpm lockfile pins, one `name@version` per line:
// the list warm-pnpm-store.sh feeds `pnpm store add`.
//
//   node pnpm-store-packages.mjs pnpm-lock.yaml [--skip-scope @12-apps] > packages.txt
//
// Only plain registry versions are listed; git, file and link dependencies
// resolve at install time either way. A skipped scope is for packages that
// need a credential to fetch: the image carries none, so those stay with the
// job, which has its own.
import { readFileSync } from "node:fs";

export function storePackages(lockfile, { skipScopes = [] } = {}) {
  const out = new Set();
  let inPackages = false;
  for (const line of lockfile.split("\n")) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (inPackages && /^\S/.test(line)) break;
    const m = inPackages && /^ {2}'?((?:@[^@\s'/]+\/)?[^@\s'/]+)@(\d[^:'\s()]*)'?:\s*$/.exec(line);
    if (m && !skipScopes.some((s) => m[1].startsWith(`${s}/`))) out.add(`${m[1]}@${m[2]}`);
  }
  return [...out];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, ...rest] = process.argv.slice(2);
  const skipScopes = rest.flatMap((a, i) => (rest[i - 1] === "--skip-scope" ? [a] : []));
  process.stdout.write(`${storePackages(readFileSync(file, "utf8"), { skipScopes }).join("\n")}\n`);
}
