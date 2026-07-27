#!/usr/bin/env node
/**
 * Central MCP store-compliance gate.
 *
 * Validates a consuming repo's GENERATED MCP tool manifest against the rules
 * both assistant directories enforce at review time, so a non-compliant tool
 * cannot land in any org repo. The ruleset lives here, not in the consumer, so
 * updating it updates every repo on its next CI run.
 *
 * What it enforces, and why:
 *
 * - Anthropic Software Directory Policy requires a human-readable `title` plus
 *   the applicable behavior hint on EVERY tool; the hints drive auto-permissions
 *   (read-only tools may run without per-call confirmation).
 * - The Apps SDK guidelines prohibit collecting, soliciting, or processing
 *   payment-card data, government identifiers, API keys, and passwords, and
 *   require precise location to arrive by a client side channel rather than a
 *   tool argument. Missing annotations are called out as a frequent rejection.
 * - Both reject tool descriptions that steer the model rather than describe the
 *   tool.
 *
 * This is a FLOOR, not a ceiling: a repo is free to enforce more in its own
 * `mcp:lint`. Genuine exceptions are declared per repo in
 * `mcp-store-exceptions.json` with a reason, mirroring `rbac-exclusions.json`.
 *
 * Zero dependencies on purpose — it runs on the runner's node with no install.
 */

import { readFileSync, existsSync } from "node:fs";

const [, , manifestPath, exceptionsPath] = process.argv;

if (!manifestPath) {
  console.error("usage: check-store-compliance.mjs <manifest.json> [exceptions.json]");
  process.exit(2);
}

/**
 * Word-level matching, deliberately fail-closed.
 *
 * Field names are split on camelCase and separators first, so `verificationToken`
 * and `api_key` are both caught while `tokenization` (a capability enum, one
 * word) is not. A false positive costs one documented line in
 * `mcp-store-exceptions.json`; a missed credential costs a review rejection or
 * a leak, so the bias is toward flagging.
 */
const RESTRICTED_WORDS = new Set([
  "token", "secret", "password", "passwd", "apikey", "authorization", "auth",
  "credential", "credentials", "privatekey", "taxid", "cnpj", "cpf", "ssn",
  "pan", "cvv", "cvc", "iban", "sortcode", "cardnumber", "cardmeta",
]);

/** Precise-location fields that must come from a client side channel instead. */
const LOCATION_WORDS = new Set([
  "lat", "lng", "latitude", "longitude", "geo", "coord", "coords",
  "cep", "zip", "zipcode", "postalcode", "addressline", "address",
]);

