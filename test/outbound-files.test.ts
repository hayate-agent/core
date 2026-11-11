import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, truncate, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { stageOutboundFile, verifyOutboundFile, MAX_OUTBOUND_FILE } from "../src/outbound-files.js";
import { messagePlugin } from "../src/message-plugin.js";
import { PluginHost } from "../src/plugins.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "hy-file-send-")));
  const home = path.join(root, "agent"), cwd = path.join(root, "work");
  await mkdir(home); await mkdir(cwd); t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home, cwd };
}
test("regular binary snapshots are origin-scoped and byte exact; originals can change after staging", async t => {
  const f = await fixture(t), bytes = Buffer.from([0, 255, 1, 42]);
  await writeFile(path.join(f.cwd, "file.dat"), bytes);
  const ref = await stageOutboundFile(f.home, "api:task", f.cwd, "file.dat", "report.dat");
  assert.equal(ref.sha256, createHash("sha256").update(bytes).digest("hex")); assert.equal(ref.name, "report.dat");
  await writeFile(path.join(f.cwd, "file.dat"), "changed"); await verifyOutboundFile(f.home, "api:task", ref);
  await assert.rejects(verifyOutboundFile(f.home, "other", ref), /scope/);
  const staged = path.join(f.home, "attachments", createHash("sha256").update("api:task").digest("hex"), ref.sha256);
  assert.deepEqual(await readFile(staged), bytes);
  assert.deepEqual(await stageOutboundFile(f.home, "api:task", f.cwd, staged, "same.dat"), { ...ref, name: "same.dat" });
  await assert.rejects(stageOutboundFile(f.home, "foreign", f.cwd, staged), /outside|protected|foreign/);
});

test("symlinks, hidden credentials, agent storage, out-of-workspace and oversized files are rejected", async t => {
  const f = await fixture(t); await mkdir(path.join(f.cwd, ".ssh")); await writeFile(path.join(f.cwd, ".ssh/id"), "secret");
  await writeFile(path.join(f.home, "runtime.json"), "secret"); await writeFile(path.join(f.root, "outside"), "outside");
  await symlink(path.join(f.root, "outside"), path.join(f.cwd, "alias"));
  for (const file of [".ssh/id", "alias", "../outside", "../agent/runtime.json", "."])
    await assert.rejects(stageOutboundFile(f.home, "main", f.cwd, file));
  await writeFile(path.join(f.cwd, "huge"), ""); await truncate(path.join(f.cwd, "huge"), MAX_OUTBOUND_FILE + 1);
  await assert.rejects(stageOutboundFile(f.home, "main", f.cwd, "huge"), /10 MiB/);
  await writeFile(path.join(f.cwd, "normal"), "normal");
  await assert.rejects(stageOutboundFile(f.home, "main", f.cwd, "normal", "../unsafe"), /filename/);
});

test("explicit ordinary workspaces inside private agent homes are exportable, but stores and hidden subtrees are not", async t => {
  const f = await fixture(t);
  const privateHome = path.join(f.root, ".hayate-agent"); const workspace = path.join(privateHome, "workspace");
  await mkdir(workspace, { recursive: true }); await writeFile(path.join(workspace, "report.bin"), Buffer.from([0, 255]));
  const ref = await stageOutboundFile(privateHome, "main", workspace, "report.bin"); await verifyOutboundFile(privateHome, "main", ref);
  await mkdir(path.join(workspace, ".ssh")); await writeFile(path.join(workspace, ".ssh/key"), "secret");
  await assert.rejects(stageOutboundFile(privateHome, "main", workspace, ".ssh/key"), /protected|outside/);
  await mkdir(path.join(privateHome, "sessions")); await writeFile(path.join(privateHome, "sessions/history"), "private");
  await assert.rejects(stageOutboundFile(privateHome, "main", path.join(privateHome, "sessions"), "history"), /protected|outside/);
  const ssh = path.join(f.root, ".ssh"); await mkdir(ssh); await writeFile(path.join(ssh, "id_rsa"), "private");
  await assert.rejects(stageOutboundFile(privateHome, "main", ssh, "id_rsa"), /protected|outside/);
});

test("native file messaging passes a host-bound reference, preserves caption, and never reuploads on retry", async t => {
  const f = await fixture(t); await writeFile(path.join(f.cwd, "report.bin"), Buffer.from([1, 2, 255])); let calls = 0;
  const gateway = { messagingCapabilities: () => [{ gateway: "chat", messaging: { text: true, files: true, connected: true, destinationFormat: "ID" } }],
    destinations: async () => ({ destinations: [] }),
    sendMessage: async (...args: any[]) => { calls++; assert.equal(args[0], "api:file-task"); assert.equal(args[3], "caption"); assert.equal(args[5].sessionKey, "api:file-task"); await verifyOutboundFile(f.home, args[0], args[5]); } };
  const host = new PluginHost(); await host.load([messagePlugin(f.home, gateway)], { home: f.home, cwd: f.cwd, agent: "any" }, []);
  const tool = host.tools.get("plugin_message")!; const input = { action: "send", gateway: "chat", target: "room", text: "caption", file: { path: "report.bin", name: "report.dat" }, requestId: "file1" };
  const first = JSON.parse(await tool.execute(input, { sessionKey: "api:file-task", cwd: f.cwd }));
  assert.equal(first.status, "delivered"); assert.equal(first.attachment.size, 3);
  await tool.execute(input, { sessionKey: "api:file-task", cwd: f.cwd }); assert.equal(calls, 1);
  await writeFile(path.join(f.cwd, "report.bin"), "different");
  await assert.rejects(tool.execute(input, { sessionKey: "api:file-task", cwd: f.cwd }), /different message/); assert.equal(calls, 1);
});
