import assert from "node:assert/strict";
import { test } from "node:test";
import { type CommandContext, COMMANDS, installCommands, parseCommand } from "../src/commands.js";
import { Harness } from "../src/harness.js";
import type { SkillInfo } from "../src/skills.js";
import { FakeRuntime, MemoryChannel, msg, ROOM } from "./fakes.js";

function setup(opts: { admins?: string[]; approvers?: string[]; skills?: SkillInfo[] } = {}) {
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, tickMs: 60_000, busyMode: "queue", log: () => {} });
  harness.onStateChange = async () => {};
  const ch = new MemoryChannel();
  harness.addChannel(ch);
  const approvals = { mode: "off" as "off" | "manual", tools: [] as string[] };
  let personality: string | undefined;
  const ctx: CommandContext = {
    harness,
    approvals,
    skills: () => opts.skills ?? [],
    reloadSkills: async () => {},
    personality: {
      get current() {
        return personality;
      },
      available: async () => ["warm", "terse"],
      set: async (n) => {
        personality = n;
      },
    },
    admins: opts.admins ?? [],
    approvers: opts.approvers,
    agent: "agent",
    restart: async () => {},
  };
  installCommands(ctx);
  const send = async (text: string, sender?: string) => {
    await harness.submit(msg(text, sender));
    await harness.drained();
  };
  return { runtime, harness, ch, ctx, send, approvals };
}

test("usage and tokens alias report session/cache/cost with honest scope and unknown fallback", async () => {
  const { harness, send, ch } = setup();
  try {
    await send("/usage");
    assert.match(ch.texts().at(-1)!, /tokens in\/out: unknown\/unknown/);
    assert.match(ch.texts().at(-1)!, /estimated cost USD: unknown/);
    const session = await harness.sessionFor("mem:room1");
    session.status = () => ({ sessionId: "usage-test", busy: true, model: "p/m", tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 }, costUsd: 0.012345 });
    await send("/tokens");
    const text = ch.texts().at(-1)!;
    assert.match(text, /usage-test \(busy; partial\)/);
    assert.match(text, /tokens in\/out: 10\/20/);
    assert.match(text, /cache read\/write: 30\/40/);
    assert.match(text, /including cache\): 100/);
    assert.match(text, /estimated cost USD: 0.012345/);
    assert.match(text, /not account billing or parent\/subagent totals/);
    await send("/help");
    assert.match(ch.texts().at(-1)!, /\/usage.*\/tokens/);
  } finally { await harness.stop(1000); }
});

test("global and reviewer model commands require admin for changes and support reset", async () => {
  const { ctx, send, ch, runtime } = setup({ admins: ["owner"] });
  const settings: Record<string, string | undefined> = {};
  ctx.modelSettings = {
    get: () => settings,
    set: async (key, value) => { settings[key] = value; },
  };
  await send("/model p/a --global", "other");
  assert.match(ch.texts().at(-1)!, /admin only/);
  assert.equal(settings.model, undefined);
  await send("/model --global p/a", "owner");
  assert.match(ch.texts().at(-1)!, /at the end/);
  assert.equal(settings.model, undefined);
  await send("/model p/a --global", "owner");
  await send("/reasoning high --global", "owner");
  await send("/review-model p/b", "owner");
  await send("/review-reasoning medium", "owner");
  assert.deepEqual(settings, { model: "p/a", thinking: "high", reviewModel: "p/b", reviewThinking: "medium" });
  await send("/review-model", "other");
  assert.match(ch.texts().at(-1)!, /p\/b/);
  await send("/review-model reset", "owner");
  assert.equal(settings.reviewModel, undefined);
  assert.equal(runtime.sessions.size, 0, "global commands do not mutate busy sessions directly");
});

