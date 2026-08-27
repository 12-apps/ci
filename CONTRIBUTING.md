# Contributing to `12-apps/ci`

This repo holds the reusable GitHub Actions workflows the 12-apps repos call.
A change here reaches every consumer, so two things matter more than usual: the
commit message, and whether a change is breaking.

## Commit messages

Every commit and every pull request title must follow
[Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): imperative summary

Optional body, wrapped at 100 characters.
```

The `Commit messages` check enforces this on every pull request. Locally, the
same contract in one line:

| Rule | |
|---|---|
| **Format** | `type(scope): description` — scope optional |
| **Type** | one of `feat` `fix` `docs` `style` `refactor` `test` `chore` `perf` `ci` `build` |
| **Header length** | 72 characters or fewer |
| **Mood** | imperative — `add`, not `added` or `adds` |
| **Punctuation** | no trailing period, no emoji |
| **Body** | lines wrapped at 100 characters |
| **Attribution** | no AI/tool attribution — no co-author trailers, no "Generated with …" |
| **Issue ref** | optional here; include `(#123)` when an issue exists |

An issue reference is *not* required. This repo is public, and demanding an
issue number for a one-line typo fix turns a drive-by contribution into a
two-step chore.

### Why both the commits and the PR title are checked

This repo is squash-only, with `squash_merge_commit_title: COMMIT_OR_PR_TITLE`.
GitHub uses the **single commit's subject** when a PR has exactly one commit and
the **PR title** when it has several — so either can be the thing that lands on
`main`, and both are linted. If you fix a PR title after CI has run, the check
re-runs automatically.

### Why this is not cosmetic

`release-major-tag.yml` advances the supported moving major (`v2`, declared in
`.github/majors.json`) by reading commit subjects. It stops at the first commit
marked breaking — a conventional `type!:` / `type(scope)!:` subject, or a
`BREAKING CHANGE:` footer — and freezes the major there.

A breaking change written **without** that marker is therefore not merely untidy:
the major advances across it, and every repo pinned to it inherits the break on
its next run with no version change to point at. This is not hypothetical — it is
how `v1` came to be dragged across twenty-nine commits and end up as a duplicate
of `v2` (see **Versioning** in the README). Mark breaking changes explicitly:

```
feat(cd)!: require an explicit target input

BREAKING CHANGE: callers that relied on the implicit `all` target must now pass
`target: all`.
```

Cutting `v2` is a manual step — see the README.

## Changing a reusable workflow

- **Add inputs with defaults.** A new required input breaks every caller at once.
  A new optional input with a default that preserves today's behaviour breaks
  none of them.
- **Document the caller snippet** in the workflow's own header comment, the way
  the existing workflows do, and add a section to [CONSUMING.md](./CONSUMING.md)
  if it is a workflow a repo opts into.
- **Remember it runs in the caller's checkout.** A reusable workflow here sees
  the *consumer's* files, scripts and config — not this repo's.

## Pull requests

Target `main`. Open the PR, get it green, then mark it ready for review.
