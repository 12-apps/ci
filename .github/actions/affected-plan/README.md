# `affected-plan` — symbol-level test selection

Decide which test files a lane must run, and write that list to a JSON plan the
lane executes verbatim.

## Why not file-level selection

`vitest related` and every tool like it answer one question:

> does this test **load** the changed file?

On a repo with a shared entry module that question selects most of the suite for
almost any diff, because the entry is loaded by nearly everything. Measured on a
real pull request in a consumer repo — 13 changed files, of which two were a
shared route entry and a component every app shell renders:

| lane | file-level | symbol-level |
|---|---|---|
| unit | 462 of 761 files (61%), 3,550 tests, 794s | **125 (16%)** |
| integration | 65 of 143 files (45%), 776 cases, 503s | **0** |

The 337 unit files that dropped out were not a heuristic guess. Every one of
them reached the changed module through `packageRoutes`, `wireEndpoint` or
`wireCall` — all three byte-identical across that diff. The two functions that
did move (`wireQuery`, `wireBody`) moved *verbatim* into a new file and were
re-exported under the same names, so nothing downstream could observe anything.
The whole diff, once the move and the comments are subtracted, was **two comment
lines** plus one genuinely new export that exactly one file imports.

This action asks the useful question instead:

> is the code **reachable** from this test different?

## How it decides

1. **Hash every exported symbol's body**, comments stripped. A comment cannot
   change behaviour, so documenting a shared module must not re-run the suite.
2. **Key those hashes by NAME across the whole diff.** A function moved between
   files with an identical body is unchanged. Relocation is the most common
   shape of refactor, and treating it as "everything changed" makes a selector
   useless exactly when the diff is largest. Re-exports are settled to the body
   they forward, so `export function x` → `export { x } from "./moved"` is a
   move, not a change.
3. **Follow an importer only when it imports a changed symbol.** An importer
   taking `packageRoutes` from a module whose `packageRoutes` is identical is
   not affected, however much else in that module moved.
4. **Once affected, a file's own exports are all treated as changed.** A
   deliberate over-approximation: tracking which of its exports actually differ
   would need to type-check the program.

Type-only imports are not edges — they are erased before any module graph
exists, so a change cannot travel through one.

## Failing safe

Both failure directions are green, and they are not symmetric. Running too much
costs minutes. Running too little reports success on code no test touched, which
looks exactly like success on code every test touched. So every uncertainty
widens to `mode=full`:

| situation | result |
|---|---|
| config missing or unreadable | `full` |
| unknown lane | `full` |
| the diff cannot be computed | `full` |
| a relative import does not resolve | `full` — never narrow against a graph with holes |
| a declaration cannot be bracketed | that file reports `*` (all exports) |
| a changed path matching no rule | **`unclassified` — the action exits 1** |

There is deliberately no `full` for an unrecognised path. It used to be the
answer, and on the first consuming repo it fired on **69% of commits**: the old
rule was a negative lookahead ("anything that is not a workspace `.ts` file"),
so a budget JSON, a migration, a docs fixture and a root script all bought the
entire suite — invisibly, because the run is green either way. Classification is
now exhaustive and an unknown path stops the plan job in red, where somebody
sees it and adds one rule.

Pair it with a full run on the default branch. Strict PR-time selection is only
sound when something unconditional runs afterwards.

## Usage

```yaml
- uses: 12-apps/ci/.github/actions/fetch-base@v2

- id: plan
  uses: 12-apps/ci/.github/actions/affected-plan@v2
  with:
    lane: unit
    base: FETCH_HEAD
    artifact-name: affected-plan-unit
    # explain: 'false'   # per-file attribution is ON by default

- name: Run exactly what the plan chose
  if: steps.plan.outputs.mode != 'none'
  run: |
    if [ "${{ steps.plan.outputs.mode }}" = "full" ]; then
      pnpm test
    else
      jq -r '.tests[]' affected-plan.json | xargs pnpm vitest run
    fi
```

The plan is a **file**, not a count. A plan job that answers only "how many
shards?" while the lane re-derives its own selection is two implementations of
one decision, and they drift. Publish the plan, have the lane run `.tests` from
it, and there is exactly one selection per run.

## Why each test was selected (`explain`)

A narrowed lane is a claim, and until you can read the argument behind it you
cannot disagree with it. The plan has always recorded the walk — for every
selected test, the file that imported it, on which line, back to the change —
and for a long time it printed nothing but the filenames. So the widest
selections, the ones actually worth arguing with, were the least explicable.

`explain` (on by default; set `explain: 'false'` for a quiet log) prints both
views to the log and to the job summary:

```
[cost] apps/client/src/pages/account/compras/detalhe/index.tsx → 57 test file(s)
[cost] apps/client/src/lib/storefront-copy.en-US.ts → 39 test file(s)

[explain] apps/client/src/__tests__/checkout.test.tsx ← apps/client/src/App.tsx:44 ← apps/client/src/routes.tsx:10 ← apps/client/src/pages/account/compras/detalhe/index.tsx:104
[explain] apps/client/src/__tests__/account-settings.test.tsx → changed file — runs as itself
```