/** `addressLine1` → ["address", "line1"]; `api_key` → ["api", "key"]. */
function wordsOf(field) {
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

/** True when a field name carries a restricted or precise-location word. */
function isSensitiveField(field) {
  const words = wordsOf(field);
  const joined = words.join("");
  if (RESTRICTED_WORDS.has(joined) || LOCATION_WORDS.has(joined)) return true;
  // Adjacent pairs catch the split forms: api+key, private+key, tax+id, card+number.
  for (let i = 0; i < words.length; i += 1) {
    if (RESTRICTED_WORDS.has(words[i]) || LOCATION_WORDS.has(words[i])) return true;
    const pair = `${words[i]}${words[i + 1] ?? ""}`;
    if (RESTRICTED_WORDS.has(pair) || LOCATION_WORDS.has(pair)) return true;
  }
  return false;
}

/** Description patterns both directories treat as prompt injection. */
const INJECTION_PATTERNS = [
  { re: /ignore\s+(all\s+)?(previous|prior|above)/i, what: "tells the model to ignore prior instructions" },
  { re: /\bsystem\s+prompt\b/i, what: "references the system prompt" },
  { re: /\byou\s+(must|should)\s+(always\s+)?(call|use|invoke)\b/i, what: "directs the model to call tools" },
  { re: /\b(do\s+not|never|don't)\s+(call|use|invoke)\s+(any\s+)?other\b/i, what: "discourages other tools" },
  { re: /\bfetch\s+(instructions|rules)\s+from\b/i, what: "pulls behavior from an external source" },
  { re: /[A-Za-z0-9+/]{120,}={0,2}/, what: "contains an encoded/obfuscated blob" },
];

const problems = [];
const note = (msg) => problems.push(msg);

if (!existsSync(manifestPath)) {
  console.log(`::notice::no MCP manifest at ${manifestPath} — skipping store-compliance gate`);
  process.exit(0);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(`::error::cannot parse ${manifestPath}: ${error.message}`);
  process.exit(1);
}

const tools = Array.isArray(manifest?.tools) ? manifest.tools : null;
if (!tools) {
  console.error(`::error::${manifestPath} has no "tools" array — not an MCP tool manifest`);
  process.exit(1);
}

/** Per-repo declared exceptions: { "<tool>": { "input": [...], "output": [...], "reason": "..." } }. */
let exceptions = {};
if (exceptionsPath && existsSync(exceptionsPath)) {
  try {
    exceptions = JSON.parse(readFileSync(exceptionsPath, "utf8"));
  } catch (error) {
    console.error(`::error::cannot parse ${exceptionsPath}: ${error.message}`);
    process.exit(1);
  }
  // `_`-prefixed keys are documentation, not entries — JSON has no comments.
  for (const key of Object.keys(exceptions)) {
    if (key.startsWith("_")) delete exceptions[key];
  }
  for (const [tool, entry] of Object.entries(exceptions)) {
    if (!entry?.reason || !String(entry.reason).trim()) {
      note(`${exceptionsPath}: exception for "${tool}" has no reason`);
    }
  }
}

const allowed = (toolName, kind) => new Set(exceptions?.[toolName]?.[kind] ?? []);

/**
 * Runtime field paths — the dotted paths that address a value, descending
 * through `items`/`anyOf`/`oneOf`/`allOf` without adding a segment so an array
 * of rows reads as `data.taxId`, matching how a redaction list is written.
 */
function fieldPaths(schema, path = []) {
  if (Array.isArray(schema)) return schema.flatMap((entry) => fieldPaths(entry, path));
  if (!schema || typeof schema !== "object") return [];

  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const fromProps = Object.entries(props).flatMap(([field, child]) => {
    const next = [...path, field];
    return [next.join("."), ...fieldPaths(child, next)];
  });
  const fromStructure = ["items", "anyOf", "oneOf", "allOf"].flatMap((keyword) =>
    fieldPaths(schema[keyword], path),
  );
  return [...fromProps, ...fromStructure];
}

const leafOf = (path) => path.split(".").at(-1) ?? "";
const sensitive = (field) => isSensitiveField(field);

for (const tool of tools) {
  const name = tool?.name;
  if (typeof name !== "string" || !name.trim()) {
    note("a tool has no name");
    continue;
  }

  // ── Naming and description ────────────────────────────────────────────────
  if (name.length > 64) {
    note(`${name}: tool name exceeds the 64-character limit (${name.length})`);
  }
  const description = tool.description;
  if (typeof description !== "string" || !description.trim()) {
    note(`${name}: missing a description`);
  } else {
    for (const { re, what } of INJECTION_PATTERNS) {
      if (re.test(description)) note(`${name}: description ${what}`);
    }
  }

  // ── Annotations ───────────────────────────────────────────────────────────
  const annotations = tool.annotations;
  if (!annotations || typeof annotations !== "object") {
    note(`${name}: missing tool annotations (both directories require them)`);
  } else {
    const title = annotations.title;
    if (typeof title !== "string" || !title.trim()) {
      note(`${name}: annotations.title is required by the Anthropic directory`);
    } else if (title === name) {
      note(`${name}: annotations.title must be human-readable, not the tool id`);
    }
    for (const hint of ["readOnlyHint", "openWorldHint", "destructiveHint"]) {
      if (typeof annotations[hint] !== "boolean") {
        note(`${name}: annotations.${hint} must be an explicit boolean`);
      }
    }
    if (annotations.readOnlyHint === true && annotations.destructiveHint === true) {
      note(`${name}: readOnlyHint and destructiveHint cannot both be true`);
    }
  }

  // ── Input exposure ────────────────────────────────────────────────────────
  const inputAllowed = allowed(name, "input");
  for (const path of new Set(fieldPaths(tool.inputSchema))) {
    if (!sensitive(leafOf(path)) || inputAllowed.has(path)) continue;
    note(
      `${name}: input field "${path}" is restricted or precise-location data — ` +
        `remove it from the agent-facing schema, or declare it in mcp-store-exceptions.json with a reason`,
    );
  }

  // ── Output exposure ───────────────────────────────────────────────────────
  // outputSchema is advertisement only; unless the server strips the value it
  // really does reach the model, so a redaction entry is what clears this.
  const redacted = new Set(Array.isArray(tool.redactResponse) ? tool.redactResponse : []);
  const outputAllowed = allowed(name, "output");
  for (const path of new Set(fieldPaths(tool.outputSchema))) {
    if (!sensitive(leafOf(path)) || redacted.has(path) || outputAllowed.has(path)) continue;
    note(
      `${name}: response field "${path}" is restricted or precise-location data and is not redacted — ` +
        `strip it server-side, or declare it in mcp-store-exceptions.json with a reason`,
    );
  }
}

// Stale exceptions rot silently, so they fail too.
const toolNames = new Set(tools.map((tool) => tool?.name));
for (const tool of Object.keys(exceptions)) {
  if (!toolNames.has(tool)) {
    note(`${exceptionsPath}: exception for "${tool}" matches no tool in the manifest`);
  }
}

if (problems.length) {
  console.error(
    `::error::MCP store-compliance: ${problems.length} problem(s)\n` +
      problems.map((problem) => `  - ${problem}`).join("\n"),
  );
  process.exit(1);
}

console.log(
  `[mcp:store-compliance] OK — ${tools.length} tool(s) in ${manifestPath} meet the Claude + ChatGPT directory floor.`,
);
