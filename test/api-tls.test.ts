import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { ApiChannel } from '../src/api/server.js';
import { RunRegistry } from '../src/api/runs.js';

test('native TLS authenticates, delivers and persists a run across listener restart', async () => {
 const dir = await mkdtemp(path.join(tmpdir(), 'api-tls-'));
 let api: ApiChannel | undefined;
 try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir,'key.pem'), '-out', path.join(dir,'cert.pem'), '-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'], {stdio:'ignore'});
  const cert = await readFile(path.join(dir,'cert.pem'));
  const tls = {key:await readFile(path.join(dir,'key.pem')),cert};
  const filename = path.join(dir,'runs.json');
  const invalid = new ApiChannel({key:'tls-test',host:'127.0.0.1',port:0,
   tls:{key:Buffer.from('invalid'),cert},agent:'same-instance',runs:new RunRegistry(filename),
   cancel:async()=>false,models:async()=>[],log:()=>{}});
  await assert.rejects(invalid.start(async()=>{}));
  assert.equal(invalid.address,undefined,'invalid TLS must not open a plaintext listener');
  let deliveries=0;
  const start = async () => {
   const runs = new RunRegistry(filename); await runs.load();
   const channel = new ApiChannel({key:'tls-test',host:'127.0.0.1',port:0,tls,agent:'same-instance',runs,cancel:async()=>false,models:async()=>[],log:()=>{}});
   await channel.start(async input => { deliveries++; await runs.finish(input.replyTo.target, 'actual delivered result'); });
   return channel;
  };
  api=await start();
  const call = (method:string,url:string,body?:unknown,key='tls-test',trusted=true) => new Promise<{status:number;body:any}>((resolve,reject)=>{
   const req=https.request({hostname:'127.0.0.1',port:api!.address!.port,path:url,method,ca:trusted?cert:undefined,headers:{authorization:`Bearer ${key}`,'content-type':'application/json','idempotency-key':'tls-once'}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(text)}));});
   req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  assert.equal((await call('POST','/v1/runs',{input:'execute'},'wrong')).status,401);
  await assert.rejects(call('GET','/health',undefined,'tls-test',false));
  const receipt=await call('POST','/v1/runs',{input:'execute'});
  assert.equal(receipt.status,202);
  const id=receipt.body.run_id;
  assert.equal((await call('GET',`/v1/runs/${id}`)).body.status,'completed');
  await api.stop();api=await start();
  assert.equal((await call('GET',`/v1/runs/${id}`)).body.status,'completed');
  assert.equal((await call('POST','/v1/runs',{input:'execute'})).body.run_id,id);
  assert.equal(deliveries,1);
 } finally {await api?.stop();await rm(dir,{recursive:true,force:true});}
});
