/**
 * PI runtime adapter. The only module that imports the PI SDK.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createMcpExtension,
  createCodemodeExtension,
  createToolSearchExtension,
  InteractiveMode,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentRuntime, OpenSessionOptions, PromptOptions, RuntimeSession, RuntimeSessionStatus, TurnEvent } from "../types.js";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Thinking = (typeof THINKING)[number];

/** Approval hook; resolve true to allow. Called only when the approval mode is "manual". */
export type ApprovalRequest = (sessionKey: string, tool: string, input: unknown) => Promise<boolean>;

export interface PiRuntimeOptions {
  cwd: string;
  /** Per-agent session store, one subdirectory per session key. */
  sessionsDir: string;
  model?: string;
  thinking?: string;
  /** Explicit active tool names, including extension tools; [] disables all tools. */
  tools?: string[];
  skillPaths: string[];
  /** Returns persona sections, read on every session open (so persona edits apply to new sessions). */
  personaSections: () => Promise<string[]>;
  /** "off" (default, YOLO) or "manual". Mutable at runtime via /approvals and /yolo. */
  approvals: { mode: "off" | "manual"; tools: string[] };
  requestApproval?: ApprovalRequest;
}

function parseModelRef(ref: string): { provider: string; id: string } {
  const i = ref.indexOf("/");
  if (i <= 0) throw new Error(`model must be "provider/model", got "${ref}"`);
  return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "default";
}

/** Per-turn system instructions, read by the session's inline extension (one turn at a time). */
interface TurnSlot {
  instructions?: string;
}

/** PI session event → harness turn event (undefined: not relevant). */
export function toTurnEvent(event: AgentSessionEvent): TurnEvent | undefined {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    return { type: "text", delta: event.assistantMessageEvent.delta };
  }
  if (event.type === "tool_execution_start") return { type: "tool", phase: "start", name: event.toolName };
  if (event.type === "tool_execution_end") {
    return { type: "tool", phase: "end", name: event.toolName, ...(event.isError ? { error: true } : {}) };
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    const m = event.message;
    return {
      type: "usage",
      model: `${m.provider}/${m.model}`,
      ...(m.thinkingLevel ? { thinking: m.thinkingLevel } : {}),
      input: m.usage.input,
      output: m.usage.output,
      cacheRead: m.usage.cacheRead,
      cacheWrite: m.usage.cacheWrite,
      costUsd: m.usage.cost.total,
    };
  }
  return undefined;
}

export class PiSession implements RuntimeSession {
  /** The prompt in progress; abort() during its setup (before generation) cancels it. */
  private turn?: { aborted: boolean };
  /** Per-turn overrides could not be undone: restore before the next turn runs. */
  private restore?: { model: NonNullable<AgentSession["model"]>; thinking: AgentSession["thinkingLevel"] };

  constructor(
    private readonly session: AgentSession,
    private readonly models: ModelRuntime,
    private readonly slot: TurnSlot,
  ) {}

  get busy(): boolean {
    return this.session.isStreaming;
  }

  async prompt(text: string, options: PromptOptions = {}): Promise<string> {
    const { onEvent, instructions, model, thinking } = options;
    const turn = { aborted: false };
    this.turn = turn;
    let unsubscribe: (() => void) | undefined;
    let prevModel: AgentSession["model"];
    let prevThinking: AgentSession["thinkingLevel"] | undefined;
    try {
      if (this.restore) {
        // Never run on a leftover override: fails this turn loudly until restoration works.
        await this.session.setModel(this.restore.model);
        this.session.setThinkingLevel(this.restore.thinking);
        this.restore = undefined;
      }
      prevModel = this.session.model;
      prevThinking = this.session.thinkingLevel;
      unsubscribe = onEvent
        ? this.session.subscribe((event) => {
            const mapped = toTurnEvent(event);
            if (mapped) onEvent(mapped);
          })
        : undefined;
      // Validate and apply every override before anything runs, then restore them afterwards
      // (the session's own model/thinking stay what /model and /reasoning set).
      if (model) await this.setModel(model);
      if (thinking) this.setThinking(thinking);
      this.slot.instructions = instructions?.trim() || undefined;
      // Aborted while setting up: nothing has run yet, so nothing runs.
      if (turn.aborted) return "";
      await this.session.prompt(text, { source: "rpc" });
      await this.session.waitForIdle();
    } finally {
      if (this.turn === turn) this.turn = undefined;
      this.slot.instructions = undefined;
      unsubscribe?.();
      // Model first: switching models may clamp the thinking level, which is restored after it.
      if (model && prevModel && this.session.model !== prevModel) {
        try {
          await this.session.setModel(prevModel);
        } catch {
          this.restore = { model: prevModel, thinking: prevThinking ?? this.session.thinkingLevel };
        }
      }
      if (!this.restore && (model || thinking) && prevThinking && this.session.thinkingLevel !== prevThinking) {
        this.session.setThinkingLevel(prevThinking);
      }
    }
    const last = this.session.messages.findLast((m) => m.role === "assistant");
    if (last?.role === "assistant" && last.stopReason === "error") {
      throw new Error(last.errorMessage || "model request failed");
    }
    return this.session.getLastAssistantText() ?? "";
  }

  async steer(text: string): Promise<void> {
    await this.session.steer(text);
  }

  async abort(): Promise<void> {
    if (this.turn) this.turn.aborted = true;
    await this.session.abort();
  }

  async compact(instructions?: string): Promise<void> {
    await this.session.compact(instructions);
  }

  async setModel(ref: string): Promise<void> {
    const { provider, id } = parseModelRef(ref);
    const model = this.models.getModel(provider, id);
    if (!model) throw new Error(`unknown model: ${ref}`);
    await this.session.setModel(model);
    this.restore = undefined;
  }

