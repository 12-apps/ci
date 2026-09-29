import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeGithub } from "../github.mjs";

// The scaler reads the whole queue on every delivery. Unchanged answers must
// come back as free 304s, or a busy hour spends the token's allowance and the
// fleet goes blind until the hour turns (2026-09-28: 307 minutes).

const REPO = "acme/app";
const LABEL = "fp-ci";

/**
 * A GitHub that answers from `state` (path → body), with an ETag per body,
 * and a 304 when the request already holds the current one.
 */
function fakeGithub(state, { fail } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const path = url.replace("https://api.github.com", "");
    const sent = init.headers["If-None-Match"];
    calls.push({ path, method: init.method, etag: sent });
    const headers = { "x-ratelimit-remaining": String(4000 - calls.length), "x-ratelimit-reset": "1790712578" };
    if (fail) return new Response(JSON.stringify(fail.body), { status: fail.status, headers: { ...headers, ...fail.headers } });
    if (!(path in state)) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers });
    const etag = `"${JSON.stringify(state[path]).length}-${JSON.stringify(state[path]).split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}"`;
    if (sent === etag) return new Response(null, { status: 304, headers: { ...headers, etag } });
    return new Response(JSON.stringify(state[path]), { status: init.method === "POST" ? 201 : 200, headers: { ...headers, etag } });
  };
  return { calls, fetchFn };
}

const runs = (ids) => ({ workflow_runs: ids.map((id) => ({ id })) });
const jobs = (...list) => ({ jobs: list });
const queuedJob = (labels = [LABEL]) => ({ status: "queued", labels });
const runningJob = (labels = [LABEL]) => ({ status: "in_progress", labels });
const path = {
  queued: `/repos/${REPO}/actions/runs?status=queued&per_page=100`,
  inProgress: `/repos/${REPO}/actions/runs?status=in_progress&per_page=100`,
  jobs: (id) => `/repos/${REPO}/actions/runs/${id}/jobs?filter=latest&per_page=100`,
  runners: `/repos/${REPO}/actions/runners?per_page=100`,
};

function queue() {
  return {
    [path.queued]: runs([1]),
    [path.inProgress]: runs([2]),
    [path.jobs(1)]: jobs(queuedJob(), queuedJob(["ubuntu-latest"])),
    [path.jobs(2)]: jobs(runningJob(), queuedJob()),
    [path.runners]: { runners: [{ status: "online", busy: false, labels: [{ name: LABEL }] }] },
  };
}

test("the first read of the queue pays for every request and counts jobs with the label", async () => {
  const { calls, fetchFn } = fakeGithub(queue());
  const github = makeGithub({ repo: REPO, label: LABEL, token: () => "t", fetchFn });
  assert.equal(await github.queuedJobs(LABEL), 2);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.etag === undefined));
  assert.deepEqual(github.take(), { billed: 4, free: 0, remaining: 3996 });
});

test("an unchanged queue is read again with ETags and costs nothing", async () => {
  const { calls, fetchFn } = fakeGithub(queue());
  const github = makeGithub({ repo: REPO, label: LABEL, token: () => "t", fetchFn });
  await github.queuedJobs(LABEL);
  await github.idleRunners(LABEL);
  github.take();
  assert.equal(await github.queuedJobs(LABEL), 2);
  assert.equal(await github.idleRunners(LABEL), 1);
  assert.equal(calls.slice(5).filter((c) => c.etag).length, 5, "every repeated read carries the ETag it was given");
  assert.deepEqual(github.take(), { billed: 0, free: 5, remaining: 3990 });
});

test("a changed answer is read in full and replaces what was kept", async () => {
  const state = queue();
  const { fetchFn } = fakeGithub(state);
  const github = makeGithub({ repo: REPO, label: LABEL, token: () => "t", fetchFn });
  assert.equal(await github.queuedJobs(LABEL), 2);
  state[path.jobs(2)] = jobs(runningJob(), queuedJob(), queuedJob());
  github.take();
  assert.equal(await github.queuedJobs(LABEL), 3);
  assert.deepEqual({ ...github.take(), remaining: undefined }, { billed: 1, free: 3, remaining: undefined });
  // And the new answer is the one a later 304 stands for.
  assert.equal(await github.queuedJobs(LABEL), 3);
  assert.equal(github.take().billed, 0);
});

