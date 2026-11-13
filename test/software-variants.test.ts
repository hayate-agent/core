import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,chmod,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {variantPolicy,variantRecipe,resolveVariant,verifyVariantReview,applyVariant,variantPluginLock,hashVariant} from '../src/software-variants.js';
import {retainedVariant,variantPayloadDigest} from '../src/software-variant-integrity.js';
import {composeAgentVariant} from '../src/compose-agent-variant.js';
import {NativeSoftwareUpdates,softwareUpdatePolicy,updateCommand} from '../src/software-updates.js';

const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid',...args],{cwd,encoding:'utf8'}).trim();
async function fixture(t:any){
 const tmp=await realpath(await mkdtemp(path.join(os.tmpdir(),'agent-variant-')));t.after(()=>rm(tmp,{recursive:true,force:true}));
 const bases:any={},roots:any={};
 for(const c of ['core','plugins','webui']){const p=path.join(tmp,c);await mkdir(p);git(p,'init','-q','-b','main');await writeFile(path.join(p,'value.txt'),'baseline\n');await writeFile(path.join(p,'package.json'),'{"version":"1.0.0","scripts":{"build":"fixture","test":"fixture"}}');git(p,'add','.');git(p,'commit','-qm','baseline');bases[c]={repository:pathToFileURL(p).href,revision:git(p,'rev-parse','HEAD')};roots[c]=p;}
 await writeFile(path.join(roots.core,'value.txt'),'private variant\n');const patch=execFileSync('git',['diff','--','value.txt'],{cwd:roots.core,encoding:'utf8'});git(roots.core,'checkout','--','value.txt');
 await writeFile(path.join(roots.core,'plugins.lock.json'),JSON.stringify({schema:1,repository:'https://github.com/hayate-agent/plugins',revision:bases.plugins.revision,files:{}}));git(roots.core,'add','.');git(roots.core,'commit','-qm','locked plugin base');bases.core.revision=git(roots.core,'rev-parse','HEAD');
 const profile=path.join(tmp,'profile-source');await mkdir(profile);git(profile,'init','-q','-b','main');await mkdir(path.join(profile,'patches'));await writeFile(path.join(profile,'patches/private.patch'),patch);
 const recipe={schema:1,profile:'fixture-agent',bases,patches:[{component:'core',path:'patches/private.patch',sha256:hashVariant(patch)}]};await writeFile(path.join(profile,'variant.json'),JSON.stringify(recipe));git(profile,'add','.');git(profile,'commit','-qm','reviewable private recipe');
 const runner=path.join(tmp,'verify.cjs');await writeFile(runner,`#!/usr/bin/env node\nlet s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{let v=JSON.parse(s);console.log(JSON.stringify({binding:v.identity.binding,reviewer:'independent-fixture',independent:true,evidence:'fixture://external-review/1'}));});\n`);await chmod(runner,0o700);
 const policy=variantPolicy({repository:pathToFileURL(profile).href,branch:'main',manifest:'variant.json',review:{runner,sha256:hashVariant(await readFile(runner))}});
 const checkout=path.join(tmp,'checkout');await mkdir(checkout);const resolved=await resolveVariant(policy,checkout,updateCommand);
 return {tmp,bases,roots,profile,recipe,policy,resolved,runner};
}

test('variant schema requires immutable bases, safe paths, bounded distinct patches and a pinned owner verifier',()=>{
 const bases=Object.fromEntries(['core','plugins','webui'].map(c=>[c,{repository:'https://example.org/'+c,revision:'a'.repeat(40)}]));
 const valid={schema:1,profile:'agent',bases,patches:[]};assert.equal(variantRecipe(valid).profile,'agent');
 for(const value of [{...valid,approved:true},{...valid,bases:{...bases,core:{repository:'https://example.org/core',revision:'main'}}},{...valid,patches:[{component:'core',path:'../escape',sha256:'a'.repeat(64)}]},{...valid,patches:[{component:'webui',path:'x',sha256:'no'}]}])assert.throws(()=>variantRecipe(value));
 for(const repository of ['https://token:secret@example.org/repo','https://example.org/repo?token=secret'])assert.throws(()=>variantPolicy({repository,branch:'main',manifest:'variant.json',review:{runner:'/trusted/reviewer',sha256:'a'.repeat(64)}}));
 assert.equal(softwareUpdatePolicy({variant:null}).variant,null);
});

