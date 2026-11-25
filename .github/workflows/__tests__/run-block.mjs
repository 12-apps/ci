import { strict as assert } from "node:assert";

/** The `run: |` block of the step with this exact name, dedented. */
export function runBlock(text, name) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trimStart() === `- name: ${name}`);
  assert.ok(at >= 0, `the workflow has no step named "${name}"`);
  const stepIndent = lines[at].indexOf("-");
  let i = at + 1;
  while (i < lines.length && !/^\s*run: \|\s*$/.test(lines[i])) {
    const ind = lines[i].search(/\S/);
    assert.ok(ind === -1 || ind > stepIndent, `step "${name}" has no run: | block`);
    i++;
  }
  const body = [];
  let indent = -1;
  for (i += 1; i < lines.length; i++) {
    const line = lines[i];
    const ind = line.search(/\S/);
    if (ind === -1) { body.push(""); continue; }
    if (indent === -1) indent = ind;
    if (ind < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n").trimEnd() + "\n";
}
