import { Editor, Input, SelectList, ProcessTerminal, Text, TuiAltScreen, VStack, ScrollView, matchesKey, truncateToWidth, type Component, type Terminal } from "@earendil-works/pi-tui";
import type { PluginPanel, PluginUI, PluginWidget } from "../plugins.js";
import type { Address, Channel, Inbound, TurnEvent, LoginUI } from "../types.js";

export interface TuiOptions {
  agent: string;
  panels?: () => Iterable<PluginPanel>;
  status: () => string;
  quit: () => void;
  terminal?: Terminal;
  models?: () => Promise<string[]>;
  login?: (ui: LoginUI) => Promise<void>;
}

/** UI only: every conversation input and command goes through Harness.accept. */
export class HarnessTuiChannel implements Channel {
  readonly name = "console"; // same trusted local identity and persisted reply address
  private readonly address: Address = { channel: "console", target: "local" };
  private readonly tui;
  private readonly header = new Text();
  private readonly transcript = new Text();
  private readonly activity = new Text();
  private readonly panelText = new Text();
  private readonly editor;
  private readonly layout;
  private readonly bottom = new VStack();
  private lines: string[] = [];
  private partial = "";
  private timer?: NodeJS.Timeout;
  private live = false;
  private cancelDialog?: () => void;
  private dialog?: Component;
  private uiBusy = false;

  constructor(private readonly opts: TuiOptions) {
    this.tui = new TuiAltScreen(opts.terminal ?? new ProcessTerminal());
    const plain = (s: string) => s;
    this.editor = new Editor(this.tui, {
      borderColor: plain,
      selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
    });
    this.bottom.addChild(this.panelText, { maxSize: 4 });
    this.bottom.addChild(this.activity, { maxSize: 3 });
    this.bottom.addChild(this.editor, { maxSize: 8 });
    this.layout = new VStack([
      { component: this.header, shrink: 0, maxSize: 4 },
      { component: new ScrollView(this.transcript, { follow: "end", primary: true }), grow: 1, minSize: 1 },
      { component: this.bottom, shrink: 0 },
    ]);
    this.tui.setLayoutRoot(this.layout);
    this.tui.setFocus(this.editor);
  }

