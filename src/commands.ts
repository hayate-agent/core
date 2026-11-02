/**
 * Hermes-compatible slash commands (gateway-relevant subset; TUI-only commands are left out).
 * Names and aliases follow hermes_cli/commands.py so operators can keep their habits.
 */
import type { PluginCommand, PluginUI } from "./plugins.js";
import { developmentGuide } from "./development.js";
import { randomUUID } from "node:crypto";
import { formatInterval, parseInterval } from "./interval.js";
import type { Harness } from "./harness.js";
import type { Scheduler } from "./scheduler.js";
import { type SkillInfo, skillInvocationPrompt } from "./skills.js";
import type { BusyMode, Inbound } from "./types.js";

import { BUILD_INFO } from "./build-info.js";
export const VERSION = BUILD_INFO.version;

export interface CommandContext {
  harness: Harness;
  modelSettings?: {
    get: () => import("./model-settings.js").ModelSettings;
    source?: (key: import("./model-settings.js").ModelSetting) => string;
    set: (key: import("./model-settings.js").ModelSetting, value?: string) => Promise<void>;
  };
  scheduler?: Scheduler;
  updater?: import("./update.js").OverlayUpdater;
  /** Mutable approval settings shared with the runtime. */
  approvals: { mode: "off" | "manual"; tools: string[] };
  /** Current skill catalog (refreshed by /reload-skills). */
  skills: () => SkillInfo[];
  reloadSkills: () => Promise<void>;
  /** Active personality overlay; applies to sessions opened afterwards. */
  personality: { current?: string; available: () => Promise<string[]>; set: (name?: string) => Promise<void> };
  admins: string[];
  /**
   * With an empty admin list: true = everyone is admin (local single-user use);
   * false = only the local console (fail-closed, set when remote channels are enabled).
   */
  openAdmin?: boolean;
  /** Who may resolve approvals. Empty: same as admins. Independent of admin rights otherwise. */
  approvers?: string[];
  agent: string;
  pluginCommands?: ReadonlyMap<string, PluginCommand>;
  pluginUI?: () => PluginUI | undefined;
  localSessionKey?: () => string;
  /** Graceful restart (supervisor brings the process back). */
  restart: () => Promise<void>;
}

interface Command {
  name: string;
  aliases?: string[];
  help: string;
  admin?: boolean;
  run: (args: string, input: Inbound, ctx: CommandContext) => Promise<string | void>;
}

function globalArgument(args: string): string | undefined {
  const parts = args.trim().split(/\s+/);
  if (!parts.includes("--global")) return undefined;
  if (parts.at(-1) !== "--global" || parts.slice(0, -1).includes("--global") || parts.length > 2) throw new Error("Place --global at the end: /model provider/model --global or /reasoning medium --global");
  return parts.slice(0, -1).join(" ");
}

async function globalSetting(key: import("./model-settings.js").ModelSetting, value: string, input: Inbound, ctx: CommandContext): Promise<string> {
  if (value && !isAdmin(ctx, input)) return "⛔ admin only";
  if (!ctx.modelSettings) throw new Error("Global model settings are unavailable");
  if (value) await ctx.modelSettings.set(key, value === "reset" ? undefined : value);
  return `global ${key}: ${ctx.modelSettings.get()[key] ?? "runtime default"} [${ctx.modelSettings.source?.(key) ?? "defaults"}]${value ? " (applies on next turn; active turns unchanged)" : ""}`;
}

import { naturalBudgetReset } from "./natural-budget-reset.js";

const BUSY_MODES: BusyMode[] = ["queue", "steer", "interrupt"];

/** Command replies go through the durable outbox: delivery retries never re-run the command. */
function reply(ctx: CommandContext, input: Inbound, text: string): void {
  ctx.harness.post(input, text);
}

