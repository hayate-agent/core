import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ApiChannel } from '../src/api/server.js';

class Response extends EventEmitter {
 writableEnded=false;
 blocked=false;
 writes:string[]=[];
 writeHead() {}
 write(text:string) { this.writes.push(text); return !this.blocked; }
 end() { this.writableEnded=true; }
 destroy() { this.emit('close'); }
}

test('keepalives stop during backpressure and resume only after drain', async(t)=>{
 t.mock.timers.enable({apis:['setInterval']});
 let listener!:(event:any)=>void;
 let unsubscribed=false;
 const api=new ApiChannel({key:'test',agent:'test',keepaliveMs:10,cancel:async()=>false,models:async()=>[],
  runs:{get:()=>({run_id:'r'}),subscribe:(_id:string,_seq:number,cb:any)=>{listener=cb;return {replay:[],closed:false,unsubscribe:()=>{unsubscribed=true;}};}} as any});
 const response=new Response();
 (api as any).events({headers:{}},response,new URL('http://local/'),'r');
 t.after(()=>response.emit('close'));
 response.blocked=true;
 listener({seq:0,data:{event:'message.delta'}});
 const blockedWrites=response.writes.length;
 t.mock.timers.tick(100);
 assert.equal(response.writes.length,blockedWrites,'timer must not add frames while waiting for drain');
 response.blocked=false;response.emit('drain');t.mock.timers.tick(10);
 assert.equal(response.writes.at(-1),': keepalive\n\n');
 response.blocked=true;t.mock.timers.tick(10);
 const keepaliveBlocked=response.writes.length;t.mock.timers.tick(100);
 assert.equal(response.writes.length,keepaliveBlocked,'keepalive itself must honor a false write return');
 response.emit('close');assert.equal(unsubscribed,true);
 const closedWrites=response.writes.length;t.mock.timers.tick(100);
 assert.equal(response.writes.length,closedWrites);
});
