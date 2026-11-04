import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness, type DurableTask } from "../src/harness.js";
import { SettingsService } from "../src/settings.js";
import { gatewaySettings, type GatewayConfig } from "../src/gateway-settings.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

for (const channelName of ["matrix", "telegram", "slack", "future", "tui", "api"]) {
  for (const enabled of [false, true]) {
    test(`${channelName}: recovery diagnostics ${enabled ? "opt-in" : "default-off"} retain blocked state across restart`, async () => {
      const channel = new MemoryChannel();
      Object.defineProperty(channel, "name", { value: channelName });
      const logs: string[] = [];
      const gateways: GatewayConfig | undefined = enabled ? { overrides: { [channelName]: { recoveryDiagnostics: true } } } : undefined;
      const task: DurableTask = { id: "retained", original: "Check existing result", state: "active", depth: 2,
        expiresAt: Date.now() + 60000, recoveryRetry: { attempts: 0, nextAt: 0 } };
      const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, gateways, log: text => logs.push(text) });
      h.addChannel(channel);
      h.restoreSessions([{ key: "retained", task, replyTo: { channel: channelName, target: "room1" } }]);
      h.onStateChange = async () => {};
      let restored: Harness | undefined;
      try {
        await h.recoverTasks();
        const snapshot = JSON.parse(JSON.stringify(h.snapshotSessions()));
        const saved = snapshot[0].task;
        assert.equal(saved.state, "blocked");
        assert.equal(saved.depth, 2);
        assert.equal(saved.expiresAt, task.expiresAt);
        assert.deepEqual(saved.recoveryRetry, task.recoveryRetry);
        assert.ok(saved.recoveryAttentionId);
        assert.equal(h.pendingInputs().length, 0);
        assert.ok(logs.some(text => text.includes("retained: invalid")));
        assert.equal(h.outboxEntries().length, enabled ? 1 : 0);
        assert.equal(channel.sent.length, 0); // save/delivery barrier is still held
        restored = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, gateways });
        restored.addChannel(channel); restored.restoreSessions(snapshot);
        restored.restoreOutbox(h.outboxEntries()); restored.onStateChange = async () => {};
        await restored.recoverTasks(); restored.releaseRestored(); await restored.drained();
        await restored.tick(); await restored.drained();
        assert.equal(channel.texts().filter(text => text.includes("Recovery angehalten")).length, enabled ? 1 : 0);
        assert.equal(restored.state("retained").task?.state, "blocked");
        assert.equal(restored.pendingInputs().length, 0);
      } finally { await h.stop(0); await restored?.stop(0); }
    });
  }
}

test("diagnostic settings validate, inherit, persist and permit an explicit channel opt-out", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "recovery-diagnostic-settings-"));
  try {
    const file = path.join(home, "settings.local.yaml");
    const settings = new SettingsService(file, {}); await settings.load();
    await settings.setGateways({ recoveryDiagnostics: true, overrides: { matrix: { recoveryDiagnostics: false } } });
    const restored = new SettingsService(file, {}); await restored.load();
    assert.equal(gatewaySettings(restored.effective().gateways, "matrix").recoveryDiagnostics, false);
    assert.equal(gatewaySettings(restored.effective().gateways, "future").recoveryDiagnostics, true);
    await assert.rejects(settings.setGateways({ recoveryDiagnostics: "false" } as any));
  } finally { await rm(home, { recursive: true, force: true }); }
});

for (const reply of ["Ergebnis: geprüft und gespeichert.", "Freigabe erforderlich: Produktionsänderung genehmigen?", "Blockiert: benötigter Serverzugang fehlt.", "Entscheidung nötig: Variante A oder B?"]) {
  test(`default-off retains real attention and substantive replies: ${reply}`, async () => {
    const h = new Harness({ runtime: new FakeRuntime(() => reply), tickMs: 60000 });
    const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {};
    try {
      await h.submit(msg("Prüfe den Auftrag")); await h.drained();
      assert.deepEqual(channel.texts(), [reply]);
      assert.equal(channel.texts().some(text => text.includes("Recovery angehalten")), false);
    } finally { await h.stop(0); }
  });
}