test("plugin commands use admin authorization, help and outbox instead of model turns", async () => {
  const { ctx, send, ch, runtime } = setup({ admins: ["owner"] });
  let calls = 0;
  ctx.pluginCommands = new Map([["extension", { name: "extension", help: "Extension command", admin: true, run: async () => { calls++; return "plugin reply"; } }]]);
  await send("/extension", "other");
  assert.match(ch.texts().at(-1)!, /admin only/);
  assert.equal(calls, 0);
  await send("/extension", "owner");
  assert.equal(ch.texts().at(-1), "plugin reply");
  await send("/help", "owner");
  assert.match(ch.texts().at(-1)!, /\/extension \[admin\] \[Plugin\]: Extension command/);
  assert.equal(runtime.sessions.size, 0);
});

test("interactive plugin UI is available only to the attached local session", async () => {
  const { ctx, harness, send, ch } = setup();
  const ui = { prompt: async () => "value" } as any;
  ctx.pluginUI = () => ui;
  ctx.pluginCommands = new Map([["interactive", { name: "interactive", help: "UI test", admin: false,
    run: async (_args, context) => context.ui ? "local UI" : "headless" }]]);
  await send("/interactive");
  assert.equal(ch.texts().at(-1), "headless");
  let seen: unknown;
  ctx.pluginCommands = new Map([["interactive", { name: "interactive", help: "UI test", run: async (_args, context) => { seen = context.ui; } }]]);
  await harness.commandHandler!({ text: "/interactive", source: "channel", sessionKey: "console:local", replyTo: { channel: "console", target: "local" } });
  assert.equal(seen, ui);
});

test("parseCommand handles args, bot suffix and non-commands", () => {
  assert.deepEqual(parseCommand("/goal ship v1"), { name: "goal", args: "ship v1" });
  assert.deepEqual(parseCommand("/status@agent"), { name: "status", args: "" });
  assert.equal(parseCommand("hello /status"), undefined);
  assert.equal(parseCommand("/ not a command"), undefined);
});

