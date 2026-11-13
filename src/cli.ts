#!/usr/bin/env node
import { reasoningEffortNoneModels } from "./product-paths.js";
import { BUILD_INFO } from "./build-info.js";
import { readSoftwareVersions } from "./component-versions.js";
import { StartupNotice, startupNoticeTarget } from "./startup-notice.js";
import { McpManagement } from "./mcp-management.js";
import { workingTreeEvidence } from "./repetition-budget.js";
import { ToolGuardError } from "./tool-guard-error.js";
import { guardDispatcherMain } from "./dispatcher-main-guard.js";
import { improvementPlugin } from "./builtin-plugins/improvement-plugin.js";
import { pluginOverlayReload } from "./plugin-overlay-reload.js";
import { gatewayManagerPlugin } from "./builtin-plugins/gateway-manager-plugin.js";
import { bundledGatewayModules } from "./builtin-plugins/gateway-baselines.js";
import { reloadableToolsPlugin } from "./builtin-plugins/reloadable-tools-plugin.js";
import { protectedContentPlugin } from "./builtin-plugins/protected-content-plugin.js";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { LocalSessions } from "./local-sessions.js";
import { ExecutionContexts } from "./execution-contexts.js";
import { HarnessTuiChannel } from "./channels/tui.js";
import { ConsoleChannel } from "./channels/console.js";
import { GatewayManager } from "./gateway-manager.js";
import { PolicyManager } from "./policy-manager.js";
import { policyManagerPlugin } from "./builtin-plugins/policy-manager-plugin.js";
import { ExtensionManager } from "./extension-manager.js";
import { extensionManagerPlugin } from "./builtin-plugins/extension-manager-plugin.js";
import { RunRegistry } from "./api/runs.js";
import { API_CHANNEL, ApiChannel } from "./api/server.js";
import { resolveApiKey } from "./api/credential.js";
import { CompactionSelection, type CompactionStrategy } from "./compaction.js";
import { compactionStrategyPlugin } from "./builtin-plugins/compaction-strategy-plugin.js";
import { FilesystemSessionProvider, type SessionProvider } from "./sessions.js";
import { SessionProviderLifecycle } from "./session-provider-lifecycle.js";
import { memoryConfig } from "./memory.js";
import { ParallelAdmission, bindParallelAdmission } from "./parallel-admission.js";
import { memoryConsolidationHost } from "./memory-consolidation-host.js";
import { LocalMemory } from "./memory-local.js";
import { MemoryService } from "./builtin-plugins/memory-service.js";
import { MemoryProviderLifecycle } from "./memory-provider-lifecycle.js";
import { memoryPlugin } from "./builtin-plugins/memory-plugin.js";
import { memoryOrchestrationPlugin } from "./builtin-plugins/memory-orchestration-plugin.js";
import { maintenanceClient } from "./builtin-plugins/maintenance-client.js";
import { maintenanceControlPlugin } from "./builtin-plugins/maintenance-control-plugin.js";
import { sessionObserverPlugin, attachObserver } from "./builtin-plugins/session-observer-plugin.js";
import { gatewayPlugin } from "./builtin-plugins/gateway-plugin.js";
import { PluginHost } from "./plugins.js";
import { Subagents } from "./subagents.js";
import { ExecutionStore, executionTarget } from "./execution.js";
import { Dispatcher, stopDispatcherParent } from "./dispatcher.js";
import { MaintenanceJournal } from "./update-maintenance.js";
import { ShutdownDeadline } from "./shutdown-deadline.js";
import { requestSoftwareUpdate, softwareLifecyclePlugin } from "./software-update-client.js";
import { containerRuntime } from "./software-updates.js";
import { DispatcherRuntime } from "./dispatcher-runtime.js";
import { attentionRequired } from "./notification-routing.js";
import { dispatcherConfig } from "./dispatcher-config.js";
import { dispatcherPlugin } from "./builtin-plugins/dispatcher-plugin.js";
import { workerTasksPlugin } from "./worker-tasks-plugin.js";
import { subagentPlugin } from "./builtin-plugins/subagent-plugin.js";
import { wasmToolsPlugin } from "./builtin-plugins/wasm-tools-plugin.js";
import { ReloadableTools, composeToolCatalog } from "./reloadable-tools.js";
import { builtinCommandNames, installCommands, VERSION } from "./commands.js";
import { loadConfig } from "./config.js";
import { initialize, diagnose } from "./setup.js";
import { Harness } from "./harness.js";
import { startMemoryGuard } from "./memguard.js";
import { loadPersona, personaSections } from "./persona.js";
import { ProtectedContent } from "./protected-content.js";
import { workflowTools } from "./workflow-tools.js";
import { continuationPlugin } from "./builtin-plugins/continuation-plugin.js";
import { dispatchPlanHistoryPlugin } from "./dispatch-plan-history-plugin.js";
import { dispatchDecisionsPlugin } from "./dispatch-decisions-plugin.js";
import { taskPriorityPlugin } from "./task-priority-plugin.js";
import { operatorPriorityIntent } from "./priority-intent.js";
import { loopPlugin } from "./builtin-plugins/loop-plugin.js";
import { OverlayUpdater } from "./update.js";
import { SkillUpdates } from "./skill-updates.js";
import { skillSearchPlugin } from "./skill-search-plugin.js";
import { AdaptiveSkills } from "./adaptive-skills.js";
import { ImprovementController } from "./improvement.js";
import nightlyDefault from "./builtin-plugins/nightly-default.js";
import { nightlyStrategyHolder } from "./nightly-strategy.js";
import { nightlyStrategyPlugin } from "./builtin-plugins/nightly-strategy-plugin.js";
import { PiRuntime } from "./runtime/pi.js";
import { launchMode } from "./launch.js";
import { Scheduler } from "./scheduler.js";
import { BenchmarkService } from "./benchmark/index.js";
import type { BenchmarkSubmitter } from "./benchmark/runner.js";
import { cronReportPlugin } from "./builtin-plugins/cron-report-plugin.js";
import { StateStore } from "./state.js";
import type { Inbound } from "./types.js";
import { type SkillInfo } from "./skills.js";
import { SkillCatalog } from "./skill-catalog.js";
import { createReviewEngine } from "./builtin-plugins/review-engine.js";
import { loadPolicyEngine, createPolicyEngine } from "./policy-engine.js";
import { type ModelSettings } from "./model-settings.js";
import { pruningPolicy } from "./tool-result-pruning.js";
import { ContextMaintenance, contextPolicy } from "./context-maintenance.js";
import { contextPlugin } from "./builtin-plugins/context-plugin.js";
import { SettingsService, type SettingPath } from "./settings.js";
import { handoverWorktreeReview } from "./review-worktree.js";
import { ReviewWorkers } from "./review-execution.js";
import { ReviewSubagents } from "./review-subagents.js";
import { capabilityContext } from "./capability-context.js";
import { messagePlugin } from "./message-plugin.js";
import { conversationPolicyPlugin } from "./conversation-policy-plugin.js";
import { roleAwareReviewer, resolveModelRole } from "./model-roles.js";
import { runtimeReviewer } from "./runtime/reviewer.js";
import { validatorRole } from "./dispatcher-sequential.js";
import { boundaryAssessor } from "./builtin-plugins/boundary-assessor.js";
import { pruneToolResults } from "./builtin-plugins/tool-result-projector.js";
import { contextStrategyHolder, disabledContextStrategies, diagnosedBoundaryAssessor } from "./context-strategies.js";
import { contextStrategyPlugin } from "./builtin-plugins/context-strategy-plugin.js";
import { guardResultOrchestration } from "./result-orchestration.js";
import { assessCompletion } from "./completion-check.js";
import { validatorPlugin } from "./builtin-plugins/completion-validator-plugin.js";
import { semanticTopicLabeler } from "./topic-labels.js";
import { completionPrompt } from "./builtin-plugins/completion-prompt.js";
import { completionStrategyHolder } from "./completion-strategy.js";
import { completionStrategyPlugin } from "./builtin-plugins/completion-strategy-plugin.js";
import { reviewConfig } from "./review-config.js";
import { appendFileDurable } from "./durable.js";

