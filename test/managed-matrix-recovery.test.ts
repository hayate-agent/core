import test from 'node:test';
import assert from 'node:assert/strict';

test('managed Matrix recovery preserves compaction and bounded 429 backoff under native stop',async()=>{
 // Built artifact is required, as for product-naming integration tests.
 const {default:factory,RecoveryMatrixChannel,compactReviewReply}=await import('../docs/gateways/matrix-recovery.mjs' as string);
 assert.equal(factory.updateAdmission,'foreground-owned');
 const marker='\n\n⚠️ Review blocked: budget exhausted; operator escalation required.\n';
 const original='answer'+marker+JSON.stringify({version:1,status:'escalated',rounds:[{findings:[{severity:'P1',title:'retain refusal'}]}]});
 const compact=compactReviewReply(original);assert.match(compact,/retain refusal/);assert.match(compact,/Keine Veröffentlichung oder Freigabe/);assert.ok(!compact.includes('"rounds"'));assert.equal(compactReviewReply('plain'),'plain');
 const proto=Object.getPrototypeOf(RecoveryMatrixChannel.prototype);const old=proto.api;
 let calls=0,waits:number[]=[];
 const channel={abort:new AbortController(),backoff:async(ms:number)=>{waits.push(ms);}};
 try{
  proto.api=async()=>{calls++;if(calls<3)throw Object.assign(Error('{"retry_after_ms":2000}'),{status:429});return 'ok';};
  assert.equal(await RecoveryMatrixChannel.prototype.api.call(channel,'GET','/sync'),'ok');assert.deepEqual(waits,[2250,2250]);
  calls=0;proto.api=async()=>{calls++;throw Object.assign(Error('429'),{status:429});};
  await assert.rejects(RecoveryMatrixChannel.prototype.api.call(channel,'GET','/sync'));assert.equal(calls,9);
  calls=0;channel.abort.abort();await assert.rejects(RecoveryMatrixChannel.prototype.api.call(channel,'GET','/sync'));assert.equal(calls,1);
  assert.equal(RecoveryMatrixChannel.prototype.stop,proto.stop,'native ordered stop is inherited unchanged');
 }finally{proto.api=old;}
});