test("all relevant Hermes gateway commands exist", () => {
  const names = new Set(COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  for (const n of ["new", "reset", "retry", "title", "compress", "compact", "stop", "queue", "q", "steer", "s", "bg", "btw", "agents", "tasks", "goal", "subgoal", "heartbeat", "hb", "loop", "status", "context", "whoami", "profile", "sethome", "model", "reasoning", "personality", "busy", "yolo", "approvals", "approve", "deny", "pause", "restart", "skills", "reload-skills", "reload-mcp", "cron", "help", "commands", "version"]) {
    assert.ok(names.has(n), `missing /${n}`);
  }
});

test("commands do not reach the agent; replies go to the chat", async () => {
  const { send, runtime, ch } = setup();
  await send("/version");
  assert.match(ch.texts()[0], /vanillacore-harness/);
  assert.equal(runtime.sessions.size, 0);
});

test("unknown /word falls through to the agent", async () => {
  const { send, ch } = setup();
  await send("/shrug what now");
  assert.deepEqual(ch.texts(), ["echo: /shrug what now"]);
});

test("/new opens a fresh session", async () => {
  const { send, runtime } = setup();
  await send("hi");
  await send("/new");
  assert.deepEqual(runtime.opened.map((o) => o.fresh), [false, true]);
});

test("/goal, /subgoal, /goal status, /goal clear", async () => {
  const { send, harness, ch } = setup();
  await send("/goal migrate agent to vanillacore-harness");
  await send("/subgoal tests green");
  await send("/goal status");
  assert.match(ch.texts().at(-1)!, /migrate agent[\s\S]*tests green/);
  await send("/goal pause");
  assert.equal(harness.state("mem:room1").goal?.paused, true);
  await send("/goal clear");
  assert.equal(harness.state("mem:room1").goal, undefined);
});

test("/heartbeat every 30m and /loop with --times", async () => {
  const { send, harness, ch } = setup();
  await send("/heartbeat every 30m check matrix inbox");
  const hb = harness.state("mem:room1").heartbeat!;
  assert.equal(hb.everyMs, 30 * 60_000);
  assert.equal(hb.prompt, "check matrix inbox");
  await send("/hb pause");
  assert.equal(hb.paused, true);
  await send("/loop 5m check CI --times 3");
  const loop = harness.state("mem:room1").loop!;
  assert.deepEqual([loop.everyMs, loop.remaining, loop.prompt], [5 * 60_000, 3, "check CI"]);
  await send("/loop 10s too fast");
  assert.match(ch.texts().at(-1)!, /minimum interval/);
});

test("/busy switches mode", async () => {
  const { send, harness } = setup();
  await send("/busy steer");
  assert.equal(harness.busyMode, "steer");
});

test("/model and /reasoning act on the session", async () => {
  const { send, runtime } = setup();
  await send("/model example-provider/claude-opus-5-5");
  await send("/reasoning high");
  const s = runtime.sessions.get("mem:room1")!;
  assert.deepEqual([s.model, s.thinking], ["example-provider/claude-opus-5-5", "high"]);
});

test("YOLO uses explicit idempotent settings and shares approval configuration", async () => {
  const { send, ch, approvals } = setup();
  await send("/yolo");
  assert.equal(approvals.mode, "off");
  assert.match(ch.texts().at(-1)!, /YOLO on/);
  await send("/approvals manual bash");
  for (const command of ["/yolo", "/yolo status", "/yolo toggle", "/yolo on extra"]) {
    await send(command);
    assert.equal(approvals.mode, "manual");
    assert.deepEqual(approvals.tools, ["bash"]);
  }
  assert.equal(ch.texts().at(-1), "usage: /yolo on|off|status");
  for (const command of ["/yolo on", "/yolo on", "/yolo status", "/yolo"]) {
    await send(command);
    assert.equal(approvals.mode, "off");
  }
  for (const command of ["/yolo off", "/yolo off", "/yolo status", "/yolo"]) {
    await send(command);
    assert.equal(approvals.mode, "manual");
  }
  assert.deepEqual(approvals.tools, ["bash"]);
});

test("help identifies Harness and plugin commands, admin access and YOLO scope", async () => {
  const { send, ch, ctx } = setup();
  ctx.pluginCommands = new Map([
    ["z-extension", { name: "z-extension", help: "Admin extension", admin: true, run: async () => {} }],
    ["a-extension", { name: "a-extension", help: "General extension", run: async () => {} }],
    ["extension", { name: "extension", help: "Extension command", admin: true, run: async () => {} }],
  ]);
  for (const command of ["/help", "/commands"]) {
    await send(command);
    const text = ch.texts().at(-1)!;
    assert.match(text, /^VanillaCore Agent Harness commands/);
    assert.match(text, /\/yolo \[admin\] \[Harness\]: on\|off\|status/);
    assert.match(text, /does not bypass permissions or review/);
    assert.match(text, /same state as \/yolo/);
    assert.match(text, /\/extension \[admin\] \[Plugin\]: Extension command/);
    const [general, admin] = text.split("General commands:\n")[1].split("\n\nAdmin commands:\n");
    const names = (section: string) => section.split("\n").map((line) => line.split(" ")[0].split(":")[0]);
    for (const section of [general, admin]) {
      const list = names(section);
      assert.deepEqual(list, [...list].sort());
      assert.equal(new Set(list).size, list.length);
    }
    assert.ok(names(general).includes("/a-extension"));
    assert.ok(!general.includes("[admin]"));
    assert.ok(names(admin).includes("/z-extension"));
    assert.ok(admin.split("\n").every((line) => line.includes("[admin]")));
    assert.match(general, /\/help \(\/commands\) \[Harness\]/);
    assert.ok(!names(general).includes("/commands"));
  }
});

test("admin-only commands are guarded when admins are configured", async () => {
  const { send, ch, approvals } = setup({ admins: ["@owner:x"] });
  await send("/yolo", "@stranger:x");
  assert.equal(ch.texts().at(-1), "⛔ admin only");
  assert.equal(approvals.mode, "off");
  await send("/yolo off", "@owner:x");
  assert.equal(approvals.mode, "manual");
});

test("local console remains admin when remote admins are configured", async () => {
  const { harness, approvals } = setup({ admins: ["@remote-admin:x"] });
  const replies: string[] = [];
  harness.addChannel({
    name: "console",
    start: async () => {},
    send: async (_to, text) => void replies.push(text),
    stop: async () => {},
  });
  await harness.submit({
    sessionKey: "console:local",
    text: "/yolo off",
    source: "channel",
    sender: "local-user",
    replyTo: { channel: "console", target: "local" },
  });
  await harness.drained(); // replies go through the durable outbox
  assert.equal(approvals.mode, "manual");
  assert.match(replies.at(-1)!, /manual tool approvals on/);
});

test("approvals: request is posted, /approve resolves it", async () => {
  const { harness, send, ch } = setup();
  harness.state("mem:room1").replyTo = { channel: "mem", target: "room1" };
  const pending = harness.requestApproval("mem:room1", "bash", { command: "rm -rf build" });
  await new Promise((r) => setImmediate(r));
  assert.match(ch.texts()[0], /Approval needed .*bash/);
  await send("/approve");
  assert.equal(await pending, true);
});

test("fail-closed: with remote channels and no admins, only the console is admin", async () => {
  const { ctx, send, ch, approvals } = setup();
  ctx.openAdmin = false;
  await send("/yolo", "@owner:x");
  assert.equal(ch.texts().at(-1), "⛔ admin only");
  assert.equal(approvals.mode, "off");
});

test("approver list is independent of admins", async () => {
  const { harness, send, ch } = setup({ admins: ["@admin:x"], approvers: ["@approver:x"] });
  harness.state("mem:room1").replyTo = { channel: "mem", target: "room1" };
  const pending = harness.requestApproval("mem:room1", "bash", {});
  await new Promise((r) => setImmediate(r));
  await send("/approve", "@admin:x");
  assert.equal(ch.texts().at(-1), "⛔ not an approver");
  await send("/approve", "@approver:x");
  assert.equal(await pending, true);
});

test("local console may resolve approvals despite a remote approver list", async () => {
  const { harness } = setup({ admins: ["@admin:x"], approvers: ["@approver:x"] });
  harness.state("mem:room1").replyTo = { channel: "mem", target: "room1" };
  const pending = harness.requestApproval("mem:room1", "bash", {});
  await new Promise((r) => setImmediate(r));
  const id = [...harness.approvals.keys()][0];
  const replies: string[] = [];
  harness.addChannel({
    name: "console",
    start: async () => {},
    send: async (_to, text) => void replies.push(text),
    stop: async () => {},
  });
  await harness.submit({
    sessionKey: "console:local",
    text: `/approve ${id}`,
    source: "channel",
    sender: "local-user",
    replyTo: { channel: "console", target: "local" },
  });
  assert.equal(await pending, true);
  assert.match(replies.at(-1)!, /approved/);
});

test("/deny blocks", async () => {
  const { harness, send } = setup();
  harness.state("mem:room1").replyTo = { channel: "mem", target: "room1" };
  const pending = harness.requestApproval("mem:room1", "bash", {});
  await new Promise((r) => setImmediate(r));
  await send("/deny");
  assert.equal(await pending, false);
});

test("/<skill-name> invokes a skill", async () => {
  const skill: SkillInfo = { name: "release-notes", description: "Write release notes", filePath: "/s/release-notes/SKILL.md", baseDir: "/s/release-notes" };
  const { send, runtime } = setup({ skills: [skill] });
  await send("/release-notes v0.1.0");
  const prompt = runtime.sessions.get("mem:room1")!.prompts[0];
  assert.match(prompt, /Read \/s\/release-notes\/SKILL\.md/);
  assert.match(prompt, /Task: v0\.1\.0/);
});

test("/personality lists and sets", async () => {
  const { send, ch, ctx } = setup();
  await send("/personality");
  assert.match(ch.texts().at(-1)!, /available: warm, terse/);
  await send("/personality warm");
  assert.equal(ctx.personality.current, "warm");
});

test("/sethome sets home channel", async () => {
  const { send, harness } = setup();
  await send("/sethome");
  assert.deepEqual(harness.home, { channel: "mem", target: "room1" });
});

test("/bg runs in a separate session", async () => {
  const { send, runtime } = setup();
  await send("/bg summarize logs");
  const keys = [...runtime.sessions.keys()];
  assert.ok(keys.some((k) => k.startsWith("mem:room1:bg:")));
});

test("a failed command acknowledgement is retried from the outbox without re-running the command", async () => {
  const { harness, ch, approvals } = setup();
  const realSend = ch.send.bind(ch);
  let fail = true;
  ch.send = async (to, text) => {
    if (fail) throw new Error("matrix 502");
    return realSend(to, text);
  };
  harness.onStateChange = async () => {};
  await harness.accept({ ...msg("/yolo off"), id: "$y1" }); // acknowledged: effect + reply saved
  assert.equal(approvals.mode, "manual");
  assert.equal(harness.outboxEntries().length, 1);
  await harness.accept({ ...msg("/yolo off"), id: "$y1" }); // redelivery: deduplicated
  fail = false;
  harness.tick();
  await harness.drained();
  assert.equal(approvals.mode, "manual", "explicit mode retained on redelivery");
  assert.equal(ch.texts().length, 1);
});

test("command replies wait for the durable save, also while another pump runs", async () => {
  const { harness, ch, runtime, approvals } = setup();
  await harness.sessionFor("mem:room1");
  const release = runtime.sessions.get("mem:room1")!.hold();
  harness.onStateChange = async () => {};
  await harness.accept({ ...msg("work"), id: "$w" });
  await new Promise((r) => setImmediate(r));
  let fail = true;
  harness.onStateChange = async () => {
    if (fail) throw new Error("disk full");
  };
  await assert.rejects(harness.accept({ ...msg("/yolo off"), id: "$y" }), /disk full/);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!ch.texts().some((t) => t.includes("YOLO")), "no ack before durable save");
  fail = false;
  await harness.tick();
  await harness.drained();
  assert.equal(ch.texts().filter((t) => t.includes("YOLO")).length, 1);
  assert.equal(approvals.mode, "manual");
});