  setThinking(level: string): void {
    if (!(THINKING as readonly string[]).includes(level)) throw new Error(`thinking must be one of ${THINKING.join(", ")}`);
    this.session.setThinkingLevel(level as Thinking);
  }

  setTitle(title: string): void {
    this.session.setSessionName(title);
  }

  status(): RuntimeSessionStatus {
    const stats = this.session.getSessionStats();
    const usage = this.session.getContextUsage();
    const m = this.session.model;
    return {
      sessionId: this.session.sessionId,
      sessionFile: this.session.sessionFile,
      model: m ? `${m.provider}/${m.id}` : undefined,
      thinking: this.session.thinkingLevel,
      busy: this.busy,
      messages: stats.totalMessages,
      tokens: { input: stats.tokens.input, output: stats.tokens.output },
      contextPercent: usage?.percent ?? undefined,
    };
  }

  dispose(): void {
    this.session.dispose();
  }
}

/** Native PI UI, backed by one session runtime (including /new and /resume replacements). */
export async function runInteractive(opts: Pick<PiRuntimeOptions, "cwd" | "model" | "thinking" | "tools" | "skillPaths" | "personaSections">): Promise<void> {
  const agentDir = getAgentDir();
  const runtime = await createAgentSessionRuntime(async ({ cwd, sessionManager, sessionStartEvent }) => {
    const sections = await opts.personaSections();
    const services = await createAgentSessionServices({
      cwd, agentDir,
      resourceLoaderOptions: {
        additionalSkillPaths: opts.skillPaths,
        appendSystemPromptOverride: (base) => [...base, ...sections],
        extensionFactories: [createCodemodeExtension({ mode: "on" }), createToolSearchExtension(), createMcpExtension()],
      },
    });
    let model;
    if (opts.model) {
      const ref = parseModelRef(opts.model);
      model = services.modelRuntime.getModel(ref.provider, ref.id);
      if (!model) throw new Error(`Unknown configured model: ${opts.model}`);
    }
    if (opts.thinking && !(THINKING as readonly string[]).includes(opts.thinking)) throw new Error(`Invalid thinking level: ${opts.thinking}`);
    return {
      ...(await createAgentSessionFromServices({
        services, sessionManager, sessionStartEvent, model,
        thinkingLevel: opts.thinking as Thinking | undefined,
        tools: opts.tools,
        noTools: opts.tools?.length === 0 ? "all" : undefined,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  }, { cwd: opts.cwd, agentDir, sessionManager: SessionManager.create(opts.cwd) });
  try {
    await new InteractiveMode(runtime, { startupDiagnostics: [...runtime.diagnostics] }).run();
  } finally {
    await runtime.dispose();
  }
}

export class PiRuntime implements AgentRuntime {
  readonly name = "pi";
  private modelsRuntime?: ModelRuntime;

  constructor(private readonly opts: PiRuntimeOptions) {}

  private async modelRuntime(): Promise<ModelRuntime> {
    this.modelsRuntime ??= await ModelRuntime.create();
    return this.modelsRuntime;
  }

  async reload(): Promise<void> {
    this.modelsRuntime = undefined;
  }

  async models(): Promise<string[]> {
    const runtime = await this.modelRuntime();
    return (await runtime.getAvailable()).map((m) => `${m.provider}/${m.id}`);
  }

  async open(sessionKey: string, options: OpenSessionOptions = {}): Promise<RuntimeSession> {
    const { cwd, sessionsDir } = this.opts;
    const models = await this.modelRuntime();
    const dir = path.join(sessionsDir, safeKey(sessionKey));
    await mkdir(dir, { recursive: true });
    const sessionManager = options.fresh ? SessionManager.create(cwd, dir) : SessionManager.continueRecent(cwd, dir);

    const sections = await this.opts.personaSections();
    const approvals = this.opts.approvals;
    const requestApproval = this.opts.requestApproval;
    const slot: TurnSlot = {};
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      additionalSkillPaths: this.opts.skillPaths,
      appendSystemPromptOverride: (base) => [...base, ...sections],
      extensionFactories: [
        {
          name: "vanillacore-harness-turn",
          factory: (pi) => {
            // Sent as this request's leading system prompt, not recorded in the transcript:
            // the instructions apply to this one run only.
            pi.on("before_agent_start", (event) =>
              slot.instructions
                ? { systemPrompt: `${event.systemPrompt}\n\n<run_instructions>\n${slot.instructions}\n</run_instructions>` }
                : undefined,
            );
          },
        },
        {
          name: "vanillacore-harness-approvals",
          factory: (pi) => {
            pi.on("tool_call", async (event) => {
              if (approvals.mode !== "manual" || !requestApproval) return undefined;
              if (approvals.tools.length && !approvals.tools.includes(event.toolName)) return undefined;
              const ok = await requestApproval(sessionKey, event.toolName, event.input);
              return ok ? undefined : { block: true, reason: `${event.toolName} was denied by the operator` };
            });
          },
        },
      ],
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd,
      modelRuntime: models,
      resourceLoader: loader,
      sessionManager,
      tools: this.opts.tools,
      noTools: this.opts.tools?.length === 0 ? "all" : undefined,
    });
    // Extensions may register providers (e.g. a custom AI gateway), so resolve the
    // configured model only after they are bound.
    await session.bindExtensions({});
    const wrapped = new PiSession(session, models, slot);
    try {
      if (this.opts.model && wrapped.status().model !== this.opts.model) await wrapped.setModel(this.opts.model);
      if (this.opts.thinking) wrapped.setThinking(this.opts.thinking);
    } catch (err) {
      session.dispose();
      throw err;
    }
    return wrapped;
  }
}
