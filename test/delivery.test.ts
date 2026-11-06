// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { InboxLedger } from "../src/delivery/inbox.js";
import { OutboxDelivery, type OutboxEntry } from "../src/delivery/outbox.js";
import { SeenWindow } from "../src/delivery/seen.js";
import { PermanentDeliveryError } from "../src/types.js";

const TO = { channel: "mem", target: "r" };

test("seen window evicts oldest unpinned ids; restored ids stay until a checkpoint", () => {
  const w = new SeenWindow(3);
  w.restore(["a", "b", "c", "d"]);
  // Channels pin on hand-off, before the harness marks the id (upstream not yet committed).
  w.pin(["e", "f"]);
  w.mark("e");
  w.mark("f");
  assert.deepEqual(w.ids(), ["a", "b", "c", "d", "e", "f"], "restored ids are provisional pins");
  w.unpin(["f"]); // checkpoint covering "f": provisional pins released, the pin on "e" kept
  assert.deepEqual(w.ids(), ["d", "e", "f"]);
  assert.deepEqual(w.ids(new Set(["e"])), ["d", "f"]);
});

test("outbox: barrier holds blocked entries until a save succeeds; permanent errors are parked", async () => {
  const sent: string[] = [];
  const parked: string[] = [];
  let saveOk = false;
  let permanent = false;
  const ob = new OutboxDelivery({
    deliver: async (_to, text) => {
      if (permanent) {
        permanent = false;
        throw new PermanentDeliveryError("403");
      }
      sent.push(text);
    },
    park: async (e) => void parked.push(e.text),
    save: async () => {
      if (!saveOk) throw new Error("disk");
    },
    log: () => {},
  });
  const box: OutboxEntry[] = [ob.create("k", TO, "ack")];
  ob.block(box[0]!);
  assert.equal(await ob.flush("k", box), false);
  await assert.rejects(ob.barrier());
  assert.equal(await ob.flush("k", box), false, "still blocked after failed save");
  saveOk = true;
  await ob.barrier();
  permanent = true;
  box.push(ob.create("k", TO, "next"));
  assert.equal(await ob.flush("k", box), true);
  assert.deepEqual(parked, ["ack"]);
  assert.deepEqual(sent, ["next"]);
});

test("inbox ledger snapshot covers handoff, current, steered and queued replayable inputs", () => {
  const l = new InboxLedger();
  const mk = (text: string, source: "channel" | "loop" = "channel") => ({ sessionKey: "k", text, source });
  const h = mk("handoff");
  l.handoff.add(h);
  const snap = l.snapshot([{ current: mk("cur"), steered: [mk("st")], queue: [mk("q"), mk("tick", "loop"), h] }]);
  assert.deepEqual(snap.map((i) => i.text), ["handoff", "cur", "st", "q"]);
  const r = mk("restored");
  l.restored.add(r);
  assert.equal(l.held(r), true);
});
