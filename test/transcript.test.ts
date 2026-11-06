// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ConversationTranscript } from "../src/channels/transcript.js";

const sample = `# A heading

Some **bold** and *italic* text with \`inline code\`.

- first item
- second item

> quoted material

\`\`\`typescript
const answer = 42;
console.log(answer);
\`\`\`

| Name | Value |
| --- | --- |
| status | ready |

[Docs](https://example.org/docs)`;

test("assistant Markdown renders structure and styles, user input stays literal", () => {
  const transcript = new ConversationTranscript();
  transcript.setEntries([{ kind: "user", text: "Please explain **this**" }, { kind: "assistant", text: sample }], true);
  const lines = transcript.render(100);
  const rendered = lines.map(stripTerminalSequences).join("\n");
  assert.match(rendered, /❯ Please explain \*\*this\*\*/);
  assert.match(rendered, /Some bold and italic text with inline code/);
  assert.ok(!rendered.includes("**bold**"));
  assert.ok(!rendered.includes("```"));
  assert.ok(!rendered.includes("# A heading"));
  assert.match(rendered, /const answer = 42;/);
  assert.match(rendered, /console.log\(answer\);/);
  assert.match(rendered, /quoted material/);
  assert.match(rendered, /ready/);
  assert.match(lines.join("\n"), /\x1b\[1m/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 100));
});

test("Markdown supports narrow widths, Unicode, resize, unfinished streamed code and no color", () => {
  const transcript = new ConversationTranscript();
  for (const width of [1, 2, 12, 40, 120]) {
    transcript.setEntries([{ kind: "assistant", text: `${sample}\n\n日本語 🙂\n\n\`\`\`python\nprint('streaming')` }], false);
    const first = transcript.render(width);
    assert.ok(first.every((line) => visibleWidth(line) <= width), `width ${width}`);
    const before = first.join("\n");
    transcript.invalidate();
    assert.equal(transcript.render(width).join("\n"), before);
  }
  const rendered = transcript.render(120).map(stripTerminalSequences).join("\n");
  assert.match(rendered, /print\('streaming'\)/);
  assert.ok(!rendered.includes("**bold**"));
  assert.ok(!transcript.render(120).join("\n").includes("\x1b[35m"));
});

test("status refresh reuses parsed Markdown components when history has not changed", () => {
  const transcript = new ConversationTranscript();
  const entries = [{ kind: "assistant" as const, text: sample }];
  transcript.setEntries(entries, true);
  const first = (transcript as any).rows[0].component;
  transcript.render(80);
  transcript.setEntries(entries.map((entry) => ({ ...entry })), true);
  assert.equal((transcript as any).rows[0].component, first);
  transcript.setEntries([{ kind: "assistant", text: "new response" }], true);
  assert.notEqual((transcript as any).rows[0].component, first);
});
