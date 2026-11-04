#!/usr/bin/env node
/**
 * The memo `entriesForMatches` shares across the database router's calls
 * (`matchCache`) must change only how long the answer takes, never the answer.
 *
 * Measured on future-pay (integration lane, PR #4096's head): the router's
 * input pass called `entriesForMatches` once per migration — 567 of them, over
 * the same ~4,000 files and mostly the same models — and that repetition was
 * 94% of a 5m29s plan step. With the memo, the word index and the anchor
 * pre-filter the same plan took 48 s locally (from 8m38s) and wrote a
 * byte-identical document. These cases pin the "identical" half.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { entriesForMatches, identifierAlternation, matchCache, withAnchors } from "../lib/occurrences.mjs";

const texts = {
  "a.ts": "export function load() { return db.client.findMany({ where: { orderId: 1 } }); }\nexport const other = 1;\n",
  "b.ts": "const x = { client: true };\nexport function useIt() { return x; }\n",
  "c.ts": "export const label = 'CLIENT list';\nexport const orderIdish = 2;\n",
  "d.test.ts": "it('reads', () => db.client.findFirst());\n",
  "e.ts": "SELECT * FROM \"clients\" WHERE 1;\nexport const q = 1;\n",
  "f.ts": "export const fooBar = order_id;\n",
  "g.ts": "",
  "h.ts": "export const y = { Client: { select: 1 } };\n",
};
const files = Object.keys(texts);
const textOf = (f) => texts[f] || null;
const isTest = (f) => f.endsWith(".test.ts");

const mention = () =>
  withAnchors(
    /\.\s*client\s*\.\s*(?:findMany|findFirst)\s*\(|\bclient\s*:\s*(?:true\b|\{)|\b(?:FROM|JOIN)\s+"?clients"?(?![\w])/i,
    ["client", "client", "clients"],
  );
const specsOf = () => [
  { re: mention(), mentionRe: null },
  { re: /\b(?:orderId|order_id)\b/, mentionRe: mention() },
  { re: /\bfooBar\b/, mentionRe: null },
];

test("with or without the memo, the entries are the same, in the same order", () => {
  const plain = entriesForMatches({ files, textOf, isTest, specs: specsOf() });
  const cache = matchCache();
  const first = entriesForMatches({ files, textOf, isTest, specs: specsOf(), cache });
  const again = entriesForMatches({ files, textOf, isTest, specs: specsOf(), cache });
  assert.deepEqual(first, plain);
  assert.deepEqual(again, plain);
  assert.ok(plain.length > 0, "the fixture must select something to compare");
});

test("one memo serves calls with different specs over the same files", () => {
  const cache = matchCache();
  for (const specs of [[specsOf()[2]], specsOf(), [specsOf()[0]], [specsOf()[1]]]) {
    assert.deepEqual(entriesForMatches({ files, textOf, isTest, specs, cache }), entriesForMatches({ files, textOf, isTest, specs }));
  }
});

test("only a plain, case-sensitive identifier alternation takes the word index", () => {
  assert.deepEqual(identifierAlternation(/\b(?:orderId|order_id)\b/), ["orderId", "order_id"]);
  assert.deepEqual(identifierAlternation(/\bfooBar\b/), ["fooBar"]);
  for (const re of [/\b(?:a|b)\b/i, /\b(?:a.b)\b/, /\b(?:x|)\b/, /\bfoo\b|\bbar\b/, /foo/, /\b(?:a|b)\b/u]) {
    assert.equal(identifierAlternation(re), null, re.source);
  }
});

test("the word index agrees with the regex, `$` and Unicode included", () => {
  const tricky = { "x.ts": "const $orderId = 1; const orderIdé = 2;", "y.ts": "orderId$", "z.ts": "my_orderId" };
  const tf = (f) => tricky[f];
  const fs = Object.keys(tricky);
  const re = /\b(?:orderId)\b/;
  assert.deepEqual([...matchCache().matching(re, fs, tf)].sort(), fs.filter((f) => re.test(tricky[f])).sort());
});

test("an anchor pre-filter never drops a file the regex would match", () => {
  const re = mention();
  const fromCache = [...matchCache().matching(re, files, textOf)].sort();
  const direct = files.filter((f) => textOf(f) && re.test(textOf(f))).sort();
  assert.deepEqual(fromCache, direct);
  assert.ok(direct.includes("b.ts") && direct.includes("h.ts"), "case-insensitive anchors must still find `client:` and `Client:`");
});

test("an anchor that is not a plain identifier disables the hint instead of guessing", () => {
  const re = withAnchors(/order-items/i, ["order-items"]);
  const t = { "a.ts": "the ORDER-ITEMS table" };
  assert.deepEqual([...matchCache().matching(re, ["a.ts"], (f) => t[f])], ["a.ts"]);
});

test("a global pattern is probed statelessly, so the memo cannot depend on file order", () => {
  const re = /\bclient\b/g;
  const forward = [...matchCache().matching(re, files, textOf)].sort();
  const backward = [...matchCache().matching(re, [...files].reverse(), textOf)].sort();
  assert.deepEqual(forward, backward);
});