  async start(deliver: (input: Inbound) => Promise<void>): Promise<void> {
    this.live = true;
    this.editor.onSubmit = (raw) => {
      if (this.uiBusy) return;
      const text = raw.trim();
      if (!text) return;
      this.editor.setText("");
      this.editor.addToHistory(text);
      if (text === "/quit" || text === "/exit") { this.opts.quit(); return; }
      if (text === "/login" || text === "/model") {
        this.uiBusy = true;
        void (async () => {
          if (text === "/login") {
            if (!this.opts.login) throw new Error("Runtime login is not available");
            await this.opts.login({ prompt: (m, secret) => this.prompt(m, secret), select: (m, choices) => this.select(m, choices), notify: (m) => this.note(m) });
            this.note("Login completed.");
          } else {
            const models = await this.opts.models?.() ?? [];
            const ref = await this.select("Select model", models.map((id) => ({ id, label: id })));
            await deliver({ sessionKey: "console:local", text: `/model ${ref}`, source: "channel", replyTo: this.address });
          }
        })().catch((err) => this.note(err instanceof Error ? err.message : String(err))).finally(() => { this.uiBusy = false; });
        return;
      }
      this.append(`You: ${text}`);
      void deliver({ sessionKey: "console:local", text, source: "channel", replyTo: this.address, sender: process.env.USER ?? "console" })
        .catch((err) => this.note(`Input failed: ${err instanceof Error ? err.message : err}`));
    };
    this.tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) { if (this.cancelDialog) this.cancelDialog(); else this.opts.quit(); return { consume: true }; }
      return undefined;
    });
    this.render();
    this.tui.start();
    this.timer = setInterval(() => this.render(), 500);
    this.timer.unref();
  }

  private async dialogResult(message: string, component: Component, bind: (done: (value: string) => void, cancel: () => void) => void): Promise<string> {
    if (!this.live) throw new Error("TUI is not running");
    if (this.dialog) throw new Error("A dialog is already open");
    this.dialog = component;
    this.bottom.removeChild(this.editor);
    this.bottom.addChild(component, { maxSize: 12 });
    this.tui.setFocus(component);
    this.activity.setText(message);
    this.tui.requestRender();
    try {
      return await new Promise<string>((resolve, reject) => {
        const cancel = () => reject(new Error("Dialog cancelled"));
        this.cancelDialog = cancel;
        bind(resolve, cancel);
      });
    } finally {
      this.cancelDialog = undefined;
      this.dialog = undefined;
      this.bottom.removeChild(component);
      this.bottom.addChild(this.editor, { maxSize: 8 });
      this.tui.setFocus(this.editor);
      this.render();
    }
  }

  /** Only supplied to commands originating at the attached local console. */
  pluginUI(): PluginUI {
    return {
      prompt: (message, secret) => this.live ? this.prompt(message, secret) : Promise.reject(new Error("TUI is not running")),
      select: (message, choices) => this.live ? this.select(message, choices) : Promise.reject(new Error("TUI is not running")),
      confirm: async (message) => (await this.select(message, [{ id: "no", label: "No" }, { id: "yes", label: "Yes" }])) === "yes",
      custom: (message, widget) => this.custom(message, widget),
      notify: (message) => this.note(message),
    };
  }

  private custom(message: string, widget: PluginWidget): Promise<string> {
    if (!this.live) return Promise.reject(new Error("TUI is not running"));
    let done: (value: string) => void = () => {};
    let cancel: () => void = () => {};
    const component: Component = {
      render: (width) => {
        try {
          const lines = widget.render(width);
          if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) throw new Error("Invalid widget output");
          return lines.slice(0, 12).map((line) => truncateToWidth(line.slice(0, 4000).replace(/[\x00-\x1f\x7f-\x9f]/g, " "), width));
        } catch { cancel(); return ["Widget unavailable"]; }
      },
      invalidate: () => { try { widget.invalidate?.(); } catch { cancel(); } },
      handleInput: (data) => {
        if (matchesKey(data, "escape")) { cancel(); return; }
        try {
          const result = widget.handleInput(data);
          if (result && "cancel" in result) cancel();
          else if (result && "value" in result && typeof result.value === "string") done(result.value);
          this.tui.requestRender();
        } catch { cancel(); }
      },
    };
    return this.dialogResult(message, component, (resolve, reject) => { done = resolve; cancel = reject; });
  }

  private prompt(message: string, secret = false): Promise<string> {
    const input = new Input();
    if (secret) input.render = (width) => [truncateToWidth(`Secret: ${"*".repeat(input.getValue().length)}`, width)];
    return this.dialogResult(message, input, (done, cancel) => { input.onSubmit = done; input.onEscape = cancel; });
  }

  private select(message: string, choices: Array<{ id: string; label: string }>): Promise<string> {
    if (!choices.length) return Promise.reject(new Error("No configured choices available"));
    const plain = (s: string) => s;
    const list = new SelectList(choices.map((c) => ({ value: c.id, label: c.label })), 10,
      { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain });
    return this.dialogResult(message, list, (done, cancel) => { list.onSelect = (c) => done(c.value); list.onCancel = cancel; });
  }

  private append(text: string): void {
    this.lines.push(text);
    // Bound the display buffer; durable conversation history stays in runtime sessions.
    this.lines = this.lines.slice(-80);
    this.render();
  }

  note(text: string): void { this.append(`[Harness] ${text}`); }

  private render(): void {
    if (!this.live) return;
    const panelLines: string[] = [];
    for (const panel of this.opts.panels?.() ?? []) {
      if (panelLines.length >= 4) break;
      try {
        const lines = panel.render({ agent: this.opts.agent });
        if (!Array.isArray(lines) || lines.some((s) => typeof s !== "string")) throw new Error("Invalid panel output");
        panelLines.push(...lines.slice(0, 4 - panelLines.length).map((s) => s.slice(0, 500).replace(/[\x00-\x1f\x7f-\x9f]/g, " ")));
      } catch { panelLines.push(`[${panel.name}] panel unavailable`); }
    }
    this.panelText.setText(panelLines.join("\n"));
    this.header.setText(`VanillaCore Agent Harness · ${this.opts.agent}\n${this.opts.status()}`);
    this.transcript.setText(this.lines.join("\n\n"));
    if (!this.dialog) this.activity.setText(this.partial ? `${this.opts.agent}: ${this.partial.slice(-6000)}` : "/help · /status · /goal · /heartbeat · /cron · /quit");
    this.tui.requestRender();
  }

  turnEvent(_to: Address, event: TurnEvent): void {
    if (event.type === "text") this.partial = (this.partial + event.delta).slice(-6000);
    if (event.type === "tool") this.note(`Tool ${event.name}: ${event.phase}${event.error ? " (error)" : ""}`);
    this.render();
  }

  async send(_to: Address, text: string): Promise<void> {
    this.partial = "";
    this.append(`${this.opts.agent}: ${text}`);
  }

  async stop(): Promise<void> {
    this.live = false;
    this.cancelDialog?.();
    clearInterval(this.timer);
    this.tui.stop();
  }
}
