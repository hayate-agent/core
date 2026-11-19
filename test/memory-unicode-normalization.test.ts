import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileMemoryStore } from "../src/memory-worker.js";
import { memoryConfig } from "../src/memory.js";

test("search matches canonically equivalent Unicode forms (NFC stored, NFD queried and vice versa)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-nfc-"));
  const ctx = { sessionKey: "one" };
  const store = new FileMemoryStore(dir, memoryConfig());
  try {
    await store.start();
    const nfc = await store.put(ctx, { key: "nfc", title: "Kunde Müller", text: "Ansprechpartner" });
    const nfd = await store.put(ctx, { key: "nfd", title: "Kunde Zoë".normalize("NFD"), text: "Kontakt" });
    assert.equal((await store.search(ctx, "Müller".normalize("NFD")))[0]?.entry.id, nfc.id);
    assert.equal((await store.search(ctx, "Zoë".normalize("NFC")))[0]?.entry.id, nfd.id);
    assert.equal((await store.search(ctx, "Müller".normalize("NFC")))[0]?.entry.id, nfc.id);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});
