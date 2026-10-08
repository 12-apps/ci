# Validate the consumer's requested Playwright browser before apt

**Status:** Open — not a decision. Baseline engine:
`1208c421d9cf8953507d6a36bd6acd08a4252514`. Consumer documentation:
`future-pay/docs/ci/log/draft-playwright-validate-before-apt.md`.

Ownership: ENGINE (`12-apps/ci`); consumer experiment history belongs in FuturePay.

The action now launches the requested engine through the consumer-installed
`@playwright/test` API, checks that package's version against the version used in
the cache key, creates a page, evaluates JavaScript and closes the browser.
There is no system-browser/channel/executable-path substitution. Unknown browser
selectors and absent versions are inconclusive. Only success avoids apt.
The probe is bounded to 30 seconds plus a 5-second kill grace period.

On failure, exception or timeout, the original fallback remains: write apt's
network configuration, then `install-deps <browser>` on an exact cache hit or
`install --with-deps <browser>` otherwise. Attempts, 360-second default timeout,
process-group/root escalation and apt-lock sweeps are unchanged. A corrupt exact
cache cannot take the fast path; this experiment preserves the existing
cache-hit fallback rather than claiming to repair missing binaries. Subsequent
consumer tests still enforce browser usability.

Local controls: `node --test .github/actions/setup-playwright/__tests__/validate-browser.test.mjs`
passed 30/30, including all three engines, missing libraries/executables, version
changes, unknown selectors, probe timeout/exception and fallback failure.
The unchanged install suite had the same two failures before and after:
16 tests, 14 pass, 2 fail. In this container unavailable privileged lock cleanup
adds warning lines, and PID 1 leaves a killed grandchild as a zombie detected by
`kill(pid, 0)`. Neither guard nor production fallback was weakened.

The real FuturePay installed version 1.61.1 correctly rejected absent Chromium
headless shell revision 1228. `pnpm exec playwright install chromium` failed on
2026-10-07: CDN response 403 `Domain forbidden`. No unrelated system Chromium
was substituted. A real-browser positive control and hosted fallback evidence
remain required before a keep verdict. Self Tests now explicitly discovers both
Playwright suites; the legacy guard remains wired.

Baseline workload reference: FuturePay run 37678991172, job 112993608638:
setup 590 seconds, tests 157 seconds/25 passing, exact browser cache hit, first
360-second install-deps attempt timed out then retried. Those are job-step
seconds, not measured critical-path or dollar savings. No after workload number
has been measured yet.

Verdict target: 2026-10-09 12:00 UTC, measuring draft PR Self Tests plus a bounded
consumer probe at the exact proposed/released revision before consumer merge.
Reject if any of the 30 new controls fail, any existing guard regresses, probe
accepts one wrong version/browser, fallback loses one cleanup/retry step or real
consumer tests lose any of the baseline 25 executed cases. No live configuration
has changed. Rollback: restore the four changed tracked files from baseline and
remove the three new source/test files; retain this experiment's history. If
merged and shown harmful, revert the experiment source commit, prove the restored
baseline guards and verify the normal v2 release before consumer readiness.
No draft becomes ready and no rollout is treated as a decision after the target
without the complete verdict and required reviews/checks.
