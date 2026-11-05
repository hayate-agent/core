import { Editor, Input, SelectList, ProcessTerminal, Text, TuiAltScreen, VStack, ScrollView, matchesKey, truncateToWidth, type Component, type Terminal } from "@earendil-works/pi-tui";
import { taskContextLabel, activityExecutionLabel, executionMetadata, type ExecutionMetadata } from "../builtin-plugins/execution-metadata.js";
import { ConversationTranscript } from "./transcript.js";
import { tint, type TranscriptEntry, type MessageKind } from "./presentation.js";
import type { LocalSessions } from "../local-sessions.js";
import type { PluginPanel, PluginUI, PluginWidget } from "../plugins.js";
import type { Address, Channel, Inbound, TurnEvent, LoginUI, SendMeta } from "../types.js";

export interface TuiOptions {
  agent: string;
  color?: boolean;
  sessions?: LocalSessions;
  canSwitchSession?: () => boolean;
  /** Snapshot the old owner before creating a different conversation. */
  remainingWorkNotice?: () => string;
  panels?: () => Iterable<PluginPanel>;
  status: () => string;
  workState?: () => { running: boolean; queued: number };
  model?: () => string;
  reasoning?: () => string;
  prepareSession?: () => Promise<void>;
  quit: () => void;
  terminal?: Terminal;
  models?: () => Promise<string[]>;
  login?: (ui: LoginUI) => Promise<void>;
}

/** UI only: every conversation input and command goes through Harness.accept. */
export class HarnessTuiChannel implements Channel {
  readonly name = "console"; // same trusted local identity and persisted reply address
  private get sessionKey(): string { return this.opts.sessions?.current?.key ?? "console:local"; }
  private get address(): Address { return { channel: "console", target: this.opts.sessions ? this.sessionKey : "local" }; }
  private readonly tui;
  private readonly header = new Text();
  private readonly modelFooter: Component = {
    render: (width) => this.opts.model ? [truncateToWidth(` Model: ${this.opts.model()}${this.opts.reasoning ? ` · Reasoning: ${this.opts.reasoning()}` : ""}`, width)] : [],
    invalidate: () => {},
  };
  private readonly transcript = new ConversationTranscript();
  private readonly conversationScroll = new ScrollView(this.transcript, { follow: "end", primary: true });
  private readonly activity = new Text();
  private routineStatus = "";
  readonly editableProgress = true;
  private readonly panelText = new Text();
  private readonly editor;
  private readonly layout;
  private readonly bottom = new VStack();
  private lines: TranscriptEntry[] = [];
  private get color(): boolean { return this.opts.color ?? (process.env.NO_COLOR === undefined && process.env.TERM !== "dumb"); }
  private partial = "";
  private working = false;
  private execution?: ExecutionMetadata;
  private executionState: "pending" | "observed" | "unavailable" = "pending";
  private classifiers = new Map<string, { target: string; label: string }>();
  private pendingSubmissions = 0;
  private startedAt = 0;
  private finishedAt = 0;
  private completedTools = 0;
  private failedTools = 0;
  private outcome?: SendMeta["outcome"];
  private readonly activeTools = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private live = false;
  private cancelDialog?: () => void;
  private dialog?: Component;
  private uiBusy = false;

  constructor(private readonly opts: TuiOptions) {
    this.tui = new TuiAltScreen(opts.terminal ?? new ProcessTerminal(), false, undefined, {
      scrollToEndIndicator: () => tint(" ↓ Jump to latest · Ctrl+End ", "1;36", this.color),
    });
    const plain = (s: string) => s;
    this.editor = new Editor(this.tui, {
      borderColor: (s) => tint(s, "2", this.color),
      selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
    });
    this.bottom.addChild(this.panelText, { maxSize: 4 });
    this.bottom.addChild(this.activity, { maxSize: 3 });
    this.bottom.addChild(this.editor, { maxSize: 8 });
    this.layout = new VStack([
      { component: this.header, shrink: 0, maxSize: 4 },
      { component: this.conversationScroll, grow: 1, minSize: 1 },
      { component: this.bottom, shrink: 0 },
      { component: this.modelFooter, shrink: 0, maxSize: 1 },
    ]);
    this.tui.setLayoutRoot(this.layout);
    this.tui.setFocus(this.editor);
  }

