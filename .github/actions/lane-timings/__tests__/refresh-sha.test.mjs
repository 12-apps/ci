import assert from "node:assert/strict";
import { test } from "node:test";

import { measuredSha } from "../refresh.mjs";

const never = () => assert.fail("its own run needs no API call");

test("the ledger records the commit the measured run tested", async () => {
  // Measuring itself (the daily job): this run's sha.
  assert.equal(await measuredSha("7", { ownRunId: "7", ownSha: "aaa", readRun: never }), "aaa");
  // Measuring another run (--run-id): that run's head_sha, never this checkout's.
  assert.equal(
    await measuredSha("5", { ownRunId: "7", ownSha: "probe", readRun: async () => ({ head_sha: "bbb" }) }),
    "bbb",
  );
  // That run cannot be read: no sha, rather than a wrong one.
  assert.equal(
    await measuredSha("5", { ownRunId: "7", ownSha: "probe", readRun: async () => { throw new Error("HTTP 502"); } }),
    null,
  );
});
