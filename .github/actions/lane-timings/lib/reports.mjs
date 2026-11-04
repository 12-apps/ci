/**
 * Reading what a leg measured, per item, out of the reports lanes already write.
 *
 * Two formats cover every lane today:
 *
 *   - `junit`: vitest's JUnit XML. One `<testsuite>` per test file, its `time`
 *     the file's own seconds and `name` the file's path relative to the vitest
 *     ROOT that ran it. A monorepo's unit lane runs one vitest per package, so
 *     the report at `packages/prisma/reports/junit/unit/x.xml` names
 *     `tests/a.test.ts` and means `packages/prisma/tests/a.test.ts`: the key is
 *     prefixed with the report's own path up to `junitRoot` (`reports/`). A
 *     report outside any such directory (integration's root-level
 *     `integration.xml`) is already root-relative and gets no prefix.
 *   - `durations-json`: `{ "<item>": seconds }`, what a Playwright reporter can
 *     write per leg (future-pay's `spec-durations.json`).
 *
 * `rewrite` maps a report's key onto the item the plan deals (a Gherkin
 * generated spec `.features-gen/admin/x.feature.spec.js` onto its feature
 * `x.feature`). Several keys that rewrite onto one item are SUMMED within a
 * report: they are parts of the item that ran on the same leg.
 */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : ENTITIES[e.toLowerCase()],
  );

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : null;
};

/** The prefix a junit report's keys need, from where the report sits. */
export function junitPrefix(reportPath, junitRoot = "reports/") {
  const normalised = reportPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!junitRoot) return "";
  const at = normalised.startsWith(junitRoot) ? 0 : normalised.indexOf(`/${junitRoot}`);
  if (at < 0) return "";
  return at === 0 ? "" : `${normalised.slice(0, at)}/`;
}

/** `[{ key, seconds, tests }]` out of a JUnit document. Unparseable rows are skipped. */
export function parseJunit(xml, prefix = "") {
  const rows = [];
  for (const m of xml.matchAll(/<testsuite\s[^>]*>/g)) {
    const tag = m[0];
    const name = attr(tag, "name");
    const seconds = Number(attr(tag, "time"));
    if (!name || !Number.isFinite(seconds) || seconds < 0) continue;
    const tests = Number(attr(tag, "tests"));
    rows.push({ key: `${prefix}${name}`, seconds, tests: Number.isFinite(tests) ? tests : null });
  }
  return rows;
}

/** `[{ key, seconds, tests: null }]` out of a `{ key: seconds }` document. */
export function parseDurationsJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.entries(parsed)
    .filter(([, s]) => typeof s === "number" && Number.isFinite(s) && s >= 0)
    .map(([key, seconds]) => ({ key, seconds, tests: null }));
}

/** Apply the lane's rewrite rules (first match wins); a key no rule matches is kept. */
export function rewriteKey(key, rules = []) {
  for (const rule of rules) {
    const re = new RegExp(rule.pattern);
    if (re.test(key)) return key.replace(re, rule.replace ?? "");
  }
  return key;
}

/**
 * One report's rows, rewritten and summed per item.
 * Returns `Map<item, { seconds, tests }>`.
 */
export function reportItems(rows, rules = []) {
  const out = new Map();
  for (const row of rows) {
    const item = rewriteKey(row.key, rules);
    const prev = out.get(item) ?? { seconds: 0, tests: null };
    out.set(item, {
      seconds: prev.seconds + row.seconds,
      tests: row.tests == null ? prev.tests : (prev.tests ?? 0) + row.tests,
    });
  }
  return out;
}

/**
 * Many reports of one run, merged: an item seen in several reports (a re-run
 * attempt of the same leg) keeps its LONGEST measurement, which is the safe
 * bias for a number whose job is to keep a leg under its target.
 */
export function mergeReports(reports) {
  const out = new Map();
  for (const report of reports) {
    for (const [item, row] of report) {
      const prev = out.get(item);
      if (!prev || row.seconds > prev.seconds) out.set(item, row);
    }
  }
  return out;
}
