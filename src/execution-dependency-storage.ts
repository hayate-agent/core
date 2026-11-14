import {createHash}from'node:crypto';
import{mkdir,lstat,chmod,open}from'node:fs/promises';
import{constants}from'node:fs';
import path from'node:path';
import{writeFileDurableExclusive,syncDirStrict as syncDir}from'./durable.js';
import type{Execution}from'./execution.js';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const hash=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
type Ref={version:1;sha256:string};
type Stored=Omit<Execution,'dependency'>&{dependency?:Execution['dependency'];dependencyRef?:Ref};
/** Host-owned snapshots are immutable. Never share mutable input with a draft. */
const immutable=new WeakSet<object>();
export function freezeExecutionDependency(value:unknown,seen=new WeakSet<object>()):void{if(value&&typeof value==='object'&&!immutable.has(value)&&!seen.has(value)){const proto=Object.getPrototypeOf(value);if(!Array.isArray(value)&&proto!==Object.prototype&&proto!==null)throw Error('Execution dependency must be JSON-shaped evidence');seen.add(value);for(const item of Object.values(value))freezeExecutionDependency(item,seen);Object.freeze(value);immutable.add(value);}}
/** Immutable exact dependency snapshots, published before their small ledger.
 * Never prune these receipts automatically: archived execution idempotency and
 * downgrade/recovery tooling may still need them. In-memory Execution is unchanged. */
export class ExecutionDependencyStorage{
 private known=new Map<string,string>();
 private encoded=new WeakMap<object,Map<string,{raw:string;key:string;bytes:number}>>();
 private identity(s:Awaited<ReturnType<typeof lstat>>){return JSON.stringify([s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs,s.mode,s.uid]);}
 constructor(private readonly ledger:string){}
 private get dir(){return this.ledger+'.dependencies';}
 private async directory(){await mkdir(this.dir,{recursive:true,mode:0o700});const s=await lstat(this.dir);if(!s.isDirectory()||s.isSymbolicLink()||typeof process.getuid==='function'&&s.uid!==process.getuid()||(s.mode&0o007)!==0)throw Error('Unsafe execution dependency directory');if((s.mode&0o777)!==0o700){await chmod(this.dir,0o700);await syncDir(this.dir);}await syncDir(path.dirname(this.dir));}
 private async bytes(file:string,durable=false):Promise<string>{
  const handle=await open(file,(durable?constants.O_RDWR:constants.O_RDONLY)|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const s=await handle.stat();if(!s.isFile()||s.size>32*1024*1024||typeof process.getuid==='function'&&s.uid!==process.getuid()||(s.mode&0o117)!==0)throw Error('Unsafe execution dependency file');const raw=await handle.readFile('utf8');if(durable){if((s.mode&0o777)!==0o600)await handle.chmod(0o600);await handle.sync();await syncDir(path.dirname(file));}return raw;}finally{await handle.close();}
 }
 async preserveLegacy(raw:string):Promise<void>{const file=this.ledger+'.legacy-v1';try{await writeFileDurableExclusive(file,raw,undefined,syncDir);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||await this.bytes(file,true)!==raw)throw error;}}
 async stage(executions:readonly Execution[]):Promise<Stored[]>{
  const pending=new Map<string,string>();const rows=executions.map(task=>{
   if(Object.hasOwn(task,'dependencyRef'))throw Error('Unexpected in-memory execution dependency reference');
   if(!task.dependency || typeof task.dependency !== 'object')return task;
   freezeExecutionDependency(task.dependency);
   const binding=JSON.stringify([task.id,task.parent]);let encodings=this.encoded.get(task.dependency),entry=encodings?.get(binding);
   if(!entry){
    const bytes=Buffer.byteLength(JSON.stringify(task.dependency));
    const raw=JSON.stringify({version:1,id:task.id,parent:task.parent,dependency:task.dependency})+'\n';
    entry={raw,key:digest(raw),bytes};
    if(!encodings){encodings=new Map();this.encoded.set(task.dependency,encodings);}encodings.set(binding,entry);
   }
   if(entry.bytes<4096)return task;
   const{raw,key}=entry;
   if(Buffer.byteLength(raw)>32*1024*1024)throw Error('Execution dependency snapshot exceeds reader budget');
   pending.set(key,raw);
   // Preserve JSON property order too: recovery fences hash exact task JSON.
   return Object.fromEntries(Object.entries(task).map(([name,value])=>name==='dependency'?[ 'dependencyRef',{version:1 as const,sha256:key} ]:[name,value])) as Stored;
  });
  if([...pending.values()].reduce((n,raw)=>n+Buffer.byteLength(raw),Buffer.byteLength(JSON.stringify(rows)))>64*1024*1024)throw Error('Expanded execution dependency budget exceeded');
  if(pending.size){await this.directory();const items=[...pending];let next=0;const results=await Promise.allSettled(Array.from({length:Math.min(4,items.length)},async()=>{
   while(next<items.length){const[key,raw]=items[next++]!;const file=path.join(this.dir,key+'.json');
    try{const s=await lstat(file);if(s.isFile()&&!s.isSymbolicLink()&&this.known.get(key)===this.identity(s))continue;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    try{await writeFileDurableExclusive(file,raw,undefined,syncDir);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||await this.bytes(file,true)!==raw)throw error;}
    this.known.set(key,this.identity(await lstat(file)));
   }
  }));const failed=results.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;}
  return rows;
 }
 async hydrate(executions:unknown[]):Promise<Execution[]>{
  try{return await this.read(executions);}catch(error){throw new Error('Cannot load retained execution dependency snapshots',{cause:error});}
 }
 private async read(executions:unknown[]):Promise<Execution[]>{
  if(!Array.isArray(executions))throw Error('Invalid execution records');
  const rows:Execution[]=[];const cache=new Map<string,string>();let expanded=Buffer.byteLength(JSON.stringify(executions));
  for(const value of executions){if(!value||typeof value!=='object')throw Error('Invalid execution dependency record');const row=value as Stored;
   if(!Object.hasOwn(row,'dependencyRef')){rows.push(row as Execution);continue;}
   const ref=row.dependencyRef;
   if(Object.hasOwn(row,'dependency')||!ref||ref.version!==1||!hash(ref.sha256)||Object.keys(ref).some(k=>!['version','sha256'].includes(k)))throw Error('Invalid execution dependency reference');
   const s=await lstat(this.dir);if(!s.isDirectory()||s.isSymbolicLink()||typeof process.getuid==='function'&&s.uid!==process.getuid()||(s.mode&0o007)!==0)throw Error('Unsafe execution dependency directory');
   const raw=cache.get(ref.sha256)??await this.bytes(path.join(this.dir,ref.sha256+'.json'));
   expanded+=Buffer.byteLength(raw);if(expanded>64*1024*1024)throw Error('Expanded execution dependency budget exceeded');
   if(digest(raw)!==ref.sha256)throw Error('Execution dependency checksum mismatch');const shard=JSON.parse(raw);
   if(shard.version!==1||shard.id!==row.id||shard.parent!==row.parent||!Object.hasOwn(shard,'dependency')||Object.keys(shard).some(k=>!['version','id','parent','dependency'].includes(k)))throw Error('Execution dependency binding mismatch');
   cache.set(ref.sha256,raw);rows.push(Object.fromEntries(Object.entries(row).map(([name,value])=>name==='dependencyRef'?['dependency',shard.dependency]:[name,value])) as unknown as Execution);
   // Loading does not establish durability for a subsequent acknowledgement;
   // first write re-fsyncs exact existing bytes before caching immutable shards.
  }
  return rows;
 }
}
