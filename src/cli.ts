#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { HarnessTuiChannel } from "./channels/tui.js";
import { ConsoleChannel } from "./channels/console.js";
import { MatrixChannel, matrixOptionsFromEnv } from "./channels/matrix.js";
import { RunRegistry } from "./api/runs.js";
import { API_CHANNEL, ApiChannel } from "./api/server.js";
import { PluginHost } from "./plugins.js";
import { builtinCommandNames, installCommands, VERSION } from "./commands.js";
import { loadConfig } from "./config.js";
import { initialize, diagnose } from "./setup.js";
import { Harness } from "./harness.js";
import { startMemoryGuard } from "./memguard.js";
import { loadPersona, personaSections } from "./persona.js";
import { PiRuntime } from "./runtime/pi.js";
import { launchMode } from "./launch.js";
import { Scheduler } from "./scheduler.js";
import { StateStore } from "./state.js";
import type { Inbound } from "./types.js";
import { discoverSkills, type SkillInfo } from "./skills.js";
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
  let tui: HarnessTuiChannel | undefined;
  const log = (text: string) => tui ? tui.note(text) : console.error(text);
  const approvals = { mode: "off" as "off" | "manual", tools: [] as string[] };
  let personality: string | undefined;
  let skills: SkillInfo[] = [];
  const skillDirs = () => [...config.skills.paths, path.join(config.cwd, ".pi", "skills"), path.join(getAgentDir(), "skills")];
  const reloadSkills = async () => {
    skills = await discoverSkills(skillDirs());
  };
  await reloadSkills();

  let harness!: Harness;
  const runtime = new PiRuntime({
    cwd: config.cwd,
    sessionsDir: path.join(config.home, "sessions"),
    model: config.model,
    thinking: config.thinking,
    tools: config.tools,
    skillPaths: config.skills.paths,
    personaSections: async () => personaSections(await loadPersona(config.persona, personality), { name: config.agent, workspace: config.cwd }),
    approvals,
    requestApproval: (key, tool, input) => harness.requestApproval(key, tool, input),
  });
  harness = new Harness({
    runtime,
    tickMs: config.loop.tickMs,
    busyMode: config.loop.busyMode,
    log,
    // Permanently rejected replies (e.g. no permission in the room) are parked for manual follow-up.
    parkUndeliverable: (entry, error) =>
      appendFileDurable(path.join(config.home, "outbox-deadletter.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), error, ...entry })}\n`),
  });
  harness.home = config.home_address;
  const matrixOpts = matrixOptionsFromEnv(process.env, config.home);
  // Resolve one remote approval policy and pass it to both Matrix reactions and commands.
  const matrixApprovers = matrixOpts?.approvers ?? [];
  const admins = config.admins.length ? config.admins : matrixApprovers;
  const approvers = config.approvers.length ? config.approvers : matrixApprovers.length ? matrixApprovers : admins;
  if (matrixOpts) {
    const matrix = new MatrixChannel({ ...matrixOpts, approvers, displayName: matrixOpts.displayName ?? config.agent });
    harness.addChannel(matrix);
    harness.home ??= matrix.home;
  }
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
        defaultModel: () => config.model,
      }),
    );
  }
  // Console: interactive use, or when nothing else would receive input. A daemon with Matrix or
  // the API (e.g. a container without a TTY) does not read stdin unless asked to.
  if (interactive) {
    tui = new HarnessTuiChannel({
      agent: config.agent,
      models: () => runtime.models(),
      login: (ui) => runtime.login(ui),
      quit: () => void shutdown(0),
      status: () => {
        const sessions = [...harness.sessions.values()];
        const active = sessions.filter((s) => s.running).length;
        const queued = sessions.reduce((n, s) => n + s.queue.length, 0);
        const model = harness.sessions.get("console:local")?.session?.status().model ?? config.model ?? "runtime default";
        return `Model: ${model} · ${harness.paused ? "PAUSED" : "running"} · Active: ${active} · Queue: ${queued}\nGoals: ${sessions.filter((s) => s.goal).length} · Heartbeats: ${sessions.filter((s) => s.heartbeat).length} · Channels: ${[...harness.channels.keys()].join(", ")}`;
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

  const plugins = new PluginHost();
  await plugins.load(config.plugins ?? [], { agent: config.agent, home: config.home, cwd: config.cwd }, [...builtinCommandNames, ...skills.map((s) => s.name)], ["console", "api", "matrix", ...harness.channels.keys()]);
  for (const channel of plugins.channels.values()) harness.addChannel(channel);

  let stopping = false;
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    // Like Hermes restart_drain_timeout: stop input, finish in-flight work for up to
    // drainSeconds, abort the rest, then persist state (user's /pause flag untouched).
    scheduler.stop();
    const unfinished = await harness.stop(config.loop.drainSeconds * 1000);
    harness.onStateChange = undefined;
    // A graceful stop is not the turn's fault: only crashes (OOM, kill) count towards giving up.
    for (const input of unfinished) input.started = undefined;
    await persist(unfinished).catch((err) => console.error(`[state] save failed: ${err}`));
    if (unfinished.length) console.error(`[harness] ${unfinished.length} unfinished input(s) saved for replay`);
    await plugins.stop().catch(() => console.error("[plugins] cleanup failed"));
    process.exit(code);
  };

  installCommands({
    harness,
    scheduler,
    approvals,
    skills: () => skills,
    pluginCommands: plugins.commands,
    reloadSkills,
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
    openAdmin: !matrixOpts && plugins.channels.size === 0,
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
  try { await harness.start(); }
  catch (err) {
    await harness.stop(0).catch(() => {});
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

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
