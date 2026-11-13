import { Markdown, Text, truncateToWidth, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { plainText, renderEntry, tint, type TranscriptEntry } from "./presentation.js";

function markdownTheme(color: boolean): MarkdownTheme {
  const style = (code: string) => (text: string) => tint(text, code, color);
  return {
    heading: style("1;35"), link: style("4;34"), linkUrl: style("2"),
    code: style("36"), codeBlock: style("36"),
    codeBlockBorder: (text) => tint(text === "```" ? "╰─" : `╭─ ${text.slice(3) || "code"}`, "2", color),
    quote: style("2"), quoteBorder: style("35"), hr: style("2"),
    listBullet: style("35"), bold: style("1"), italic: style("3"),
    strikethrough: style("9"), underline: style("4"),
  };
}

/** Reuse native Markdown/Text layout caches; the activity timer must not reparse history. */
export class ConversationTranscript implements Component {
  private rows: Array<{ entry: TranscriptEntry; component: Component }> = [];
  private color = false;

  setEntries(entries: TranscriptEntry[], color: boolean): void {
    const theme = markdownTheme(color);
    const old = this.color === color ? this.rows : [];
    this.rows = entries.map((entry, i) => {
      const previous = old[i];
      if (previous?.entry.kind === entry.kind && previous.entry.text === entry.text) return previous;
      const component = entry.kind === "assistant"
        ? new Markdown(plainText(entry.text), 0, 0, theme)
        : new Text(renderEntry(entry, color), 0, 0);
      return { entry: { ...entry }, component };
    });
    this.color = color;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const lines: string[] = [];
    for (const { entry, component } of this.rows) {
      if (lines.length) lines.push("");
      if (entry.kind === "assistant") {
        const available = Math.max(1, width - 2);
        const gutter = tint("│", "35", this.color);
        for (const line of component.render(available)) lines.push(truncateToWidth(`${gutter} ${line}`, width));
      } else {
        lines.push(...component.render(width));
      }
    }
    return lines;
  }

  invalidate(): void { for (const { component } of this.rows) component.invalidate(); }
}
