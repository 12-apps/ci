# Immutable build artifact experiment

Status: open; no merge or performance verdict yet.

Engine owns the mechanism; the consumer supplies declared output directories and
its exact build command. Optional quality inputs default empty. Reliability stays
independent and publishes before test mutation. Consumers validate source,
lockfile, Node, pnpm, platform, command, explicit build environment and all bytes.
Missing, incompatible, corrupt and unsafe artifacts retain the local build.
Artifacts contain regular compiled files and directories only; database/server
state and node_modules never cross jobs. Reports remain independent.

Local controls: 337/337 engine tests, including identity mutations, corruption,
traversal, symlinks, empty compiled directories and workflow placement. Hosted
artifact-transfer and actual consumer controls remain required before merge.
No build-duration, job-second, critical-path or dollar savings claimed.

Failure history: fixed a predictable staging directory and broken-symlink check
before publication. Consumer graph inspection disproved the initial assumption
that only one dependency package was relevant: the current graph has 13 packages.
The no-spec Reliability fast path already avoids setup; no incremental savings
are attributed to it. Prior Playwright optimization is not counted here.

Rollback: leave consumer inputs empty and retain its original workspace build.
Target: assess actual transfer and consumer measurements by 2026-10-09 12:00 UTC.

Independent review R1 found an incomplete-manifest reuse bug. A complete manifest
digest now binds output paths, modes, roots, directories and files; omitted-file,
omitted-root and altered-metadata controls reject reuse before replacing outputs.
A public hosted fixture now exercises actual artifact upload/download, matching
reuse, missing artifact, changed command/environment and truncated manifest,
with a mutated producer and fresh independent consumer database marker.

Hosted run37805188422 at b27313a passes all five real transfer controls. Matching
job113407609425 reports `Immutable build reused: 2 verified files, 49 output bytes`
and skips fallback; missing, wrong command/environment and omitted-file manifest
controls all build locally. Corrupt job113407609415 confirms manifest digest
mismatch. Every consumer retains its fresh database marker after producer mutation.
Review round2 closed the original blocker with 24/24 focused tests and zero
remaining blockers. Actual local consumer builds (baseline12.829s versus normalized
producer environment12.079s) produce identical20 files/79,631 bytes. No hosted
consumer speed claim is implied. Normal release and exact-consumer proof remain
required before adopting its inputs.
