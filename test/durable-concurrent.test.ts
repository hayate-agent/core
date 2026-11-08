import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeFileDurable } from '../src/durable.js';

test('concurrent durable replacements own independent temporary files', async (t) => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'durable-concurrent-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.json');
 const payloads=Array.from({length:12},(_,i)=>JSON.stringify({i,text:String(i).repeat(20000+i*5000)}));
 const outcomes=await Promise.allSettled(payloads.map(data=>writeFileDurable(file,data)));
 assert.equal(outcomes.filter(r=>r.status==='rejected').length,0,'all independent atomic replacements must succeed');
 assert.ok(payloads.includes(await readFile(file,'utf8')),'final content must be one complete submitted payload');
 assert.deepEqual(await readdir(dir),['state.json']);
});

test('durable binary replacement preserves every byte', async (t) => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'durable-binary-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'attachment');
 const bytes=Uint8Array.from({length:256},(_,i)=>i);
 await writeFileDurable(file,bytes);
 assert.deepEqual(await readFile(file),Buffer.from(bytes));
 assert.deepEqual(await readdir(dir),['attachment']);
});

test('failed rename removes owned temporary file and preserves existing target',async(t)=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'durable-failure-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const target=path.join(dir,'target'); await mkdir(target);
 await assert.rejects(writeFileDurable(target,'synthetic'));
 assert.deepEqual(await readdir(dir),['target'],'failure must not leave staging files');
});
