# Record sleeps in mocked refresh-image tests

**Status:** Open — not a decision. ENGINE ownership (`12-apps/ci`).
Consumer history: FuturePay `docs/ci/log/draft-refresh-tests-record-sleep.md`.
Baseline source: `1208c421d9cf8953507d6a36bd6acd08a4252514`.

The production refresh script is byte-identical. Each existing mocked AWS
child receives its own temporary PATH containing a recording sleep executable.
The executable logs the requested delay alongside the AWS calls and returns
immediately. Programmable polling states exercise the unchanged shell loops.
The existing 60-second child-process timeout remains.

Measurements, same local environment and engine revision:

| execution | tests | result | elapsed |
|---|---:|---|---:|
| original with real sleep | 22 | all pass | 302.220 s |
| original with recording sleep | 22 | all pass | 1.975 s |
| expanded recording suite | 33 | all pass | 7.034 s |

Independent reviewer rerun: 33/33, 7.031 s, zero blocking findings or identified
regressions. The matched original suite removes approximately 300.24 local test
seconds. This is not measured hosted critical-path or dollar savings. GitHub
baseline run 37458425860/job112251643262 timestamps show Runner host supervisor
11:45:41–11:50:45 UTC (304 seconds).

All 22 existing cases remain. Eleven new cases cover SSM pending→success,
Failed/TimedOut/Cancelled, 390 ten-second command polls, 90 ten-second online
waits, 270 twenty-second image waits and sleep/poll ordering. Separate smoke
state prevents a golden success case from falling into the mocked deploy path.
The first expanded suite was 30/33 because assertions counted smoke/deploy waits
as golden waits; assertions and mock states were corrected, not production.
Negative throwaway probes deleting a pre-poll sleep or shortening the retry
limit both exit 1; neither mutation is in the proposed result.

Run `node --test scripts/runner-host/wake/__tests__/refresh-image.test.mjs`.
The existing Self Tests runner-host glob discovers this suite. Hosted final-head
33/33 counts and job-step timing, independent review and normal release proof
are needed before a keep verdict. No real AWS operation or fleet deployment is
part of this experiment.

Verdict target: 2026-10-09 12:00 UTC on the draft PR. Revert criteria: any one
failed original/new control, production timing change, missing recorded order
or original-suite fake-clock time at least 30 seconds. Rollback: restore only
the test file from the baseline, rerun the 22 original cases, record its result
as an addendum without deleting this history. The deadline never promotes the
change to a decision; retain draft state if evidence remains blocked.

## Hosted verdict — keep

On source `050d0cc35d6c16a5905ad1068e63054a50336592`, [Self Tests37732824868/job113165615109](https://github.com/12-apps/ci/actions/runs/37732824868/job/113165615109) logs all33 refresh cases within the222/222 supervisor aggregate, zero failures/skips,10026.87ms. Step timestamps05:32:49–05:32:59 UTC confirm10s versus historical304s, approximately294 job-step seconds removed. The11 new cases actually executed. Runner-image build/smoke, commitlint and CodeQL passed. Independent review round1 had no blocking findings/regressions. Keep the test-only change; normal release verification follows merge. The documentation head must pass its own checks. No dollar or critical-path claim.
