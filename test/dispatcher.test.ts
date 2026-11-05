import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Dispatcher } from "../src/dispatcher.js";
import { ExecutionStore } from "../src/execution.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("update inventory covers a submission before durable claim and fences new producers", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatcher-admission-"));
  const entered = gate(), release = gate();
  class HeldStore extends ExecutionStore {
    override async submit(...args: Parameters<ExecutionStore["submit"]>) {
      entered.resolve(); await release.promise; return super.submit(...args);
    }
  }
  const store = new HeldStore(path.join(home, "ledger.json"));
  await store.load();
  let fenced = false;
  const dispatcher = new Dispatcher(store, { name: "direct", version: 1, replaySafe: false, execute: async () => "done" },
    1, async () => {}, () => {}, undefined, undefined, () => fenced);
  t.after(async () => { release.resolve(); await dispatcher.stop(); await rm(home, { recursive: true, force: true }); });
  await dispatcher.start();
  const submitting = dispatcher.submit("parent", "request", "work");
  await entered.promise;
  assert.deepEqual(dispatcher.updateBlockers(), ["dispatcher work"]);
  release.resolve(); await submitting;
  await until(() => !dispatcher.updateBlockers().length);
  fenced = true;
  await assert.rejects(dispatcher.submit("parent", "later", "work"), /unavailable/);
  assert.equal(store.list().length, 1);
});
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise(done => setTimeout(done, 5));
  }
  assert.fail("Condition did not settle");
}

test("submission during a claim starts in spare capacity without external ticks", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatcher-"));
  let stop = async () => {};
  t.after(async () => {
    await stop();
    await rm(home, { recursive: true, force: true });
  });
  const entered = gate();
  const release = gate();
  class HeldStore extends ExecutionStore {
    override async claim(...args: Parameters<ExecutionStore["claim"]>) {
      if (this.list().find(task => task.id === args[0])?.requestId === "b") {
        entered.resolve();
        await release.promise;
      }
      return super.claim(...args);
    }
  }
  const store = new HeldStore(path.join(home, "ledger.json"));
  await store.load();
  await store.submit("p", "a", "work a", "direct");
  await store.submit("p", "b", "work b", "direct");
  const started = new Set<string>();
  const errors: unknown[] = [];
  const dispatcher = new Dispatcher(store, {
    name: "direct", version: 1, replaySafe: false,
    execute: async (task, context) => {
      started.add(task.requestId);
      await new Promise<void>(done => {
        if (context.signal.aborted) done();
        else context.signal.addEventListener("abort", () => done(), { once: true });
      });
      return "stopped";
    },
  }, 3, async () => {}, error => errors.push(error));
  stop = async () => { release.resolve(); await dispatcher.stop(); };
  const starting = dispatcher.start();
  await entered.promise;
  const submitted = dispatcher.submit("p", "c", "work c");
  await until(() => store.list().some(task => task.requestId === "c"));
  release.resolve();
  await Promise.all([starting, submitted]);
  await until(() => started.size === 3);
  assert.deepEqual([...started].sort(), ["a", "b", "c"]);
  assert.ok(store.list().every(task => task.status === "running"));
  assert.deepEqual(errors, []);
});

for (const action of ["pause", "cancel"] as const) {
  test(`${action} during an earlier claim does not abort scheduling other tasks`, async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dispatcher-"));
    let stop = async () => {};
    t.after(async () => {
      await stop();
      await rm(home, { recursive: true, force: true });
    });
    const entered = gate();
    const release = gate();
    class HeldStore extends ExecutionStore {
      override async claim(...args: Parameters<ExecutionStore["claim"]>) {
        if (this.list().find(task => task.id === args[0])?.requestId === "a") {
          entered.resolve();
          await release.promise;
        }
        return super.claim(...args);
      }
    }
    const store = new HeldStore(path.join(home, "ledger.json"));
    await store.load();
    await store.submit("p", "a", "a", "direct");
    const controlled = await store.submit("p", "b", "b", "direct");
    await store.submit("p", "c", "c", "direct");
    const started: string[] = [];
    const errors: unknown[] = [];
    const dispatcher = new Dispatcher(store, {
      name: "direct", version: 1, replaySafe: false,
      execute: async (task, context) => {
        started.push(task.requestId);
        await new Promise<void>(done => {
          if (context.signal.aborted) done();
          else context.signal.addEventListener("abort", () => done(), { once: true });
        });
        return "stopped";
      },
    }, 3, async () => {}, error => errors.push(error));
    stop = async () => { release.resolve(); await dispatcher.stop(); };
    const starting = dispatcher.start();
    await entered.promise;
    const controlling = dispatcher.control("p", controlled.id, action);
    await until(() => store.list().find(task => task.id === controlled.id)?.status === (action === "pause" ? "paused" : "cancelled"));
    const submitted = dispatcher.submit("p", "d", "d");
    await until(() => store.list().some(task => task.requestId === "d"));
    release.resolve();
    await Promise.all([starting, controlling, submitted]);
    await until(() => started.length === 3);
    assert.deepEqual(started.sort(), ["a", "c", "d"]);
    assert.deepEqual(errors, []);
  });
}

