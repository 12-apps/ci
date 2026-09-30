import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflows = new Map([
  ['monorepo-static', 5], ['monorepo-tests', 9],
  ['commitlint', 1], ['post-merge-regen', 3],
]);
const expected = "inputs.runner || vars.CI_RUNNER || 'ubuntu-latest'";

function expressions(source) {
  return [...source.matchAll(/^    runs-on: \$\{\{ (.*?) \}\}$/gm)].map((m) => m[1]);
}

function choose(expression, runner, inherited) {
  const values = { 'inputs.runner': runner, 'vars.CI_RUNNER': inherited };
  const operands = expression.split(' || ');
  for (const operand of operands) {
    assert.ok(Object.hasOwn(values, operand) || operand === "'ubuntu-latest'", operand);
    const value = operand === "'ubuntu-latest'" ? 'ubuntu-latest' : values[operand];
    if (value) return value;
  }
  return '';
}

function assertRouting(source, count) {
  const choices = expressions(source);
  assert.equal(choices.length, count, 'every expected job must declare runs-on');
  for (const expression of choices) {
    assert.equal(expression, expected, 'caller override must be first for every job');
    assert.equal(choose(expression, 'ubuntu-latest', 'future-pay-ci'), 'ubuntu-latest');
    assert.equal(choose(expression, 'ubuntu-24.04', 'future-pay-ci'), 'ubuntu-24.04');
    assert.equal(choose(expression, '', 'future-pay-ci'), 'future-pay-ci');
    assert.equal(choose(expression, '', ''), 'ubuntu-latest');
  }
}

for (const [name, count] of workflows) {
  const source = readFileSync(new URL(`../${name}.yml`, import.meta.url), 'utf8');
  test(`${name}: runner is an optional empty-default workflow-call string`, () => {
    const inputs = source.slice(source.indexOf('    inputs:\n'));
    const runner = /^      runner:\n([\s\S]*?)(?=^      [a-z]|^    [a-z])/m.exec(inputs)?.[1];
    assert.ok(runner, 'runner must be declared as a workflow-call input');
    assert.match(runner, /^        type: string$/m);
    assert.match(runner, /^        required: false$/m);
    assert.match(runner, /^        default: ''$/m);
  });
  test(`${name}: all ${count} jobs honor explicit public choice and retain private defaults`, () => {
    assertRouting(source, count);
  });
  test(`${name}: removing the override from any job is rejected`, () => {
    const jobs = expressions(source);
    for (let index = 0; index < jobs.length; index++) {
      let seen = 0;
      const mutated = source.replace(/^    runs-on: \$\{\{ (.*?) \}\}$/gm, (line) =>
        seen++ === index ? line.replace('inputs.runner || ', '') : line);
      assert.throws(() => assertRouting(mutated, count));
    }
  });
  test(`${name}: inherited-first regression would select the private fleet`, () => {
    const mutated = source.replaceAll(expected, "vars.CI_RUNNER || inputs.runner || 'ubuntu-latest'");
    assert.equal(choose(expressions(mutated)[0], 'ubuntu-latest', 'future-pay-ci'), 'future-pay-ci');
    assert.throws(() => assertRouting(mutated, count));
  });
}

test('the hosted self-test executes this routing suite', () => {
  const selfTest = readFileSync(new URL('../self-test.yml', import.meta.url), 'utf8');
  assert.match(selfTest, /^        run: node --test \.github\/workflows\/__tests__\/runner-override\.test\.mjs$/m);
});