test("a new run is read in full; a run that left the lists is forgotten", async () => {
  const state = queue();
  const { calls, fetchFn } = fakeGithub(state);
  const github = makeGithub({ repo: REPO, label: LABEL, token: () => "t", fetchFn });
  await github.queuedJobs(LABEL);
  state[path.queued] = runs([3]);
  state[path.jobs(3)] = jobs(queuedJob());
  assert.equal(await github.queuedJobs(LABEL), 2);
  assert.equal(calls.find((c) => c.path === path.jobs(3)).etag, undefined);
  assert.ok(!calls.slice(4).some((c) => c.path === path.jobs(1)), "run 1 left the lists and is not read");
  // Back in a list, run 1 is read as new: nothing was kept for it.
  state[path.queued] = runs([1, 3]);
  await github.queuedJobs(LABEL);
  assert.equal(calls.filter((c) => c.path === path.jobs(1)).at(-1).etag, undefined);
});

test("what is kept is per label: another label is never answered from it", async () => {
  const { calls, fetchFn } = fakeGithub(queue());
  const github = makeGithub({ repo: REPO, label: LABEL, token: () => "t", fetchFn });
  assert.equal(await github.queuedJobs(LABEL), 2);
  assert.equal(await github.queuedJobs("ubuntu-latest"), 1);
  const second = calls.slice(4);
  assert.ok(second.filter((c) => c.path.includes("/jobs?")).every((c) => c.etag === undefined));
});

test("writes and one-off reads never carry an ETag", async () => {
  const { calls, fetchFn } = fakeGithub({
    [`/repos/${REPO}/actions/runs/7/attempts/1/jobs?per_page=100`]: jobs(
      { conclusion: "failure", labels: [LABEL], steps: [{ status: "in_progress" }] },
      { conclusion: "failure", labels: [LABEL], steps: [{ status: "completed" }] },
      { conclusion: "failure", labels: ["ubuntu-latest"], steps: [{ status: "in_progress" }] },
    ),
    [`/repos/${REPO}/actions/runs/7/rerun-failed-jobs`]: {},
  });
  const github = makeGithub({ repo: REPO, label: LABEL, token: () => "t", fetchFn });
  assert.equal(await github.lostJobs(7, 1), 1);
  assert.equal(await github.lostJobs(7, 1), 1);
  assert.equal(await github.rerunFailed(7), undefined);
  assert.ok(calls.every((c) => c.etag === undefined));
  assert.equal(calls.at(-1).method, "POST");
});

test("a refusal says why and when the allowance comes back", async () => {
  const { fetchFn } = fakeGithub(queue(), {
    fail: { status: 403, body: { message: "API rate limit exceeded for user ID 1." }, headers: { "x-ratelimit-remaining": "0" } },
  });
  const github = makeGithub({ repo: REPO, label: LABEL, token: () => "t", fetchFn });
  await assert.rejects(github.idleRunners(LABEL), (e) => {
    assert.equal(e.message, `GitHub 403 on GET ${path.runners}: API rate limit exceeded for user ID 1.; 0 left, resets 20:09:38Z`);
    return true;
  });
  assert.deepEqual(github.take(), { billed: 1, free: 0, remaining: 0 });
});

test("a secondary limit's retry-after is reported too", async () => {
  const { fetchFn } = fakeGithub(queue(), {
    fail: { status: 403, body: { message: "You have exceeded a secondary rate limit." }, headers: { "retry-after": "60" } },
  });
  const github = makeGithub({ repo: REPO, label: LABEL, token: () => "t", fetchFn });
  await assert.rejects(github.queuedJobs(LABEL), /secondary rate limit\.; 3999 left, resets 20:09:38Z; retry after 60s$/);
});
