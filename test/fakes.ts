import type {
  Address,
  AgentRuntime,
  Channel,
  Inbound,
  OpenSessionOptions,
  PromptOptions,
  RuntimeSession,
  RuntimeSessionStatus,
  SendMeta,
  TurnEvent,
} from "../src/types.js";

export class FakeSession implements RuntimeSession {
  busy = false;
  prompts: string[] = [];
  options: PromptOptions[] = [];
  steered: string[] = [];
  aborted = 0;
  compacted = 0;
  model?: string;
  thinking?: string;
  title?: string;
  /** Hold the next prompt until release() is called. */
  private gate?: { promise: Promise<void>; release: () => void };

  constructor(
    readonly key: string,
    private readonly answer: (text: string, key: string) => string,
  ) {}

  hold(): () => void {
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    this.gate = { promise, release };
    return release;
  }

  async prompt(text: string, options: PromptOptions = {}): Promise<string> {
    this.busy = true;
    this.prompts.push(text);
    this.options.push(options);
    options.onEvent?.({ type: "text", delta: "…" });
    try {
      if (this.gate) {
        const g = this.gate;
        await g.promise;
        if (this.gate === g) this.gate = undefined;
      }
      return this.answer(text, this.key);
    } finally {
      this.busy = false;
    }
  }
  async steer(text: string): Promise<void> {
    this.steered.push(text);
  }
  async abort(): Promise<void> {
    this.aborted++;
    this.gate?.release();
  }
  async compact(): Promise<void> {
    this.compacted++;
  }
  async setModel(ref: string): Promise<void> {
    this.model = ref;
  }
  setThinking(level: string): void {
    this.thinking = level;
  }
  setTitle(title: string): void {
    this.title = title;
  }
  status(): RuntimeSessionStatus {
    return { sessionId: `s-${this.key}`, busy: this.busy, model: this.model, thinking: this.thinking, messages: this.prompts.length * 2 };
  }
  dispose(): void {}
}

export class FakeRuntime implements AgentRuntime {
  readonly name = "fake";
  sessions = new Map<string, FakeSession>();
  opened: Array<{ key: string; fresh: boolean }> = [];
  reloads = 0;
  constructor(public answer: (text: string, key: string) => string = (t) => `echo: ${t}`) {}
  async open(key: string, options: OpenSessionOptions = {}): Promise<RuntimeSession> {
    this.opened.push({ key, fresh: !!options.fresh });
    const s = new FakeSession(key, (t, k) => this.answer(t, k));
    this.sessions.set(key, s);
    return s;
  }
  async reload(): Promise<void> {
    this.reloads++;
  }
}

export class MemoryChannel implements Channel {
  readonly name = "mem";
  sent: Array<{ to: Address; text: string; meta?: SendMeta }> = [];
  events: Array<{ to: Address; event: TurnEvent }> = [];
  /** Opt-in: only channels that implement turnEvent receive progress. */
  streams = false;
  private deliver?: (i: Inbound) => Promise<void>;
  async start(deliver: (i: Inbound) => Promise<void>): Promise<void> {
    this.deliver = deliver;
  }
  async send(to: Address, text: string, meta?: SendMeta): Promise<void> {
    this.sent.push({ to, text, meta });
  }
  turnEvent = (to: Address, event: TurnEvent): void => {
    if (this.streams) this.events.push({ to, event });
  };
  async stop(): Promise<void> {}
  texts(): string[] {
    return this.sent.map((s) => s.text);
  }
}

export const ROOM: Address = { channel: "mem", target: "room1" };

export function msg(text: string, sender = "@owner:x", sessionKey = "mem:room1"): Inbound {
  return { sessionKey, text, source: "channel", sender, replyTo: ROOM };
}
