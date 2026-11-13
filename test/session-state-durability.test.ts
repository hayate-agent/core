import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, open, readFile, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore, type PersistedState } from '../src/state.js';
import { prepareSessionState, SessionStateStorage } from '../src/session-state-storage.js';

const fixture=():PersistedState=>({version:1,paused:false,busyMode:'queue',sessions:[{key:'p',resetPending:true}],pending:[{sessionKey:'p',source:'api',text:'accepted'}]});
test('reused shard is fsynced after prior target-publication/directory-sync failure',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'session-fsync-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const prepared=prepareSessionState(fixture()),storage=new SessionStateStorage(path.join(dir,'shards'));
 const ref=prepared.manifest.refs[0]!,target=path.join(storage.directory,ref.scope,ref.revision+'.json');
 const handle=await open(path.join(dir,'probe'),'w');const proto=Object.getPrototypeOf(handle),original=proto.sync;await handle.close();
 let failed=false;
 proto.sync=async function(){if((await this.stat()).isDirectory()&&!failed){try{await stat(target);failed=true;throw Object.assign(Error('injected directory fsync failure'),{code:'EIO'});}catch(e){if((e as any).code!=='ENOENT')throw e;}}return original.call(this);};
 try{await assert.rejects(storage.stage(prepared),/injected/);}finally{proto.sync=original;}
 assert.equal(failed,true);const inode=(await stat(target)).ino;let synced=0;
 proto.sync=async function(){if((await this.stat()).ino===inode)synced++;return original.call(this);};
 try{await storage.stage(prepared);}finally{proto.sync=original;}
 assert.ok(synced>0,'EEXIST target itself, not merely a temporary file, must be synced');
});

test('an existing exact legacy backup must be fsynced successfully before migration publishes v2',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'backup-fsync-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.json'),raw=JSON.stringify(fixture());await writeFile(file,raw,{mode:0o600});await writeFile(file+'.legacy-v1',raw,{mode:0o600});
 const store=new StateStore(file);await store.load();const inode=(await stat(file+'.legacy-v1')).ino;
 const handle=await open(path.join(dir,'probe'),'w');const proto=Object.getPrototypeOf(handle),original=proto.sync;await handle.close();
 proto.sync=async function(){if((await this.stat()).ino===inode)throw Error('injected backup fsync failure');return original.call(this);};
 try{await assert.rejects(store.capture(fixture),/injected/);}finally{proto.sync=original;}
 assert.equal(await readFile(file,'utf8'),raw);await store.capture(fixture);assert.equal(JSON.parse(await readFile(file,'utf8')).version,2);
});

test('uncertain manifest publication invalidates cached A before retrying A after failed B',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'manifest-sync-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.json'),store=new StateStore(file),a={...fixture(),personality:'A'},b={...fixture(),personality:'B'};
 await store.save(a);
 const handle=await open(path.join(dir,'probe'),'w');const proto=Object.getPrototypeOf(handle),original=proto.sync;await handle.close();
 let failed=false;
 proto.sync=async function(){if((await this.stat()).isDirectory()&&!failed){const raw=JSON.parse(await readFile(file,'utf8'));if(raw.globals.personality==='B'){failed=true;throw Error('injected manifest directory fsync failure');}}return original.call(this);};
 try{await assert.rejects(store.save(b),/injected manifest/);}finally{proto.sync=original;}
 assert.equal(failed,true);assert.equal(JSON.parse(await readFile(file,'utf8')).globals.personality,'B');
 await store.capture(()=>a);assert.deepEqual(await new StateStore(file).load(),a);
});

test('omitting an existing committed array is corruption, not permission to discard accepted work',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'array-membership-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.json');await new StateStore(file).save(fixture());const manifest=JSON.parse(await readFile(file,'utf8'));manifest.arrays=[];delete manifest.orders.pending;
 await writeFile(file,JSON.stringify(manifest));await assert.rejects(new StateStore(file).load(),/Omitted committed/);
});
