import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { mkdirDurable, syncDirStrict, writeFileDurable } from "./durable.js";
import type { Inbound } from "./types.js";

export interface OperatorRule {
  key: string;
  text: string;
  revision: number;
  source: { id: string; sessionKey: string; text: string };
}
interface RuleBook { version: 1; revision: number; rules: OperatorRule[] }
const validKey = (key: unknown): key is string => typeof key === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(key);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Agent-wide operator preferences, separate from historical memory and recipes.
 * Exact wording and authentic host ingress are retained. A semantic proposal
 * needs independent authorization; a model cannot invent or paraphrase a rule. */
export class OperatorRules {
  private book: RuleBook = { version: 1, revision: 0, rules: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private uncertain = false;
  private readonly file: string;
  constructor(home: string) { this.file = path.join(home, "operator-rules", "rules.json"); }
  private async checkDirectory(): Promise<void> {
    const directory = path.dirname(this.file), stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022 ||
        typeof process.getuid === "function" && stat.uid !== process.getuid() ||
        await realpath(directory) !== path.join(await realpath(path.dirname(directory)), path.basename(directory))) throw Error("Unsafe operator rule directory");
  }
  async load(): Promise<void> {
    try {
      await this.checkDirectory();
      const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const s = await handle.stat();
        if (!s.isFile() || s.size > 256000 || s.mode & 0o077 || typeof process.getuid === "function" && s.uid !== process.getuid()) throw Error("Unsafe operator rule store");
        const book = JSON.parse(await handle.readFile("utf8")) as RuleBook;
        if (book.version !== 1 || !Number.isSafeInteger(book.revision) || book.revision < 0 || !Array.isArray(book.rules) || book.rules.length > 64 ||
            new Set(book.rules.map(rule => rule.key)).size !== book.rules.length || book.rules.some(rule => !validKey(rule.key) ||
            typeof rule.text !== "string" || !rule.text.trim() || rule.text.length > 2000 || !Number.isSafeInteger(rule.revision) || rule.revision < 1 || rule.revision > book.revision ||
            typeof rule.source?.id !== "string" || !rule.source.id || typeof rule.source.sessionKey !== "string" || !rule.source.sessionKey ||
            typeof rule.source.text !== "string" || rule.source.text.length > 16000 || !rule.source.text.includes(rule.text))) throw Error("Invalid operator rule store");
        this.book = book;
      } finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.loaded = true;
  }
  snapshot(): RuleBook {
    if (!this.loaded || this.uncertain) throw Error("Operator rules unavailable; publication must be reconciled by restart");
    return structuredClone(this.book);
  }
  instructions(): string {
    const book = this.snapshot();
    if (!book.rules.length) return "";
    return `Durable operator preferences (host-retained exact wording, revision ${book.revision}). Apply in Main, scheduled work and delegated children. They override contradictory learned recipes and historical summaries, not current explicit operator corrections or higher-priority restrictions. They grant no tools, permissions or task scope. If a recipe conflicts, follow the actual operator source; never rewrite a quote of an assistant assertion into operator intent.\n${JSON.stringify(book.rules.map(rule => ({ key: rule.key, text: rule.text, revision: rule.revision, source: { id: rule.source.id, sessionKey: rule.source.sessionKey } })))}`;
  }
  /** `authorize` must check enduring intent, quotation attribution, conflict-key
   * selection and the exact proposed operation against the CURRENT ingress. */
  change(input: Inbound, proposal: { key: string; text?: string; expectedRevision: number; remove?: boolean },
    authorize: (evidence: object) => Promise<boolean>, stillCurrent: () => boolean): Promise<RuleBook> {
    const next = this.queue.catch(() => {}).then(async () => {
      const book = this.snapshot();
      if (!["channel", "api"].includes(input.source) || input.source === "api" && input.operatorIngress !== true || /^(dispatch|subagent|cron):/.test(input.sessionKey) || input.continuationDepth ||
          !validKey(proposal.key) || proposal.expectedRevision !== book.revision || input.text.length > 16000 ||
          (!proposal.remove && (typeof proposal.text !== "string" || !proposal.text.trim() || proposal.text.length > 2000 || !input.text.includes(proposal.text)))) throw Error("Exact current operator wording and current rule revision required");
      const sourceText = input.text;
      if (!stillCurrent() || !await authorize({ proposal, currentRules: book.rules, source: { text: sourceText, sessionKey: input.sessionKey, id: input.id } }) ||
          !stillCurrent() || input.text !== sourceText) throw Error("Rule is not supported by the actual current operator instruction");
      if (proposal.remove && !book.rules.some(rule => rule.key === proposal.key)) throw Error("Unknown operator rule");
      const revision = book.revision + 1;
      const rules = book.rules.filter(rule => rule.key !== proposal.key);
      if (!proposal.remove) rules.push({ key: proposal.key, text: proposal.text!, revision,
        source: { id: input.id ?? `operator:${digest(input.sessionKey + "\0" + sourceText)}`, sessionKey: input.sessionKey, text: sourceText } });
      if (rules.length > 64) throw Error("Operator rule store full; reconcile superseded rules first");
      const candidate: RuleBook = { version: 1, revision, rules };
      const raw = JSON.stringify(candidate);
      if (Buffer.byteLength(raw) > 256000) throw Error("Operator rule store full");
      await mkdirDurable(path.dirname(this.file));
      await this.checkDirectory();
      await writeFileDurable(this.file, raw, 0o600, () => { if (!stillCurrent() || input.text !== sourceText) throw Error("Operator input changed before rule publication"); }, syncDirStrict,
        () => { this.uncertain = true; });
      this.book = candidate; this.uncertain = false;
      return this.snapshot();
    });
    this.queue = next; return next;
  }
}