`[explain]` answers *why is THIS test running* — read it right to left: the
changed file, each hop that carried it, the test at the end. `[cost]` answers
*what is this diff costing me*, ordered by how many test files each changed file
dragged in.

The second one is the one that changes what you do. In the run above, two files
account for 96 of 118 selected tests, and both are barrels: `routes.tsx` (which
`App.tsx` imports, and nearly every client test mounts `App`) and a copy module
re-exported through one index. A lane that feels like it runs everything usually
has one or two of these, and no amount of selector tuning fixes them — splitting
the barrel does.

## Config — `.affected-plan.json`

```json
{
  "workspaces": ["apps/*", "packages/*"],
  "aliases": [{ "prefix": "@", "replacement": "<workspace>/src" }],
  "ignore": "\\.(md|png|svg)$|^\\.github/",
  "source": "\\.(ts|tsx|js|jsx|mjs|cjs)$",
  "sourceRoots": ["apps", "packages", "scripts"],
  "routes": [
    { "match": "^packages/[^/]+/prisma/.*\\.prisma$", "entry": ["packages/prisma/src/index.ts"] },
    { "match": "^pnpm-(lock|workspace)\\.(yaml)$", "command": "node scripts/plan-route.mjs" }
  ],
  "lanes": {
    "unit": {
      "roots": ["apps", "packages"],
      "test": "\\.(test|spec)\\.(ts|tsx)$",
      "exclude": "(^|/)tests/integration/"
    },
    "integration": {
      "roots": ["apps", "packages", "tests"],
      "test": "(^|/)tests/integration/.*\\.test\\.ts$"
    }
  }
}
```

| key | meaning |
|---|---|
| `workspaces` | package roots; globs expanded one level. Used for `exports` resolution |
| `aliases` | bundler aliases. `<workspace>` is replaced with the importing file's own workspace, so `@/x` resolves per app |
| `ignore` | paths that cannot change any verdict — docs, images, CI config |
| `source` / `sourceRoots` | what the graph traces directly. Stated positively, so anything else must be ignored or routed |
| `routes[].match` + `.entry` | a codegen INPUT, replaced by the source file carrying its whole effect, then traced normally. A Prisma schema is the motivating case: non-`.ts`, but its only runtime effect is the generated client's surface |
| `routes[].match` + `.command` | for an input whose entry cannot be named in a regex — a catalog bump's entry is whichever source imports the packages whose pins moved. Run once with every matching path, printing one entry per line |
| `lanes.<name>.ignore` | added to the repo-wide `ignore` for this lane only — never subtracted. Prisma migrations are the case: they decide what integration runs against a real database and cannot reach a unit test, which mocks the client |
| `lanes.<name>.roots` | directories to build the graph over |
| `lanes.<name>.test` / `.exclude` | which files are this lane's tests |

A route whose command fails, or prints nothing, leaves its paths **unclassified**
rather than routed-to-nothing. A silent empty there would skip exactly the tests
the bump was supposed to reach, and report success doing it.

A package whose `exports` point at an unbuilt `dist/` falls back to `src/`,
which is what a test run actually resolves.

## Migrations and schema files — the `database` block

A migration and a `.prisma` file are not source. Routing them to the database
client entry is correct and useless: every database test loads that entry, so
any migration selected every one of them. Measured on a consumer: one backfill
of one column — `UPDATE clients SET comanda_cancel_answer_roles = …` — selected
256 of 282 integration files on seven shards. With this block, the same diff
selects 14 on one.

