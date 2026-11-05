import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Harness } from '../src/harness.js';
import { GatewayManager } from '../src/gateway-manager.js';
import { SettingsService } from '../src/settings.js';
import { FakeRuntime } from './fakes.js';

test('gateway admission follows actual active owner across pending, failure and removal', async t => {
 const home=await mkdtemp(path.join(os.tmpdir(),'gateway-owner-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const module=(supported:boolean,broken=false)=>`export default {apiVersion:1,${supported?"updateAdmission:'foreground-owned',":''}async create(){return {channel:{name:'test',async start(){${broken?"throw Error('broken')":''}},async stop(){${broken?"throw Error('cleanup failed')":''}},async send(){}}}}}`;
 for(const [name,supported,broken] of [['legacy',false,false],['safe',true,false],['broken',true,true]] as const)await writeFile(path.join(home,name+'.mjs'),module(supported,broken));
 const settings=new SettingsService(path.join(home,'settings.yaml'),{});await settings.load();await settings.setGatewayPlugin('test',{module:'legacy.mjs'});
 let manager: GatewayManager;
 const harness=new Harness({runtime:new FakeRuntime(),tickMs:60000,updateBlockers:()=>manager.updateBlockers()});
 manager=new GatewayManager(harness,settings,{home,agent:'test',approvers:[]},{});await manager.load();
 assert.deepEqual(manager.updateBlockers(),['unsupported update owner: gateway test']);
 await settings.setGatewayPlugin('test',{module:'safe.mjs'});await manager.request('test');
 assert.deepEqual(manager.updateBlockers(),['gateway transition','unsupported update owner: gateway test']);
 await manager.tick();assert.deepEqual(manager.updateBlockers(),[]);
 await settings.setGatewayPlugin('test',{module:'broken.mjs'});await manager.request('test');await manager.tick();
 assert.deepEqual(manager.updateBlockers(),['gateway cleanup unverified; runtime owner reconciliation required'], 'failed replacement cannot prove candidate cleanup');
 assert.notEqual(harness.acquireUpdateAdmission(60000).status,'admitted');
 await settings.setGatewayPlugin('test',{module:'legacy.mjs'});await manager.request('test');await manager.tick();
 assert.deepEqual(manager.updateBlockers(),['gateway cleanup unverified; runtime owner reconciliation required','unsupported update owner: gateway test']);
 await settings.setGatewayPlugin('test',{disabled:true});await manager.request('test');assert.ok(manager.updateBlockers().includes('gateway transition'));await manager.tick();assert.deepEqual(manager.updateBlockers(),['gateway cleanup unverified; runtime owner reconciliation required']);
});

test('gateway factory preparation blocks admission before its first await settles',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'gateway-preparing-'));t.after(()=>rm(home,{recursive:true,force:true}));
 await writeFile(path.join(home,'slow.mjs'),`export default {apiVersion:1,updateAdmission:'foreground-owned',async create(){await new Promise(r=>setTimeout(r,40));return undefined}}`);
 const settings=new SettingsService(path.join(home,'settings.yaml'),{});await settings.load();
 const manager=new GatewayManager(new Harness({runtime:new FakeRuntime(),tickMs:60000}),settings,{home,agent:'test',approvers:[]},{});
 await settings.setGatewayPlugin('test',{module:'slow.mjs'});const pending=manager.request('test');assert.deepEqual(manager.updateBlockers(),['gateway transition']);await pending;assert.deepEqual(manager.updateBlockers(),['gateway transition']);await manager.tick();assert.deepEqual(manager.updateBlockers(),[]);
});
