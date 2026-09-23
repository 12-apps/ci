# `migration-domains` — every migration says what it affects, and it is true

Every committed migration carries one line naming the domains it affects:

```sql
-- @domains: orders, payments
ALTER TABLE "orders" ADD COLUMN "tip_cents" INTEGER NOT NULL DEFAULT 0;
```

and this action refuses the tree — the whole migration history, not only the
diff — unless every one of those lines is true.

## Why

A migration used to be invisible to test selection: it is not source, so
`affected-plan` routed it to the database client entry, which every database
test loads. Any migration at all therefore ran every database test. Measured on
a consumer: one backfill of one column selected 256 of 282 integration files
across seven shards.

Selecting honestly needs to know what a migration touches. The SQL says most of
it, and the declaration says the rest: dynamic SQL (`EXECUTE format(…)`) has no
table name to read, so the domains a file declares stand in for what a parse
cannot see. A declaration nothing checks is a comment, and a comment is what the
next author copies from the migration above without reading. So this action
checks it.

## What it refuses

| refusal | example |
|---|---|
| no declaration | a migration with no `-- @domains:` line, old or new |
| malformed | empty list, a non-id (`Orders`), a domain twice, two lines |
| unknown domain | `-- @domains: payments` when the registry has no `payments` |
| **under-declared** | `UPDATE "clients" …` in a migration that does not declare the domain owning `clients` |
| **over-declared** | a declared domain none of whose tables the SQL changes — unless the file holds dynamic SQL |
| table without a domain | a migration or a Prisma model touching a table the registry does not place |
| registry conflicts | a table in two domains, a domain with no tables, a table no migration or model has |
| nothing to check | no file matches the pattern — a gate that passes having read nothing is not a gate |

"Changes" means the statement alters the table's shape (CREATE, ALTER, DROP, an
index, a trigger on it, a COMMENT) or its rows (INSERT, UPDATE, DELETE,
TRUNCATE), including inside function bodies and `DO` blocks. A table a
statement only READS — `REFERENCES clients(id)`, `UPDATE … FROM clients` — is
not changed by it, or every migration in a multi-tenant schema would have to
declare the tenancy domain and the line would stop saying anything.

## Registry

```json
{
  "domains": {
    "orders":  { "description": "Orders and their lines.", "tables": ["orders", "order_items"] },
    "tenancy": { "description": "The store itself.",       "tables": ["clients"] }
  }
}
```

A table belongs to exactly one domain, and every table any migration ever
created is listed — including ones a later migration dropped, since the
migration that created them is still in the history and is still checked.

## Usage

It is wired into the static tier, where it runs FIRST — as the opening step of
`Detect Changes`, before a single filter is evaluated. Failing that job is the
mechanism: every lane downstream is gated on its outputs, so a migration that
does not say what it affects schedules no unit, integration, e2e or smoke job.

```yaml
static:
  uses: 12-apps/ci/.github/workflows/monorepo-static.yml@v2
  with:
    migration-domains-registry: packages/prisma/prisma/domains.json
    migration-domains-schema: packages/prisma/prisma/schema
```

Standalone:

```yaml
- uses: 12-apps/ci/.github/actions/migration-domains@v2
  with:
    registry: packages/prisma/prisma/domains.json
    schema: packages/prisma/prisma/schema   # optional
```

It reads files only — one Node process, no install, no database.

## Adopting it on an existing history

```bash
node <ci>/.github/actions/migration-domains/check.mjs \
  --registry packages/prisma/prisma/domains.json --schema packages/prisma/prisma/schema --write
```

`--write` adds the computed line to every migration that has none and never
rewrites one that exists. It refuses a file whose SQL it cannot fully read —
dynamic SQL, an index nobody created — because a guessed declaration is the
thing this gate exists to stop; declare those by hand.

Editing an applied migration's comment is safe: `prisma migrate deploy` does not
re-verify checksums of migrations already recorded in `_prisma_migrations`.
