#!/usr/bin/env node
// The fleet's live deploy settings, as the environment deploy.sh reads.
//
// deploy.sh takes every setting from its environment, with defaults. A
// redeploy that only wants a NEW IMAGE must therefore pass the settings the
// fleet runs with today, or the defaults come back: DAILY_BUDGET 10 when the
// fleet runs on 20, the pnpm store mounted again when it is off, a new webhook
// secret. Those settings live in two places, both read here:
//   - the scaler Lambda's environment (budget, regions, types, caps, strategy),
//     including WEBHOOK_SECRET, which is written to a file and never printed;
//   - the launch template's user data (idle minutes, the pnpm store switch).
//
//   node live-settings.mjs <lambda-env.json> <user-data.txt> <secret-file>
//
// Prints `export NAME='value'` lines for `eval`.
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";

// Lambda variable → deploy.sh variable. Everything deploy.sh would otherwise
// default, and nothing it derives itself (LAUNCH_TEMPLATE, MODE).
const FROM_LAMBDA = {
  REGIONS: "REGIONS",
  DAILY_BUDGET: "DAILY_BUDGET",
  DEGRADED_MAX_HOSTS: "DEGRADED_MAX_HOSTS",
  BUDGET_UTC_OFFSET: "BUDGET_UTC_OFFSET",
  ALERT_PARAMETER: "ALERT_PARAMETER",
  SPOT_STRATEGY: "SPOT_STRATEGY",
  INSTANCE_TYPES: "INSTANCE_TYPES",
  MAX_HOSTS: "MAX_HOSTS",
  SLOTS_PER_HOST: "SLOTS_PER_HOST",
  TOKEN_PARAMETER: "TOKEN_PARAMETER",
  REPOSITORY: "REPOSITORY",
  RUNNER_LABEL: "RUNNER_LABEL",
};

const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

/**
 * @param {Record<string, string>} lambdaEnv the function's Environment.Variables
 * @param {string} userData the launch template's decoded user data
 * @returns {{ env: Record<string, string>, secret: string | null }}
 */
export function liveSettings(lambdaEnv, userData) {
  const env = {};
  for (const [from, to] of Object.entries(FROM_LAMBDA)) {
    if (lambdaEnv[from] !== undefined && lambdaEnv[from] !== "") env[to] = String(lambdaEnv[from]);
  }
  const idle = /CI_RUNNER_IDLE_MINUTES=(\d+)/.exec(userData);
  if (idle) env.IDLE_MINUTES = idle[1];
  // deploy.sh writes the blanking line only when PNPM_STORE=off.
  env.PNPM_STORE = /s\/\^CI_RUNNER_PNPM_STORE=\.\*\/CI_RUNNER_PNPM_STORE=\//.test(userData) ? "off" : "on";
  const missing = ["REGIONS", "DAILY_BUDGET", "RUNNER_LABEL", "REPOSITORY"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`the live fleet does not say ${missing.join(", ")}; refusing to redeploy on defaults`);
  return { env, secret: lambdaEnv.WEBHOOK_SECRET || null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [envFile, userDataFile, secretFile] = process.argv.slice(2);
  const { env, secret } = liveSettings(JSON.parse(readFileSync(envFile, "utf8")), readFileSync(userDataFile, "utf8"));
  if (!secret) throw new Error("the scaler has no WEBHOOK_SECRET; a redeploy would rotate the webhook's secret");
  writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
  for (const [k, v] of Object.entries(env)) process.stdout.write(`export ${k}=${quote(v)}\n`);
}
