/**
 * Path globs: `**` any depth, `*` one path segment, every other character
 * literal.
 *
 * A glob rather than a regex on purpose, and compiled the way
 * `migration-domains/check.mjs` compiles its own: the value comes from a file
 * the consumer owns, and compiling it verbatim would hand that file the regex
 * engine. Every character but the two wildcards is escaped.
 */
const escapeSegment = (part) =>
  part
    .split("*")
    .map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");

/** @param {string} glob */
export const globToRegExp = (glob) =>
  new RegExp(
    `^${glob
      .split("**/")
      .map((chunk) => chunk.split("**").map(escapeSegment).join(".*"))
      .join("(?:.*/)?")}$`,
  );

/**
 * One predicate for a list of globs: true when any of them matches the path.
 *
 * @param {string[]} globs
 * @returns {(path: string) => boolean}
 */
export function globMatcher(globs) {
  const patterns = globs.map(globToRegExp);
  return (path) => patterns.some((pattern) => pattern.test(path));
}
