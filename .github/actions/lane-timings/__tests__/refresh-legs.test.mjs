import assert from "node:assert/strict";
import { test } from "node:test";

import { legOfArtifact, legOfJob } from "../refresh.mjs";

test("a job's leg is read from every name a matrix leg takes", () => {
  assert.equal(legOfJob("Tests / Integration Tests · shard 3/24"), 3);
  assert.equal(legOfJob("Gherkin Journeys · shard 10/10"), 10);
  // GitHub's default matrix name: one value in parentheses, or several.
  assert.equal(legOfJob("SPA E2E (3)"), 3);
  assert.equal(legOfJob("SPA E2E (7)"), 7);
  assert.equal(legOfJob("SPA E2E (4, chromium)"), 4);
  // A lone, unsharded leg.
  assert.equal(legOfJob("Gherkin Journeys"), 1);
  assert.equal(legOfJob("SPA E2E"), 1);
});

test("an artifact's leg is its -s<n> suffix", () => {
  assert.equal(legOfArtifact("spa-e2e-report-s3"), 3);
  assert.equal(legOfArtifact("spa-e2e-specs"), 1);
});
