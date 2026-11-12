import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { parseInterval } from "../src/interval.js";
import { loadPersona, personaSections } from "../src/persona.js";
import { parseJobs, resolveDelivery, Scheduler } from "../src/scheduler.js";
import { discoverSkills, parseSkill } from "../src/skills.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-"));

test("parseInterval", () => {
  assert.equal(parseInterval("30m"), 1_800_000);
  assert.equal(parseInterval("1h30m"), 5_400_000);
  assert.equal(parseInterval("soon"), undefined);
});

// ------------------------------------------------------------------ scheduler

const JOBS = `
jobs:
  - name: status
    schedule: "0 * * * *"
    prompt_file: prompts/status.md
    deliver: origin
    origin: {platform: mem, chat_id: "room1"}
  - name: watchdog
    schedule: "*/15 * * * *"
    script: watch.sh
    no_agent: true
    deliver: "mem:ops"
  - name: quiet
    schedule: "*/5 * * * *"
    script: quiet.sh
    no_agent: true
    deliver: local
  - name: gone
    absent: true
`;

test("parseJobs reads the Hermes jobs.yaml format and drops absent jobs", () => {
  const jobs = parseJobs(JOBS);
  assert.deepEqual(jobs.map((j) => j.name), ["status", "watchdog", "quiet"]);
  assert.deepEqual(resolveDelivery(jobs[0]), { channel: "mem", target: "room1", thread: undefined });
  assert.deepEqual(resolveDelivery(jobs[1]), { channel: "mem", target: "ops" });
  assert.equal(resolveDelivery(jobs[2]), undefined);
});

async function cronSetup() {
  const dir = await tmp();
  await mkdir(path.join(dir, "prompts"));
  await mkdir(path.join(dir, "scripts"));
  await writeFile(path.join(dir, "jobs.yaml"), JOBS);
  await writeFile(path.join(dir, "prompts", "status.md"), "Write the hourly status.");
  await writeFile(path.join(dir, "scripts", "watch.sh"), "#!/bin/sh\necho 'agent X in error'\n");
  await writeFile(path.join(dir, "scripts", "quiet.sh"), "#!/bin/sh\necho NO_REPLY\n");
  await chmod(path.join(dir, "scripts", "watch.sh"), 0o755);
  await chmod(path.join(dir, "scripts", "quiet.sh"), 0o755);
  const runtime = new FakeRuntime((t) => `report for: ${t.split("\n")[0]}`);
  const harness = new Harness({ runtime, tickMs: 60_000, busyMode: "queue", log: () => {} });
  const ch = new MemoryChannel();
  harness.addChannel(ch);
  const sched = new Scheduler(harness, { jobsFile: path.join(dir, "jobs.yaml"), timezone: "Europe/Berlin", log: () => {} });
  await sched.load();
  return { sched, harness, ch, runtime };
}

test("scheduler: agent job runs prompt in cron session and delivers to origin", async () => {
  const { sched, harness, ch, runtime } = await cronSetup();
  try {
    await sched.runJob(sched.find("status")!);
    await harness.drained();
    assert.ok(runtime.sessions.has("cron:status"));
    assert.deepEqual(ch.sent.map(({ to, text }) => ({ to, text })), [{ to: { channel: "mem", target: "room1", thread: undefined }, text: "report for: Write the hourly status." }]);
    assert.equal(sched.list().length, 3);
    assert.ok(sched.list()[0].next);
  } finally {
    sched.stop();
  }
});

test("scheduler: no_agent script output delivered as-is; NO_REPLY stays silent", async () => {
  const { sched, ch, runtime } = await cronSetup();
  try {
    await sched.runJob(sched.find("watchdog")!);
    await sched.runJob(sched.find("quiet")!);
    assert.deepEqual(ch.sent.map(({ to, text }) => ({ to, text })), [{ to: { channel: "mem", target: "ops" }, text: "agent X in error" }]);
    assert.equal(runtime.sessions.size, 0);
  } finally {
    sched.stop();
  }
});

test("scheduler: scripts cannot escape the scripts dir", async () => {
  const { sched } = await cronSetup();
  try {
    await assert.rejects(sched.runJob({ name: "x", schedule: "* * * * *", script: "../jobs.yaml", no_agent: true }), /outside scripts dir/);
  } finally {
    sched.stop();
  }
});

// ------------------------------------------------------------------ persona

test("persona: SOUL + VOICE + personality become prompt sections", async () => {
  const dir = await tmp();
  await mkdir(path.join(dir, "personalities"));
  await writeFile(path.join(dir, "SOUL.md"), "Du bist Example Agent, Lead von VanillaCore.");
  await writeFile(path.join(dir, "VOICE.md"), "Trocken, knapp, gelegentlich ironisch.");
  await writeFile(path.join(dir, "personalities", "warm.md"), "Etwas wärmer heute.");
  const files = { soul: path.join(dir, "SOUL.md"), voice: path.join(dir, "VOICE.md"), personalitiesDir: path.join(dir, "personalities") };
  const sections = personaSections(await loadPersona(files, "warm"));
  assert.match(sections[0], /^# Agent foundation[\s\S]*Hayate Agent/);
  assert.match(sections[1], /# Hayate Agent development resources/);
  assert.match(sections[2], /^# Identity[\s\S]*Example Agent/);
  assert.match(sections[3], /^# Voice[\s\S]*ironisch/);
  assert.match(sections[4], /^# Personality: warm/);
  assert.match(sections.at(-1)!, /NO_REPLY/);
  await assert.rejects(loadPersona(files, "../etc"), /invalid personality/);
  await assert.rejects(loadPersona(files, "nope"), /unknown personality/);
});

test("persona: missing files are fine", async () => {
  const dir = await tmp();
  const sections = personaSections(await loadPersona({ soul: path.join(dir, "a"), voice: path.join(dir, "b"), personalitiesDir: dir }));
  assert.equal(sections.length, 3);
  assert.match(sections[0], /not your product identity/);
  assert.match(sections[0], /not PI themes by default/);
  const configured = personaSections({}, { name: "custom-agent", workspace: "/workspace" });
  assert.match(configured[0], /custom-agent/);
  assert.match(configured[0], /\/workspace/);
});

// ------------------------------------------------------------------ skills

test("skills: SKILL.md discovery, first dir wins, invalid skipped", async () => {
  const a = await tmp();
  const b = await tmp();
  const write = async (root: string, rel: string, body: string) => {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body);
  };
  await write(a, "ops/deploy/SKILL.md", "---\nname: deploy\ndescription: Deploy things\n---\nbody");
  await write(b, "deploy/SKILL.md", "---\nname: deploy\ndescription: Other deploy\n---\n");
  await write(b, "notes/SKILL.md", "---\ndescription: Take notes\n---\n");
  await write(b, "broken/SKILL.md", "no frontmatter");
  const skills = await discoverSkills([a, b, path.join(a, "missing")]);
  assert.deepEqual(skills.map((s) => [s.name, s.description]), [
    ["deploy", "Deploy things"],
    ["notes", "Take notes"],
  ]);
  assert.equal(parseSkill("---\nname: x\n---\n", "/x/SKILL.md"), undefined, "description is required");
});
