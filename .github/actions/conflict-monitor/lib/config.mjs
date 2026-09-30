/**
 * The caller's half of the classification: which paths form which bucket.
 *
 * Buckets are the CONSUMER's vocabulary ("route table", "ADR index",
 * "ledgers") and so never live here; the engine only knows how to match them.
 * Rules are tried in order and the first match wins, so a narrow rule placed
 * above a broad one carves its files out of it.
 *
 *   {
 *     "buckets": [
 *       { "name": "routes", "paths": ["apps/web/server/routes.generated.ts"] },
 *       { "name": "mcp-artifacts", "paths": ["apps/web/mcp/*.json"], "absent": true },
 *       { "name": "ledgers", "paths": [".*.json"] }
 *     ],
 *     "ticketPattern": "FUT-\\d+"
 *   }
 *
 * `absent: true` matches a path only when it no longer exists at the base tip:
 * the way to keep a file that has been taken out of git classifying correctly
 * in the history report, without the rule also claiming a new file that later
 * reuses the name.
 *
 * A file no rule claims is `code`. The report then splits `code` by shape, so
 * the default bucket is never a place where a conflict disappears.
 */
import { readFileSync } from "node:fs";

export const DEFAULT_BUCKET = "code";

/**
 * Glob → RegExp. `**` crosses directories (and `**\/` may match nothing), `*`
 * and `?` stay within one segment. A leading-dot pattern such as `.*.json` is
 * matched literally from the root: patterns are anchored at both ends, so
 * `.*.json` is a root file and `**\/package.json` is any depth, including the
 * root.
 */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export class ConfigError extends Error {}

export function parseConfig(text, source = "config") {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${source}: not valid JSON (${err.message})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${source}: expected an object with a "buckets" array`);
  }
  const buckets = raw.buckets ?? [];
  if (!Array.isArray(buckets)) throw new ConfigError(`${source}: "buckets" must be an array`);
  const rules = buckets.map((b, i) => {
    const where = `${source}: buckets[${i}]`;
    if (!b || typeof b.name !== "string" || !b.name) throw new ConfigError(`${where} needs a "name"`);
    if (b.name === DEFAULT_BUCKET) throw new ConfigError(`${where}: "${DEFAULT_BUCKET}" is the default bucket and cannot be declared`);
    if (!Array.isArray(b.paths) || b.paths.length === 0 || b.paths.some((p) => typeof p !== "string" || !p)) {
      throw new ConfigError(`${where} ("${b.name}") needs a non-empty "paths" array of globs`);
    }
    return { name: b.name, absent: b.absent === true, patterns: b.paths.map(globToRegExp) };
  });
  let ticket = null;
  if (raw.ticketPattern != null) {
    if (typeof raw.ticketPattern !== "string") throw new ConfigError(`${source}: "ticketPattern" must be a string`);
    try {
      ticket = new RegExp(raw.ticketPattern, "g");
    } catch (err) {
      throw new ConfigError(`${source}: "ticketPattern" is not a valid regex (${err.message})`);
    }
  }
  return { rules, ticket };
}

/** A missing config file is an empty config: every file is `code`. */
export function loadConfig(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return parseConfig("{}", path);
    throw err;
  }
  return parseConfig(text, path);
}

/**
 * The bucket of `path`. `exists(path)` answers whether the path is present at
 * the base tip; it is only called for `absent` rules.
 */
export function bucketOf(path, config, exists = () => true) {
  for (const rule of config.rules) {
    if (!rule.patterns.some((re) => re.test(path))) continue;
    if (rule.absent && exists(path)) continue;
    return rule.name;
  }
  return DEFAULT_BUCKET;
}

export function ticketsIn(text, config) {
  if (!config.ticket || !text) return new Set();
  return new Set(text.match(config.ticket) ?? []);
}
