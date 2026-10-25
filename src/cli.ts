#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { LocalSessions } from "./local-sessions.js";
import { HarnessTuiChannel } from "./channels/tui.js";
import { ConsoleChannel } from "./channels/console.js";
import { GatewayManager } from "./gateway-manager.js";
import { RunRegistry } from "./api/runs.js";
import { API_CHANNEL, ApiChannel } from "./api/server.js";
import { nativeCompaction, type CompactionStrategy } from "./compaction.js";
import { FilesystemSessionProvider, type SessionProvider } from "./sessions.js";
import { memoryConfig } from "./memory.js";
import { LocalMemory } from "./memory-local.js";
import { MemoryService, memoryPlugin } from "./memory-plugin.js";
import { gatewayPlugin } from "./gateway-plugin.js";
import { PluginHost } from "./plugins.js";
import { wasmToolsPlugin } from "./wasm-tools.js";
import { builtinCommandNames, installCommands, VERSION } from "./commands.js";
import { loadConfig } from "./config.js";
import { initialize, diagnose } from "./setup.js";
import { Harness } from "./harness.js";
import { startMemoryGuard } from "./memguard.js";
import { loadPersona, personaSections } from "./persona.js";
import { ProtectedContent } from "./protected-content.js";
import { workflowTools } from "./workflow-tools.js";
import { continuationPlugin } from "./continuation-plugin.js";
import { loopPlugin } from "./loop-plugin.js";
import { OverlayUpdater } from "./update.js";
import { SkillUpdates } from "./skill-updates.js";
import { ImprovementController } from "./improvement.js";
import { PiRuntime } from "./runtime/pi.js";
import { launchMode } from "./launch.js";
import { Scheduler } from "./scheduler.js";
import { StateStore } from "./state.js";
import type { Inbound } from "./types.js";
import { type SkillInfo } from "./skills.js";
import { SkillCatalog } from "./skill-catalog.js";
import { ReviewService } from "./review.js";
import { type ModelSettings } from "./model-settings.js";
import { pruningPolicy } from "./tool-result-pruning.js";
import { ContextMaintenance, contextPolicy } from "./context-maintenance.js";
import { contextPlugin } from "./context-plugin.js";
import { SettingsService, type SettingPath } from "./settings.js";
import { runtimeReviewer } from "./runtime/reviewer.js";
import { assessCompletion } from "./completion-check.js";
import { reviewConfig } from "./review-config.js";
import { reviewPlugin } from "./review-plugin.js";
import { finishWithReview } from "./review-lifecycle.js";
import { guardReviewTool } from "./review-guard.js";
import { appendFileDurable } from "./durable.js";

const USAGE = `VanillaCore Agent Harness ${VERSION}

Usage:
  vanillacore-harness                      Interactive Harness TUI in the current directory
  vanillacore-harness run [--home <dir>]   Start the agent loop (console channel on stdin/stdout)
  vanillacore-harness init [--home <dir>] [--cwd <dir>] [--agent <name>] [--model <provider/model>]
  vanillacore-harness doctor [--home <dir>]
  vanillacore-harness version

Home (default ~/.vanillacore-harness, env VANILLACORE_HARNESS_HOME): harness.yaml, SOUL.md, VOICE.md,
personalities/<name>.md, skills/, cron/jobs.yaml (+ cron/scripts, cron/prompts), sessions/.`;

const sessionOwners = new Set<LocalSessions>();

