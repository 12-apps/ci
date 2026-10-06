# ADR: re-stack a child branch after its parent's squash, as a merge under a lease

Status: accepted with the engine change for FUT-3341. The consumer records its
own half (the local command, the pre-push check, the block memory) in its own
ADR.

## Context

The conflict monitor's consumers merge by squash only. A branch cut from
another PR's branch keeps that PR's commits after the parent is squash-merged,
so its next merge of the base meets the parent's code "added on both sides"
and conflicts with its own parent. In future-pay's history this is the
`code: stacked` row: 60 syncs, 324 conflicted files (live, 2026-10-05), every
one resolved by hand. GitHub's own re-stacking applies only to `gh stack`
members and to PRs whose base branch was deleted; it did nothing for 59 of
those 60 syncs.

Three merges were measured against the hand resolutions: a single explicit
base (`--merge-base=<parent's held head>`) is clean on 43 syncs and worse than
the default merge on 3; replaying the child's commits (`rebase --onto`) is
clean on 28 and rewrites history; a merge with a throwaway commit Z (the
base's tree, with the base and each parent's held head as parents) is clean on
46, never worse than the default, and equal to the human's tree on 40 of those
46.

## Decision

1. **The algorithm is one module** (`.github/actions/conflict-monitor/lib/restack.mjs`),
   git only, with the squash-to-PR mapping injected, shared by the bot, the
   probe, the report and a consumer's local command. It merges with Z, so git
   uses every merge base it finds and builds a virtual one when there are
   several. A squash is mapped to its PR by `merge_commit_sha`
   (`GET /commits/{sha}/pulls`); the subject's `(#N)` is a fast path only.
   A parent the base reverted is skipped.
2. **The bot writes a merge, never a rebase.** The commit has the parents
   (branch, base); Z is never pushed. It is pushed with
   `--force-with-lease=<ref>:<planned head>` after asserting that it descends
   from that head, so nothing is rewritten and a branch the author moved or
   deleted is never overwritten or recreated. A merge that still conflicts is
   never pushed.
3. **The token is a PAT, held by one job on a pinned ephemeral runner.**
   `conflict-restack.yml` is the first engine workflow that writes to a
   contributor's PR branch. A `GITHUB_TOKEN` push would start no checks, so it
   takes `PUSH_TOKEN`, sends it as an extraheader in the push call only, runs
   on `ubuntu-latest` with no input to move it (a listed exception to the
   runner-selection rule), checks out the base without persisting
   credentials, and executes nothing from a PR; no git subprocess inherits a
   token, and every git call runs with hooks and fsmonitor off. Without the
   token it plans and warns. Forks, non-default bases, protected heads and
   ignored heads are never written to. A force-push over the bot's re-stack
   stops it for that parent, read from a record that survives the
   force-push: the repository activity API's `force_push` events and the
   compare of what each discarded, both readable with the job's
   `contents: read`. When that record cannot be read the PR is skipped with
   a warning, never re-stacked blind.
4. **The report tells a tool merge from a hand merge by contract, not by
   tree.** Most hand resolutions produce the tool's tree, so the tree cannot be
   the tell. A tool merge carries `Restack-Base`/`Restack-Parent` trailers; the
   report accepts them only when they name exactly the held heads and parents
   it computes itself and the committed blob equals Z's, for every file:
   a merge driver that wrote another blob (a real `git merge` runs drivers,
   `merge-tree` does not) is counted as a hand resolution, conservatively,
   because an exemption by attribute would let trailers alone hide any blob
   in a repository that gives every code file a driver. It is rare: a driver
   runs only where both sides changed a file that Z already merges cleanly.
   Re-stack-aware groups
   are primary, and the legacy columns are printed next to them so a report
   stays comparable with the ones before it.

## Consequences

The `code: stacked` row now means "resolved by hand where the re-stack would
have merged": 249 / 9 instead of 318 / 55 on the epic's pinned window, with the
difference re-attributed by shape to concurrent edit, append point and
duplicated scope. Those baselines move for any consumer reading the report.

The bot pushes to branches people are working on. Their next push is rejected
and they pull a fast-forward or a normal merge; nothing of theirs is
rewritten. Real conflicts, and residuals only a merge driver resolves, are
left to the developer and the probe's comment. The ping-pong cap does not
use the PR timeline, which lists only the commits the PR has now (checked on
future-pay's five force-pushed PRs); it depends on the activity API keeping a
ref's force-pushes and on compare serving the commits they discarded, both
checked read-only on #1849's force-push of 2026-09-19.
