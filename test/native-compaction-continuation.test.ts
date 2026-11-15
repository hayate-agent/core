import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {ContextMaintenance,contextPolicy} from "../src/context-maintenance.js";
import {Harness} from "../src/harness.js";
import {FakeRuntime,MemoryChannel,msg} from "./fakes.js";

test("failed automatic compaction resumes assessed remaining work in a fresh context, not the completed effect",async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),"native-continue-"));t.after(()=>rm(home,{recursive:true,force:true}));
 let effects=0,remaining=0,checks=0,seeded=false;
 const runtime=new FakeRuntime(text=>{
  if(text==='Perform the authorized fixture once, then verify the remaining state.'){effects++;return '';}
  assert(seeded,'new context is seeded before remaining work');
  assert.match(text,/Inspect the linked archive before the remaining verification/);
  remaining++;return 'Remaining verification complete; original effect was not repeated.';
 });
 const entries=[{id:'operator',role:'user',text:'Perform the authorized fixture once, then verify the remaining state.'},
  {id:'receipt',role:'toolResult',text:'effect completed once; receipt 123; reconcile unknown later effects'}];
 const open=runtime.open.bind(runtime);
 runtime.open=async(key,options)=>{
  const s=await open(key,options),fresh=!!options?.fresh;
  s.status=()=>({sessionId:fresh?'fresh':'old',...(!fresh&&effects?{nativeCompactionFailure:{reason:'threshold' as const,receiptId:'failed'}}:{})});
  s.archiveEntries=()=>entries;s.seedHandover=async text=>{assert.match(text,/Archive ID:/);seeded=true;};return s;
 };
 const maintenance=new ContextMaintenance(home,()=>contextPolicy());
 const h=new Harness({runtime,contextMaintenance:maintenance,tickMs:60000,
  completionCheck:async()=>++checks===1?{state:'continue',next:'Inspect the linked archive before the remaining verification; never repeat receipt 123.'}:{state:'completed'}});
 h.onStateChange=async()=>{};h.addChannel(new MemoryChannel());t.after(()=>h.stop(0));
 await h.accept({...msg('Perform the authorized fixture once, then verify the remaining state.'),id:'original-order'});await h.drained();
 assert.equal(effects,1);assert.equal(remaining,1);assert.equal(checks,2);
 assert.equal(h.sessions.get('mem:room1')!.task!.state,'completed');
 assert.equal((await maintenance.status('mem:room1')).sessionId,'fresh');
 assert.equal(h.pendingInputs().length,0);
});
