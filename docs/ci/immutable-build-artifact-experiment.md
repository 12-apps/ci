# Immutable build artifact experiment

Status: open; no merge or performance verdict yet.

Engine owns the mechanism; the consumer supplies declared output directories and
its exact build command. Optional quality inputs default empty. Reliability stays
independent and publishes before test mutation. Consumers validate source,
lockfile, Node, pnpm, platform, command, explicit build environment and all bytes.
Missing, incompatible, corrupt and unsafe artifacts retain the local build.
Artifacts contain regular compiled files and directories only; database/server
state and node_modules never cross jobs. Reports remain independent.

Local controls: 331/331 engine tests, including identity mutations, corruption,
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
