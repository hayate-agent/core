import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsService } from '../src/settings.js';
import { loadPersona } from '../src/persona.js';
import { updatePersonaPrompt } from '../src/runtime/pi.js';

test('partial memory/context commands and empty updates never activate pending siblings', async t => {
 const home=await mkdtemp(path.join(os.tmpdir(),'overlay-partial-')); t.after(()=>rm(home,{recursive:true,force:true}));
 await mkdir(path.join(home,'settings.d')); const file=path.join(home,'settings.local.yaml');
 await writeFile(file,'memory: {autoRecall: true, autoCapture: true}\ncontextMaintenance: {enabled: true, autoHandover: true}');
 const settings=new SettingsService(file,{}); await settings.load();
 await writeFile(file,'memory: {autoRecall: false, autoCapture: true}\ncontextMaintenance: {enabled: false, autoHandover: true}');
 await settings.reload(); await settings.setMemory({}); await settings.setContext({});
 assert.equal(settings.effective().memory?.autoRecall,true); assert.equal(settings.effective().contextMaintenance?.enabled,true);
 await settings.setMemory({autoCapture:false}); await settings.setContext({autoHandover:false});
 assert.deepEqual(settings.effective().memory,{autoRecall:true,autoCapture:false});
 assert.deepEqual(settings.effective().contextMaintenance,{enabled:true,autoHandover:false});
 assert.deepEqual(settings.restartPending.sort(),['contextMaintenance','memory']);
});

test('all named module maps preserve module across disabled and re-enabled layers', async t => {
 const home=await mkdtemp(path.join(os.tmpdir(),'overlay-maps-')); t.after(()=>rm(home,{recursive:true,force:true}));
 await mkdir(path.join(home,'settings.d')); const file=path.join(home,'settings.local.yaml');
 const categories=['gatewayPlugins','policyPlugins','extensionPlugins'];
 await writeFile(file,categories.map(key=>`${key}: {custom: {module: custom.mjs}}`).join('\n'));
 await writeFile(path.join(home,'settings.d/10.yaml'),categories.map(key=>`${key}: {custom: {disabled: true}}`).join('\n'));
 await writeFile(path.join(home,'settings.d/50.yaml'),categories.map(key=>`${key}: {custom: {disabled: false}}`).join('\n'));
 const settings=new SettingsService(file,{}); await settings.load();
 for(const key of categories) assert.deepEqual((settings.effective() as any)[key].custom,{module:'custom.mjs',disabled:false});
});

test('default identity and voice .md.d layers preserve identity and lexical ordering without loading legacy alternatives', async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'overlay-defaults-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const files={soul:path.join(home,'SOUL.md'),voice:path.join(home,'VOICE.md'),personalitiesDir:path.join(home,'personalities')};
 await writeFile(files.soul,'Severus Snape'); await writeFile(files.voice,'German, concise');
 for(const file of [files.soul,files.voice]){await mkdir(file+'.d');await writeFile(file+'.d/50.md','last');await writeFile(file+'.d/1.md','first');}
 await mkdir(files.personalitiesDir);await writeFile(path.join(files.personalitiesDir,'severus-delivery.md'),'DELIVERY');
 let persona=await loadPersona(files);assert.equal(persona.soul,'Severus Snape\n\nfirst\n\nlast');assert.equal(persona.voice,'German, concise\n\nfirst\n\nlast');assert.deepEqual(persona.overlays,[]);
 persona=await loadPersona({...files,overlays:[path.join(files.personalitiesDir,'severus-delivery.md')]});assert.equal(persona.overlays?.[0].text,'DELIVERY');
 await rm(files.voice+'.d',{recursive:true});assert.equal((await loadPersona(files)).voice,'German, concise');
 await symlink(home,files.voice+'.d');await assert.rejects(loadPersona(files),/Cannot load persona directory/);
 await rm(files.voice+'.d');await symlink(path.join(home,'missing'),files.voice+'.d');await assert.rejects(loadPersona(files),/Cannot load persona directory/);
});

test('PI prompt compatibility guard validates both snapshots before writing',()=>{
 const base={appendSystemPrompt:'old'};
 for(const invalid of [undefined,{}, {appendSystemPrompt:3},Object.freeze({appendSystemPrompt:'old'})]){
  assert.throws(()=>updatePersonaPrompt({_baseSystemPromptOptions:base,_runSystemPromptOptions:invalid??{}} as any,'new'),/unsupported/);
  assert.equal(base.appendSystemPrompt,'old');
 }
 updatePersonaPrompt({_baseSystemPromptOptions:base} as any,'new');assert.equal(base.appendSystemPrompt,'new');
});