test("ticks before and during recovery never schedule work", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatcher-"));
  let stop = async () => {};
  t.after(async () => {
    await stop();
    await rm(home, { recursive: true, force: true });
  });
  const entered = gate(); const release = gate();
  class RecoveringStore extends ExecutionStore {
    override async recover(...args: Parameters<ExecutionStore["recover"]>) {
      entered.resolve(); await release.promise; return super.recover(...args);
    }
  }
  const store = new RecoveringStore(path.join(home, "ledger.json"));
  await store.load(); await store.submit("p", "r", "work", "direct");
  let calls = 0;
  const dispatcher = new Dispatcher(store, { name: "direct", version: 1, replaySafe: false,
    execute: async () => { calls++; return "answer"; } }, 1, async () => {}, () => {});
  let starting: Promise<void> | undefined;
  stop = async () => {
    release.resolve();
    try { await starting; } finally { await dispatcher.stop(); }
  };
  await dispatcher.kick(); assert.equal(calls, 0);
  starting = dispatcher.start(); await entered.promise;
  await dispatcher.kick(); assert.equal(store.list()[0]!.status, "ready");
  await assert.rejects(dispatcher.submit("p", "early", "work"), /unavailable/);
  release.resolve(); await starting;
  await until(() => store.list()[0]!.status === "completed");
  assert.equal(calls, 1);
});

test("claim storage failures are not swallowed as contention", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatcher-"));
  let stop = async () => {};
  t.after(async () => {
    await stop();
    await rm(home, { recursive: true, force: true });
  });
  class BrokenStore extends ExecutionStore {
    override async claim(..._args: Parameters<ExecutionStore["claim"]>): Promise<never> { throw Error("disk unavailable"); }
  }
  const store = new BrokenStore(path.join(home, "ledger.json"));
  await store.load();
  await store.submit("p", "r", "work", "direct");
  const dispatcher = new Dispatcher(store, {
    name: "direct", version: 1, replaySafe: false, execute: async () => "unexpected",
  }, 1, async () => {}, () => {});
  stop = () => dispatcher.stop();
  await assert.rejects(dispatcher.start(), /disk unavailable/);
  await dispatcher.stop();
});

test("completion during held delivery drains without an external tick", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatcher-"));
  let stop = async () => {};
  t.after(async () => {
    await stop();
    await rm(home, { recursive: true, force: true });
  });
  const store = new ExecutionStore(path.join(home, "ledger.json"));
  await store.load();
  await store.submit("parent", "request", "work", "direct");
  const entered = gate();
  const release = gate();
  const delivered: string[] = [];
  const errors: unknown[] = [];
  const dispatcher = new Dispatcher(store, {
    name: "direct", version: 1, replaySafe: false,
    execute: async () => "answer",
  }, 1, async event => {
    if (event.type === "accepted") { entered.resolve(); await release.promise; }
    delivered.push(event.type);
  }, error => errors.push(error));
  stop = async () => { release.resolve(); await dispatcher.stop(); };
  await dispatcher.start();
  await entered.promise;
  await until(() => store.list()[0]!.status === "completed");
  assert.ok(store.events().some(event => event.type === "result"));
  release.resolve();
  await until(() => delivered.includes("result") && store.events().length === 0);
  assert.deepEqual(delivered, ["accepted", "status", "result"]);
  assert.deepEqual(errors, []);
});

test("failed delivery retains the same event for explicit retry without spinning", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatcher-"));
  let stop = async () => {};
  t.after(async () => {
    await stop();
    await rm(home, { recursive: true, force: true });
  });
  const store = new ExecutionStore(path.join(home, "ledger.json"));
  await store.load();
  const dispatcher = new Dispatcher(store, {
    name: "direct", version: 1, replaySafe: false, execute: async () => "unused",
  }, 1, async () => { attempts++; if (fail) throw Error("offline"); }, () => {});
  stop = () => dispatcher.stop();
  let attempts = 0;
  let fail = true;
  await store.submit("p", "r", "work", "direct");
  const id = store.events()[0]!.id;
  await assert.rejects(dispatcher.flushEvents(), /offline/);
  assert.equal(attempts, 1);
  assert.equal(store.events()[0]!.id, id);
  fail = false;
  await dispatcher.flushEvents();
  assert.equal(attempts, 2);
  assert.deepEqual(store.events(), []);
  await dispatcher.stop();
});

test("strategy switch keeps retained built-in tasks runnable; new work uses the selected strategy", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatcher-"));
  const store = new ExecutionStore(path.join(home, "ledger.json"));
  await store.load();
  await store.submit("parent", "old", "queued before switch", "direct");
  const ran: string[] = [];
  const direct = { name: "direct", version: 1, replaySafe: false, execute: async () => { ran.push("direct"); return "old done"; } };
  const sequential = { name: "sequential", version: 1, replaySafe: false, reconcile: true, execute: async () => { ran.push("sequential"); return "new done"; } };
  const dispatcher = new Dispatcher(store, sequential, 1, async () => {}, () => {}, undefined, undefined, () => false, [direct, sequential]);
  t.after(async () => { await dispatcher.stop(); await rm(home, { recursive: true, force: true }); });
  await dispatcher.start();
  await until(() => store.list()[0]!.status === "completed");
  const task = await dispatcher.submit("parent", "new", "after switch");
  assert.equal(task.strategy, "sequential");
  await until(() => store.list().every(item => item.status === "completed"));
  assert.deepEqual(ran, ["direct", "sequential"]);
  assert.deepEqual(store.list().map(item => item.result), ["old done", "new done"]);
});

test("unregistered strategy still blocks visibly on recovery", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatcher-"));
  const store = new ExecutionStore(path.join(home, "ledger.json"));
  await store.load();
  await store.submit("parent", "old", "queued", "removed-plugin");
  const dispatcher = new Dispatcher(store, { name: "direct", version: 1, replaySafe: false, execute: async () => assert.fail("must not run") }, 1, async () => {}, () => {});
  t.after(async () => { await dispatcher.stop(); await rm(home, { recursive: true, force: true }); });
  await dispatcher.start();
  assert.equal(store.list()[0]!.status, "blocked");
  assert.match(store.list()[0]!.recoveryReason ?? "", /removed-plugin@1 unavailable/);
});
