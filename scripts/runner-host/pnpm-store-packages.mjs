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
//
// Packages built for another platform are left out too. A lockfile pins every
// platform's native binary (esbuild, rollup, next's swc, turbo, the Prisma
// engines…) and an install on the runner fetches only its own; with them all,
// future-pay's store was 4.4 GB, and a fresh host reads its disk from the
// snapshot at ~116 MiB/s the first time, so every unused byte in it is paid
// for on the first job of every host.
import { readFileSync } from "node:fs";

export const RUNNER_PLATFORM = { os: "linux", cpu: "x64", libc: "glibc" };

// npm's rule for `os`, `cpu` and `libc`: a value is allowed unless the list
// negates it (`!win32`) or lists only other values.
function allows(list, value) {
  if (!list) return true;
  if (list.includes(`!${value}`)) return false;
  const positive = list.filter((v) => !v.startsWith("!"));
  return positive.length === 0 || positive.includes(value);
}

export function storePackages(lockfile, { skipScopes = [], platform = null } = {}) {
  const entries = [];
  let inPackages = false;
  for (const line of lockfile.split("\n")) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (!inPackages) continue;
    if (/^\S/.test(line)) break;
    const m = /^ {2}'?((?:@[^@\s'/]+\/)?[^@\s'/]+)@(\d[^:'\s()]*)'?:\s*$/.exec(line);
    if (m) { entries.push({ spec: `${m[1]}@${m[2]}`, name: m[1] }); continue; }
    if (/^ {2}\S/.test(line)) { entries.push(null); continue; }
    const field = /^ {4}(os|cpu|libc): \[(.*)\]\s*$/.exec(line);
    const current = entries.at(-1);
    if (field && current) current[field[1]] = field[2].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
  }
  const out = new Set();
  for (const e of entries) {
    if (!e || skipScopes.some((s) => e.name.startsWith(`${s}/`))) continue;
    if (platform && !["os", "cpu", "libc"].every((k) => allows(e[k], platform[k]))) continue;
    out.add(e.spec);
  }
  return [...out];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, ...rest] = process.argv.slice(2);
  const skipScopes = rest.flatMap((a, i) => (rest[i - 1] === "--skip-scope" ? [a] : []));
  const platform = rest.includes("--all-platforms") ? null : RUNNER_PLATFORM;
  process.stdout.write(`${storePackages(readFileSync(file, "utf8"), { skipScopes, platform }).join("\n")}\n`);
}
