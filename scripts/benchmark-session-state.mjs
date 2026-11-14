// Synthetic isolated workload only: no production files, tasks, models or network.
// Build first; run: node --expose-gc scripts/benchmark-session-state.mjs [legacy|sharded]
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StateStore } from '../dist/state.js';
import { writeFileDurable } from '../dist/durable.js';
const mode=process.argv[2];if(!['legacy','sharded'].includes(mode))throw Error('Choose legacy or sharded');
const dir=await mkdtemp(path.join(os.tmpdir(),'session-storage-bench-')),file=path.join(dir,'state.json');
try{
 const sessions=Array.from({length:534},(_,i)=>{const task={id:'task-'+i,state:i===0?'active':'stopped',original:'retained scoped evidence '+String(i)+' '+ 'x'.repeat(70000),depth:2,expiresAt:Date.now()+600000};return{key:'matrix:benchmark-'+i,task,tasks:[task]};});
 const state={version:1,paused:false,busyMode:'queue',sessions,seen:[]};
 await writeFile(file,JSON.stringify(state));const legacyBytes=(await stat(file)).size;
 let store;if(mode==='sharded'){store=new StateStore(file);await store.load();}
 let legacyLast;
 const capture=async()=>{
  if(mode==='sharded')return store.capture(()=>state);
  const raw=JSON.stringify({...state,sessions:sessions.map(s=>({...s,task:structuredClone(s.task),tasks:structuredClone(s.tasks)}))});
  if(raw===legacyLast)return;await writeFileDurable(file,raw);legacyLast=raw;
 };
 const resource=()=>({ms:performance.now(),blocks:process.resourceUsage().fsWrite,rss:process.memoryUsage().rss});
 global.gc?.();const init=resource();await capture();const migrated=resource();
 const times=[];for(let i=0;i<20;i++){sessions[0].task.depth++;const start=performance.now();await capture();times.push(performance.now()-start);}
 const final=resource();global.gc?.();
 const reloaded=mode==='sharded'?await new StateStore(file).load():JSON.parse(await(await import('node:fs/promises')).readFile(file,'utf8'));
 if(reloaded.sessions[0].task.depth!==22||reloaded.sessions[1].task.state!=='stopped')throw Error('Lost task state');
 console.log(JSON.stringify({mode,sessions:534,events:20,legacyBytes,manifestOrWholeFileBytes:(await stat(file)).size,migrationMs:migrated.ms-init.ms,migrationFsWriteBlocks:migrated.blocks-init.blocks,eventMedianMs:times.sort((a,b)=>a-b)[10],eventsTotalMs:final.ms-migrated.ms,eventFsWriteBlocks:final.blocks-migrated.blocks,peakRssKiB:process.resourceUsage().maxRSS,retainedRssBytes:process.memoryUsage().rss,retainedHeapBytes:process.memoryUsage().heapUsed},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
