/**
 * Why each selected test file is in the plan — file by file.
 *
 * The plan already KNEW. `selectAffected` walks the import graph from the
 * changed files outward and records, for every file it reaches, the hop that
 * reached it: which file imported it, on which line, and the import statement
 * itself. That walk is written into the plan document as `reasons` and has
 * been since the beginning — and then nothing ever printed it. A reviewer
 * looking at a lane that selected 462 of 761 files could see THAT it did and
 * never WHY, unless they downloaded the artifact and read JSON by hand.
 *
 * So the widest selection — the expensive one, the one worth arguing with —
 * was the least explicable. The Gherkin lane has had `--explain` for exactly
 * this reason; this is the same affordance for the two lanes that cost the
 * most.
 *
 * Two views, because they answer different questions:
 *
 *   BY TEST  — "why is THIS file running?" One line per selected test, the
 *              chain read right to left: the changed file, each hop that
 *              carried it, and the test at the end.
 *   BY CHANGE — "what is this diff COSTING me?" One line per changed file,
 *              ordered by how many tests it dragged in. This is the view that
 *              finds the barrel file, the shared type module, the route entry
 *              everything imports — the thing to split if a lane is too wide.
 *
 * Node builtins only, and no imports at all: the action runs this before any
 * install exists in the consumer's checkout.
 */

/** The changed file a chain ends at — the last hop's source, or the test itself. */
export function originOf(chain) {
  if (!Array.isArray(chain) || chain.length === 0) return null;
  const last = chain[chain.length - 1];
  return last?.imports ?? null;
}

/**
 * One line per selected test, the chain rendered left to right from the test.
 *
 * `a.test.ts ← lib/y.ts:12 ← lib/z.ts:4 ← packages/prisma/src/index.ts`
 *
 * A file that IS the change reads `runs as itself`, which is the shape
 * `selectAffected` already gives it — a one-hop chain pointing at itself.
 */
export function explainByTest(reasons, { limit = Infinity } = {}) {
  const lines = [];
  const tests = Object.keys(reasons ?? {}).sort();
  for (const test of tests.slice(0, limit)) {
    const chain = reasons[test] ?? [];
    if (chain.length === 1 && chain[0]?.importer === chain[0]?.imports) {
      lines.push(`[explain] ${test} → changed file — runs as itself`);
      continue;
    }
    const hops = chain.map((hop) => `${hop.imports}${hop.line ? `:${hop.line}` : ""}`);
    lines.push(`[explain] ${test} ← ${hops.join(" ← ")}`);
  }
  if (tests.length > limit) {
    lines.push(`[explain] …and ${tests.length - limit} more (every one of them is in the plan artifact)`);
  }
  return lines;
}

/**
 * One line per changed file, most expensive first.
 *
 * Ties break on the path so the output is stable run to run — an unstable
 * ordering makes two runs of the same diff look like different decisions.
 */
export function explainByChange(reasons) {
  const cost = new Map();
  for (const [test, chain] of Object.entries(reasons ?? {})) {
    const origin = originOf(chain) ?? test;
    if (!cost.has(origin)) cost.set(origin, []);
    cost.get(origin).push(test);
  }
  return [...cost.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([file, tests]) => `[cost] ${file} → ${tests.length} test file(s)`);
}

/**
 * The `<details>` block for the job summary.
 *
 * Bounded, and the bound is stated rather than silent: a truncated list that
 * does not say it is truncated is how a reviewer concludes a lane selected
 * fifty files when it selected five hundred.
 */
export function explainSummary(reasons, { limit = 100 } = {}) {
  const total = Object.keys(reasons ?? {}).length;
  if (total === 0) return [];
  const byChange = explainByChange(reasons);
  return [
    "<details><summary>Why each test was selected</summary>",
    "",
    "**What the diff cost, per changed file**",
    "",
    "```",
    ...byChange.slice(0, 40),
    ...(byChange.length > 40 ? [`…and ${byChange.length - 40} more changed file(s)`] : []),
    "```",
    "",
    `**Each selected test, and the import chain that reached it** (${total} total)`,
    "",
    "```",
    ...explainByTest(reasons, { limit }),
    "```",
    "",
    "</details>",
  ];
}
