# `terminology` — one word per concept, and the forbidden one names its substitute

A consumer keeps a glossary: for each concept the word to use, and the words
not to. This action fails the run when a file holds one of the forbidden words,
and every finding says what to write instead:

```
apps/admin/src/copy.pt-BR.ts:12:18  "entregador" → use "motoboy"  (A pessoa que entrega é sempre "motoboy".)
```

`--fix` rewrites the findings a rule marks as safe to rewrite.

It carries no consumer knowledge. The words, the scope and the exceptions come
from one JSON file the consumer owns.

## Why

Copy drifts one synonym at a time. Measured in a consumer before any rule: the
courier was "motoboy" 247 times and "entregador" 350 times, on the same
screens. A person searching the help centre for one word misses half the
articles, and nothing was ever red.

A flat text search cannot be the gate. In that consumer, of about 120 lines
holding the word `delivery`, about 40 were comments, 40 object keys and 10
import paths: a grep reports all of them, and a rewrite of them breaks the
build. So in a code file this reads only the text a person will read.

## The glossary

```json
{
  "include": ["apps/*/src/**/*pt-BR*.ts", "apps/web/content/help/**/*.ts"],
  "exclude": ["**/__tests__/**"],
  "skipLines": ["keywords:"],
  "terms": [
    {
      "use": "motoboy",
      "definition": "Quem leva o pedido até o cliente.",
      "search": ["entregador", "courier"],
      "avoid": ["entregador", { "word": "entregadores", "use": "motoboys" }, { "word": "entregadora", "autofix": false }],
      "autofix": true,
      "enforce": "new",
      "reason": "A pessoa que entrega é sempre \"motoboy\"."
    },
    { "use": "adicional", "avoid": [{ "word": "extras", "use": "adicionais" }], "allow": ["horas extras"], "paths": ["apps/client/**"] },
    { "use": "ficha técnica", "definition": "A composição de um produto." }
  ]
}
```

| key | meaning |
|---|---|
| `include`, `exclude` | Path globs: `**` any depth, `*` one segment, every other character literal. Only tracked files are read. |
| `skipLines` | Literal prefixes. A line whose trimmed text starts with one is never judged and never rewritten: a help article's `keywords: […]` line is where the synonyms belong. |
| `terms[].use` | The canonical word. Required. |
| `terms[].avoid` | The forbidden forms: a string, or `{ "word", "use"?, "autofix"? }` so a plural or a feminine names its own substitute. A form may hold spaces or a hyphen (`frente de caixa`). |
| `terms[].autofix` | Whether `--fix` may rewrite this term's forms. Default `false`. |
| `terms[].enforce` | `all` (default): every line. `new`: only the lines a diff adds, so a term can be adopted before its sweep. |
| `terms[].allow` | Literal phrases, compared whatever the case. A match inside one of them on its line stands (`horas extras`). |
| `terms[].paths` | Globs that narrow the term inside the scope. |
| `terms[].reason` | One line, printed with the finding. |
| `terms[].definition`, `terms[].search` | The glossary's own fields: typed, otherwise ignored. A term with a `definition` and no `avoid` is a definition only and is never judged. |

The file is validated strictly. Any other key, at any level, is an error (a
typo such as `autofx` must not switch a rule off in silence), and so are: an
empty `avoid`, a term with neither `avoid` nor `definition`, a forbidden word
listed twice (whatever the case), a forbidden word equal to its own substitute.

`--list` prints the terms as JSON with every default filled in, so a consumer
can render its glossary page from the same file.

## What is read in a file

By extension. `.ts .tsx .js .jsx .mjs .cjs` are read as code; every other file
as plain text, every line.

In code only the TEXT of string and template literals is judged. Never judged:

- comments and identifiers;
- a module specifier: `import … from "…"`, `export … from "…"`, `import "…"`,
  `import("…")`, `require("…")`, `declare module "…"`;
- a quoted property key: a literal followed by `:` whose previous token is `{`
  or `,`. The middle arm of a ternary follows `?`, so it is not a key;
- the `${…}` expressions of a template. A literal inside one is judged as a
  literal of its own;
- a slug or a path: the whole text is `[a-z0-9_./:#@-]` and holds one of
  `_ . / : # @ -` or a digit (`"delivery_zone"`, `"/entregadores/novo"`).

A literal that is one bare lower-case word (`"ingredientes"`, `"delivery"`) IS
judged, because copy packs render such literals, but it is only reported and
never rewritten: it may be an enum value (`icon: "delivery"`). It is not judged
at all as an operand of `===`, `!==`, `==`, `!=` or as a `case` label.
`"Delivery"` and `"Ex-entregadores"` are judged and rewritten. A word that
touches a `${…}` (`` `entregador${plural}` ``) is reported and never rewritten.

Matching is on whole words, whatever the case. A letter, a digit or `_` on
either side means another word, accents included; every other character is a
boundary, a hyphen too, so `Ex-entregadores` is a finding.

## Which lines: `--base` and `--staged`

A term enforced on `all` lines is judged on every line of every file in scope.
A term enforced on `new` lines needs a diff:

