// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { SessionProviderLifecycle } from "../src/session-provider-lifecycle.js";
import { FilesystemSessionProvider } from "../src/sessions.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

test("session lease allows final checkpoint while closing, rejects new access, drains all operations", async () => {
  const store = new FilesystemSessionProvider("/unused"); const gate = deferred(); let closed = 0;
  store.active = async () => { await gate.promise; return "id"; };
  const owner = new SessionProviderLifecycle(Object.assign(store, { close: async () => { closed++; } }));
  const lease = owner.retain();
  const direct = owner.active("conversation");
  const closing = owner.close(); assert.equal(owner.close(), closing);
  assert.throws(() => owner.retain(), /stopping/); await assert.rejects(owner.list("conversation"), /stopping/);
  const final = lease.provider.active("conversation"); lease.release(); lease.release();
  assert.equal(closed, 0); gate.resolve(); await direct; await final; await closing;
  assert.equal(closed, 1); await assert.rejects(lease.provider.active("conversation"), /released/);
});

test("cleanup failure propagates and is never automatically retried", async () => {
  let closes = 0;
  const owner = new SessionProviderLifecycle(Object.assign(new FilesystemSessionProvider("/unused"), {
    close: async () => { closes++; throw Error("close failed"); },
  }));
  await assert.rejects(owner.close(), /close failed/); await assert.rejects(owner.close(), /close failed/);
  assert.equal(closes, 1);
});

test("real PiRuntime holds owner until final checkpoint, failed open releases its lease", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "session-owner-"));
  try {
    const code = `
import assert from 'node:assert/strict';
import {PiRuntime} from './src/runtime/pi.ts';
import {FilesystemSessionProvider} from './src/sessions.ts';
import {SessionProviderLifecycle} from './src/session-provider-lifecycle.ts';
import {AgentSession} from '@earendil-works/pi-coding-agent';
const backend=new FilesystemSessionProvider(process.env.TEST_HOME+'/store');
let closes=0;
backend.close=async()=>{closes++;};
const owner=new SessionProviderLifecycle(backend);
const options={cwd:process.env.TEST_HOME,sessionsDir:process.env.TEST_HOME+'/sessions',skillPaths:[],personaSections:async()=>[],approvals:{mode:'off',tools:[]},sessionProvider:()=>owner};
const runtime=new PiRuntime(options);
const wrapped=await runtime.open('conversation');
wrapped.session.sessionManager.appendMessage({role:'user',content:'retained final checkpoint',timestamp:1000});
let stopped=false; const stopping=owner.close().then(()=>{stopped=true;});
await new Promise(r=>setImmediate(r));assert.equal(stopped,false);
await assert.rejects(runtime.open('new'),/stopping/);
await wrapped.dispose(); await wrapped.dispose(); await stopping;
assert.equal(closes,1);
const id=await backend.active('conversation');const record=await backend.load(id);
assert.ok(JSON.stringify(record.entries).includes('retained final checkpoint'));
// Fail before SDK session creation; the lease must not strand owner shutdown.
const broken=new SessionProviderLifecycle({...backend,active:async()=>{throw Error('load unavailable');},close:async()=>{closes++;}});
await assert.rejects(new PiRuntime({...options,sessionProvider:()=>broken}).open('broken'),/load unavailable/);
await broken.close();assert.equal(closes,2);
// Fail after SDK open, during initial checkpoint: cleanup must release too.
const failing=new SessionProviderLifecycle({active:backend.active.bind(backend),load:backend.load.bind(backend),create:backend.create.bind(backend),bind:backend.bind.bind(backend),list:backend.list.bind(backend),save:async()=>{throw Error('checkpoint failure');},close:async()=>{closes++;}});
await assert.rejects(new PiRuntime({...options,sessionProvider:()=>failing}).open('conversation'),/checkpoint failure/);
await failing.close();assert.equal(closes,3);
// SDK exists, but binding fails before a PiSession can own its cleanup.
const bind=AgentSession.prototype.bindExtensions, dispose=AgentSession.prototype.dispose;
let disposed=0;
AgentSession.prototype.bindExtensions=async()=>{throw Error('extension bind failure');};
AgentSession.prototype.dispose=function(){disposed++;dispose.call(this);throw Error('cleanup fixture failure');};
const bindOwner=new SessionProviderLifecycle(backend);
try {
 await assert.rejects(new PiRuntime({...options,sessionProvider:()=>bindOwner}).open('conversation'),/extension bind failure/);
 assert.equal(disposed,1,'SDK session is disposed once even before wrapper creation');
 await bindOwner.close();assert.equal(closes,4,'failed binding releases provider ownership');
} finally {AgentSession.prototype.bindExtensions=bind;AgentSession.prototype.dispose=dispose;}
console.log('SESSION_OWNER_OK');`;
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      env: { ...process.env, PI_CODING_AGENT_DIR: home, TEST_HOME: home }, timeout: 30000,
    });
    assert.match(result.stdout, /SESSION_OWNER_OK/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
