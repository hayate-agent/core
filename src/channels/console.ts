import { createInterface, type Interface } from "node:readline";
import type { Address, Channel, Inbound } from "../types.js";

/** Line-based stdin/stdout channel for local use and smoke tests. One conversation: "console:local". */
export class ConsoleChannel implements Channel {
  readonly name = "console";
  private rl?: Interface;
  private readonly address: Address = { channel: "console", target: "local" };

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
    private readonly user = process.env.USER ?? "console",
  ) {}

  async start(deliver: (input: Inbound) => Promise<void>): Promise<void> {
    this.rl = createInterface({ input: this.input, terminal: false });
    this.rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      void deliver({ sessionKey: "console:local", text, source: "channel", sender: this.user, replyTo: this.address }).catch((err) => this.output.write(`⚠️ ${err instanceof Error ? err.message : err}\n`));
    });
  }

  async send(_to: Address, text: string): Promise<void> {
    this.output.write(`${text}\n\n`);
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }
}