test('real private Git recipe composes only the staged source and binds independent review',async t=>{
 const f=await fixture(t);const approval=await verifyVariantReview(f.policy,f.resolved);assert.equal(approval.binding,f.resolved.identity.binding);retainedVariant(f.resolved,approval);
 await applyVariant(f.resolved,f.roots,f.tmp,updateCommand);assert.equal(await readFile(path.join(f.roots.core,'value.txt'),'utf8'),'private variant\n');assert.equal(git(f.roots.core,'rev-parse','HEAD'),f.bases.core.revision);assert.match(git(f.roots.core,'diff','--cached'),/private variant/);
 const changed=structuredClone(f.resolved);changed.patches[0].content+='changed';assert.throws(()=>retainedVariant(changed,approval));
});

test('patch conflict never changes the existing source to an invented merged result',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.roots.core,'value.txt'),'unrelated local work\n');await assert.rejects(applyVariant(f.resolved,f.roots,f.tmp,updateCommand));assert.equal(await readFile(path.join(f.roots.core,'value.txt'),'utf8'),'unrelated local work\n');
});

test('file integrity, traversal and installed verifier tampering fail before approval',async t=>{
 const f=await fixture(t);await writeFile(f.runner,'#!/bin/sh\necho forged\n');await assert.rejects(verifyVariantReview(f.policy,f.resolved),/integrity/);
 await writeFile(path.join(f.profile,'patches/private.patch'),'tampered');git(f.profile,'add','.');git(f.profile,'commit','-qm','changed patch without hash');const c=path.join(f.tmp,'second');await mkdir(c);await assert.rejects(resolveVariant(f.policy,c,updateCommand),/digest/);
});

test('review can neither approve a different binding nor claim the author as independent',async t=>{
 const f=await fixture(t);
 for(const response of [{binding:'f'.repeat(64),reviewer:'external',independent:true,evidence:'fixture'},{binding:f.resolved.identity.binding,reviewer:'fixture-agent',independent:true,evidence:'fixture'},{binding:f.resolved.identity.binding,reviewer:'external',independent:false,evidence:'fixture'}]){
  await writeFile(f.runner,'#!/usr/bin/env node\nprocess.stdin.resume();console.log('+JSON.stringify(JSON.stringify(response))+');\n');const p={...f.policy,review:{...f.policy.review,sha256:hashVariant(await readFile(f.runner))}};await assert.rejects(verifyVariantReview(p,f.resolved),/Invalid external/);
 }
});

test('checkout symlink cannot provide patch bytes from outside the profile',async t=>{
 const f=await fixture(t);await rm(path.join(f.profile,'patches/private.patch'));await symlink(path.join(f.roots.core,'value.txt'),path.join(f.profile,'patches/private.patch'));git(f.profile,'add','.');git(f.profile,'commit','-qm','unsafe link');const c=path.join(f.tmp,'linked');await mkdir(c);await assert.rejects(resolveVariant(f.policy,c,updateCommand),/Unsafe/);
});

test('plugin patch composition records changed bytes and upstream base lock rather than bypassing hashes',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.roots.plugins,'src'));await writeFile(path.join(f.roots.plugins,'src/example.ts'),'export const value=2;');const original={schema:1,repository:'https://github.com/hayate-agent/plugins',revision:f.bases.plugins.revision,files:{'example.ts':'a'.repeat(64)}};await writeFile(path.join(f.roots.core,'plugins.lock.json'),JSON.stringify(original));const v=structuredClone(f.resolved);v.patches[0].component='plugins';await variantPluginLock(f.roots.core,f.roots.plugins,v);const lock=JSON.parse(await readFile(path.join(f.roots.core,'plugins.lock.json'),'utf8'));assert.equal(lock.files['example.ts'],hashVariant('export const value=2;'));assert.equal(lock.variant.baseLockSha256,hashVariant(JSON.stringify(original)));assert.equal(lock.revision,f.bases.plugins.revision);
});

