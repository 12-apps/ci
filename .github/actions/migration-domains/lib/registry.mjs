/**
 * The domain registry: which domain every table belongs to.
 *
 *     {
 *       "domains": {
 *         "orders":   { "description": "…", "tables": ["orders", "order_items"] },
 *         "payments": { "description": "…", "tables": ["payments"] }
 *       }
 *     }
 *
 * A table belongs to EXACTLY one domain. Two owners would make a migration's
 * declaration ambiguous — either domain would satisfy the gate, and selection
 * could not say whose tests a change to it runs.
 */
import { readFileSync } from "node:fs";

import { DOMAIN_ID } from "./sql.mjs";

/**
 * @param {string} path
 * @returns {{ domains: Map<string,{description:string,tables:string[]}>, tableDomain: Map<string,string>, problems: string[] }}
 */
export function loadRegistry(path) {
  const problems = [];
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { domains: new Map(), tableDomain: new Map(), problems: [`cannot read the domain registry: ${error.message}`] };
  }
  return parseRegistry(raw, problems);
}

/** The same, over an already-parsed document. */
export function parseRegistry(raw, problems = []) {
  const domains = new Map();
  const tableDomain = new Map();
  const entries = raw && typeof raw.domains === "object" && raw.domains !== null ? Object.entries(raw.domains) : null;
  if (!entries) {
    problems.push('the domain registry has no "domains" object');
    return { domains, tableDomain, problems };
  }
  for (const [id, value] of entries) {
    if (!DOMAIN_ID.test(id)) problems.push(`domain "${id}" is not a domain id (lower-case, digits, dashes)`);
    const tables = Array.isArray(value?.tables) ? value.tables : [];
    if (tables.length === 0) problems.push(`domain "${id}" lists no tables`);
    domains.set(id, { description: String(value?.description ?? ""), tables });
    for (const table of tables) {
      const owner = tableDomain.get(table);
      if (owner) problems.push(`table "${table}" belongs to both "${owner}" and "${id}" — a table has one domain`);
      else tableDomain.set(table, id);
    }
  }
  return { domains, tableDomain, problems };
}
