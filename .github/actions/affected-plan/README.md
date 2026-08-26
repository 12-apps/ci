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
| a changed path the caller marks untraceable | `full` |

Pair it with a full run on the default branch. Strict PR-time selection is only
sound when something unconditional runs afterwards.

## Usage

```yaml
- uses: 12-apps/ci/.github/actions/fetch-base@v1

- id: plan
  uses: 12-apps/ci/.github/actions/affected-plan@v1
  with:
    lane: unit
    base: FETCH_HEAD
    artifact-name: affected-plan-unit

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

## Config — `.affected-plan.json`

```json
{
  "workspaces": ["apps/*", "packages/*"],
  "aliases": [{ "prefix": "@", "replacement": "<workspace>/src" }],
  "ignore": "\\.(md|png|svg)$|^\\.github/",
  "untraceable": "(^|/)(package\\.json|tsconfig.*\\.json|[^/]*\\.config\\.[cm]?[jt]s)$|^pnpm-lock\\.yaml$",
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
| `untraceable` | paths whose effect the import graph cannot model — manifests, tsconfigs, lockfiles. These force `full` |
| `lanes.<name>.roots` | directories to build the graph over |
| `lanes.<name>.test` / `.exclude` | which files are this lane's tests |

A package whose `exports` point at an unbuilt `dist/` falls back to `src/`,
which is what a test run actually resolves.

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