function recurringCommand(kind: "heartbeat" | "loop"): Command["run"] {
  return async (args, input, ctx) => {
    const s = ctx.harness.state(input.sessionKey);
    const [sub, ...rest] = args.trim().split(/\s+/);
    const current = s[kind];
    switch (sub ?? "") {
      case "":
      case "status":
        return current
          ? `${kind}: every ${formatInterval(current.everyMs)}${current.paused ? " (paused)" : ""}${current.remaining !== undefined ? `, ${current.remaining} left` : ""}: ${current.prompt}`
          : `no ${kind} set`;
      case "pause":
      case "resume":
        if (!current) return `no ${kind} set`;
        if (kind === "loop") await ctx.harness.controlLoop(input.sessionKey, { action: sub });
        else current.paused = sub === "pause";
        return `${kind} ${sub}d`;
      case "clear":
      case "stop":
        if (kind === "loop") await ctx.harness.controlLoop(input.sessionKey, { action: "stop" });
        else s[kind] = undefined;
        if (kind === "heartbeat") s.heartbeatDisabled = true;
        return `${kind} cleared`;
    }
    // heartbeat: "every <interval> <prompt>"; loop: "[interval] <prompt> [--times N]"
    let words = sub === "every" ? rest : [sub, ...rest];
    let everyMs = parseInterval(words[0] ?? "");
    if (everyMs) words = words.slice(1);
    else {
      if (sub === "every" || /^(\d+[smhd])+$/i.test(words[0] ?? "")) return "invalid interval: use a positive duration within safe integer milliseconds";
      everyMs = kind === "heartbeat" ? 30 * 60_000 : 10 * 60_000;
    }
    let remaining: number | undefined;
    const t = words.indexOf("--times");
    if (t >= 0) {
      remaining = Number(words[t + 1]);
      if (!Number.isInteger(remaining) || remaining < 1) return "--times needs a positive integer";
      words.splice(t, 2);
    }
    const prompt = words.join(" ").trim();
    if (!prompt) return `usage: /${kind} ${kind === "heartbeat" ? "every <interval> <prompt>" : "[interval] <prompt> [--times N]"}`;
    if (everyMs < 60_000) return "minimum interval is 1m";
    if (kind === "heartbeat") s.heartbeatDisabled = false;
    if (kind === "loop") {
      await ctx.harness.controlLoop(input.sessionKey, { action: "set", prompt, everyMs, times: remaining });
    } else s[kind] = { prompt, everyMs, nextAt: Date.now() + everyMs, paused: false, remaining };
    return `${kind} set: every ${formatInterval(everyMs)}: ${prompt}`;
  };
}