const USAGE = `Hayate Agent ${VERSION}

Usage:
  hayate-agent                      Interactive Hayate Agent TUI in the current directory
  hayate-agent run [--home <dir>]   Start the agent loop (console channel on stdin/stdout)
  hayate-agent init [--home <dir>] [--cwd <dir>] [--agent <name>] [--model <provider/model>]
  hayate-agent run --observe-directory <private-dir> --observe-session <exact-key> [--home <dir>]
  hayate-agent run --maintenance-directory <private-dir> --maintenance-session <exact-key> [--home <dir>]
  hayate-agent attach <local-socket-path>  Read-only JSON status; Ctrl+C detaches
  hayate-agent doctor [--home <dir>]
  hayate-agent maintenance <socket> status | admit <id> <version> <request.json> | cancel <id> <version>
  hayate-agent version

Home (default ~/.hayate-agent, env HAYATE_AGENT_HOME): hayate-agent.yaml, SOUL.md, VOICE.md,
personalities/<name>.md, skills/, cron/jobs.yaml (+ cron/scripts, cron/prompts), sessions/.`;

const sessionOwners = new Set<LocalSessions>();

async function main(argv: string[]): Promise<void> {
  const interactive = launchMode(argv) === "interactive";
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("Interactive mode requires a terminal; use 'run' for the gateway.");
  const [cmd, ...rest] = interactive ? ["run"] : argv;
  if (cmd === "maintenance") {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort); process.once("SIGTERM", abort);
    try { console.log(await maintenanceClient(rest, controller.signal)); }
    finally { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
    return;
  }
  if (cmd === "attach") {
    if (rest.length !== 1 || !rest[0]) throw Error("Usage: attach <local-socket-path>");
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort); process.once("SIGTERM", abort);
    try { await attachObserver(rest[0], line => console.log(line), controller.signal); }
    finally { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
    return;
  }
  if (cmd === "version" || cmd === "--version") return void console.log(VERSION);
  if (!["run", "init", "doctor"].includes(cmd ?? "")) return void console.log(USAGE);
  const allowed = cmd === "init" ? ["--home", "--cwd", "--agent", "--model"] : ["--home", ...(cmd === "run" ? ["--console", "--observe-directory", "--observe-session", "--maintenance-directory", "--maintenance-session"] : [])];
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
  if (!!values["--observe-directory"] !== !!values["--observe-session"]) throw Error("Observer requires both directory and exact session key");
  if (!!values["--maintenance-directory"] !== !!values["--maintenance-session"]) throw Error("Maintenance requires both directory and exact session key");
  // Direct `node dist/cli.js run` and `npm start` need the same process owner
  // as the installed launcher. Otherwise exit 75 merely stops a native service
  // whose host restart policy may intentionally be disabled.
  if (!Boolean(process.send && process.connected)) {
    const { runForeground, foregroundOptions } = await import("./launcher.js");
    process.exitCode = await runForeground(process.argv[1] ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url), argv,
      process.execArgv, await foregroundOptions(argv));
    return;
  }
  const config = await loadConfig(values["--home"]);
  if (interactive) config.cwd = process.cwd();
  const protectedContent = new ProtectedContent(config.home, config.protectedContent);
  await protectedContent.verify();
  const sessionOwnership = await LocalSessions.open(config.home, config.cwd);
  await sessionOwnership.acquireHome();
  sessionOwners.add(sessionOwnership);
  // Resolve after home ownership, before runtime/channel startup. Invalid storage fails closed.
  const apiKey = await resolveApiKey(config.home);
  let tui: HarnessTuiChannel | undefined;
  const log = (text: string) => tui ? tui.note(text) : console.error(text);
  const approvals = { mode: "off" as "off" | "manual", tools: [] as string[] };
  let personality: string | undefined;
  let skills: SkillInfo[] = [];
  const skillUpdates = new SkillUpdates(config.home, config.skillUpdateSource);
  await skillUpdates.restore();
  const skillDirs = () => [...skillUpdates.roots, ...config.skills.paths, path.join(config.cwd, ".pi", "skills"), path.join(config.cwd, ".agents", "skills"), path.join(getAgentDir(), "skills")];
  const skillCatalog = new SkillCatalog(path.join(config.home, "skills", "index.json"), skillDirs);
  let skillContextCache: string | undefined; // invalidated whenever skills reload
  const reloadSkills = async () => {
    await protectedContent.verify();
    const snapshot = await skillCatalog.refresh();
    skills = skillCatalog.skills;
    skillContextCache = undefined;
    for (const diagnostic of snapshot.diagnostics) log(`[skills] ${diagnostic.filePath}: ${diagnostic.message}`);
    return { warnings: snapshot.diagnostics.length };
  };
  await reloadSkills();

  const plugins = new PluginHost();
  plugins.validators.select(config.completionCheck?.provider ?? "legacy-llm");
  const initialReloadableTools: PluginHost["tools"] = new Map();
  const reloadableTools = config.reloadableToolPlugins?.length
    ? new ReloadableTools({home:config.home,cwd:config.cwd,agent:config.agent},config.reloadableToolPlugins,log,true, tools => {
      composeToolCatalog(plugins.tools, initialReloadableTools, tools);
    }) : undefined;
  let memory!: MemoryService;
  let sessionProvider: SessionProvider | undefined;
  let compaction: CompactionSelection | undefined;
  const selectedCompaction = (): CompactionSelection => {
    if (!compaction) throw Error("Compaction selection not initialized");
    return compaction;
  };
  const compactionAdapter: CompactionStrategy = { compact: context => selectedCompaction().compact(context) };
  let harness!: Harness;
  let hostAdmissionReady = false;
  let dispatchRuntime: DispatcherRuntime | undefined;
  let dispatcher: Dispatcher | undefined;
  let localSessions: LocalSessions | undefined;
  const sessionEnabled = (key: string): boolean => {
    if (!interactive) return true;
    let parent: string | undefined = key;
    const seen = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (!parent || seen.has(parent)) return false;
      seen.add(parent);
      if (parent.startsWith("dispatch:")) parent = executions.list().find(task => parent!.startsWith(`dispatch:${task.id}:`))?.parent;
      else if (parent.startsWith("subagent:")) parent = subagents.snapshot().find(task => task.sessionKey === parent)?.parent;
      else return (!parent.startsWith("local-") && parent !== "console:local") || parent === localSessions?.current?.key;
    }
    return false;
  };
  // One persistence foundation in both modes, also covering managed child turns.
  const executions = new ExecutionStore(path.join(config.home, "executions.json"), {
    protectedExecutions: () => new Set(harness?.pendingInputs().flatMap(input => input.hostEvent ? [input.hostEvent.executionId] : []) ?? []),
  });
  await executions.load();
  const maintenanceJournal = new MaintenanceJournal(path.join(config.home, "update-maintenance.json"));
  await maintenanceJournal.load();
  await maintenanceJournal.recover();
  const reviewSettings = reviewConfig(config.review);
  const reviewModule = reviewSettings.enabled ? await loadPolicyEngine(config.home, config.reviewEngine, {
    apiVersion: 1, executionContexts: (createReviewEngine as typeof createReviewEngine & { executionContexts?: 1 }).executionContexts, modelTools: ["plugin_review"], create: context => createReviewEngine({ ...context, config: reviewSettings }),
  }) : undefined;
  const settings = new SettingsService(path.join(config.home, "settings.local.yaml"), {
    model: config.model, thinking: config.thinking,
    mcp: config.mcp,
    dispatcher: config.dispatcher,
    modelRoles: config.modelRoles,
    reasoningEffortNoneModels: config.reasoningEffortNoneModels,
    gateways: config.gateways,
    memory: config.memory,
    skills: config.skills,
    contextMaintenance: contextPolicy(config.contextMaintenance),
    toolResultPruning: pruningPolicy(config.toolResultPruning),
    review: { model: config.reviewOverrides?.model, thinking: config.reviewOverrides?.thinking },
  }, message => log(`[settings] ${message}`));
  await settings.load();
  let reloadError: string | undefined;
  const reloadRuntimeSettings = async () => {
    try { await settings.reload(); reloadError = undefined; }
    catch (error) {
      const message = `Runtime settings rejected; retaining last valid configuration: ${String(error)}`;
      if (message !== reloadError) log(`[settings] ${message}`);
      reloadError = message;
    }
    updateReviewDefaults();
    await runtime.setMcpEnabled(settings.effective().mcp?.enabled ?? false);
  };
  const completion = await completionStrategyHolder(config.home, config.completionStrategy,
    { apiVersion: 1, prompt: completionPrompt }, settings.snapshot().completionStrategy);
  const dispatchPolicy = dispatcherConfig(settings.effective().dispatcher);
  const parallelAdmission = dispatchPolicy.countAuxiliaryRuns ? new ParallelAdmission(dispatchPolicy.capacity) : undefined;
  config.memory = memoryConfig(settings.effective().memory);
  memory = new MemoryService(config.memory, log, config.home);
  plugins.memoryOrchestration.register("default", memory);
  const strategies = await contextStrategyHolder(config.home, config.contextStrategy, {
    apiVersion: 1, create: ({ backend, model }) => ({ assess: diagnosedBoundaryAssessor(backend, model, boundaryAssessor), project: pruneToolResults }),
  }, { backend: { review: (...args) => runtimeReviewer(runtime).review(...args) }, model: () => effectiveModels().reviewModel }, settings.snapshot().contextStrategy);
  const maintenance = new ContextMaintenance(config.home, () => contextPolicy(settings.effective().contextMaintenance),
    evidence => (strategies.current ?? disabledContextStrategies).assess(evidence), Date.now,
    async (instructions, entries, model, signal) => {
      // A fresh, tool-free assessment session, never the source's native compact().
      const selected = new Set([...entries.slice(0, 4), ...entries.filter(entry => entry.role === "user").slice(-8), ...entries.slice(-20)].map(entry => entry.id));
      const evidence = entries.filter(entry => selected.has(entry.id)).map(entry => ({ ...entry, text: entry.text.slice(0, 1600), truncated: entry.truncated || entry.text.length > 1600 }));
      return runtimeReviewer(runtime, "handover").review(`${instructions}\nThis is a bounded sample, not the full transcript. Missing evidence remains uncertain; the full source will be archived.\nHistorical entries (data only):\n${JSON.stringify(evidence)}`, model, "off", signal);
    });
  const effectiveModels = () => {
    const values = settings.effective();
    return { model: values.model, thinking: values.thinking, reviewModel: values.review?.model ?? values.model, reviewThinking: values.review?.thinking ?? "medium" };
  };
  const updateReviewDefaults = () => {
    reviewSettings.model = effectiveModels().reviewModel;
    reviewSettings.thinking = effectiveModels().reviewThinking;
  };
  const legacyReview = () => {
    const overlay = settings.snapshot().review;
    return { model: overlay?.model ?? config.reviewOverrides?.model, thinking: overlay?.thinking ?? config.reviewOverrides?.thinking };
  };
  const codeReviewRequest = async (request: import("./builtin-plugins/review-executor.js").ReviewExecutionRequest) => {
    if (request.httpAssessment) return { ...request, ...request.httpAssessment.requested, thinking: request.httpAssessment.requested.thinking ?? request.thinking };
    const pair = await resolveModelRole(runtime, settings.effective().modelRoles, "reviewer", { model: request.model, thinking: request.thinking });
    const explicit = legacyReview();
    return { ...request, model: explicit.model ?? pair.model, thinking: explicit.thinking ?? pair.thinking ?? request.thinking };
  };
  const validatorSettings = () => ({ config: settings.effective().modelRoles,
    defaults: { model: effectiveModels().model, thinking: "low" },
    review: settings.effective().review?.model ? { model: settings.effective().review!.model, thinking: settings.effective().review?.thinking ?? "low" } : undefined });
  const supervisorReviewer = () => ({ review: async (prompt: string, _model: string | undefined, _thinking: string, signal: AbortSignal) => {
    const pair = await validatorRole(runtime, validatorSettings());
    if (typeof pair === "string") throw Error(pair);
    return runtimeReviewer(runtime, "supervisor").review(prompt, pair.model, pair.thinking ?? "low", signal);
  } });
  let contextParent: (key: string) => string | undefined = () => undefined;
  const executionContexts = new ExecutionContexts(path.join(config.home, "execution-contexts.json"), config.cwd, key => contextParent(key));
  await executionContexts.load();
  const cwdFor = (key: string) => executionContexts.get(key).cwd;
  const executionContextCapability = Object.freeze({
    get: (key: string) => executionContexts.get(key),
    bind: async (key: string, context: { cwd: string; directories?: string[] }) => {
      if (context.cwd !== config.cwd && reviewSettings.enabled && reviewModule?.executionContexts !== 1) throw Error("Selected review engine does not support stream execution contexts");
      if (harness.sessions.has(key) || harness.pendingInputs().some(input => input.sessionKey === key)) {
        const existing = executionContexts.get(key);
        if (existing.cwd !== context.cwd) throw Error("Existing stream cannot change its execution directory; create a new stream");
      }
      return harness.withForegroundWork(() => executionContexts.bind(key, context));
    },
  });
  const adaptiveSkills = config.skills.adaptive === true ? new AdaptiveSkills(config.home, config.cwd, skillCatalog) : undefined;
  const runtime = new PiRuntime({
    adaptiveSkills,
    // Capture worker ancestry before token ownership changes; a reopened worker
    // must never silently fall back to the host startup directory.
    executionContext: key => executionContexts.capture(key),
    cwd: config.cwd,
    sessionsDir: path.join(config.home, "sessions"),
    model: config.model,
    thinking: config.thinking,
    beforeRequest: reloadRuntimeSettings,
    reasoningEffortNoneModels: () => [...settings.effective().reasoningEffortNoneModels ?? [],
      ...reasoningEffortNoneModels()],
    pruning: () => pruningPolicy(settings.effective().toolResultPruning),
    projectToolResults: (messages, policy) => (strategies.current ?? disabledContextStrategies).project(messages, policy),
    modelDefaults: () => ({ revision: settings.revision, model: effectiveModels().model, thinking: effectiveModels().thinking }),
    tools: (() => {
      const workflow = workflowTools(config.tools, config.memory.enabled, false);
      const tools = workflow?.length ? [...new Set([...workflow, ...(reviewModule?.modelTools ?? [])])] : workflow;
      return dispatchPolicy.enabled && tools?.length ? [...new Set([...tools, "plugin_dispatch", "plugin_dispatch_decisions", "plugin_dispatch_plan_history", "plugin_worker_tasks"])] : tools;
    })(),
    pluginTools: () => composeToolCatalog(plugins.tools, initialReloadableTools, reloadableTools?.tools ?? new Map()),
    sessionProvider: () => sessionProvider,
    legacySessionProvider: new FilesystemSessionProvider(path.join(config.home, "session-store")),
    compaction: () => compactionAdapter,
    compactionOwner: () => contextPolicy(settings.effective().contextMaintenance).compactionOwner ?? "harness",
    workerContextTokens: () => contextPolicy(settings.effective().contextMaintenance).workerContextTokens ?? 131072,
    contextBudgets: () => contextPolicy(settings.effective().contextMaintenance),
    mcp: settings.effective().mcp,
    mcpUserManagement: true,
    skillPaths: config.skills.paths,
    skillContext: async () => {
      const mode = settings.effective().skills?.context ?? "auto";
      if (mode !== "auto") return "";
      // Skill metadata is computed once per session and reused, so the leading prompt
      // prefix stays byte-stable across turns (prefix-cache friendly) and skill dirs are
      // not re-scanned every turn; invalidated whenever skills reload.
      return skillContextCache ??= `Available skills (metadata only; read the named SKILL.md when relevant):\n${JSON.stringify(skills)}`;
    },
    toolGuard: async (key, tool, input) => {
      if (tool === "plugin_review") await reloadRuntimeSettings();
      subagents.guardTool(key, tool);
      dispatchRuntime?.guardTool(key, tool);
      guardDispatcherMain(key, tool, dispatchPolicy.enabled && dispatcher?.ready === true, input);
      await harness.guardWaitTool(key, tool, input);
      const current = harness.sessions.get(key)?.current;
      if (current?.source === "host") {
        if (!current.hostEvent) throw new ToolGuardError("authority_revoked", "Host event authority unavailable");
        if (!dispatchRuntime) throw new ToolGuardError("dispatcher_unavailable", "Host result dispatcher unavailable");
        dispatchRuntime.guardResult(key, current.hostEvent.executionId);
        guardResultOrchestration(harness, key, tool, input);
      }
      await plugins.policies.beforeTool(cwdFor(key), tool, input);
    },
    personaSections: async (cwd = config.cwd) => {
      await protectedContent.verify();
      return personaSections(await loadPersona(config.persona, personality), { name: config.agent, workspace: cwd });
    },
    approvals,
    requestApproval: (key, tool, input) => harness.requestApproval(key, tool, input),
  });
  const mcp = new McpManagement({ agentDir: getAgentDir(),
    providerToken: provider => runtime.mcpProviderToken(provider),
    enabled: () => settings.effective().mcp?.enabled ?? false,
    setEnabled: async enabled => { await settings.setMcpEnabled(enabled); await runtime.setMcpEnabled(enabled); },
    changed: () => runtime.reload(),
  });
  if (parallelAdmission) bindParallelAdmission(runtime, parallelAdmission);
  const reviewWorkers = new ReviewWorkers(runtime, new ExecutionStore(path.join(config.home, "review-executions.json")), dispatchPolicy.capacity);
  const reviewSubagents = new ReviewSubagents(runtime, path.join(config.home, "review-subagents"));
  const reviewEngine = reviewModule ? await createPolicyEngine(reviewModule, { home: config.home, cwd: config.cwd, cwdFor, config: reviewSettings,
    reviewExecution: {
      dispatcherEnabled: () => dispatchPolicy.enabled,
      httpSelection: async (model, thinking) => {
        if (!settings.effective().modelRoles?.enabled) return undefined;
        const pair = await resolveModelRole(runtime, settings.effective().modelRoles, "reviewer", { model, thinking });
        const explicit = legacyReview();
        const defaults = effectiveModels();
        return { requested: { model: explicit.model ?? pair.model, thinking: explicit.thinking ?? pair.thinking ?? thinking },
          defaults: { model: defaults.model, thinking: defaults.thinking } };
      },
      dispatcherWorker: async request => reviewWorkers.review(await codeReviewRequest(request)),
      handoverWorktree: async request => handoverWorktreeReview(runtime, await codeReviewRequest(request)),
      subagent: async request => reviewSubagents.review(await codeReviewRequest(request)),
    },
    backend: runtimeReviewer(runtime), notify: async (sessionKey, message, origin) => {
      log(`[review] ${message}`);
      harness.post({ sessionKey, text: "", source: "channel", replyTo: origin ?? harness.home }, `⚠️ Operator escalation: ${message}`);
    }, origin: input => subagents.isChild(input.sessionKey) ? subagents.approvalTarget(input.sessionKey) : input.replyTo }) : { required: [], policies: [], plugins: [], instructions: "" };
  plugins.policies.require(reviewEngine.required);
  for (const policy of reviewEngine.policies) plugins.policies.register(policy);
  let improvement: ImprovementController | undefined;
  let gatewayManager: GatewayManager | undefined;

  const updateOwnerBlockers = () => {
      const blockers = [...plugins.updateBlockers()];
      if (!hostAdmissionReady) blockers.push("startup reconciliation");
      const effective = settings.effective();
      // These independently loaded owners predate the foreground ownership contract.
      // Core-only and audited bundled owners remain supported; never infer third-party safety from harness idle.
      if (config.reloadableToolPlugins?.length) blockers.push("unsupported update owner: reloadable tool modules");
      if (Object.values(effective.extensionPlugins ?? {}).some(spec => spec.module && !spec.disabled)) blockers.push("unsupported update owner: runtime extension modules");
      if (Object.values(effective.policyPlugins ?? {}).some(spec => spec.module && !spec.disabled)) blockers.push("unsupported update owner: policy modules");
      blockers.push(...(gatewayManager?.updateBlockers() ?? ["gateway startup"]));
      return blockers;
  };
  harness = new Harness({
    attachmentRoot: path.join(config.home, "attachments"),
    updateBlockers: () => [...updateOwnerBlockers(), ...(dispatcher?.updateBlockers() ?? [])],
    maintenance: {
      blockers: () => [...updateOwnerBlockers(), ...(dispatcher?.maintenanceBlockers() ?? [])],
      flush: async () => { await executions.drain(); await executionContexts.drain(); },
      journal: maintenanceJournal,
    },
    runtime,
    currentRuntime: { ...BUILD_INFO, startedAt: Date.now() },
    sessionEnabled,
    progressEvidence: input => workingTreeEvidence(cwdFor(input.sessionKey)),
    executionStore: executions,
    contextMaintenance: maintenance,
    memory: plugins.memoryOrchestration,
    approvalTarget: key => dispatchRuntime?.isWorker(key) ? dispatchRuntime.approvalTarget(key) : subagents.approvalTarget(key),
    conversationStopping: async key => {
      await executions.cancelParent(key);
      await subagents.revokeChildren(key);
    },
    conversationStopped: async key => {
      await stopDispatcherParent(executions, key, dispatcher);
      await subagents.cancelChildren(key);
    },
    taskStopped: async (key, taskId, preexistingUnscoped) => {
      if (dispatcher) await dispatcher.cancelTask(key, taskId, preexistingUnscoped);
      await subagents.cancelTaskChildren(key, taskId);
    },
    // Nightly owns dispatcher evidence directly, including retained pre-upgrade inbox events.
    // It must never become a new LLM turn through the generic host-result lane.
    hostEventAllowed: input => input.sessionKey !== "improvement:nightly" && !!input.hostEvent && !!dispatchRuntime?.resultAllowed(input.sessionKey, input.hostEvent.executionId),
    // Reserve this namespace even with dispatch disabled: stale opaque turns
    // must be reconciled through the ledger, not replayed by Harness startup.
    externallyRecoveredSession: key => key.startsWith("dispatch:"),
    beforeExecution: input => {
      subagents.beforeTurn(input.sessionKey);
      dispatchRuntime?.beforeTurn(input.sessionKey);
    },
    capabilityContext: input => capabilityContext({
      revision: settings.revision, sessionKey: input.sessionKey,
      selectedTools: (() => {
        const workflow = workflowTools(config.tools, config.memory.enabled, false);
        const tools = workflow?.length ? [...new Set([...workflow, ...(reviewModule?.modelTools ?? [])])] : workflow;
        return dispatchPolicy.enabled && tools?.length ? [...new Set([...tools, "plugin_dispatch", "plugin_dispatch_decisions", "plugin_dispatch_plan_history", "plugin_worker_tasks"])] : tools;
      })(),
      registeredTools: composeToolCatalog(plugins.tools, initialReloadableTools, reloadableTools?.tools ?? new Map()).map(tool => tool.name),
      dispatcherEnabled: dispatchPolicy.enabled, dispatcherReady: dispatcher?.ready === true,
      dispatcherWorkers: dispatcher?.workers,
      messagingGateways: gatewayManager?.messagingCapabilities(),
      reviewInstructions: reviewEngine.instructions,
    }),
    beforeTurn: async (input) => {
      subagents.beforeTurn(input.sessionKey);
      dispatchRuntime?.beforeTurn(input.sessionKey);
      await protectedContent.verify();
      if (config.autoReloadToolPlugins) await reloadableTools?.refresh();
      await improvement?.before(input);
      await plugins.policies.prepare(cwdFor(input.sessionKey), input);
    },
    reportOutput: (input, output) => plugins.reportProcessing.record(input, output),
    reportContext: input => plugins.reportProcessing.context(input),
    turnCommitted: async (input) => { await improvement?.committed(input); },
    continuationDeadline: input => config.completionCheck?.authorizations?.[input.sessionKey]?.expiresAt,
    topicLabeler: semanticTopicLabeler(runtimeReviewer(runtime), () => effectiveModels().reviewModel),
    completionCheck: async (input, reply, signal, diagnostic) => {
      const grant = config.completionCheck?.authorizations?.[input.sessionKey] ??
        (input.completionAnchor ? { task: input.completionAnchor.task } : undefined);
      return assessCompletion(supervisorReviewer(), input, reply, grant, signal, effectiveModels().reviewModel, Date.now, completion.current, diagnostic, config.completionCheck?.timeoutMs ?? 30000, plugins.validators);
    },
    afterTurn: async (input, reply, session, options, signal) => {
      await reloadRuntimeSettings();
      const result = await plugins.policies.finish(cwdFor(input.sessionKey), input, reply, session, options, signal);
      await improvement?.completed(input, result, signal);
      return result;
    },
    tickMs: config.loop.tickMs,
    busyMode: config.loop.busyMode,
    gateways: settings.effective().gateways,
    activity: config.activity,
    log,
    // Permanently rejected replies (e.g. no permission in the room) are parked for manual follow-up.
    parkUndeliverable: (entry, error) =>
      appendFileDurable(path.join(config.home, "outbox-deadletter.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), error, ...entry })}\n`),
  });
  harness.home = config.home_address;
  gatewayManager = new GatewayManager(harness, settings, {
    inboundAttachments: 1, outboundAttachments: 1,
    services: plugins.services,
    home: config.home, agent: config.agent, approvers: config.approvers, admins: config.admins,
  }, bundledGatewayModules());
  await gatewayManager.load();
  const gatewayApprovers = gatewayManager.approvers;
  const admins = config.admins.length ? config.admins : gatewayApprovers;
  const approvers = config.approvers.length ? config.approvers : gatewayApprovers.length ? gatewayApprovers : admins;
  const nightly = await nightlyStrategyHolder(config.home, config.nightlyStrategy, nightlyDefault);
  improvement = new ImprovementController(config.home, harness, config.timezone, Date.now, nightly.current!, async request => {
    const task = "Prüfe den Abschluss der GESAMTEN autorisierten Nachtarbeit, nicht nur eines Experiments. " +
      "Ein verworfener Versuch oder fehlende Skill-Ideen belegen keine Erschöpfung. Berücksichtige Core, Plugins, " +
      "Integrationen, bestehende und fehlende Features sowie erlaubte öffentliche Ansätze anderer Agenten. " +
      "Bestätige completed nur bei fachlich begründetem Ende; sonst continue mit einem konkreten sicheren nächsten Schritt. " +
      JSON.stringify({ night: request.night, turns: request.turn, maxTurns: request.maxTurns,
        expiresAt: request.expiresAt, experiments: request.experiments });
    return assessCompletion(supervisorReviewer(), request.input, request.reply,
      { task, purpose: "nightly-closure", expiresAt: request.expiresAt }, request.signal, effectiveModels().reviewModel,
      Date.now, completion.current, undefined, config.completionCheck?.timeoutMs ?? 30000, plugins.validators);
  }, () => executions.list("improvement:nightly"));
  await improvement.initializeStrategy(nightly, settings.snapshot().nightlyStrategy);
  let nextLedgerCompact = 0;
  let ledgerRecoveryReady = false;
  const gatewayTimer = setInterval(() => {
    if (ledgerRecoveryReady && Date.now() >= nextLedgerCompact) {
      nextLedgerCompact = Date.now() + 60 * 60 * 1000;
      void executions.compact(undefined, dispatchPolicy.retentionDays * 86400000).catch(() => log("[execution] ledger archive failed; records retained"));
    }
    void gatewayManager.tick().catch(() => log("[gateway] activation failed"));
    void dispatcher?.kick().catch(() => log("[dispatcher] scheduling failed"));
  }, 2000);
  gatewayTimer.unref();
  // Hermes-compatible HTTP API; enabled by explicit key or private loopback key file.
  const runs = new RunRegistry(path.join(config.home, "runs.json"));
  const tlsKeyFile = process.env.API_SERVER_TLS_KEY_FILE;
  const tlsCertFile = process.env.API_SERVER_TLS_CERT_FILE;
  if (Boolean(tlsKeyFile) !== Boolean(tlsCertFile)) throw new Error("API TLS requires both key and certificate files");
  if (tlsKeyFile && !apiKey) throw new Error("API TLS requires an API key");
  const apiTls = tlsKeyFile && tlsCertFile
    ? { key: await readFile(tlsKeyFile), cert: await readFile(tlsCertFile) } : undefined;
  if (apiKey) {
    await runs.load();
    harness.addChannel(
      new ApiChannel({
        key: apiKey,
        host: process.env.API_SERVER_HOST,
        port: process.env.API_SERVER_PORT ? Number(process.env.API_SERVER_PORT) : undefined,
        tls: apiTls,
        agent: config.agent,
        runs,
        software: () => readSoftwareVersions(BUILD_INFO),
        lifecycle: { timeoutSeconds: config.lifecycle?.restartTimeoutSeconds ?? 60,
          nativeSoftwareUpdates: !containerRuntime() && config.softwareUpdates?.enabled !== false },
        updateAdmission: harness,
        cancel: (key, id) => harness.cancel(key, id),
        models: () => runtime.models(),
        defaultModel: () => effectiveModels().model,
      }),
    );
  }
  let announceStartup = () => {}; // TUI selection can finish after channel startup.
  // Console: interactive use, or when nothing else would receive input. A daemon with Matrix or
  // the API (e.g. a container without a TTY) does not read stdin unless asked to.
  if (interactive) {
    localSessions = await LocalSessions.open(config.home, config.cwd);
    sessionOwners.add(localSessions);
    const restartSession = process.send && process.connected ? process.env.HAYATE_RESTART_SESSION : undefined;
    if (restartSession) await localSessions.resume(restartSession);
    else await localSessions.create();
    tui = new HarnessTuiChannel({
      sessions: localSessions,
      workState: () => {
        const state = harness.sessions.get(localSessions?.current?.key ?? "console:local");
        return { running: !!state?.running, queued: state?.queue.length ?? 0 };
      },
      remainingWorkNotice: () => harness.remainingWorkNotice(localSessions!.current!.key),
      canSwitchSession: () => {
        const key = localSessions?.current?.key;
        const state = key ? harness.sessions.get(key) : undefined;
        return !state?.running && !state?.queue.length && !state?.outbox.length && !state?.unsaved
          && !harness.pendingInputs().some((input) => input.sessionKey === key)
          && !executions.list(key).some(task => task.status === "running" || task.status === "ready")
          && !subagents.list(key!).some(task => task.state === "running" || task.state === "queued");
      },
      panels: () => plugins.panels.values(),
      agent: config.agent,
      models: () => runtime.models(),
      login: (ui) => runtime.login(ui),
      quit: () => void shutdown(0),
      interrupt: () => void shutdown(130, true),
      prepareSession: async () => {
        const key = localSessions?.current?.key ?? "console:local";
        await harness.sessionFor(key);
        if (hostAdmissionReady) { await dispatcher?.activateParent(key); await subagents.reconcile(sessionEnabled); await harness.activateSession(key); announceStartup(); }
      },
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
  await executions.reconcileSettledTurns(new Set((saved?.pending ?? []).flatMap(input => input.executionTurnId ? [input.executionTurnId] : [])));
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
  const subagents = new Subagents(harness, async () => { await persist(); });
  contextParent = key => subagents.snapshot().find(record => record.sessionKey === key)?.parent ??
    executions.list().find(task => key === `dispatch:${task.id}:${task.token}`)?.parent;
  subagents.restore(saved?.subagents ?? []);
  subagents.restoreOverrides(saved?.subagentOverrides ?? {});
  // Freeze contexts of previously used conversations before plugins can bind new
  // streams. Legacy histories inherit their pre-upgrade host/worker context.
  for (const session of saved?.sessions ?? []) await executionContexts.capture(session.key);
  harness.addChannel(subagents.channel);
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
      subagents: subagents.snapshot(),
      subagentOverrides: subagents.overrides(),
      pending: pending.length ? pending : undefined,
      outbox: harness.outboxEntries().length ? harness.outboxEntries() : undefined,
      seen: harness.seenIds(),
    });
  // Restore before scheduler execution, persistence callbacks, or channel startup can write state.
  // Historical permits/timers are not evidence of ongoing execution. Establish
  // the upgrade boundary before any scheduler/channel can release old input.
  await executions.holdLegacyRecovery();
  harness.holdLegacyRecovery(saved?.pending ?? []);
  if (saved?.pending?.length) harness.restorePending(saved.pending);
  if (saved?.outbox?.length) harness.restoreOutbox(saved.outbox);
  ledgerRecoveryReady = true;
  harness.onStateChange = () => persist();
  // Persist held history before plugins, dispatcher or channels can execute.
  await persist();
  if (apiKey) {
    // A run whose turn never made it into the inbox (crash between record and accept) is over.
    const pendingIds = new Set((saved?.pending ?? []).map((i) => i.id));
    const outboxRuns = new Set((saved?.outbox ?? []).filter((e) => e.to.channel === API_CHANNEL).map((e) => e.to.target));
    const lost = await runs.reconcile((r) => pendingIds.has(r.input_id) || outboxRuns.has(r.run_id));
    if (lost.length) console.error(`[api] ${lost.length} run(s) interrupted by the restart`);
  }
  await scheduler.load();

  const extensionManager = new ExtensionManager(harness, plugins, settings, { home: config.home, cwd: config.cwd, agent: config.agent },
    [...builtinCommandNames, "sessions", "resume", ...skills.map(s => s.name)]);
  const policyManager = new PolicyManager(harness, plugins.policies, settings, { home: config.home, cwd: config.cwd, agent: config.agent });
  settings.onPluginReload(pluginOverlayReload(settings, { gateway: gatewayManager, policy: policyManager, extension: extensionManager }));
  const reportPlugin = cronReportPlugin({ home: config.home,
    backend: { analyze: (prompt, signal) => runtimeReviewer(runtime).review(prompt, effectiveModels().reviewModel, "off", signal) },
    dispatch: async (report, requestId, task) => {
      if (!dispatcher || harness.paused) throw Error("Dispatcher unavailable or Harness paused");
      const key = `cron-followup:${requestId}`;
      if (executions.list(key).some(item => item.requestId === requestId)) return;
      const mandate = await harness.scheduledMandate(key, requestId, report.authorization!);
      await dispatcher.submitScheduled(key, requestId, task, mandate);
    },
  });
  let requestRestart: () => Promise<void> = async () => { throw Error("Lifecycle startup not complete; retry restart"); };
  await plugins.load(config.plugins ?? [], { agent: config.agent, home: config.home, cwd: config.cwd, executionContexts: executionContextCapability, foregroundWork: work => harness.withForegroundWork(work) }, [...builtinCommandNames, "sessions", "resume", ...skills.map((s) => s.name)], ["console", "api", "dispatch", ...Object.keys(bundledGatewayModules()), ...harness.channels.keys()], [taskPriorityPlugin(harness, async (key, taskId, priority, signal) => {
    const session = harness.sessions.get(key), input = session?.current;
    const task = (session?.tasks ?? (session?.task ? [session.task] : [])).find(task => task.id === taskId);
    if (!task || input?.source !== "channel" || !(input.replyTo?.channel === "console" || !!input.sender && admins.includes(input.sender))) return false;
    const text = input.text;
    const approved = await operatorPriorityIntent(runtimeReviewer(runtime, "supervisor"), text, { id: task.id, original: task.original }, priority, signal);
    return approved && !signal?.aborted && harness.sessions.get(key)?.current === input && input.text === text;
  }), softwareLifecyclePlugin(() => requestRestart(), (action, key) => {
    if (action === "install" && config.softwareUpdates?.enabled !== false && config.softwareUpdates?.autoInstall !== false) return true;
    if (action === "restart" && config.lifecycle?.agentRestart === true) return true;
    const input = harness.sessions.get(key)?.current;
    return input?.source === "channel" && (input.replyTo?.channel === "console" || !!input.sender && admins.includes(input.sender));
  }), ...(values["--maintenance-directory"] ? [maintenanceControlPlugin(Object.freeze({
    status: () => maintenance.admissionStatus(values["--maintenance-session"]!),
    admit: (id: string, request: import("./context-maintenance.js").MaintenanceRequest, version: number) => maintenance.admit(values["--maintenance-session"]!, id, request, version),
    cancel: (id: string, version: number) => maintenance.cancelAdmission(values["--maintenance-session"]!, id, version),
    maintain: () => harness.maintainIdle(values["--maintenance-session"]!),
  }), path.resolve(values["--maintenance-directory"]))] : []), ...(values["--observe-directory"] ? [sessionObserverPlugin(Object.freeze({ observeSession: (key: string) => harness.observeSession(key) }), path.resolve(values["--observe-directory"]), values["--observe-session"]!)] : []), validatorPlugin, memoryOrchestrationPlugin(plugins.memoryOrchestration, settings, harness, config.memory.enabled), completionStrategyPlugin(completion, settings, harness), contextStrategyPlugin(strategies, settings, harness, maintenance), compactionStrategyPlugin(selectedCompaction, settings, harness, maintenance), nightlyStrategyPlugin(nightly, settings, improvement), reportPlugin, dispatcherPlugin(() => dispatcher), dispatchDecisionsPlugin(() => dispatcher), dispatchPlanHistoryPlugin(() => dispatcher), workerTasksPlugin(config.home, () => dispatcher, async (parent, requestId, input) => {
      if (!dispatcher || harness.paused) throw Error("Dispatcher unavailable or Harness paused");
      const existing = await executions.findRequest(parent, requestId);
      if (existing) {
        if (existing.input !== input) throw Error("Conflicting operator task request");
        return existing;
      }
      const mandate = await harness.operatorTaskMandate(parent, requestId, input);
      return dispatcher.submitScheduled(parent, requestId, input, mandate);
    }), subagentPlugin(subagents,async()=>{await persist();}), ...(reloadableTools ? [reloadableToolsPlugin(reloadableTools)] : []), wasmToolsPlugin(config.home, config.wasmTools ?? []), continuationPlugin(harness), loopPlugin(harness), improvementPlugin(improvement!), protectedContentPlugin(protectedContent), gatewayManagerPlugin(gatewayManager, settings), messagePlugin(config.home, gatewayManager), conversationPolicyPlugin(settings, harness), policyManagerPlugin(policyManager, settings), extensionManagerPlugin(extensionManager, settings), gatewayPlugin(settings, harness), contextPlugin(maintenance, settings), ...(config.memory.enabled ? [memoryPlugin(memory), ...(config.memory.consolidation ? [memoryConsolidationHost(config.memory.consolidation, runtime, memory, log)] : [])] : []), skillSearchPlugin(skillCatalog), ...(adaptiveSkills ? [adaptiveSkills.plugin()] : []), ...reviewEngine.plugins], [settings.desired().gatewayPlugins?.webui?.module].filter((value): value is string => typeof value === "string"));
  if (dispatchPolicy.enabled) {
    dispatchRuntime = new DispatcherRuntime(harness, executions, async () => {
      await reloadRuntimeSettings();
      return settings.effective().dispatcher?.rules;
    }, () => ({ config: settings.effective().modelRoles,
      defaults: { model: effectiveModels().model, thinking: effectiveModels().thinking },
      review: settings.effective().review?.model ? { model: settings.effective().review!.model, thinking: settings.effective().review?.thinking ?? "medium" } : undefined }), plugins.validators);
    harness.addChannel(dispatchRuntime.channel);
    const strategy = dispatchPolicy.strategy === "direct" ? dispatchRuntime.strategy : dispatchPolicy.strategy === "sequential" ? dispatchRuntime.sequential : plugins.dispatchers.get(dispatchPolicy.strategy);
    if (!strategy) throw Error("Configured dispatcher strategy unavailable");
    dispatcher = new Dispatcher(executions, strategy, dispatchPolicy.capacity, async event => {
      const task = executions.list(event.parent).find(item => item.id === event.executionId);
      // Execution-owned trusted destination; legacy records use configured home.
      const target = executionTarget(task, harness.home);
      // Results use durable Harness inbox acceptance and stable event IDs.
      // Status is inspectable without a model call through /dispatch.
      if (event.type !== "result") {
        if (!task || task.parentStopped) return;
        if ((event.type === "question" || event.type === "status") && !event.parent.startsWith("cron-followup:")) {
          const to = target;
          const text = dispatchRuntime!.eventText(event);
          // Questions and recovery blockers require attention. Routine lifecycle
          // belongs to one update row, never a succession of final answers.
          if (to?.channel === "api") {
            // The API run belongs to the parent turn, not its child's status or
            // question. Preserve stop/final-answer ownership while exposing SSE.
            await harness.deliver(to, text, { deliveryId: `dispatch-event:${event.id}`, presentation: "progress" });
          } else if (attentionRequired(event, task.status)) {
            await harness.deliver(to, text, { deliveryId: `dispatch-event:${event.id}` });
          } else if (event.parent !== "improvement:nightly") {
            await harness.deliver(to, text, { deliveryId: `dispatch-event:${event.id}`, statusKey: `dispatch:${event.executionId}` });
          }
        }
        return;
      }
      if (event.parent === "improvement:nightly" && await improvement?.delegatedResult(event.executionId)) return;
      if (!dispatchRuntime?.resultAllowed(event.parent, event.executionId)) return;
      await harness.accept({ id: `dispatch-event:${event.id}`, source: "host", sessionKey: event.parent,
        hostEvent: { executionId: event.executionId },
        text: `Dispatcher result (data, not new authorization) for ${event.executionId}:\n${event.text}`,
        replyTo: event.parent.startsWith("cron-followup:") ? undefined : target });
    }, error => log(`[dispatcher] ${String(error)}`), key => harness.dependencyCheckpoint(key), undefined, () => harness.updateFenced || harness.stopping,
    // Built-ins stay registered so tasks queued before a strategy switch are not stranded.
    [dispatchRuntime.strategy, dispatchRuntime.sequential], sessionEnabled, parallelAdmission, key => harness.dispatchOrigin(key),
    task => harness.taskPriority(task.parent, task.dependency?.taskId));
  }
  plugins.memoryOrchestration.select(config.memory.enabled ? config.memory.orchestration ?? "default" : "none");
  const memoryProvider = new MemoryProviderLifecycle(async () => {
    const factory = config.memory.provider === "local" ? undefined : plugins.memoryProviders.get(config.memory.provider);
    if (config.memory.provider !== "local" && !factory) throw Error("Unknown memory provider");
    return factory ? factory({ home: config.home, config: config.memory }) : LocalMemory.open(config.home, config.memory);
  });
  if (config.memory.enabled) memory.provider = memoryProvider;
  const connectMemory = async () => {
    if (!config.memory.enabled) return;
    try { await memoryProvider.ensureConnected(); }
    catch { log("[memory] provider unavailable; failed cleanup requires restart, otherwise retrying on next maintenance tick"); }
  };
  await connectMemory();
  for (const name of reloadableTools?.tools.keys() ?? []) {
    const tool = plugins.tools.get(name);
    if (!tool) throw Error("Reloadable startup tool missing");
    initialReloadableTools.set(name, tool);
  }
  try { await policyManager.load(); await extensionManager.load(); }
  catch (err) { await extensionManager.stop().catch(() => {}); await policyManager.stop().catch(() => {}); await plugins.stop().catch(() => {}); throw err; }
  plugins.reportProcessing.select(config.reportProcessing ?? "cron");
  const cronReportTimer = setInterval(() => {
    if (!harness.stopping && !harness.updateFenced) void harness.withForegroundWork(() => plugins.reportProcessing.tick()).catch(() => log("[cron] report processing deferred"));
  }, 30000);
  cronReportTimer.unref();
  const policyTimer = setInterval(() => { void policyManager.tick().catch(() => {}); void extensionManager.tick().catch(() => {}); }, 1000);
  policyTimer.unref();
  const memoryTimer = config.memory.enabled ? setInterval(() => { void connectMemory().then(() => memory.flush()).catch(() => log("[memory] capture backlog retained")); }, 30000) : undefined;
  memoryTimer?.unref();
  void memory.flush().catch(() => log("[memory] capture backlog retained"));
  compaction = new CompactionSelection(plugins.compactions, config.compaction?.strategy ?? "native");
  if (settings.snapshot().compactionStrategy !== undefined) {
    await compaction.change(settings.snapshot().compactionStrategy, async () => {});
  }
  const providerName = config.sessions?.provider ?? "native";
  if (providerName === "filesystem") sessionProvider = new FilesystemSessionProvider(path.join(config.home, "session-store"));
  else if (providerName !== "native") {
    const factory = plugins.sessionProviders.get(providerName);
    if (!factory) throw new Error(`Unknown session provider: ${providerName}`);
    sessionProvider = await factory({ home: config.home, options: config.sessions?.options });
  }
  const sessionProviderOwner = sessionProvider ? new SessionProviderLifecycle(sessionProvider) : undefined;
  sessionProvider = sessionProviderOwner;
  if (localSessions) localSessions.provider = sessionProvider ?? new FilesystemSessionProvider(path.join(config.home, "session-store"));
  for (const channel of plugins.channels.values()) harness.addChannel(channel);

  let stopping = false;
  const shutdown = async (code = 0, interrupt = false) => {
    if (stopping) return;
    stopping = true;
    harness.stopping = true; // fence synchronously, before any ordered cleanup awaits
    let persisted = false;
    const deadline = new ShutdownDeadline((config.lifecycle?.restartTimeoutSeconds ?? 60) * 1000, () => {
      console.error(`[lifecycle] shutdown deadline reached; ${persisted ? "checkpoint saved" : "previous durable inbox retained; final checkpoint unconfirmed"}`);
      process.exit(persisted ? code : 1);
    });
    // Signal all producers/owners now. Waiting for business-level idle would
    // deadlock durable agents that have queued work, monitors or periodic jobs.
    scheduler.stop();
    clearInterval(policyTimer);
    clearInterval(cronReportTimer);
    clearInterval(gatewayTimer);
    clearInterval(memoryTimer);
    improvement?.stop();
    // Abort all owners before awaiting any of them: an active review may itself
    // be waiting on a Harness worker. Sequential teardown deadlocked that cycle.
    const owners = Promise.allSettled([reviewWorkers.stop(), reviewSubagents.stop(), plugins.reportProcessing.stop(), dispatcher?.stop()]);
    const selected = interrupt && localSessions?.current ? harness.sessions.get(localSessions.current.key) : undefined;
    const cancelledInput = selected?.current;
    const cancellationReceipt = selected && cancelledInput?.executionTurnId
      ? executions.stopTurn(cancelledInput.executionTurnId, selected.key).then(() => true, () => false) : Promise.resolve(true);
    if (selected && cancelledInput) {
      selected.cancelling = cancelledInput;
      cancelledInput.continuation = undefined;
      const task = selected.tasks?.find(task => task.id === cancelledInput.taskId) ??
        (selected.task?.id === cancelledInput.taskId ? selected.task : undefined);
      if (task) { task.state = "stopped"; task.recoveryAdmission = undefined; }
    }
    // Reserve part of the SAME deadline for durable snapshot and delivery cleanup.
    const reserve = Math.min(5000, (config.lifecycle?.restartTimeoutSeconds ?? 60) * 200);
    const retained = await deadline.wait(harness.stop(interrupt ? 0 :
      Math.min(config.loop.drainSeconds * 1000, deadline.remaining(reserve + 1000)),
      Math.min(1000, deadline.remaining(reserve))), deadline.remaining(reserve), () => harness.pendingInputs());
    // Only the explicitly interrupted current turn is cancelled; queued human
    // inputs and other conversations remain durable, parked under their owners.
    const cancelledDurably = await deadline.wait(cancellationReceipt, 1000, () => false);
    let unfinished = cancelledInput && cancelledDurably ? retained.filter(input =>
      !(cancelledInput.id && input.id === cancelledInput.id) &&
      !(cancelledInput.executionTurnId && input.executionTurnId === cancelledInput.executionTurnId) &&
      !(cancelledInput.completionAnchor?.id && input.completionAnchor?.id === cancelledInput.completionAnchor.id)) : retained;
    if (cancelledInput && !cancelledDurably) {
      unfinished = [...retained, structuredClone(cancelledInput)];
      console.error("[state] interruption could not be durably confirmed; input retained for reconciliation"); code = 1;
    }
    harness.onStateChange = undefined;
    // A graceful stop is not the turn's fault: only crashes (OOM, kill) count towards giving up.
    for (const input of unfinished) if (sessionEnabled(input.sessionKey)) input.started = undefined;
    for (let attempt = 0; attempt < 2 && !persisted && deadline.remaining() > 0; attempt++) {
      try {
        persisted = await deadline.wait(persist(unfinished).then(() => true), 2000, () => false);
        if (!persisted) break; // A timed-out write has an unknown outcome; never overlap retries.
      } catch { console.error("[state] shutdown save failed; retaining ownership for a bounded retry"); }
    }
    if (!persisted) { console.error("[state] shutdown snapshot was NOT saved; previous durable inbox retained"); code = 1; }
    if (unfinished.length) console.error(`[harness] ${unfinished.length} pending input(s) retained for their owning conversations`);
    const cleanup = Promise.allSettled([owners, mcp.close(), memoryProvider.close(), extensionManager.stop(), policyManager.stop(), sessionProviderOwner?.close(), plugins.stop().then(() => executionContexts.drain())]);
    await deadline.wait(cleanup.then(() => undefined), 3000, () => undefined);
    deadline.close();
    // The kernel releases the Home lock when this owner exits, never while its
    // uncooperative callbacks could still write beside a replacement process.
    process.exit(code);
  };

  // The bundled review command is startup-owned; retain the live registry for
  // dynamically replaced extension commands.
  const reviewCommand = plugins.commands.get("review");
  if (reviewCommand) plugins.commands.set("review", { ...reviewCommand, run: async (...args) => {
    await reloadRuntimeSettings();
    return reviewCommand.run(...args);
  } });
  // Benchmarks reuse the dispatcher so a measured run goes through the same
  // queue, policy and session logs as any other delegated worker task.
  const activeDispatcher = dispatcher;
  const benchmarkService = activeDispatcher
    ? new BenchmarkService({
      submitScheduled: (parent, requestId, text, mandate, pinned) => activeDispatcher.submitScheduled(parent, requestId, text, mandate, pinned),
      waitForExecution: id => activeDispatcher.waitForExecution(id),
      control: (parent, id, action) => activeDispatcher.control(parent, id, action),
      list: parent => executions.list(parent),
    } satisfies BenchmarkSubmitter, { home: config.home, config: () => settings.effective().benchmark })
    : undefined;

  requestRestart = async () => {
    if (localSessions?.current && process.send && process.connected) {
      try { process.send({ type: "hayate-restart", session: localSessions.current.id }, error => {
        if (error) log("[lifecycle] foreground selection handoff failed; durable sessions retained");
      }); } catch { log("[lifecycle] foreground selection handoff unavailable; durable sessions retained"); }
    }
    void shutdown(75);
  };
  const softwareEvent = (message: unknown) => {
    const event = message as { type?: unknown; event?: unknown; detail?: unknown };
    if (event?.type !== "hayate-software-event" || !["available", "prepared"].includes(event.event as string) || typeof event.detail !== "string") return;
    const target = harness.home ?? config.home_address;
    const text = event.event === "prepared" ? `♻️ Software prepared; checkpointing and restarting: ${event.detail}` :
      `Software update available: ${event.detail}. ${config.softwareUpdates?.autoInstall === false ? "Use /update install to install and restart." : "Automatic download and validation enabled."}`;
    log(`[lifecycle] ${text}`);
    if (target) harness.post({ source: "host", sessionKey: `${target.channel}:${target.target}`, text: "Software lifecycle notice", replyTo: target }, text);
    if (event.event === "prepared") void requestRestart();
  };
  process.on("message", softwareEvent);
  installCommands({
    harness,
    softwareUpdates: requestSoftwareUpdate,
    benchmark: benchmarkService,
    mcp,
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
    modelRoles: { get: () => settings.effective().modelRoles, set: value => settings.setModelRoles(value) },
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
    cwdFor,
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
    // Exit with 75 after drain. The native foreground launcher or service supervisor restarts.
    restart: requestRestart,
  });

  // Kill the largest tool child before the kernel OOM-kills the whole container.
  const stopGuard = startMemoryGuard({ percent: config.memoryGuard.percent, log });
  process.on("exit", stopGuard);
  process.on("SIGINT", () => void shutdown(130, interactive));
  process.on("SIGTERM", () => void shutdown(143));
  process.on("SIGHUP", () => void shutdown(129, interactive));
  if (interactive) {
    process.stdin.once("end", () => void shutdown(129, true));
  }
  // A lost native foreground owner is not a user cancellation. Checkpoint in
  // gateway mode too, so an orphan cannot retain the Home lock indefinitely.
  process.once("disconnect", () => void shutdown(interactive ? 129 : 143));
  try {
    await harness.start();
    await improvement!.start();
  }
  catch (err) {
    clearInterval(policyTimer);
    clearInterval(cronReportTimer);
    await plugins.reportProcessing.stop();
    await harness.stop(0).catch(() => {});
    await extensionManager.stop().catch(() => {});
    await policyManager.stop().catch(() => {});
    clearInterval(gatewayTimer);
    clearInterval(memoryTimer);
    await memoryProvider.close().catch(() => {});
    await sessionProviderOwner?.close().catch(() => {});
    await plugins.stop().catch(() => {});
    throw err;
  }

  // Replay only after outbound channels are authenticated and ready. Entries remain in the
  // durable inbox until both their reply and the completion-state write succeed.
  // A crash can land between the Harness snapshot and child-ledger saves.
  // Finish retained conversation revocation before any child is admitted.
  for (const session of harness.snapshotSessions()) {
    if (!session.stopPending) continue;
    await executions.cancelParent(session.key);
    await subagents.revokeChildren(session.key);
  }
  for (const session of harness.snapshotSessions()) {
    if (session.stopPending) await harness.stopConversation(session.key);
  }
  if (apiKey) await harness.reconcileCancelledApiTasks((key, inputId) => {
    const receipt = runs.get(inputId.slice("api:".length));
    return receipt?.status === "cancelled" && receipt.session_key === key && receipt.input_id === inputId;
  });
  await harness.reconcileStoppedTasks();
  await subagents.reconcile(sessionEnabled);
  await dispatcher?.start();
  await harness.recoverTasks();
  if (saved?.pending?.length || saved?.outbox?.length || harness.pendingInputs().length) {
    const pending = (saved?.pending ?? []).filter(input => sessionEnabled(input.sessionKey)).length;
    const replies = (saved?.outbox ?? []).filter(entry => sessionEnabled(entry.sessionKey)).length;
    if (pending || replies) console.error(`[harness] replaying ${pending} unfinished input(s), ${replies} undelivered reply(ies) for selected/remote conversations`);
    // Replay counters (and abandoned inputs' failure replies) are durable before anything runs.
    await persist();
    harness.releaseRestored();
  }
  await persist(); // Complete failure-capable startup work before claiming readiness.
  if (stopping) return;
  hostAdmissionReady = true;
  // Never acknowledge from the old process or before startup recovery and
  // channel authentication succeed. Delivery remains independent of work.
  const startupNotice = new StartupNotice({ agent: config.agent,
    build: readSoftwareVersions(BUILD_INFO), restarted: !!saved,
    post: (input, text) => harness.post(input, text), log });
  announceStartup = () => {
    if (stopping) return;
    if (localSessions) {
      // Do not fall back to a remote home while local selection is in flight.
      const current = localSessions.current;
      if (current) startupNotice.ready({ channel: "console", target: current.key });
    } else startupNotice.ready(startupNoticeTarget(harness.home ?? config.home_address,
      harness.snapshotSessions(), new Set(harness.channels.keys())));
  };
  announceStartup();
  if (process.send && process.connected) process.send({ type: "hayate-runtime-ready" }, () => {});
}

main(process.argv.slice(2)).catch(async (err) => {
  for (const owner of sessionOwners) await owner.release().catch(() => {});
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