- `--base <ref>` judges the lines the WORKING TREE adds against
  `git merge-base <ref> HEAD`, so the line numbers are the ones `--fix` writes
  to. An untracked file in scope is all new. Renames are not followed: **a line
  moved from another file counts as added.**
- `--staged [files…]` judges the lines the staged diff adds, reading each file
  from the index. With files given, only those (a hook passes its own list).
  `all` terms are judged on every line of the staged files.

With neither flag, a glossary holding a `new` term is a usage error (exit 2),
never a silent pass. So **a caller with `new` terms runs the action on pull
requests only**: a push to the default branch has no base to count from.

## `--fix`

Rewrites, in the working tree, exactly the findings it would have reported for
forms with autofix on, then reports what is left. It keeps the case
(`Entregador` → `Motoboy`, `ENTREGADOR` → `MOTOBOY`). A form the glossary
itself writes with a capital, an acronym such as `PDV`, is matched whatever the
case and its substitute is written exactly as configured.

It prints `fixed: <path>` for each file it changed. Under `--staged` it rewrites
a file only when its working-tree copy has the same bytes as its index copy; a
file with unstaged changes is left alone, its findings stay findings, and the
report names the command to run by hand.

## Exceptions in the file

```ts
// terminology-allow: entregador
const legacy = "Aguardando entregador"; // the line above keeps the word here

/* terminology-allow-file: delivery */
```

`terminology-allow: a, b` keeps those words on its own line and the next one.
`terminology-allow-file: a, b`, anywhere, keeps them in the whole file: a help
article's body is one template literal, where a comment on the line above
would become article text. In code both are read from comments only; in plain
text from the line itself.

## Exit status

| status | meaning |
|---|---|
| `0` | nothing found (or, with `--fix`, nothing left) |
| `1` | findings |
| `2` | the glossary or the call is wrong, a base does not resolve, or a file could not be scanned |

It never passes having read nothing. `include` globs that together match no
tracked file are a `2`, as is a glossary that forbids nothing. A diff that
touches no file in scope is a normal pass, and says so. The last line states
files read, lines judged, findings and fixed.

## Usage

```yaml
on:
  pull_request:

jobs:
  terminology:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: 12-apps/ci/.github/actions/terminology@v2
        with:
          config: docs/glossary.json
          base-ref: origin/${{ github.base_ref }}
```

The action does not check out or fetch. The checkout must hold the base commit
and the history down to the merge base: `fetch-depth: 0` as above, or the
[`fetch-base`](../fetch-base) action, which deepens only as far as needed:

```yaml
      - uses: actions/checkout@v4
      - id: base
        uses: 12-apps/ci/.github/actions/fetch-base@v2
      - uses: 12-apps/ci/.github/actions/terminology@v2
        with:
          config: docs/glossary.json
          base-ref: ${{ steps.base.outputs.base-sha }}
```

| input | |
|---|---|
| `config` | Required. The glossary, relative to `working-directory`. |
| `base-ref` | The pull request's base. Required when the glossary holds a `new` term. |
| `working-directory` | Default `.`. |

Each finding is an `::error` annotation on the diff, 30 at most per run (the log
lists them all), and the job summary gets a table: term, findings, fixed.

## Running it locally

One Node process, builtins only, no install. `<ci>` is a checkout of this
repository:

```bash
node <ci>/.github/actions/terminology/check.mjs --config docs/glossary.json --base origin/main
node <ci>/.github/actions/terminology/check.mjs --config docs/glossary.json --base origin/main --fix
node <ci>/.github/actions/terminology/check.mjs --config docs/glossary.json --list
```

In a pre-commit hook, fix what can be fixed and stage it again:

```bash
out=$(node "$CI"/.github/actions/terminology/check.mjs --config docs/glossary.json --staged --fix) && status=0 || status=$?
printf '%s\n' "$out"
printf '%s\n' "$out" | sed -n 's/^fixed: //p' | while IFS= read -r file; do git add -- "$file"; done
exit "$status"
```

The git environment is passed through untouched, so a hook that commits through
a temporary index (`GIT_INDEX_FILE`) gets that index read.

## Files the scanner refuses

The scanner is small and it is not a parser. When it cannot follow a file it
says so (`could not scan <file>:<line>`, exit 2) and judges nothing in it,
because a file judged in part would pass as if it were clean. The cause is a
quote outside a literal:

- JSX text holding a quote (`<p>copo d'água</p>`): put the copy in a literal
  (`{"copo d'água"}`) or in a copy pack;
- a regex literal holding a quote right after `)` or `}`, where a `/` cannot be
  told from a division: name the regex in a constant.

A file with no forbidden form anywhere in it is not scanned at all, so the
refusal only appears with a word to judge. `exclude` the file if neither fits.

## What it does not do

- A form is matched on one line: `frente de` at the end of a line and `caixa`
  on the next is not a match.
- JSX text is not judged, only literals.
- A `skipLines` prefix has to start the line that holds the word. A value a
  formatter wrapped onto the line after `keywords:` is judged; keep it on the
  key's line, or allow the word in the file.
- An enum value written as one lower-case word is reported like copy
  (`icon: "delivery"`). It is never rewritten; allow it on its line.
- A file that is not valid UTF-8 is judged but never rewritten.