export const COMMANDS: Command[] = [
  {
    name: "task-budget", admin: true,
    help: "inspect|reset|resume|reset-resume <session-key> <task-id> [<token> <request-id>] (authenticated operator only)",
    run: async (args, input, ctx) => {
      // Unlike legacy openAdmin mode, this control requires an identified operator.
      // Host/API/model inputs and sender-less remote messages never establish authority.
      if (input.source !== "channel" || !(input.replyTo?.channel === "console" ||
          !!input.sender && ctx.admins.includes(input.sender))) return "⛔ authenticated operator channel required";
      const [action, key, id, token, request, extra] = args.trim().split(/\s+/);
      if (!key || !id || extra || !["inspect", "reset", "resume", "reset-resume"].includes(action) ||
          (action === "inspect" ? !!token : !token || !request))
        return "usage: /task-budget inspect <session-key> <task-id> OR /task-budget reset|resume|reset-resume <session-key> <task-id> <token> <unique-request-id>";
      if (action === "inspect") {
        const status = ctx.harness.taskBudgetStatus(key, id);
        return JSON.stringify({ session: key, ...status });
      }
      return ctx.harness.controlTaskBudget(key, id, action as "reset" | "resume" | "reset-resume", token, request,
        input.replyTo?.channel === "console" ? "console:local" : `${input.replyTo?.channel}:${input.sender}`, input);
    },
  },
  // -- Session
  {
    name: "hashtags", help: "List tags or find retained messages: /hashtags [#slug]",
    run: async (args, input, ctx) => {
      const refs = ctx.harness.state(input.sessionKey).hashtags ?? [];
      if (!args.trim()) return [...new Set(refs.map(ref => ref.tag))].sort().map(tag => `#${tag}`).join("\n") || "No hashtags indexed yet.";
      if (!/^#[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)*$/.test(args.trim())) return "usage: /hashtags [#slug]";
      const matches = refs.filter(ref => ref.tag === args.trim().slice(1).toLowerCase());
      if (!matches.length) return "No references for this hashtag.";
      const rows: string[] = [];
      for (const ref of matches) {
        try {
          if (!ctx.harness.runtime.sessionHistory) throw new Error("Runtime history retrieval unavailable");
          const entries = await ctx.harness.runtime.sessionHistory(input.sessionKey, ref.sessionId);
          const message = entries.find(entry => entry.id === ref.messageId && entry.role === "user");
          if (!message) throw new Error("Referenced message no longer retained");
          rows.push(`${ref.date} · ${ref.sessionId}\n  ${message.text.replace(/\s+/g, " ").slice(0, 180)}\n  /resume ${ref.sessionId}`);
        } catch (error) {
          rows.push(`${ref.date} · ${ref.sessionId} · unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return rows.join("\n");
    },
  },
  {
    name: "sessions", help: "List conversation sessions: /sessions [page]",
    run: async (args, input, ctx) => {
      const page = args.trim() ? Number(args) : 1;
      if (!Number.isInteger(page) || page < 1) return "usage: /sessions [page]";
      const list = await ctx.harness.runtime.sessions?.(input.sessionKey, (page - 1) * 20) ?? [];
      return list.length ? list.map((s) => `${s.title} · ${s.updated} · ${s.key}\n  /resume ${s.id}`).join("\n") : "No sessions on this page.";
    },
  },
  {
    name: "resume", help: "Resume a session by exact ID; /sessions lists titles",
    run: async (args, input, ctx) => {
      if (!args.trim()) return "Use /sessions or the local /resume picker to select a conversation.";
      await ctx.harness.resumeSession(input.sessionKey, args.trim());
      const status = ctx.harness.state(input.sessionKey).session!.status();
      return `Resumed: ${status.title ?? status.sessionId}`;
    },
  },
  {
    name: "new",
    aliases: ["reset"],
    help: "Start a new session (fresh history)",
    run: async (_a, input, ctx) => {
      await ctx.harness.resetSession(input.sessionKey);
      return "🆕 New session.";
    },
  },
  {
    name: "retry",
    help: "Retry the last message",
    run: async (_a, input, ctx) => {
      const last = ctx.harness.state(input.sessionKey).lastInput;
      if (!last) return "nothing to retry";
      await ctx.harness.enqueueChannel({ ...last }, true);
    },
  },
  {
    name: "title",
    help: "Set a title for the current session",
    run: async (args, input, ctx) => {
      if (!args.trim()) return "usage: /title <text>";
      await (await ctx.harness.sessionFor(input.sessionKey)).setTitle(args.trim());
      return `title set: ${args.trim()}`;
    },
  },
  {
    name: "handover",
    help: "Switch idle conversation to a fresh session with a durable handover [resume instructions]",
    run: async (args, input, ctx) => ctx.harness.handover(input.sessionKey, args.trim() || "Continue with the next operator request; do not invent new authorization."),
  },
  {
    name: "compress",
    aliases: ["compact"],
    help: "Compress conversation context [instructions]",
    run: async (args, input, ctx) => {
      const s = ctx.harness.state(input.sessionKey);
      if (s.running) return "busy; try again when idle";
      // Keep this inside channel acceptance: shutdown can abort it and replay the command if needed.
      await (await ctx.harness.sessionFor(input.sessionKey)).compact(args.trim() || undefined);
      return "🗜️ Context compressed.";
    },
  },
  {
    name: "stop",
    help: "Stop the running turn and clear this session's queue",
    run: async (_a, input, ctx) => {
      const dropped = await ctx.harness.stopConversation(input.sessionKey);
      return `⏹️ Stopped${dropped ? `, ${dropped} queued dropped` : ""}.`;
    },
  },
  {
    name: "queue",
    aliases: ["q"],
    help: "Queue a prompt for the next turn | list | clear",
    run: async (args, input, ctx) => {
      const s = ctx.harness.state(input.sessionKey);
      const a = args.trim();
      if (a === "" || a === "list") return s.queue.length ? s.queue.map((q, i) => `${i + 1}. ${q.text.slice(0, 120)}`).join("\n") : "queue empty";
      if (a === "clear") {
        s.queue.length = 0;
        return "queue cleared";
      }
      await ctx.harness.enqueueChannel({ ...input, text: a });
      return s.running ? `queued (#${s.queue.length})` : undefined;
    },
  },
  {
    name: "steer",
    aliases: ["s"],
    help: "Inject a message after the next tool call without interrupting",
    run: async (args, input, ctx) => {
      const s = ctx.harness.state(input.sessionKey);
      if (!args.trim()) return "usage: /steer <text>";
      if (!s.running || !s.session) {
        await ctx.harness.enqueueChannel({ ...input, text: args.trim() });
        return;
      }
      await s.session.steer(args.trim());
      return "↪️ steered";
    },
  },
  {
    name: "bg",
    help: "Run a prompt in a separate background session",
    run: async (args, input, ctx) => {
      if (!args.trim()) return "usage: /bg <prompt>";
      const key = `${input.sessionKey}:bg:${randomUUID().slice(0, 6)}`;
      ctx.harness.enqueue({ sessionKey: key, text: args.trim(), source: "api", replyTo: input.replyTo });
      return `🧵 background task started (${key.split(":").pop()})`;
    },
  },
  {
    name: "btw",
    help: "Ask a side question without interrupting the current work",
    run: async (args, input, ctx) => {
      if (!args.trim()) return "usage: /btw <question>";
      ctx.harness.enqueue({ sessionKey: `${input.sessionKey}:btw`, text: args.trim(), source: "api", replyTo: input.replyTo });
    },
  },
  {
    name: "agents",
    aliases: ["tasks"],
    help: "Show active sessions and running tasks",
    run: async (_a, _i, ctx) => {
      const rows = [...ctx.harness.sessions.values()].map((s) => {
        const flags = [s.running ? "running" : "idle", s.queue.length ? `${s.queue.length} queued` : "", s.goal ? "goal" : "", s.loop ? "loop" : "", s.heartbeat ? "heartbeat" : ""].filter(Boolean);
        return `• ${s.key}: ${flags.join(", ")}`;
      });
      return rows.length ? rows.join("\n") : "no sessions";
    },
  },
  {
    name: "goal",
    help: "Standing goal: <text> | show | pause | resume | clear | status",
    run: async (args, input, ctx) => {
      const s = ctx.harness.state(input.sessionKey);
      const a = args.trim();
      switch (a) {
        case "":
        case "show":
        case "status":
          return s.goal ? `🎯 ${s.goal.text}${s.goal.paused ? " (paused)" : ""}, ${s.goal.turns} turn(s)${s.goal.criteria.length ? `\n${s.goal.criteria.map((c) => `- ${c}`).join("\n")}` : ""}` : "no goal";
        case "pause":
        case "resume":
          if (!s.goal) return "no goal";
          s.goal.paused = a === "pause";
          if (a === "resume") s.goal.turns = 0;
          return `goal ${a}d`;
        case "clear":
          s.goal = undefined;
          return "goal cleared";
      }
      s.goal = { text: a.replace(/^--\s*/, ""), criteria: [], paused: false, turns: 0 };
      return `🎯 goal set: ${s.goal.text}`;
    },
  },
  {
    name: "subgoal",
    help: "Add a criterion to the active goal | clear",
    run: async (args, input, ctx) => {
      const g = ctx.harness.state(input.sessionKey).goal;
      if (!g) return "no goal";
      if (args.trim() === "clear") {
        g.criteria = [];
        return "criteria cleared";
      }
      if (!args.trim()) return g.criteria.length ? g.criteria.map((c) => `- ${c}`).join("\n") : "no criteria";
      g.criteria.push(args.trim());
      return `criterion added (${g.criteria.length})`;
    },
  },
  { name: "heartbeat", aliases: ["hb"], help: "Recurring prompt when idle: every <interval> <prompt> | status | pause | resume | clear", run: recurringCommand("heartbeat") },
  { name: "loop", aliases: ["proactive"], help: "Re-run a prompt: [interval] <prompt> [--times N] | status | pause | resume | stop", run: recurringCommand("loop") },
  {
    name: "status",
    help: "Show session, model, token and context info",
    run: async (_a, input, ctx) => {
      const st = (await ctx.harness.sessionFor(input.sessionKey)).status();
      return [
        `agent: ${ctx.agent} · runtime: ${ctx.harness.runtime.name}`,
        `session: ${st.sessionId}${st.busy ? " (busy)" : ""}`,
        `model: ${st.model ?? "default"} · reasoning: ${st.thinking ?? "default"}`,
        `messages: ${st.messages ?? "?"} · tokens in/out: ${st.tokens?.input ?? "?"}/${st.tokens?.output ?? "?"}`,
        `context: ${st.contextPercent !== undefined ? `${Math.round(st.contextPercent)}%` : "?"}`,
        `busy mode: ${ctx.harness.busyMode} · approvals: ${ctx.approvals.mode}${ctx.harness.paused ? " · PAUSED" : ""}`,
      ].join("\n");
    },
  },
  {
    name: "usage",
    aliases: ["tokens"],
    help: "Show current runtime-session tokens, cache usage and estimated USD cost (alias: /tokens)",
    run: async (_a, input, ctx) => {
      const st = (await ctx.harness.sessionFor(input.sessionKey)).status();
      const count = (n: number | undefined) => n !== undefined && Number.isFinite(n) && n >= 0 ? String(n) : "unknown";
      return [
        `usage: current runtime session ${st.sessionId}${st.busy ? " (busy; partial)" : ""}`,
        `model: ${st.model ?? "default"}`,
        `tokens in/out: ${count(st.tokens?.input)}/${count(st.tokens?.output)}`,
        `cache read/write: ${count(st.tokens?.cacheRead)}/${count(st.tokens?.cacheWrite)}`,
        `total tokens (including cache): ${count(st.tokens?.total)}`,
        `estimated cost USD: ${st.costUsd !== undefined && Number.isFinite(st.costUsd) && st.costUsd >= 0 ? st.costUsd.toFixed(6) : "unknown"}`,
        "Scope: this runtime session only; not account billing or parent/subagent totals. Handover/new sessions have separate counters. Provider/model pricing may be unavailable or zero.",
      ].join("\n");
    },
  },
  {
    name: "context",
    aliases: ["ctx"],
    help: "Show context window usage",
    run: async (_a, input, ctx) => {
      const st = (await ctx.harness.sessionFor(input.sessionKey)).status();
      return `context: ${st.contextPercent !== undefined ? `${Math.round(st.contextPercent)}%` : "unknown"} · messages: ${st.messages ?? "?"}${st.systemPrompt ? `\nsystem prompt: ${st.systemPrompt.characters} characters · ${st.systemPrompt.bytes} UTF-8 bytes (history/tool schemas excluded; no token estimate)` : ""}`;
    },
  },
  {
    name: "whoami",
    help: "Show your command access",
    run: async (_a, input, ctx) => `${input.sender ?? "unknown"}: ${isAdmin(ctx, input) ? "admin" : "user"}`,
  },
  { name: "profile", help: "Show the active agent", run: async (_a, _i, ctx) => `agent: ${ctx.agent}` },
  {
    name: "sethome",
    aliases: ["set-home"],
    help: "Set this chat as the home channel",
    admin: true,
    run: async (_a, input, ctx) => {
      if (!input.replyTo) return "this input has no chat address";
      ctx.harness.home = { channel: input.replyTo.channel, target: input.replyTo.target };
      return "🏠 home channel set";
    },
  },
  {
    name: "model",
    help: "Model for this session, or <provider/model|reset> --global for instance defaults",
    run: async (args, input, ctx) => {
      const global = globalArgument(args);
      if (global !== undefined) return globalSetting("model", global, input, ctx);
      const session = await ctx.harness.sessionFor(input.sessionKey);
      if (!args.trim()) return `model: ${session.status().model ?? "default"}`;
      await session.setModel(args.trim());
      return `model: ${args.trim()}`;
    },
  },
  {
    name: "reasoning",
    help: "Session reasoning, or <level|reset> --global for instance defaults",
    run: async (args, input, ctx) => {
      const global = globalArgument(args);
      if (global !== undefined) return globalSetting("thinking", global, input, ctx);
      const session = await ctx.harness.sessionFor(input.sessionKey);
      if (!args.trim()) return `reasoning: ${session.status().thinking ?? "default"}`;
      await session.setThinking(args.trim());
      return `reasoning: ${args.trim()}`;
    },
  },
  {
    name: "review-model", help: "Instance reviewer model: <provider/model|reset>",
    run: (args, input, ctx) => globalSetting("reviewModel", args.trim(), input, ctx),
  },
  {
    name: "review-reasoning", help: "Instance reviewer reasoning: <level|reset>",
    run: (args, input, ctx) => globalSetting("reviewThinking", args.trim(), input, ctx),
  },
  {
    name: "personality",
    help: "Set a predefined personality (applies from /new) | none | list",
    run: async (args, _i, ctx) => {
      const a = args.trim();
      if (!a || a === "list") {
        const all = await ctx.personality.available();
        return `personality: ${ctx.personality.current ?? "none"}\navailable: ${all.join(", ") || "none"}`;
      }
      await ctx.personality.set(a === "none" ? undefined : a);
      return `personality: ${a} (applies on the next model call)`;
    },
  },
  {
    name: "busy",
    help: "Behaviour while working: queue|steer|interrupt|status",
    run: async (args, _i, ctx) => {
      const a = args.trim() as BusyMode | "status" | "";
      if (!a || a === "status") return `busy mode: ${ctx.harness.busyMode}`;
      if (!BUSY_MODES.includes(a as BusyMode)) return `usage: /busy ${BUSY_MODES.join("|")}`;
      ctx.harness.busyMode = a as BusyMode;
      return `busy mode: ${a}`;
    },
  },
  {
    name: "yolo",
    help: "on|off|status (default: status): skip manual tool approvals; does not bypass permissions or review",
    admin: true,
    run: async (args, _i, ctx) => {
      const mode = args.trim();
      if (mode && !["on", "off", "status"].includes(mode)) return "usage: /yolo on|off|status";
      if (mode === "on") ctx.approvals.mode = "off";
      if (mode === "off") ctx.approvals.mode = "manual";
      return ctx.approvals.mode === "off" ? "YOLO on (manual tool approvals off)" : "YOLO off (manual tool approvals on)";
    },
  },
  {
    name: "approvals",
    help: "Tool approval details: off|manual [tool...] (same state as /yolo, not a separate mode)",
    admin: true,
    run: async (args, _i, ctx) => {
      const [mode, ...tools] = args.trim().split(/\s+/).filter(Boolean);
      if (!mode) return `approvals: ${ctx.approvals.mode}${ctx.approvals.tools.length ? ` (${ctx.approvals.tools.join(", ")})` : ""}`;
      if (mode !== "off" && mode !== "manual") return "usage: /approvals off|manual [tool...]";
      ctx.approvals.mode = mode;
      ctx.approvals.tools = tools;
      return `approvals: ${mode}${tools.length ? ` (${tools.join(", ")})` : ""}`;
    },
  },
  {
    name: "approve",
    help: "Approve a pending command [id]",
    run: async (args, input, ctx) => decide(ctx, input, args.trim(), true),
  },
  {
    name: "deny",
    help: "Deny a pending command [id]",
    run: async (args, input, ctx) => decide(ctx, input, args.trim().split(/\s+/)[0] ?? "", false),
  },
  {
    name: "pause",
    help: "Pause all new work (emergency stop); '/pause off' resumes",
    admin: true,
    run: async (args, _i, ctx) => {
      if (args.trim() === "off") ctx.harness.resume();
      else ctx.harness.paused = true;
      return ctx.harness.paused ? "⏸️ paused" : "▶️ resumed";
    },
  },
  {
    name: "restart",
    aliases: ["reload"],
    help: "Gracefully restart after draining active runs",
    admin: true,
    run: async (_a, input, ctx) => {
      reply(ctx, input, "♻️ restarting after current work…");
      await ctx.restart();
    },
  },
  // -- Tools & skills
  {
    name: "skills",
    help: "List skills (invoke with /<skill-name> [task])",
    run: async (args, _i, ctx) => {
      const q = args.trim().toLowerCase();
      const list = ctx.skills().filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q));
      return list.length ? list.map((s) => `• /${s.name}: ${s.description.slice(0, 100)}`).join("\n") : "no skills";
    },
  },
  {
    name: "update",
    admin: true,
    help: "Inspect or reconcile provisioned local overlays: status | apply [skills|cron|all] (no download)",
    run: async (args, _input, ctx) => {
      if (!ctx.updater) throw Error("Overlay updater unavailable");
      const [action = "status", target = "all", ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (!["status", "apply"].includes(action) || !["skills", "cron", "all"].includes(target) || extra.length) throw Error("usage: /update status|apply [skills|cron|all]");
      const results = await ctx.updater.run(action as "status" | "apply", target === "all" ? ["skills", "cron"] : [target as "skills" | "cron"]);
      return results.map(r => `${r.component}: ${r.status} — ${r.detail}`).join("\n");
    },
  },
  {
    name: "reload-skills",
    aliases: ["reload_skills", "reload-mcp", "reload_mcp"],
    help: "Re-scan skills; reload session resources/MCP before each session's next turn",
    run: async (_a, _i, ctx) => {
      await ctx.reloadSkills();
      await ctx.harness.runtime.reload();
      return `🔄 ${ctx.skills().length} skill(s); session resource/MCP reload scheduled for the next turn`;
    },
  },
  {
    name: "cron",
    help: "Scheduled jobs: list | run <name> | pause <name> | resume <name> | reload",
    run: async (args, input, ctx) => {
      if (!ctx.scheduler) return "no scheduler";
      const [sub, ...rest] = args.trim().split(/\s+/);
      const name = rest.join(" ");
      if (!sub || sub === "list") {
        const jobs = ctx.scheduler.list();
        return jobs.length ? jobs.map((j) => `• ${j.name} [${j.schedule}] ${j.enabled ? `next ${j.next ?? "?"}` : "paused"}`).join("\n") : "no jobs";
      }
      if (sub === "reload") {
        await ctx.scheduler.load();
        return `reloaded ${ctx.scheduler.jobs.length} job(s)`;
      }
      if (!isAdmin(ctx, input)) return "⛔ admin only";
      const job = ctx.scheduler.find(name);
      if (!job) return `unknown job: ${name}`;
      if (sub === "run") {
        await ctx.scheduler.runJob(job);
        return `▶️ ${name} triggered`;
      }
      if (sub === "pause" || sub === "resume") {
        ctx.scheduler.setEnabled(name, sub === "resume");
        return `${name} ${sub}d`;
      }
      return "usage: /cron list|run|pause|resume|reload";
    },
  },
  // -- Info
  {
    name: "help",
    aliases: ["commands"],
    help: "Show Hayate Agent commands and registered plugin commands",
    run: async (_args, _input, ctx) => {
      const commands = [
        ...COMMANDS.map((c) => ({ ...c, origin: "Hayate Agent" })),
        ...[...(ctx.pluginCommands?.values() ?? [])].map((c) => ({ ...c, aliases: undefined, origin: "Plugin" })),
      ].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      const group = (admin: boolean) => commands.filter((c) => Boolean(c.admin) === admin)
        .map((c) => `/${c.name}${c.aliases?.length ? ` (${c.aliases.map((a) => `/${a}`).join(" ")})` : ""}${c.admin ? " [admin]" : ""} [${c.origin}]: ${c.help}`).join("\n");
      return `Hayate Agent commands ([admin] requires administrator access):\n\nGeneral commands:\n${group(false)}\n\nAdmin commands:\n${group(true)}`;
    },
  },
  { name: "harness", help: "Locate built-in Hayate Agent customization/development guide", run: async () => `Hayate Agent development guide: ${developmentGuide}\nRead this guide before changing Hayate Agent. Identity/voice, tools and models are configurable; native plugins support commands/channels/model tools/text panels/lifecycle (see plugins.md); interactive plugin dialogs are available locally; automatic runtime promotion remains planned.` },
  { name: "version", help: "Show version", run: async (_a, _i, ctx) => `Hayate Agent ${VERSION} (runtime: ${ctx.harness.runtime.name})` },
];

const BY_NAME = new Map<string, Command>();
for (const c of COMMANDS) for (const n of [c.name, ...(c.aliases ?? [])]) BY_NAME.set(n, c);
export const builtinCommandNames = [...BY_NAME.keys()];

function isAdmin(ctx: CommandContext, input: Inbound): boolean {
  // The attached local terminal is trusted independently of remote identity lists.
  if (input.replyTo?.channel === "console") return true;
  if (ctx.admins.length === 0) return ctx.openAdmin !== false;
  return !!input.sender && ctx.admins.includes(input.sender);
}

function mayApprove(ctx: CommandContext, input: Inbound): boolean {
  if (input.replyTo?.channel === "console") return true;
  if (ctx.approvers?.length) return !!input.sender && ctx.approvers.includes(input.sender);
  return isAdmin(ctx, input);
}

async function decide(ctx: CommandContext, input: Inbound, id: string, ok: boolean): Promise<string> {
  if (!mayApprove(ctx, input)) return "⛔ not an approver";
  const pending = [...ctx.harness.approvals.values()].filter((p) => (id ? p.id === id : p.sessionKey === input.sessionKey));
  if (!pending.length) return "nothing pending";
  const p = pending[0];
  ctx.harness.approvals.delete(p.id);
  p.resolve(ok);
  return ok ? `✅ approved ${p.tool}` : `❌ denied ${p.tool}`;
}

/** Parse "/name args". Returns undefined for non-commands. */
export function parseCommand(text: string): { name: string; args: string } | undefined {
  const m = /^\/([a-zA-Z][\w-]*)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1].toLowerCase(), args: m[2] ?? "" } : undefined;
}

/** Install the command layer on a harness. Unknown /words fall through to the agent. */
export function installCommands(ctx: CommandContext): void {
  ctx.harness.operatorBudgetActorAllowed = actor => actor === "console:local" ||
    ctx.admins.includes(actor.slice(actor.indexOf(":") + 1));
  ctx.harness.commandHandler = async (input) => {
    const reset = naturalBudgetReset(input.text);
    if (reset) {
      // No openAdmin fallback: only an actual channel accept with identified admin provenance.
      if (!ctx.harness.isAcceptingChannelInput(input) || !(input.replyTo?.channel === "console" ||
          !!input.sender && ctx.admins.includes(input.sender))) {
        reply(ctx, input, "Budget reset failed because an authenticated operator channel is required.");
        return true;
      }
      try {
        reply(ctx, input, await ctx.harness.requestNaturalBudgetReset(input,
          input.replyTo?.channel === "console" ? "console:local" : `${input.replyTo?.channel}:${input.sender}`, reset.taskId));
      } catch (error) {
        reply(ctx, input, `Budget reset failed because ${error instanceof Error ? error.message : String(error)}`);
      }
      return true;
    }
    const parsed = parseCommand(input.text);
    if (!parsed) return false;
    const cmd = BY_NAME.get(parsed.name);
    if (!cmd) {
      const plugin = ctx.pluginCommands?.get(parsed.name);
      if (plugin) {
        if (plugin.admin && !isAdmin(ctx, input)) reply(ctx, input, "⛔ admin only");
        else {
          try {
            const text = await plugin.run(parsed.args, { sessionKey: input.sessionKey, sender: input.sender,
              ui: input.replyTo?.channel === "console" && input.sessionKey === (ctx.localSessionKey?.() ?? "console:local") ? ctx.pluginUI?.() : undefined });
            if (text) reply(ctx, input, text);
          } catch { reply(ctx, input, `⚠️ /${plugin.name}: plugin command failed (details withheld)`); }
        }
        return true;
      }
      // Operational and inspection commands must remain available even when
      // content verification fails. Only skill resolution needs discovery here.
      await ctx.reloadSkills();
      const skill = ctx.skills().find((s) => s.name === parsed.name);
      if (!skill) return false;
      await ctx.harness.enqueueChannel({ ...input, text: skillInvocationPrompt(skill, parsed.args) });
      return true;
    }
    let out: string | void;
    if (cmd.admin && !isAdmin(ctx, input)) out = "⛔ admin only";
    else {
      try {
        out = await cmd.run(parsed.args, input, ctx);
      } catch (err) {
        out = `⚠️ /${cmd.name}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (out) reply(ctx, input, out);
    return true;
  };
}
