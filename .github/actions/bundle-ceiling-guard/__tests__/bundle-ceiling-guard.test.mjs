/**
 * The guard's own tests.
 *
 * A budget guard fails loudly in one direction and SILENTLY in the other: a rule
 * that stopped recognising a loosening would report "no unjustified loosening",
 * go green, and leave the ledger open to exactly the edit it exists to catch.
 * Nothing is red at any point. So the cases below pin both directions — every
 * shape that must fail, and every shape that must not.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findUnjustifiedLoosenings,
  parseLedger,
} from '../bundle-ceiling-guard.mjs';

const KEYS = { ceilingKeys: ['raw', 'brotli'], floorKeys: ['chunks'] };
const WHY =
  'PIX QR rendering moved onto the first paint: the shopper cannot pay without it, so deferring it would trade bytes for a broken checkout.';

const ledger = (surfaces, extra = {}) => ({ surfaces, ...extra });
const surface = (over = {}) => ({ dist: 'apps/client/dist', raw: 700, brotli: 200, chunks: 4, ...over });

const run = (base, head) => findUnjustifiedLoosenings({ base, head, ...KEYS });

test('an unchanged ledger is clean', () => {
  assert.deepEqual(run(ledger({ s: surface() }), ledger({ s: surface() })), []);
});

test('tightening is free, in every direction the gate cares about', () => {
  const head = ledger({ s: surface({ raw: 650, brotli: 180, chunks: 6 }) });
  assert.deepEqual(run(ledger({ s: surface() }), head), []);
});

test('a raised ceiling with no justification fails, naming the move', () => {
  const violations = run(ledger({ s: surface() }), ledger({ s: surface({ raw: 760 }) }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /`raw` raised \(700 → 760\)/);
  assert.match(violations[0], /no `loosened` block records why/);
});

test('a lowered FLOOR fails too — recombining chunks moves no bytes', () => {
  const violations = run(ledger({ s: surface() }), ledger({ s: surface({ chunks: 1 }) }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /`chunks` lowered \(4 → 1\)/);
});

test('a raised ceiling WITH a matching, argued justification passes', () => {
  const head = ledger({ s: surface({ raw: 760, loosened: { raw: 760, why: WHY } }) });
  assert.deepEqual(run(ledger({ s: surface() }), head), []);
});

test('a justification that names a different value does not carry to the next raise', () => {
  // The whole point: yesterday's sentence must not cover today's regression.
  const head = ledger({ s: surface({ raw: 900, loosened: { raw: 760, why: WHY } }) });
  const violations = run(ledger({ s: surface() }), head);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /records 760, but the committed `raw` is 900/);
});

test('a justification for one key does not cover another', () => {
  const head = ledger({ s: surface({ raw: 760, brotli: 260, loosened: { raw: 760, why: WHY } }) });
  const violations = run(ledger({ s: surface() }), head);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /`brotli` raised/);
  assert.match(violations[0], /`loosened` does not mention `brotli`/);
});

test('a label is not an argument', () => {
  const head = ledger({ s: surface({ raw: 760, loosened: { raw: 760, why: 'bigger now' } }) });
  const violations = run(ledger({ s: surface() }), head);
  assert.match(violations[0], /a label, not an argument/);
});

for (const placeholder of ['TODO', 'tbd', 'n/a', 'temporary', 'WIP', 'fixme']) {
  test(`"${placeholder}" is rejected however long the padding after it`, () => {
    const why = `${placeholder} — will sort this out in a follow-up ticket some time soon.`;
    const head = ledger({ s: surface({ raw: 760, loosened: { raw: 760, why } }) });
    const violations = run(ledger({ s: surface() }), head);
    assert.equal(violations.length, 1, `expected "${placeholder}" to be refused`);
    assert.match(violations[0], /placeholder/);
  });
}

test('a bare "because" is a placeholder; "Because <argument>" is not', () => {
  // Only the bare form is refused. An author who opens with "Because ..." and
  // then gives the reason has written the thing this gate is asking for, and a
  // rule that rejected them would be teaching worse prose, not better limits.
  const bare = ledger({ s: surface({ raw: 760, loosened: { raw: 760, why: 'because' } }) });
  assert.match(run(ledger({ s: surface() }), bare)[0], /placeholder/);

  const argued = ledger({
    s: surface({
      raw: 760,
      loosened: {
        raw: 760,
        why: 'Because the checkout cannot render a PIX code without it, and deferring the QR encoder would break payment on first paint.',
      },
    }),
  });
  assert.deepEqual(run(ledger({ s: surface() }), argued), []);
});

test('a word that merely CONTAINS a placeholder mid-sentence is still an argument', () => {
  // Rejecting these would push authors toward vaguer prose, not clearer.
  const why =
    'The vendor bundle is inlined here until the temporary polyfill shim can be dropped, which needs the Safari 17 floor.';
  const head = ledger({ s: surface({ raw: 760, loosened: { raw: 760, why } }) });
  assert.deepEqual(run(ledger({ s: surface() }), head), []);
});

test('deleting a surface is a loosening — the loosest one available', () => {
  const violations = run(ledger({ s: surface() }), ledger({}));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /no longer in the ledger/);
  assert.match(violations[0], /retired\.s\.why/);
});

test('a retired surface with an argued why is accepted', () => {
  const head = ledger({}, { retired: { s: { why: WHY } } });
  assert.deepEqual(run(ledger({ s: surface() }), head), []);
});

test('a retired surface still needs an ARGUMENT, not a label', () => {
  const head = ledger({}, { retired: { s: { why: 'gone' } } });
  assert.match(run(ledger({ s: surface() }), head)[0], /a label, not an argument/);
});

test('dropping one key from a surface that survives is a loosening', () => {
  const { brotli, ...withoutBrotli } = surface();
  const violations = run(ledger({ s: surface() }), ledger({ s: withoutBrotli }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /no longer declares `brotli` \(was 200\)/);
});

test('a brand-new surface has no previous number to loosen', () => {
  const head = ledger({ s: surface(), fresh: surface({ raw: 999 }) });
  assert.deepEqual(run(ledger({ s: surface() }), head), []);
});

test('a key that is new on an existing surface is a new baseline, not a loosening', () => {
  const { brotli, ...withoutBrotli } = surface();
  assert.deepEqual(run(ledger({ s: withoutBrotli }), ledger({ s: surface() })), []);
});

test('every loosening in one diff is reported, not just the first', () => {
  const violations = run(
    ledger({ a: surface(), b: surface() }),
    ledger({ a: surface({ raw: 800 }), b: surface({ brotli: 300, chunks: 2 }) }),
  );
  assert.equal(violations.length, 3);
});

test('keys the caller did not declare are not policed', () => {
  // `measured` moves on every build by design; only declared keys are limits.
  const head = ledger({ s: surface({ measured: { raw: 9_999 } }) });
  assert.deepEqual(run(ledger({ s: surface({ measured: { raw: 1 } }) }), head), []);
});

test('a non-numeric ceiling is not compared as one', () => {
  const head = ledger({ s: surface({ raw: 'lots' }) });
  const violations = run(ledger({ s: surface() }), head);
  // Treated as "the limit is gone", which is the fail-closed reading.
  assert.match(violations[0], /no longer declares `raw`/);
});

test('parseLedger refuses what it cannot compare, with a reason', () => {
  assert.throws(() => parseLedger('{oops', 'x.json'), /is not valid JSON/);
  assert.throws(() => parseLedger('[]', 'x.json'), /must be a JSON object/);
  assert.throws(() => parseLedger('{}', 'x.json'), /no `surfaces` object/);
});

test('a `loosened` block that is not an object is not a justification', () => {
  const head = ledger({ s: surface({ raw: 760, loosened: 'yes' }) });
  assert.match(run(ledger({ s: surface() }), head)[0], /no `loosened` block records why/);
});