test("approval prompt delivery retries with a stable delivery id, then denies", async () => {
  const { harness, ch, send } = setup();
  Harness.APPROVAL_RETRY_MS = 1;
  const ids: Array<string | undefined> = [];
  let failures = 2;
  ch.send = async (_to, _text, meta) => {
    ids.push(meta?.deliveryId);
    if (failures-- > 0) throw new Error("matrix 502");
  };
  harness.state("mem:room1").replyTo = ROOM;
  const pending = harness.requestApproval("mem:room1", "bash", {});
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 1);
  ch.send = async () => {};
  await send("/approve");
  assert.equal(await pending, true);

  ch.send = async () => {
    throw new Error("gone");
  };
  assert.equal(await harness.requestApproval("mem:room1", "bash", {}), false);
  Harness.APPROVAL_RETRY_MS = 1000;
});

test("operator controls and inspection bypass failing skill discovery", async () => {
  const { ctx, harness, send, ch } = setup();
  ctx.reloadSkills = async () => { throw Error("integrity failure"); };
  await send("/pause");
  assert.equal(harness.paused, true);
  await send("/stop");
  assert.ok(ch.sent.length >= 2);
  await assert.rejects(harness.commandHandler!({ sessionKey: "mem:room1", text: "/unknown-skill", source: "channel" }), /integrity failure/);
});