  async start(deliver: (input: Inbound) => Promise<void>): Promise<void> {
    this.live = true;
    await this.opts.prepareSession?.().catch((err) => this.note(`Session initialization failed: ${err instanceof Error ? err.message : err}`));
    this.editor.onSubmit = (raw) => {
      if (this.uiBusy) return;
      const text = raw.trim();
      if (!text) return;
      this.editor.setText("");
      this.editor.addToHistory(text);
      if (text === "/quit" || text === "/exit") { this.opts.quit(); return; }
      if (this.opts.sessions && /^\/(new|reset|sessions|resume|title)(\s|$)/.test(text)) {
        this.uiBusy = true;
        void this.sessionCommand(text).then(() => this.opts.prepareSession?.()).catch((err) => this.note(String(err instanceof Error ? err.message : err), "error"))
          .finally(() => { this.uiBusy = false; });
        return;
      }
      if (text === "/login" || text === "/model") {
        this.uiBusy = true;
        void (async () => {
          if (text === "/login") {
            if (!this.opts.login) throw new Error("Runtime login is not available");
            await this.opts.login({ prompt: (m, secret) => this.prompt(m, secret), select: (m, choices) => this.select(m, choices), notify: (m) => this.note(m) });
            this.note("Signed in successfully.", "success");
          } else {
            const models = await this.opts.models?.() ?? [];
            const ref = await this.select("Select model", models.map((id) => ({ id, label: id })));
            await deliver({ sessionKey: this.sessionKey, text: `/model ${ref}`, source: "channel", replyTo: this.address });
          }
        })().catch((err) => this.note(err instanceof Error ? err.message : String(err), "error")).finally(() => { this.uiBusy = false; });
        return;
      }
      this.pendingSubmissions++;
      this.append(text, "user");
      void deliver({ sessionKey: this.sessionKey, text, source: "channel", replyTo: this.address, sender: process.env.USER ?? "console" })
        .catch((err) => this.note(`Input failed: ${err instanceof Error ? err.message : err}`, "error"))
        .finally(() => { this.pendingSubmissions--; this.render(); });
    };
    this.tui.addInputListener((data) => {
      if (!this.dialog && matchesKey(data, "ctrl+end")) {
        this.conversationScroll.scrollToEnd();
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+c")) { if (this.cancelDialog) this.cancelDialog(); else this.opts.quit(); return { consume: true }; }
      return undefined;
    });
    if (this.opts.sessions?.current) this.note(`New session: ${this.opts.sessions.current.id}\nWorkspace: ${this.opts.sessions.workspace}\nNo previous conversation loaded. /sessions · /resume <id> · /new [title]`);
    this.render();
    this.tui.start();
    this.timer = setInterval(() => this.render(), 100);
    this.timer.unref();
  }

  private async sessionCommand(text: string): Promise<void> {
    const store = this.opts.sessions!;
    const [command, ...rest] = text.split(/\s+/);
    const argument = rest.join(" ");
    if (command === "/sessions") {
      const rows = await store.list();
      this.note(`Sessions in ${store.workspace}:\n${rows.map((s) => `${s.id === store.current?.id ? "*" : " "} ${s.title} · ${s.updatedAt ?? s.createdAt} · ${s.id}`).join("\n")}\n/resume <id> to continue explicitly; /new [title] for a fresh conversation.`);
      return;
    }
    if (this.opts.canSwitchSession && !this.opts.canSwitchSession()) throw new Error("Cannot switch sessions while work is running or queued. Finish it or use /stop first.");
    if (command === "/title") {
      await store.rename(argument);
      this.note(`Session title: ${store.current!.title}`);
      return;
    }
    if (command === "/resume") {
      const rows = await store.list();
      const id = argument || await this.select("Resume a session in this workspace", rows.map((s) => ({ id: s.id, label: `${s.title} · ${s.updatedAt ?? s.createdAt} · ${s.id.slice(0, 8)}` })));
      const row = rows.find((s) => s.id === id);
      if (!row) throw new Error("Session not found in this workspace; use /sessions");
      const history = await store.history(row);
      await store.resume(id);
      this.lines = history.slice(-80).map((text) => ({ kind: text.startsWith("You: ") ? "user" : "assistant", text: text.replace(/^(You|Agent): /, "") }));
      this.resetActivity();
      this.note(`Resumed session: ${row.title} · ${row.id.slice(0, 8)}\nWorkspace: ${store.workspace}${history.length > 80 ? "\nShowing the last 80 conversation messages; older context may remain in the model history." : ""}`);
    } else {
      const remaining = this.opts.remainingWorkNotice?.() ?? "Remaining-work inventory unavailable; old conversation work may continue.";
      const previous = store.current?.id;
      const row = await store.create(argument || "Untitled");
      this.lines = [];
      this.resetActivity();
      this.note(`New session: ${row.id} · ${row.title}\nWorkspace: ${store.workspace}\nNo previous conversation loaded.\n${remaining}\nOld work is not transferred here.${previous ? ` /resume ${previous} to manage the old owner.` : ""}`);
    }
    this.tui.resetTextSelection();
    this.conversationScroll.scrollToEnd();
    this.tui.requestRender();
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

  private append(text: string, kind: MessageKind = "assistant"): void {
    this.lines.push({ kind, text });
    // Do not drop earlier blocks during a live conversation: doing so moves a
    // scrolled-up reader's anchor even when follow-end is disabled.
    this.render();
  }

  note(text: string, kind: "info" | "success" | "error" = "info"): void { this.append(text, kind); }

  private resetActivity(): void {
    this.routineStatus = "";
    this.partial = "";
    this.execution = undefined;
    this.executionState = "pending";
    this.working = false;
    this.startedAt = 0;
    this.finishedAt = 0;
    this.completedTools = 0;
    this.failedTools = 0;
    this.outcome = undefined;
    this.activeTools.clear();
  }

  /** Called before opening the SDK session, including slow initialisation. */
  async typing(to: Address, on: boolean): Promise<void> {
    if (this.opts.sessions && to.target !== this.sessionKey) return;
    if (on) {
      this.resetActivity();
      this.working = true;
      this.startedAt = Date.now();
    } else {
      this.working = false;
      this.finishedAt = Date.now();
      // Keep the preview until durable delivery replaces it. Clearing it here briefly
      // collapses the transcript and can reset a reader's manually selected position.
      if (this.partial.trim() === "NO_REPLY") this.partial = "";
      this.activeTools.clear();
    }
    this.render();
  }

  private activityLabel(): string {
    const state = this.opts.workState?.();
    const busy = this.working || state?.running;
    const queued = state?.queued ?? 0;
    const elapsed = this.startedAt ? Math.max(0, ((busy ? Date.now() : this.finishedAt) - this.startedAt) / 1000).toFixed(1) : "0.0";
    const counts = this.completedTools ? ` · ${this.completedTools} tools completed${this.failedTools ? `, ${this.failedTools} failed` : ""}` : "";
    const queue = queued ? ` · ${queued} queued` : "";
    if (busy) {
      const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][Math.floor(Date.now() / 100) % 10];
      const tools = [...this.activeTools].map(([name, count]) => `${name}${count > 1 ? ` ×${count}` : ""}`);
      const phase = tools.length ? `Running: ${tools.slice(0, 2).join(", ")}${tools.length > 2 ? ` (+${tools.length - 2})` : ""}`
        : this.partial ? "Writing response" : "Working · waiting for model/SDK";
      return `${spinner} ${phase} · ${elapsed}s${counts}${queue} · ${activityExecutionLabel(this.execution, this.executionState)} · /stop`;
    }
    if (this.pendingSubmissions || queued) return `◌ Processing input${queue}`;
    if (this.startedAt) return `${this.outcome === "failed" ? "✕ Failed" : this.outcome === "cancelled" ? "■ Cancelled" : this.failedTools ? "⚠ Completed with tool errors" : "✓ Done"} · ${elapsed}s${counts}`;
    return "/help · /sessions · /resume · /new · /status · /goal · /quit";
  }

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
    panelLines.push(...[...this.classifiers.values()].filter(row => row.target === this.address.target).slice(-2).map(row => row.label));
    this.panelText.setText(panelLines.join("\n"));
    this.header.setText(`Hayate Agent · ${this.opts.agent}\n${this.opts.status()}${this.opts.sessions?.current ? `\nSession: ${this.opts.sessions.current.id} · ${this.opts.sessions.current.title} · ${this.opts.sessions.workspace}` : ""}`);
    // Stream into the scrollable conversation, leaving the status area compact.
    this.transcript.setEntries([...this.lines, ...(this.partial ? [{ kind: "assistant" as const, text: this.partial }] : [])], this.color);
    if (!this.dialog) this.activity.setText(tint(this.routineStatus || this.activityLabel(), this.outcome === "failed" || this.failedTools ? "31" : this.working || this.opts.workState?.().running || this.outcome === "cancelled" ? "33" : this.startedAt ? "32" : "2", this.color));
    this.tui.requestRender();
  }

