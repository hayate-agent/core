import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, lstat, writeFile, readFile, chmod, symlink } from "node:fs/promises";
import os from "node:os";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { PluginHost } from "../src/plugins.js";
import { Harness } from "../src/harness.js";
import { sessionObserverPlugin, attachObserver } from "../src/builtin-plugins/session-observer-plugin.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

test("local socket observes held owner turn; detach leaves it running; shutdown removes owned socket", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "observer-socket-"));
  const directory = path.join(root, "private"), endpoint = path.join(directory, "observe.sock");
  const runtime = new FakeRuntime(), h = new Harness({ runtime, tickMs: 60000 }), host = new PluginHost();
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  let release: (() => void) | undefined;
  try {
    await h.sessionFor("mem:room1"); release = runtime.sessions.get("mem:room1")!.hold();
    await h.submit(msg("SECRET_DO_NOT_SEND"));
    while (!runtime.sessions.get("mem:room1")!.busy) await new Promise(r => setImmediate(r));
    await host.load([], { home: root, cwd: root, agent: "test" }, [], [], [sessionObserverPlugin(h, directory, "mem:room1")]);
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(endpoint)).mode & 0o777, 0o600);
    const controller = new AbortController(); const frames: string[] = [];
    await attachObserver(endpoint, line => { frames.push(line); controller.abort(); }, controller.signal);
    assert.equal(JSON.parse(frames[0]).status.prompting, true);
    assert.ok(!frames.join("").includes("SECRET"));
    assert.equal(runtime.sessions.get("mem:room1")!.busy, true);
    assert.equal(runtime.sessions.get("mem:room1")!.aborted, 0);
    assert.equal(runtime.opened.length, 1);
    await host.stop(); await assert.rejects(lstat(endpoint), { code: "ENOENT" });
    release(); await h.drained();
  } finally { release?.(); await host.stop(); await h.stop(1000); await rm(root, { recursive: true, force: true }); }
});

test("client input is rejected and shutdown closes pending readers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "observer-input-"));
  const host = new PluginHost(), sockets: Socket[] = [];
  try {
    await host.load([], { home: root, cwd: root, agent: "test" }, [], [], [sessionObserverPlugin({ observeSession: () => undefined }, root, "fixed")]);
    const connect = () => new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(path.join(root, "observe.sock")); sockets.push(socket);
      socket.on("error", reject); socket.once("connect", () => resolve(socket));
      socket.resume();
    });
    const malicious = await connect();
    const closed = new Promise<void>(resolve => malicious.once("close", () => resolve()));
    malicious.write('{"key":"other","source":"console","command":"stop"}');
    await closed;
    const idle = await connect();
    const idleClosed = new Promise<void>(resolve => idle.once("close", () => resolve()));
    await host.stop(); await idleClosed;
  } finally { for (const socket of sockets) socket.destroy(); await host.stop(); await rm(root, { recursive: true, force: true }); }
});

test("unsafe directory and symlink are rejected without modifying their permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "observer-permissions-"));
  try {
    await chmod(root, 0o755);
    for (const directory of [root, root + "-link"]) {
      if (directory !== root) await symlink(root, directory);
      const host = new PluginHost();
      try {
        await assert.rejects(host.load([], { home: root, cwd: root, agent: "test" }, [], [], [sessionObserverPlugin({ observeSession: () => undefined }, directory, "fixed")]), /Unsafe observer directory/);
        assert.equal((await lstat(root)).mode & 0o777, 0o755);
      } finally { await host.stop(); }
    }
  } finally { await rm(root + "-link", { force: true }); await rm(root, { recursive: true, force: true }); }
});

test("existing socket path is never removed on failed activation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "observer-existing-"));
  const endpoint = path.join(root, "observe.sock"), host = new PluginHost();
  await writeFile(endpoint, "KEEP");
  try {
    await assert.rejects(host.load([], { home: root, cwd: root, agent: "test" }, [], [], [sessionObserverPlugin({ observeSession: () => undefined }, root, "x")]));
    assert.equal(await readFile(endpoint, "utf8"), "KEEP");
  } finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
});
