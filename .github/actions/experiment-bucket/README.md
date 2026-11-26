# experiment-bucket

Puts a workflow run in a CI experiment's arm or in control, so an experiment is
measured against control **in the same days**, not a week before a change
against a week after it (future-pay FUT-5641).

- **Bucket:** the last digit of `github.run_id`. Run ids are large increasing
  integers, so each digit gets about a tenth of the runs; a re-run keeps its id
  and so its bucket.
- **Registry:** a JSON file in the consumer, read from its **default branch**
  through the contents API (a pull request cannot put itself into an
  experiment by editing it). `control` lists the digits never assigned
  (default `[0, 1]`); each experiment has a `name`, a `start`, an optional
  `end`, and an `allocation` history of `{ from, digits }` steps.
- **Time:** the run's `created_at` (read from the API) picks the allocation in
  force, so every attempt of a run is judged at the same moment.
- **Off:** names in the `off` input are control at once.
- **Only `pull_request` runs** are ever in an experiment.
- **Fails open:** a registry or API it cannot read, a malformed date, or a digit
  two experiments claim → control, with a reason in the log line and a warning.

Output `experiment` (`''` for control) and `digit`. Log line:
`ci-experiment run=<id> digit=<d> experiment=<name|control> reason="…"`.

The consumer validates its own policy over the registry (when experiments may
start, how often a share may change); this action only applies it.

Tests: `node --test .github/actions/experiment-bucket/__tests__/*.test.mjs`.