async function main(argv: string[]): Promise<void> {
  const interactive = launchMode(argv) === "interactive";
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("Interactive mode requires a terminal; use 'run' for the gateway.");
  const [cmd, ...rest] = interactive ? ["run"] : argv;
  if (cmd === "version" || cmd === "--version") return void console.log(VERSION);
  if (!["run", "init", "doctor"].includes(cmd ?? "")) return void console.log(USAGE);
  const allowed = cmd === "init" ? ["--home", "--cwd", "--agent", "--model"] : ["--home", ...(cmd === "run" ? ["--console"] : [])];
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (!allowed.includes(flag)) throw new Error(`Unknown option: ${flag}`);
    if (flag === "--console") continue;
    const value = rest[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    values[flag] = value;
  }
  if (cmd === "init") {
    const created = await initialize({ home: values["--home"], cwd: values["--cwd"], agent: values["--agent"], model: values["--model"] });
    console.log(created.length ? `Created:\n${created.join("\n")}` : "Existing files retained; nothing overwritten.");
    return;
  }
  if (cmd === "doctor") {
    const result = await diagnose(values["--home"]);
    console.log(result.lines.join("\n"));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const config = await loadConfig(values["--home"]);
  if (interactive) config.cwd = process.cwd();
  const protectedContent = new ProtectedContent(config.home, config.protectedContent);
  await protectedContent.verify();
  const sessionOwnership = await LocalSessions.open(config.home, config.cwd);
  await sessionOwnership.acquireHome();
  sessionOwners.add(sessionOwnership);
  let tui: HarnessTuiChannel | undefined;
  const log = (text: string) => tui ? tui.note(text) : console.error(text);
  const approvals = { mode: "off" as "off" | "manual", tools: [] as string[] };
  let personality: string | undefined;
  let skills: SkillInfo[] = [];
  const skillUpdates = new SkillUpdates(config.home, config.skillUpdateSource);
  await skillUpdates.restore();
  const skillDirs = () => [...skillUpdates.roots, ...config.skills.paths, path.join(config.cwd, ".pi", "skills"), path.join(getAgentDir(), "skills")];
  const skillCatalog = new SkillCatalog(path.join(config.home, "skills", "index.json"), skillDirs);
  const reloadSkills = async () => {
    await protectedContent.verify();
    const snapshot = await skillCatalog.refresh();
    skills = skillCatalog.skills;
    for (const diagnostic of snapshot.diagnostics) log(`[skills] ${diagnostic.filePath}: ${diagnostic.message}`);
    return { warnings: snapshot.diagnostics.length };
  };
  await reloadSkills();

  const plugins = new PluginHost();
  let memory!: MemoryService;
  let sessionProvider: SessionProvider | undefined;
  let compaction = nativeCompaction as CompactionStrategy;
  let harness!: Harness;
  let review!: ReviewService;
  const reviewSettings = reviewConfig(config.review);
  const settings = new SettingsService(path.join(config.home, "settings.local.yaml"), {
    model: config.model, thinking: config.thinking,
    gateways: config.gateways,
    memory: config.memory,
    contextMaintenance: contextPolicy(config.contextMaintenance),
    toolResultPruning: pruningPolicy(config.toolResultPruning),
    review: { model: config.review?.model, thinking: config.review?.thinking ?? "medium" },
  });
  await settings.load();
  config.memory = memoryConfig(settings.effective().memory);
  memory = new MemoryService(config.memory, log, config.home);
  const maintenance = new ContextMaintenance(config.home, () => contextPolicy(settings.effective().contextMaintenance));
  const effectiveModels = () => {
    const values = settings.effective();
    return { model: values.model, thinking: values.thinking, reviewModel: values.review?.model ?? values.model, reviewThinking: values.review?.thinking ?? "medium" };
  };
  const updateReviewDefaults = () => {
    reviewSettings.model = effectiveModels().reviewModel;
    reviewSettings.thinking = effectiveModels().reviewThinking;
  };
  const runtime = new PiRuntime({
    cwd: config.cwd,
    sessionsDir: path.join(config.home, "sessions"),
    model: config.model,
    thinking: config.thinking,
    pruning: () => pruningPolicy(settings.effective().toolResultPruning),
    modelDefaults: () => ({ revision: settings.revision, model: effectiveModels().model, thinking: effectiveModels().thinking }),
    tools: workflowTools(config.tools, config.memory.enabled, reviewSettings.enabled),
    pluginTools: () => plugins.tools.values(),
    sessionProvider: () => sessionProvider,
    legacySessionProvider: new FilesystemSessionProvider(path.join(config.home, "session-store")),
    compaction: () => compaction,
    mcp: config.mcp,
    skillPaths: config.skills.paths,
    skillContext: async () => {
      await reloadSkills();
      return `Available skills (metadata only; read the named SKILL.md when relevant):\n${JSON.stringify(skills)}\n${reviewSettings.enabled ? "Core review is enabled. Use plugin_review to inspect, critically assess and review code changes. P0/P1 block publication and completion. Budget cannot be reset by starting another session." : ""}`;
    },
    toolGuard: (_key, tool, input) => guardReviewTool(review, config.cwd, tool, input),
    personaSections: async () => {
      await protectedContent.verify();
      return personaSections(await loadPersona(config.persona, personality), { name: config.agent, workspace: config.cwd });
    },
    approvals,
    requestApproval: (key, tool, input) => harness.requestApproval(key, tool, input),
  });
  review = new ReviewService(config.home, reviewSettings, runtimeReviewer(runtime), async (sessionKey, message, origin) => {
    log(`[review] ${message}`);
    harness.post({ sessionKey, text: "", source: "channel", replyTo: origin ?? harness.home }, `⚠️ Operator escalation: ${message}`);
  });
  let improvement: ImprovementController | undefined;

  harness = new Harness({
    runtime,
    contextMaintenance: maintenance,
    memory,
    beforeTurn: async (input) => {
      await protectedContent.verify();
      await improvement?.before(input);
      await review.prepare(config.cwd, input.replyTo, input.sessionKey);
    },
    turnCommitted: async (input) => { await improvement?.committed(input); },
    continuationDeadline: input => config.completionCheck?.authorizations[input.sessionKey]?.expiresAt,
    completionCheck: async (input, reply, signal) => {
      const grant = config.completionCheck?.authorizations[input.sessionKey] ??
        (input.completionAnchor ? { task: input.completionAnchor.task } : undefined);
      return assessCompletion(runtimeReviewer(runtime), input, reply, grant, signal, effectiveModels().reviewModel);
    },
    afterTurn: async (input, reply, session, options, signal) => {
      const result = await finishWithReview(review, config.cwd, input, reply, session, options, signal);
      await improvement?.completed(input, result);
      return result;
    },
    tickMs: config.loop.tickMs,
    busyMode: config.loop.busyMode,
    gateways: settings.effective().gateways,
    log,
    // Permanently rejected replies (e.g. no permission in the room) are parked for manual follow-up.
    parkUndeliverable: (entry, error) =>
      appendFileDurable(path.join(config.home, "outbox-deadletter.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), error, ...entry })}\n`),
  });
  harness.home = config.home_address;
  const gatewayManager = new GatewayManager(harness, settings, {
    home: config.home, agent: config.agent, approvers: config.approvers, admins: config.admins,
  }, { matrix: new URL(import.meta.url.endsWith(".ts") ? "./channels/matrix-plugin.ts" : "./channels/matrix-plugin.js", import.meta.url).href });
  await gatewayManager.load();
  const gatewayApprovers = gatewayManager.approvers;
  const admins = config.admins.length ? config.admins : gatewayApprovers;
  const approvers = config.approvers.length ? config.approvers : gatewayApprovers.length ? gatewayApprovers : admins;
  improvement = new ImprovementController(config.home, harness, config.timezone);
  const gatewayTimer = setInterval(() => {
    void gatewayManager.tick().catch(() => log("[gateway] activation failed"));
  }, 2000);
  gatewayTimer.unref();
  // Hermes-compatible HTTP API (AgentOS hermes_gateway adapter); enabled by API_SERVER_KEY.
  const runs = new RunRegistry(path.join(config.home, "runs.json"));
  const apiKey = process.env.API_SERVER_KEY?.trim();
  if (apiKey) {
    await runs.load();
    harness.addChannel(
      new ApiChannel({
        key: apiKey,
        host: process.env.API_SERVER_HOST,
        port: process.env.API_SERVER_PORT ? Number(process.env.API_SERVER_PORT) : undefined,
        agent: config.agent,
        runs,
        cancel: (key, id) => harness.cancel(key, id),
        models: () => runtime.models(),
        defaultModel: () => effectiveModels().model,
      }),
    );
  }
  // Console: interactive use, or when nothing else would receive input. A daemon with Matrix or
  // the API (e.g. a container without a TTY) does not read stdin unless asked to.
  let localSessions: LocalSessions | undefined;
  if (interactive) {
    localSessions = await LocalSessions.open(config.home, config.cwd);
    sessionOwners.add(localSessions);
    await localSessions.create();
    tui = new HarnessTuiChannel({
      sessions: localSessions,
      workState: () => {
        const state = harness.sessions.get(localSessions?.current?.key ?? "console:local");
        return { running: !!state?.running, queued: state?.queue.length ?? 0 };
      },
      canSwitchSession: () => {
        const key = localSessions?.current?.key;
        const state = key ? harness.sessions.get(key) : undefined;
        return !state?.running && !state?.queue.length && !state?.outbox.length && !state?.unsaved
          && !harness.pendingInputs().some((input) => input.sessionKey === key);
      },
      panels: () => plugins.panels.values(),
      agent: config.agent,
      models: () => runtime.models(),
      login: (ui) => runtime.login(ui),
      quit: () => void shutdown(0),
      prepareSession: async () => { await harness.sessionFor(localSessions?.current?.key ?? "console:local"); },
      model: () => harness.sessions.get(localSessions?.current?.key ?? "console:local")?.session?.status().model ?? "unavailable",
      reasoning: () => harness.sessions.get(localSessions?.current?.key ?? "console:local")?.session?.status().thinking ?? "unavailable",
      status: () => {
        const sessions = [...harness.sessions.values()];
        const active = sessions.filter((s) => s.running).length;
        const queued = sessions.reduce((n, s) => n + s.queue.length, 0);
        return `${harness.paused ? "PAUSED" : "running"} · Active: ${active} · Queue: ${queued}\nGoals: ${sessions.filter((s) => s.goal).length} · Heartbeats: ${sessions.filter((s) => s.heartbeat).length} · Channels: ${[...harness.channels.keys()].join(", ")}`;
      },
    });
    harness.addChannel(tui);
  } else if (process.stdin.isTTY || rest.includes("--console") || harness.channels.size === 0) harness.addChannel(new ConsoleChannel());
  if (!harness.home && harness.channels.has("console")) harness.home = { channel: "console", target: "local" };

  const scheduler = new Scheduler(harness, { jobsFile: config.cron.jobsFile, timezone: config.timezone });

  // Restore runtime state (heartbeats, loops, goals, settings) from the last run.
  const store = new StateStore(path.join(config.home, "state.json"));
  const saved = await store.load();
  if (saved) {
    harness.paused = saved.paused;
    harness.busyMode = saved.busyMode;
    // Only restore a home whose channel is active in this run.
    if (saved.home && harness.channels.has(saved.home.channel)) harness.home = saved.home;
    if (saved.approvals) Object.assign(approvals, saved.approvals);
    personality = saved.personality;
    for (const [name, on] of Object.entries(saved.cronOverrides ?? {})) scheduler.overrides.set(name, on);
    harness.restoreSessions(saved.sessions);
    harness.restoreSeen(saved.seen ?? []);
  }
  updateReviewDefaults();
  // The state file doubles as the inbox: unfinished user/cron inputs are part of every save.
  const persist = (pending: Inbound[] = harness.pendingInputs()) =>
    store.save({
      version: 1,
      paused: harness.paused,
      busyMode: harness.busyMode,
      home: harness.home,
      approvals: { ...approvals },
      personality,
      cronOverrides: Object.fromEntries(scheduler.overrides),
      sessions: harness.snapshotSessions(),
      pending: pending.length ? pending : undefined,
      outbox: harness.outboxEntries().length ? harness.outboxEntries() : undefined,
      seen: harness.seenIds(),
    });
  // Restore before scheduler execution, persistence callbacks, or channel startup can write state.
  if (saved?.pending?.length) harness.restorePending(saved.pending);
  if (saved?.outbox?.length) harness.restoreOutbox(saved.outbox);
  harness.onStateChange = () => persist();
  if (apiKey) {
    // A run whose turn never made it into the inbox (crash between record and accept) is over.
    const pendingIds = new Set((saved?.pending ?? []).map((i) => i.id));
    const outboxRuns = new Set((saved?.outbox ?? []).filter((e) => e.to.channel === API_CHANNEL).map((e) => e.to.target));
    const lost = await runs.reconcile((r) => pendingIds.has(r.input_id) || outboxRuns.has(r.run_id));
    if (lost.length) console.error(`[api] ${lost.length} run(s) interrupted by the restart`);
  }
  await scheduler.load();

  await plugins.load(config.plugins ?? [], { agent: config.agent, home: config.home, cwd: config.cwd }, [...builtinCommandNames, "sessions", "resume", ...skills.map((s) => s.name)], ["console", "api", "matrix", ...harness.channels.keys()], [wasmToolsPlugin(config.home, config.wasmTools ?? []), continuationPlugin(harness), loopPlugin(harness), improvement!.plugin(), protectedContent.plugin(), gatewayManager.plugin(), gatewayPlugin(settings, harness), contextPlugin(maintenance, settings), ...(config.memory.enabled ? [memoryPlugin(memory)] : []), ...(reviewSettings.enabled ? [reviewPlugin(review, config.cwd)] : [])]);
  let memoryConnecting = false;
  let memoryStopping = false;
  const connectMemory = async () => {
    if (!config.memory.enabled || memoryConnecting || memoryStopping) return;
    memoryConnecting = true;
    try {
      if (memory.provider) {
        try { await memory.provider.status(); return; }
        catch { await memory.provider.close().catch(() => {}); memory.provider = undefined; }
      }
      const factory = config.memory.provider === "local" ? undefined : plugins.memoryProviders.get(config.memory.provider);
      if (config.memory.provider !== "local" && !factory) throw Error("Unknown memory provider");
      const provider = factory ? await factory({ home: config.home, config: config.memory }) : await LocalMemory.open(config.home, config.memory);
      if (memoryStopping) await provider.close(); else memory.provider = provider;
    } catch { log("[memory] provider unavailable; retrying on next maintenance tick"); }
    finally { memoryConnecting = false; }
  };
  await connectMemory();
  const memoryTimer = config.memory.enabled ? setInterval(() => { void connectMemory().then(() => memory.flush()).catch(() => log("[memory] capture backlog retained")); }, 30000) : undefined;
  memoryTimer?.unref();
  void memory.flush().catch(() => log("[memory] capture backlog retained"));
  const strategyName = config.compaction?.strategy ?? "native";
  if (strategyName !== "native") {
    const strategy = plugins.compactions.get(strategyName);
    if (!strategy) throw new Error(`Unknown compaction strategy: ${strategyName}`);
    compaction = strategy;
  }
  const providerName = config.sessions?.provider ?? "native";
  if (providerName === "filesystem") sessionProvider = new FilesystemSessionProvider(path.join(config.home, "session-store"));
  else if (providerName !== "native") {
    const factory = plugins.sessionProviders.get(providerName);
    if (!factory) throw new Error(`Unknown session provider: ${providerName}`);
    sessionProvider = await factory({ home: config.home, options: config.sessions?.options });
  }
  if (localSessions) localSessions.provider = sessionProvider ?? new FilesystemSessionProvider(path.join(config.home, "session-store"));
  for (const channel of plugins.channels.values()) harness.addChannel(channel);

  let stopping = false;
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    // Like Hermes restart_drain_timeout: stop input, finish in-flight work for up to
    // drainSeconds, abort the rest, then persist state (user's /pause flag untouched).
    scheduler.stop();
    improvement?.stop();
    const unfinished = await harness.stop(config.loop.drainSeconds * 1000);
    harness.onStateChange = undefined;
    // A graceful stop is not the turn's fault: only crashes (OOM, kill) count towards giving up.
    for (const input of unfinished) input.started = undefined;
    await persist(unfinished).catch((err) => console.error(`[state] save failed: ${err}`));
    if (unfinished.length) console.error(`[harness] ${unfinished.length} unfinished input(s) saved for replay`);
    clearInterval(gatewayTimer);
    memoryStopping = true;
    clearInterval(memoryTimer);
    await memory.provider?.close().catch(() => console.error("[memory] cleanup failed"));
    await plugins.stop().catch(() => console.error("[plugins] cleanup failed"));
    await sessionOwnership.release();
    process.exit(code);
  };

  installCommands({
    harness,
    scheduler,
    updater: new OverlayUpdater(() => protectedContent.verify(), { skills: async () => {
      if (config.skillUpdateSource) {
        let result = { warnings: 0 };
        await skillUpdates.apply(async () => { result = await reloadSkills(); });
        return result;
      }
      return reloadSkills();
    }, cron: () => scheduler.load() }),
    approvals,
    modelSettings: {
      get: effectiveModels,
      source: (key) => {
        const paths = { model: "model", thinking: "thinking", reviewModel: "review.model", reviewThinking: "review.thinking" } as const;
        return settings.source(key === "reviewModel" && settings.effective().review?.model === undefined ? "model" : paths[key]);
      },
      set: async (key, value) => {
        if (value !== undefined && (key === "model" || key === "reviewModel") && !(await runtime.models()).includes(value)) throw new Error("Model is not available; configure provider credentials and model first");
        const paths: Record<keyof ModelSettings, SettingPath> = { model: "model", thinking: "thinking", reviewModel: "review.model", reviewThinking: "review.thinking" };
        await settings.set(paths[key], value);
        updateReviewDefaults();
      },
    },
    skills: () => skills,
    pluginCommands: plugins.commands,
    pluginUI: () => tui?.pluginUI(),
    localSessionKey: () => localSessions?.current?.key ?? "console:local",
    reloadSkills: async () => { await reloadSkills(); },
    personality: {
      get current() {
        return personality;
      },
      available: async () => {
        try {
          return (await readdir(config.persona.personalitiesDir)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
        } catch {
          return [];
        }
      },
      set: async (name) => {
        if (name) await loadPersona(config.persona, name); // validate
        personality = name;
      },
    },
    // Remote channels fail closed: without `admins` only MATRIX_APPROVAL_APPROVERS (AgentOS:
    // the human owner) and the local console may run privileged commands.
    admins,
    openAdmin: false, // Remote gateways may be enabled later; console remains explicitly privileged.
    approvers,
    agent: config.agent,
    // Exit with 75 (EX_TEMPFAIL); the supervisor (systemd/Kubernetes) restarts the process.
    restart: async () => {
      // Shut down outside the command handler; the drain delivers /restart's acknowledgement first.
      setImmediate(() => void shutdown(75));
    },
  });

  // Kill the largest tool child before the kernel OOM-kills the whole container.
  const stopGuard = startMemoryGuard({ percent: config.memoryGuard.percent, log });
  process.on("exit", stopGuard);
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  try {
    await harness.start();
    await improvement!.start();
  }
  catch (err) {
    await harness.stop(0).catch(() => {});
    clearInterval(gatewayTimer);
    memoryStopping = true;
    clearInterval(memoryTimer);
    await memory.provider?.close().catch(() => {});
    await plugins.stop().catch(() => {});
    throw err;
  }

  // Replay only after outbound channels are authenticated and ready. Entries remain in the
  // durable inbox until both their reply and the completion-state write succeed.
  if (saved?.pending?.length || saved?.outbox?.length) {
    console.error(`[harness] replaying ${saved.pending?.length ?? 0} unfinished input(s), ${saved.outbox?.length ?? 0} undelivered reply(ies)`);
    // Replay counters (and abandoned inputs' failure replies) are durable before anything runs.
    await persist();
    harness.releaseRestored();
  }
}

main(process.argv.slice(2)).catch(async (err) => {
  for (const owner of sessionOwners) await owner.release().catch(() => {});
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
