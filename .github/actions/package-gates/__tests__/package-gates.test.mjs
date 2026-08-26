import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseGates, runGates, main } from '../package-gates.mjs';

describe('parseGates', () => {
  it('reads LABEL|COMMAND, one per line', () => {
    assert.deepEqual(parseGates('A|echo a\nB|echo b'), [
      { label: 'A', command: 'echo a' },
      { label: 'B', command: 'echo b' },
    ]);
  });

  it('keeps pipes inside the COMMAND — only the FIRST separator splits', () => {
    // A gate that greps a build log is an ordinary gate; splitting on the last
    // pipe, or on every pipe, would silently truncate its command.
    assert.deepEqual(parseGates('Budget|pnpm build | grep -q ok'), [
      { label: 'Budget', command: 'pnpm build | grep -q ok' },
    ]);
  });

  it('skips blank lines and # comments', () => {
    assert.equal(parseGates('\n# why this gate exists\nA|echo a\n\n').length, 1);
  });

  it('trims surrounding whitespace from a YAML block scalar', () => {
    assert.deepEqual(parseGates('  A  |  echo a  '), [{ label: 'A', command: 'echo a' }]);
  });

  it('REFUSES a line with no separator rather than inventing a blank label', () => {
    assert.throws(() => parseGates('pnpm quality:seed-order'), /not LABEL\|COMMAND/);
  });

  it('refuses an empty label', () => {
    assert.throws(() => parseGates('|echo a'), /must both be non-empty/);
  });

  it('refuses an empty command', () => {
    assert.throws(() => parseGates('A|'), /must both be non-empty/);
  });

  it('refuses an empty gate list — running nothing must not read as passing', () => {
    assert.throws(() => parseGates(''), /no gates given/);
    assert.throws(() => parseGates('# only a comment'), /no gates given/);
    assert.throws(() => parseGates(undefined), /no gates given/);
  });
});

describe('runGates', () => {
  const silent = () => {};

  it('returns no failures when every gate exits 0', () => {
    const failed = runGates(parseGates('A|x\nB|y'), { run: () => 0, log: silent });
    assert.deepEqual(failed, []);
  });

  it('runs EVERY gate even after one fails', () => {
    // The load-bearing case. Aborting at the first failure turns one push into
    // four when a sweep trips several ratchets at once.
    const seen = [];
    const failed = runGates(parseGates('A|a\nB|b\nC|c'), {
      run: (command) => {
        seen.push(command);
        return command === 'a' ? 1 : 0;
      },
      log: silent,
    });
    assert.deepEqual(seen, ['a', 'b', 'c']);
    assert.deepEqual(failed.map((f) => f.label), ['A']);
  });

  it('collects every failure, not just the first', () => {
    const failed = runGates(parseGates('A|a\nB|b\nC|c'), {
      run: (command) => (command === 'b' ? 0 : 3),
      log: silent,
    });
    assert.deepEqual(failed.map((f) => f.label), ['A', 'C']);
    assert.deepEqual(failed.map((f) => f.code), [3, 3]);
  });

  it('reports the failure by LABEL, so the log names the property', () => {
    const lines = [];
    runGates(parseGates('A batched seed says what its order is|x'), {
      run: () => 2,
      log: (l) => lines.push(l),
    });
    assert.ok(
      lines.some((l) => l.includes('::error title=A batched seed says what its order is::')),
      `expected a titled error annotation, got:\n${lines.join('\n')}`,
    );
  });

  it('runs each gate from package-dir', () => {
    const dirs = [];
    runGates(parseGates('A|x'), { cwd: 'apps/web', run: (_c, cwd) => (dirs.push(cwd), 0), log: silent });
    assert.deepEqual(dirs, ['apps/web']);
  });
});

describe('main', () => {
  const silent = () => {};

  it('exits 0 when every gate passes', () => {
    assert.equal(main([], { GATES: "A|node -e ''" }, silent), 0);
  });

  it('exits 1 when a gate fails', () => {
    assert.equal(main([], { GATES: 'A|node -e "process.exit(4)"' }, silent), 1);
  });

  it('really runs the command — a stub that never spawned would pass this too', () => {
    // Guards the wiring, not the logic: `runGates` is tested with an injected
    // runner above, so without this nothing proves the default runner spawns.
    assert.equal(main([], { GATES: 'A|exit 7' }, silent), 1);
    assert.equal(main([], { GATES: 'A|exit 0' }, silent), 0);
  });

  it('names every failed gate in the summary', () => {
    const lines = [];
    main([], { GATES: 'A|exit 1\nB|exit 0\nC|exit 1' }, (l) => lines.push(l));
    const out = lines.join('\n');
    assert.match(out, /2 gate\(s\) failed:/);
    assert.match(out, /- A/);
    assert.match(out, /- C/);
    assert.doesNotMatch(out, /- B/);
  });
});