```json
"database": {
  "registry": "packages/prisma/prisma/domains.json",
  "schema": ["packages/prisma/prisma/schema"],
  "migrations": "^packages/[^/]+/prisma/migrations/[^/]+/migration\\.sql$",
  "schemaFiles": "^packages/[^/]+/prisma/(?:schema/)?[^/]+\\.prisma$",
  "global": ["packages/prisma/src/index.ts"],
  "schemaReaders": ["packages/prisma/scripts/prisma-partials.mjs"],
  "readerMarker": "[\"'`/]migrations[\"'`/]|MIGRATIONS_DIR",
  "carriers": ["tests/integration/**", "packages/prisma/prisma/pglite-template.ts"],
  "always": ["apps/web/tests/integration/migrations-replay.integration.test.ts"],
  "lanes": { "unit": "text", "integration": "effects" }
}
```

The router owns every path the two patterns match; a regex `route` that also
matches one is not consulted. For each path it asks what the change DOES:

1. **A migration** is parsed (`migration-domains/lib/sql.mjs`) into per-table
   effects — the whole table (`*`: new or deleted rows, a trigger, a NOT NULL
   column every INSERT must now supply), a set of columns (a backfill, a column
   added with a default, a constraint over them), or nothing observable (a
   comment, a non-unique index). A migration whose SQL is unchanged apart from
   comments changes nothing. What the parse cannot see — dynamic SQL, an index
   nobody created, a migration with no visible table (a trigger function) — its
   `-- @domains:` declaration covers: every declared-domain table the parse did
   not see counts as `*`, table by table. A migration with no valid declaration is left UNROUTED — so it
   is unclassified and the plan stops, the same verdict the gate gives it.
2. **A schema file** is diffed block by block: changed models, and inside each
   the changed fields (`@@unique`/`@@index` name theirs; `@@map`/`@@id`, or an
   added or removed model, are the whole table). A `generator`/`datasource`
   change routes to `global`. Comment-only edits change nothing.
3. **Where code touches it.** A table is reached through its Prisma delegate
   (`prisma.order.findMany(`), raw SQL naming it, or a relation field in another
   model's `include`/nested write. A column is reached through its field name —
   and a field name that several models share, or a plain lower-case word
   (`status`, `name`), only counts in a declaration that ALSO touches the model.
4. **Which exports hold it.** Each hit is attributed to its top-level
   declaration and then to the exports that can see it, so the route is
   `file#a,b` and the walk starts at those symbols, not every export of a
   repository module holding one query against the table. A test file, a file
   that cannot be bracketed, or a hit at module level is seeded whole.
5. **Who reads the files themselves.** A file naming ONE migration directory
   runs when that migration changes. A file matching `readerMarker` reads the
   folder's TEXT and runs on any migration change — unless it is a `carrier`
   (glob), one that only replays the folder to build a database or spells its
   path: that database differs exactly where step 1 says. `migrationReaders`
   (literal paths) run on any migration change whatever they name — a discovery
   test that lists the folder but pins two known entries. `schemaReaders` run on
   any schema change.
6. **`always`** runs on any migration or schema change that alters SQL or a
   model, so a migration nothing else can observe still applies somewhere.

`lanes` says how each lane consumes it: `effects` (all of the above), `text`
(a lane that never opens a database — migrations reach only their text
readers; schema edits still reach the code naming changed fields) or `off`.

Routes may now answer with an object, `{ entries }`, which is classified even
when empty ("routed to nothing" is not "unclassified"), and an entry may name
symbols — `file#a,b` — seeding only those.

## Seeded data — `keys` routes

An end-to-end suite provisions its world from modules no test imports — a
users table, a stores table, the provisioner itself — and its tests reach that
world by KEY: they sign in as `"jm-olivia@futurepay.test"`, they open
`"jornada-mesa-sai"`. The import graph cannot see that edge, so a selector
either reaches nothing from a seeder or runs everything for it. A consumer did
the second for every harness change: 102 commits in sixty days, each running
all 162 specs and every Gherkin feature, comments included.

A route with `keys` reads the diff of each matching file, both sides:

```json
{ "match": "^tests/e2e/helpers/[^/]+\\.(mjs|json)$",
  "keys": { "search": "^(apps/[^/]+/src/|tests/e2e/)", "logic": "records", "unnamed": "none" } }
```

- **only comments or whitespace moved** → routed to nothing;
- **a record changed** — the line opens, closes or sits in an object literal,
  a call's argument list or an array holding key-shaped strings (ids, slugs,
  e-mails; also `'…'` inside SQL strings) → its keys, and the property it is
  filed under (`mesaSai: {`). Files under `search` that name one are the
  entries, attributed to the declaration holding the hit (a test runs itself; a
  helper becomes `file#symbol`), and any NON-source file naming one — a
  `.feature` — is listed in the plan document's `keys` report for the caller;
- **a line that wires a sibling in** — an import from another file of the same
  route, or a call of a name imported from one → that sibling's records;
- **anything else is logic.** With `logic: "records"` (a seeder, whose effect
  is confined to the rows it seeds) that is every record the file and the files
  of the route importing it hold — `seedHistory(db, id)` is keyed by whoever
  passes `id` — or, with no keys anywhere in that chain, plain logic. A list of
  entries routes to them (a script a runner launches by path). By default the
  file is ordinary source, and the graph decides.

A record no searched file names is traced as source by default — a test may
read the whole table. `unnamed: "none"` routes it to nothing instead; set it
only where "no test imports this file" is itself checked, so a row nobody
names really is a row nobody observes.

A runner the graph cannot see through — a config that launches scripts by path
— is best made a ROOT of the lane: put it in the lane's `test` pattern and add
its file to `roots` (a root may be a single file). A plan that reaches it then
says so in `tests`, and the caller can treat that, and only that, as "every
test".

## The plan document

```jsonc
{
  "lane": "unit",
  "mode": "narrowed",
  "why": "125 test file(s) reach a changed symbol across 13 changed file(s)",
  "counts": { "changed": 13, "affectedFiles": 162, "selected": 125, "shardTotal": 4 },
  "affectedSymbols": { "apps/web/lib/wiring/endpoint.ts": ["wireReads"] },
  "tests": ["apps/web/lib/feature-flags/__tests__/host.test.ts"],
  "reasons": {
    "apps/web/lib/feature-flags/__tests__/host.test.ts": [
      { "importer": "…/host.test.ts", "imports": "…/dispatch.ts", "line": 12, "statement": "import { dispatchFeatureFlags } from \"../dispatch\";" }
    ]
  }
}
```

`affectedSymbols` and `reasons` are what make a narrowed lane reviewable: for
every selected file there is a chain of real import statements with line
numbers, and anyone can open those files and check.