  taskActivity(to: Address, event: import("../activity.js").ActivityEvent): void {
    if (this.opts.sessions && to.target !== this.sessionKey) return;
    const s = event.snapshot;
    const executionState = s.executionState ?? (s.phase === "starting" ? "pending" : "unavailable");
    if (s.role === "main") {
      this.execution = s.execution;
      this.executionState = executionState;
    }
    this.classifiers.set(s.id, { target: to.target, label: `${s.role === "dispatcher-classifier" ? "Dispatcher classifier" : s.role === "worker" ? "Worker" : "Main"} · ${taskContextLabel(s.parent ?? s.id, s.outputTags)} · ${s.phase} · ${activityExecutionLabel(s.execution, executionState)}` });
    while (this.classifiers.size > 16) this.classifiers.delete(this.classifiers.keys().next().value!);
    this.render();
  }

  turnEvent(_to: Address, event: TurnEvent): void {
    if (this.opts.sessions && _to.target !== this.sessionKey) return;
    if (event.type === "execution") {
      this.execution = executionMetadata(event.selection);
      this.executionState = this.execution.model && this.execution.thinking ? "observed" : "unavailable";
    } else if (this.executionState === "pending" && ["text", "tool", "usage"].includes(event.type)) this.executionState = "unavailable";
    if (event.type === "text") this.partial += event.delta;
    if (event.type === "tool") {
      const count = this.activeTools.get(event.name) ?? 0;
      if (event.phase === "start") this.activeTools.set(event.name, count + 1);
      else {
        if (count > 1) this.activeTools.set(event.name, count - 1);
        else this.activeTools.delete(event.name);
        this.completedTools++;
        if (event.error) this.failedTools++;
      }
    }
    this.render();
  }

  async send(_to: Address, text: string, meta?: SendMeta): Promise<void> {
    if (this.opts.sessions && _to.target !== this.sessionKey) {
      this.note(`Output for another session (${_to.target}); not added to this conversation.`);
      return;
    }
    if (meta?.presentation === "progress") {
      this.routineStatus = text;
      this.render();
      return;
    }
    this.routineStatus = "";
    this.partial = "";
    this.outcome = meta?.outcome;
    this.append(text, meta?.outcome === "failed" ? "error" : meta?.outcome === "cancelled" ? "cancelled" : "assistant");
  }

  async stop(): Promise<void> {
    this.live = false;
    this.resetActivity();
    this.cancelDialog?.();
    clearInterval(this.timer);
    this.tui.stop();
    await this.opts.sessions?.release();
  }
}
