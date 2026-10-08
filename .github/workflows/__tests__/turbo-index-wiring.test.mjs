import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../monorepo-tests.yml', import.meta.url), 'utf8');
const build = workflow.slice(workflow.indexOf('\n  build:'), workflow.indexOf('\n  integration-plan:'));
const step = name => {
  const start = build.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `missing ${name}`);
  const next = build.indexOf('\n      - name:', start + 1);
  return build.slice(start, next < 0 ? undefined : next);
};

test('lookup is advisory and retains the original payload path and prefix', () => {
  const s = step('Look up the exact turbo payload key');
  assert.match(s, /lookup-only: true/); assert.match(s, /continue-on-error: true/);
  assert.match(s, /path: \.turbo\n/); assert.match(s, /restore-keys: \|\n\s+turbo-build-/);
});
test('index restore is exact to the matched payload, without a prefix fallback', () => {
  const s = step('Restore the paired turbo hash index');
  assert.match(s, /key: turbo-hash-index-v1-\$\{\{ steps\.turbo-lookup\.outputs\.cache-matched-key \}\}/);
  assert.doesNotMatch(s, /restore-keys:/); assert.match(s, /continue-on-error: true/);
});
test('only affirmative zero overlap may skip payload restore, while the Build still runs', () => {
  const s = step('Restore turbo cache');
  assert.match(s, /outputs\.restore != 'false'/); assert.match(s, /actions\/cache\/restore@v4/);
  assert.match(s, /cache-matched-key \|\| format/); assert.match(s, /restore-keys: \|\n\s+turbo-build-/);
  assert.doesNotMatch(step('Build'), /turbo-index|turbo-lookup/);
  assert.match(step('Build'), /pnpm turbo run build --affected/);
  assert.match(step('Build'), /pnpm turbo run build 2>&1/);
});
test('payload and index writes share a unique run-attempt key and remain off PRs', () => {
  for (const name of ['Inventory the exact turbo payload to save','Save turbo cache','Save the index paired to this exact payload']) {
    const s = step(name); assert.match(s, /github\.event_name != 'pull_request'/);
    assert.match(s, /github\.sha.*github\.run_id.*github\.run_attempt/);
    assert.match(s, /lane-verdict\.outputs\.hit != 'true'/);
  }
  assert.match(step('Save the index paired to this exact payload'), /outputs\.ready == 'true'/);
});
test('index tests are actually invoked in the engine self-test workflow', () => {
  const self = readFileSync(new URL('../self-test.yml', import.meta.url), 'utf8');
  assert.match(self, /node --test \.github\/actions\/turbo-cache-index\/__tests__\/\*\.test\.mjs/);
  assert.match(self, /node --test \.github\/workflows\/__tests__\/turbo-index-wiring\.test\.mjs/);
});
