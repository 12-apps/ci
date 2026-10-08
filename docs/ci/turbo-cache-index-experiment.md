# Conservative Turbo build-cache index experiment

Owner: reusable engine (`12-apps/ci`); consumer measurements/history belong in FuturePay. Scope is the Build payload only. Lint/type-check/unit caches, selection, actual build execution, lane verdicts and cache prefix fallback are unchanged.

Status: Open — not a decision. Verdict target 2026-10-09 12:00 UTC, after exact-head controls, review, normal release and exact consumer proof. Roll back this experiment's source commit if any wrong-key/missing/stale/malformed/inconclusive index skips restore, any useful current hash loses restoration, or any build/check is skipped. Retain all failure history. No deadline automatically promotes this source to a decision.

Historical FuturePay baseline [run37732762575/job113166917938](https://github.com/12-apps/future-pay/actions/runs/37732762575/job/113166917938) restored 1,450,611,540 bytes from `turbo-build-75308947d5f5af88e455f43a4274777237149ab2`, taking the reported33s, then logged3 successful/3 total and0 cached/3 total. A changed lockfile and intervening source changes are context, not proof that any one caused every miss.

The small companion index inventories actual regular `.turbo/cache/<hash>.tar.zst` files and embeds its exact payload key, Turbo2.7.5 contract and creation time. Only a complete current dry run with zero intersection authorizes skipping the payload download. A useful dependency hash restores. Missing metadata, old schema/version, age over7days, future time, wrong key, malformed/incomplete tasks, failed command or bounded30s probe all retain restoration. Legacy entries without indexes restore normally. A lookup pins the chosen payload so a concurrent prefix save cannot change which inventory is being consulted.

Payload and index saves use the same unique SHA/run/attempt identity; this avoids pairing a fresh index with an older immutable payload on a rerun. The existing prefix still reads older entries. PRs publish no production payload or index. An index measurement/storage failure is advisory and never skips the actual build or changes its exit code. The original Build command, immutable affected base and pre-build generation are retained.

## Measurements and controls

Local Node24.19.0, pnpm10.34.5, installed Turbo2.7.5. Real dry JSON exposes `turboVersion`, task identities and16-hex task hashes. The three-task fixture uses real Turbo archives and upstream dependency hashing. Its lockfile control explicitly declares the lockfile as a global input; it does not attribute the historical consumer misses to a lockfile alone.

| case | form | index bytes / ms | payload bytes / local restore ms | build ms | total ms | executed tasks |
|---|---|---|---|---|---|---|
| useful hit | baseline | 0 / 0 | 1266 / 3 | 82 | 116 | 0 (3 cached) |
| useful hit | candidate | 179 / 373 | 1266 / 3 | 70 | 479 | 0 (3 cached) |
| no hit | baseline | 0 / 0 | 1266 / 3 | 1025 | 1057 | 3 |
| no hit | candidate | 179 / 365 | 0 / 0 | 985 | 1378 | 3 |
| lockfile change | baseline | 0 / 0 | 1266 / 3 | 927 | 960 | 3 |
| lockfile change | candidate | 179 / 350 | 0 / 0 | 945 | 1325 | 3 |

These are small local compressed-tar copies, not GitHub transfer timings. The candidate is slower for this tiny payload; do not extrapolate a dollar or critical-path saving. A permanent hosted backend matrix compares baseline/candidate for all3 controls using `actions/cache` and actual task counts. Its run/job evidence and final verdict remain pending.

Failure history: tests written before implementation failed on the absent module. First integration caught a new index-save step lacking the explicit lane-verdict condition; the workflow was fixed and the unchanged32 baseline guards passed. Two new wiring assertions initially omitted YAML's literal-block pipe; their parser expressions were corrected without changing a production guard. A warm fixture assertion initially counted the earlier cold run's executions; it now asserts the execution-counter delta and actual cached count. Consumer offline install lacked private UI6.74.1; a frozen-lockfile install using only the existing scoped npm credential succeeded. No cache invalidation, protection, credential or permission was weakened.

Focused suite67/67; complete engine workflow suite314/314. Baseline guards32/32 before/after. Unknown-index and failed/malformed dry-run CLI controls remain green on the fallback; upstream useful-hash controls require restore. Independent review, hosted exact-head controls and release are pending. No production revert or production speedup is claimed yet.
