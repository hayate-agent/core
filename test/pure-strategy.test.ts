import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PureStrategy } from "../src/pure-strategy.js";

test("absent baseline stays absent; failed validation or persistence retains active generation", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pure-strategy-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const select = (value: unknown): (() => string) => {
    const module = value as { apiVersion?: number; prompt?: () => string };
    if (module?.apiVersion !== 1 || typeof module.prompt !== "function") throw Error("Invalid strategy");
    return module.prompt.bind(module);
  };
  const strategy = new PureStrategy(home, undefined, select);
  assert.equal(strategy.current, undefined);
  await writeFile(path.join(home, "custom.mjs"), "export default {apiVersion:1,label:'one',prompt(){return this.label}}");
  let saved: string | null | undefined;
  const persist = async (selection: string | null | undefined) => { saved = selection; };
  await strategy.change("custom.mjs", persist);
  const pinned = strategy.current!;
  assert.equal(pinned(), "one"); assert.equal(saved, "custom.mjs");
  await writeFile(path.join(home, "custom.mjs"), "export default {apiVersion:1,label:'two',prompt(){return this.label}}");
  await strategy.change("custom.mjs", persist);
  assert.equal(strategy.current!(), "two"); assert.equal(pinned(), "one");
  await writeFile(path.join(home, "bad.mjs"), "export default {apiVersion:2}");
  await assert.rejects(strategy.change("bad.mjs", persist), /Invalid strategy/);
  assert.equal(strategy.current!(), "two"); assert.equal(saved, "custom.mjs");
  await assert.rejects(strategy.change(null, async () => { throw Error("save failed"); }), /save failed/);
  assert.equal(strategy.current!(), "two");
  await strategy.change(null, persist); assert.equal(strategy.current, undefined); assert.equal(saved, null);
  await strategy.change(undefined, persist); assert.equal(strategy.current, undefined); assert.equal(saved, undefined);
});

test("async preparation publishes only after validation and persistence; concurrent changes reject", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pure-async-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "custom.mjs"), "export default {value:'candidate'}");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holder = new PureStrategy(home, "baseline", value => String(value), async value => {
    await gate; return (value as { value: string }).value;
  });
  let saved = false;
  const change = holder.change("custom.mjs", async () => { assert.equal(holder.current, "baseline"); saved = true; });
  assert.equal(holder.current, "baseline");
  await assert.rejects(holder.change(null, async () => {}), /already in progress/);
  release(); await change;
  assert.equal(saved, true); assert.equal(holder.current, "candidate");
  const failing = new PureStrategy(home, "baseline", value => String(value), async () => { throw Error("factory failed"); });
  await assert.rejects(failing.change("custom.mjs", async () => { throw Error("must not save"); }), /factory failed/);
  assert.equal(failing.current, "baseline");
});

test("baseline is captured at construction; restoring it does not reload or mutate its receiver", async () => {
  const baseline = { label: "baseline", prompt() { return this.label; } };
  const strategy = new PureStrategy("/unused", baseline, (value: unknown) => {
    const module = value as typeof baseline;
    return module.prompt.bind(module);
  });
  assert.equal(strategy.current!(), "baseline");
  baseline.prompt = () => "changed";
  await strategy.change(null, async () => {});
  await strategy.change(undefined, async () => {});
  assert.equal(strategy.current!(), "baseline");
});