test('payload digest changes for source/build changes and rejects escaping symlinks',async t=>{
 const f=await fixture(t);const a=await variantPayloadDigest(f.tmp);await writeFile(path.join(f.roots.core,'value.txt'),'modified');assert.notEqual(await variantPayloadDigest(f.tmp),a);await symlink('/etc/hosts',path.join(f.roots.core,'escape'));await assert.rejects(variantPayloadDigest(f.tmp),/escapes/);
});

test('native reviewed variant prepares, activates only after exit, survives offline restart and cannot be silently dropped',async t=>{
 const f=await fixture(t);const home=path.join(f.tmp,'live-home');
 // This fixture executes real Git/patches/review protocol; npm/Node qualification
 // are controlled stubs, not a claim of real production runtime validation.
 const command:any=async(cmd:string,args:string[],cwd:string,...rest:any[])=>{
  if(cmd==='npm'){
   if(args[0]==='run'&&path.basename(cwd)==='core'){await mkdir(path.join(cwd,'dist'),{recursive:true});await writeFile(path.join(cwd,'dist/cli.js'),'// fixture');await writeFile(path.join(cwd,'dist/launcher.js'),'// fixture');await writeFile(path.join(cwd,'package.json'),'{"version":"1.0.0"}');}
   return '';
  }
  if(cmd===process.execPath)return '';
  return updateCommand(cmd,args,cwd,...rest);
 };
 const policy=softwareUpdatePolicy({variant:f.policy,sources:Object.fromEntries(Object.entries(f.bases).map(([c,b]:any)=>[c,{repository:b.repository}]))});
 const owner=new NativeSoftwareUpdates(home,policy,()=>{},command,false);t.after(()=>owner.close());await owner.open();await owner.request('install');
 for(let i=0;i<500&&!['prepared','failed'].includes(owner.snapshot().phase);i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(owner.snapshot().phase,'prepared',owner.snapshot().detail);assert.equal(owner.entrypoint('original'),'original');
 await owner.afterExit();const entry=owner.entrypoint('original');assert.notEqual(entry,'original');assert.equal(await readFile(path.join(path.dirname(path.dirname(entry)),'value.txt'),'utf8'),'private variant\n');
 const before=await readFile(path.join(home,'software-updates/selected.json'),'utf8');
 await writeFile(path.join(f.roots.core,'value.txt'),'new shared base\n');git(f.roots.core,'add','.');git(f.roots.core,'commit','-qm','upstream base advances');const nextBase=git(f.roots.core,'rev-parse','HEAD');
 await owner.request('check');for(let i=0;i<300&&owner.snapshot().phase==='checking';i++)await new Promise(r=>setTimeout(r,10));assert.equal(owner.snapshot().phase,'available');assert.equal(owner.snapshot().variantBaseCandidates?.core,nextBase);assert.equal(await readFile(path.join(home,'software-updates/selected.json'),'utf8'),before);assert.equal(owner.entrypoint('original'),entry);
 await rm(f.runner);
 const restored=new NativeSoftwareUpdates(home,policy,()=>{},command,false);t.after(()=>restored.close());await restored.open();assert.equal(restored.entrypoint('original'),entry,'startup must not depend on a review network call');
 const evidence=path.join(path.dirname(path.dirname(path.dirname(entry))),'variant-review.json');const savedEvidence=await readFile(evidence,'utf8');await rm(evidence);
 const missing=new NativeSoftwareUpdates(home,policy,()=>{},command,false);t.after(()=>missing.close());await assert.rejects(missing.open(),/reconcile/,'missing dependent evidence must not be mistaken for missing selected.json');assert.equal(await readFile(path.join(home,'software-updates/selected.json'),'utf8'),before);await writeFile(evidence,savedEvidence);
 const replaced=new NativeSoftwareUpdates(home,policy,()=>{},command,false,'/another/bootstrap.js');t.after(()=>replaced.close());await assert.rejects(replaced.open(),/reconcile/);
 const dropped=new NativeSoftwareUpdates(home,softwareUpdatePolicy({sources:policy.sources}),()=>{},command,false);t.after(()=>dropped.close());await assert.rejects(dropped.open(),/reconcile/);assert.equal(await readFile(path.join(home,'software-updates/selected.json'),'utf8'),before);
});

test('approval failure after preparation retains bootstrap instead of activating unreviewed code',async t=>{
 const f=await fixture(t),home=path.join(f.tmp,'denied-home');
 const command:any=async(cmd:string,args:string[],cwd:string,...rest:any[])=>{
  if(cmd==='npm'){if(args[0]==='run'&&path.basename(cwd)==='core'){await mkdir(path.join(cwd,'dist'),{recursive:true});await writeFile(path.join(cwd,'dist/cli.js'),'// fixture');await writeFile(path.join(cwd,'dist/launcher.js'),'// fixture');await writeFile(path.join(cwd,'package.json'),'{"version":"1.0.0"}');}return '';}
  if(cmd===process.execPath)return '';return updateCommand(cmd,args,cwd,...rest);
 };
 const policy=softwareUpdatePolicy({variant:f.policy,sources:Object.fromEntries(Object.entries(f.bases).map(([c,b]:any)=>[c,{repository:b.repository}]))});const owner=new NativeSoftwareUpdates(home,policy,()=>{},command,false);t.after(()=>owner.close());await owner.open();await owner.request('install');for(let i=0;i<500&&!['prepared','failed'].includes(owner.snapshot().phase);i++)await new Promise(r=>setTimeout(r,10));assert.equal(owner.snapshot().phase,'prepared',owner.snapshot().detail);await writeFile(f.runner,'tampered');await owner.afterExit();assert.equal(owner.snapshot().phase,'failed');assert.equal(owner.entrypoint('original'),'original');await assert.rejects(readFile(path.join(home,'software-updates/selected.json')),/ENOENT/);
});

test('prepared candidate cannot survive a variant policy branch change or a changed recipe on the same branch',async t=>{
 const f=await fixture(t),home=path.join(f.tmp,'policy-change-home');
 const command:any=async(cmd:string,args:string[],cwd:string,...rest:any[])=>{
  if(cmd==='npm'){if(args[0]==='run'&&path.basename(cwd)==='core'){await mkdir(path.join(cwd,'dist'),{recursive:true});await writeFile(path.join(cwd,'dist/cli.js'),'// fixture');await writeFile(path.join(cwd,'dist/launcher.js'),'// fixture');}return '';}
  if(cmd===process.execPath)return '';return updateCommand(cmd,args,cwd,...rest);
 };
 const sources=Object.fromEntries(Object.entries(f.bases).map(([c,b]:any)=>[c,{repository:b.repository}]));
 const owner=new NativeSoftwareUpdates(home,softwareUpdatePolicy({sources,variant:f.policy}),()=>{},command,false);await owner.open();await owner.request('install');for(let i=0;i<500&&!['prepared','failed'].includes(owner.snapshot().phase);i++)await new Promise(r=>setTimeout(r,10));assert.equal(owner.snapshot().phase,'prepared',owner.snapshot().detail);
 git(f.profile,'checkout','-b','replacement');await writeFile(path.join(f.profile,'variant.json'),JSON.stringify({...f.recipe,patches:[]}));git(f.profile,'add','.');git(f.profile,'commit','-qm','new branch recipe');
 await owner.close();const next=new NativeSoftwareUpdates(home,softwareUpdatePolicy({sources,variant:{...f.policy,branch:'replacement'}}),()=>{},command,false);t.after(()=>next.close());await next.open();assert.notEqual(next.snapshot().phase,'prepared');await next.afterExit();assert.equal(next.entrypoint('original'),'original');await assert.rejects(readFile(path.join(home,'software-updates/selected.json')),/ENOENT/);
 git(f.profile,'checkout','main');await writeFile(path.join(f.profile,'variant.json'),JSON.stringify({...f.recipe,patches:[]}));git(f.profile,'add','.');git(f.profile,'commit','-qm','changed original branch recipe');
 const stale=new NativeSoftwareUpdates(home,softwareUpdatePolicy({sources,variant:f.policy}),()=>{},command,false);t.after(()=>stale.close());await stale.open();assert.equal(stale.snapshot().phase,'prepared');await stale.afterExit();assert.equal(stale.snapshot().phase,'failed');assert.equal(stale.entrypoint('original'),'original');await assert.rejects(readFile(path.join(home,'software-updates/selected.json')),/ENOENT/);
});

test('container composer binds private sources and emits test-qualified Core and WebUI build contexts without publishing',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.roots.plugins,'src'));await writeFile(path.join(f.roots.plugins,'src/example.ts'),'export const fixture=1;');git(f.roots.plugins,'add','.');git(f.roots.plugins,'commit','-qm','plugin source');f.recipe.bases.plugins.revision=git(f.roots.plugins,'rev-parse','HEAD');
 await writeFile(path.join(f.roots.core,'plugins.lock.json'),JSON.stringify({schema:1,repository:'https://github.com/hayate-agent/plugins',revision:f.recipe.bases.plugins.revision,files:{'example.ts':hashVariant('export const fixture=1;')}}));
 await writeFile(path.join(f.roots.core,'.dockerignore'),'.git\nnode_modules\ndist\ntest\n');await writeFile(path.join(f.roots.core,'Dockerfile'),'FROM node AS build\nWORKDIR /src\nCOPY tsconfig.json plugins.lock.json ./\nCOPY scripts ./scripts\nCOPY src ./src\nRUN npm run build && npm prune --omit=dev\nFROM node\nLABEL org.opencontainers.image.version=$VERSION\n');git(f.roots.core,'add','.');git(f.roots.core,'commit','-qm','core build inputs');f.recipe.bases.core.revision=git(f.roots.core,'rev-parse','HEAD');
 await writeFile(path.join(f.roots.webui,'Dockerfile'),'FROM node AS build\nWORKDIR /build\nCOPY scripts ./scripts\nCOPY dashboard ./dashboard\nRUN npm run build\nFROM node\nWORKDIR /app\n');git(f.roots.webui,'add','.');git(f.roots.webui,'commit','-qm','web build inputs');f.recipe.bases.webui.revision=git(f.roots.webui,'rev-parse','HEAD');
 await writeFile(path.join(f.profile,'variant.json'),JSON.stringify(f.recipe));git(f.profile,'add','.');git(f.profile,'commit','-qm','exact reviewed build inputs');
 const output=path.join(f.tmp,'composed');await composeAgentVariant(f.policy,output);const r=JSON.parse(await readFile(path.join(output,'variant-receipt.json'),'utf8'));assert.equal(r.identity.profile,'fixture-agent');assert.equal(r.review.independent,true);assert.equal(await readFile(path.join(output,'core/value.txt'),'utf8'),'private variant\n');assert.match(await readFile(path.join(output,'core/Dockerfile.variant'),'utf8'),/npm run typecheck && npm run build && npm test/);assert.match(await readFile(path.join(output,'webui/Dockerfile.variant'),'utf8'),/npm test && npm run build/);assert.doesNotMatch(await readFile(path.join(output,'core/Dockerfile.variant.dockerignore'),'utf8'),/^test$/m);assert.equal(await readFile(path.join(output,'core/vendor/plugins/src/example.ts'),'utf8'),'export const fixture=1;');await assert.rejects(composeAgentVariant(f.policy,output),/EEXIST/);
});

test('native check resolves pinned variant rather than moving shared main and performs no build or activation',async t=>{
 const f=await fixture(t);const home=path.join(f.tmp,'agent-home');let built=false;const command:any=async(cmd:string,args:string[],cwd:string,...rest:any[])=>{if(cmd==='npm')built=true;return updateCommand(cmd,args,cwd,...rest);};
 const owner=new NativeSoftwareUpdates(home,softwareUpdatePolicy({sources:Object.fromEntries(Object.entries(f.bases).map(([c,b]:any)=>[c,{repository:b.repository,branch:'main'}])),variant:f.policy}),()=>{},command,false);t.after(()=>owner.close());await owner.open();await owner.request('check');for(let i=0;i<200&&owner.snapshot().phase==='checking';i++)await new Promise(r=>setTimeout(r,10));const s=owner.snapshot();assert.equal(s.phase,'available');assert.equal(s.plan?.variant?.profile,'fixture-agent');assert.deepEqual(s.plan?.revisions,f.bases&&Object.fromEntries(Object.entries(f.bases).map(([c,b]:any)=>[c,b.revision])));assert.equal(built,false);assert.equal(owner.entrypoint('original'),'original');
});
