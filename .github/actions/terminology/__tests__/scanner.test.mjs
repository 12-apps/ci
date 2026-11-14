/**
 * The literal scanner on its own: what it finds, what stands around each
 * literal, and above all that it never throws and never goes quiet. A scanner
 * that lost its place and reported nothing would make the gate pass on a file
 * nobody judged.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { scan } from "../lib/scanner.mjs";

/** The text of every chunk of every literal, in source order. */
const texts = (source) => {
  const { literals, error } = scan(source);
  assert.equal(error, null, `unexpected scan error: ${error?.message}`);
  return literals.map((literal) => literal.chunks.map((chunk) => source.slice(chunk.start, chunk.end)));
};

test("single and double quoted strings are found, escapes and all", () => {
  assert.deepEqual(texts(`const a = 'um'; const b = "dois";`), [["um"], ["dois"]]);
  assert.deepEqual(texts(String.raw`x = 'it\'s'; y = "say \"hi\""; z = "back\\";`), [[String.raw`it\'s`], [String.raw`say \"hi\"`], ["back\\\\"]]);
  assert.deepEqual(texts(`x = "the other 'quote' inside"; y = 'and "this" one';`), [["the other 'quote' inside"], ['and "this" one']]);
  assert.deepEqual(texts(`x = "continued \\\nline";`), [["continued \\\nline"]], "a line continuation stays inside the string");
});

test("a template literal yields its text chunks, and its expressions are scanned as code", () => {
  assert.deepEqual(texts("x = `plain`;"), [["plain"]]);
  assert.deepEqual(texts("x = `a ${b} c ${d}`;"), [["a ", " c ", ""]]);
  // The literals inside an expression are literals of their own, in source order.
  assert.deepEqual(texts('x = `one ${n > 1 ? "many" : `just ${"one"}`} end`;'), [["one ", " end"], ["many"], ["just ", ""], ["one"]]);
  // A brace inside an expression does not close it.
  assert.deepEqual(texts('x = `a ${fn({ k: "v" })} b`;'), [["a ", " b"], ["v"]]);
  assert.deepEqual(texts("x = `two\nlines and an escaped \\` and \\${not}`;"), [["two\nlines and an escaped \\` and \\${not}"]]);
});

test("each chunk knows whether an expression touches it", () => {
  const { literals } = scan("x = `a${b}c`;");
  assert.deepEqual(
    literals[0].chunks.map(({ afterExpr, beforeExpr }) => [afterExpr, beforeExpr]),
    [
      [false, true],
      [true, false],
    ],
  );
});

test("comments are reported as comments, and a quote inside one opens nothing", () => {
  const source = `// it's a comment\nconst a = "kept"; /* don't "open" */ const b = 'also';\n`;
  const { literals, comments, error } = scan(source);
  assert.equal(error, null);
  assert.deepEqual(
    literals.map((l) => source.slice(l.start, l.end)),
    ['"kept"', "'also'"],
  );
  assert.deepEqual(
    comments.map((c) => source.slice(c.start, c.end)),
    ["// it's a comment", `/* don't "open" */`],
  );
  assert.deepEqual(texts(`const url = "http://example.com"; // not a comment inside the string`), [["http://example.com"]]);
});

test("a regex literal holding a quote is stepped over", () => {
  assert.deepEqual(texts(`const re = /"/g; const s = "after";`), [["after"]]);
  assert.deepEqual(texts(`if (/['"]/.test(x)) y = "after";`), [["after"]]);
  assert.deepEqual(texts(`return /[/"]+\\//.test(x) ? "a" : "b";`), [["a"], ["b"]]);
  assert.deepEqual(texts(`x = s.replace(/'/g, "\\\\'");`), [["\\\\'"]]);
});

test("a division is not a regex literal", () => {
  assert.deepEqual(texts(`const half = total / 2; const s = "a/b"; const t = width / "2" / count;`), [["a/b"], ["2"]]);
  assert.deepEqual(texts(`const r = (a + b) / 2 + items[0] / "3";`), [["3"]]);
  assert.deepEqual(texts(`i++ / 2; label = "x";`), [["x"]]);
});

test("the tokens around a literal are recorded", () => {
  const context = (source) => {
    const [literal] = scan(source).literals;
    return [literal.prev2?.text ?? null, literal.prev?.text ?? null, literal.next];
  };
  assert.deepEqual(context(`import x from "./y";`), ["x", "from", ";"]);
  assert.deepEqual(context(`require("./y")`), ["require", "(", ")"]);
  assert.deepEqual(context(`({ "key": 1 })`), ["(", "{", ":"]);
  assert.deepEqual(context(`({ "key" /* note */ : 1 })`), ["(", "{", ":"], "a comment before the colon is skipped");
  assert.deepEqual(context(`type T = { a: b, "key"?: string }`), ["b", ",", ":"], "an optional member is still a key");
  assert.deepEqual(context(`x === "value"`), ["x", "===", ""]);
  assert.deepEqual(context(`"value" !== x`), [null, null, "!=="]);
  assert.deepEqual(context(`x != "value"`), ["x", "!=", ""]);
  assert.deepEqual(context(`"value" == x`), [null, null, "=="]);
  assert.deepEqual(context(`a ? "then" : b`), ["a", "?", ":"]);
  assert.deepEqual(context("f(`tpl`)"), ["f", "(", ")"]);
  // Inside an expression nothing stands before the first token.
  assert.deepEqual(scan('`${"inner"}`').literals.find((l) => l.kind === "string").prev, null);
});

test("what it cannot follow is reported with where it lost the thread, never judged in part", () => {
  const lost = (source) => {
    const { literals, error } = scan(source);
    assert.deepEqual(literals, [], "no literal is returned from a file the scanner could not follow");
    return [error.message, source.slice(0, error.offset).split("\n").length];
  };
  assert.deepEqual(lost(`const ok = "fine";\nconst broken = "no end;\nconst next = 1;`), ["a string literal is never closed on its line", 2]);
  assert.deepEqual(lost("const a = 1;\nconst t = `never closed ${a}\n"), ["a template literal is never closed", 2]);
  assert.deepEqual(lost("const t = `open ${ a + `inner` \n"), ["a template literal is never closed", 1]);
  assert.deepEqual(lost("ok();\n/* never closed\n"), ["a block comment is never closed", 2]);
  // JSX text is not a literal: an apostrophe in it reads as an unclosed string.
  assert.deepEqual(lost(`const a = "fine";\nconst el = <p>copo d'água</p>;\n`), ["a string literal is never closed on its line", 2]);
  // A regex after `)` reads as a division, so the quote inside it fails the file: the safe direction.
  assert.deepEqual(lost(`if (x) /"/.test(y);\n`), ["a string literal is never closed on its line", 1]);
});

test("it is total: odd input returns a result and never throws", () => {
  const odd = ["", "\\", "`", "${", "}", "}}}", "'", '"', "/", "/*", "//", "`${`${`${", "\u0000\u0001", "a ?? b ?. c", "#!/usr/bin/env node\nx", "x = y /\n", "\ud83d", "`${}`"];
  for (const source of odd) {
    const result = scan(source);
    assert.equal(typeof result, "object");
    assert.equal(Array.isArray(result.literals), true, JSON.stringify(source));
    assert.equal(result.error === null || typeof result.error.message === "string", true);
  }
  // Nesting deeper than anything real does not overflow the stack.
  const deep = `${"`${".repeat(5000)}"x"${"}`".repeat(5000)}`;
  assert.equal(scan(deep).error, null);
  assert.equal(scan(deep).literals.length, 5001);
});
