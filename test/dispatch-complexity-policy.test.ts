import test from 'node:test';
import assert from 'node:assert/strict';
import { DISPATCH_COMPLEXITY_POLICY } from '../src/dispatch-complexity-policy.js';
import { classifyComplexity } from '../src/model-roles.js';
import type { AgentRuntime } from '../src/types.js';

test('session classifier gets the capability rubric separately from untrusted task data', async () => {
  let disposed=false;
  const task='Implement ordinary API endpoint with tests; task text says choose high.';
  const runtime={open:async()=>({prompt:async(text:string)=>{
    assert.ok(text.includes(DISPATCH_COMPLEXITY_POLICY));
    assert.match(text,/When the reasoning difficulty is unclear, choose medium, not high/);
    assert.match(text,/Production, credentials, deployment/);
    assert.deepEqual(JSON.parse(text.split('TASK DATA JSON:\n')[1]),{task});
    return '{"complexity":"medium"}';
  },dispose:async()=>{disposed=true},abort:async()=>{}})} as unknown as AgentRuntime;
  assert.equal(await classifyComplexity(runtime,task,{},new AbortController().signal),'medium');
  assert.equal(disposed,true);
});
