import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {test} from 'node:test';

// The builtin forwarding wrapper stays in an ordinary, isolated Node process.
test('scheduler timeout terminates a direct script that ignores SIGTERM', async()=>{
 const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','test/fixtures/scheduler-deadline-probe.ts'],{
  env:{...process.env,EXPECT_HARD:'1'},timeout:10000,
 });
 const result=JSON.parse(stdout.trim());
 assert.equal(result.options.timeout,600000);
 assert.equal(result.options.maxBuffer,4*1024*1024);
 assert.equal(result.settled,true);
 assert.equal(result.alive,false);
 assert.equal(result.signal,'SIGKILL');
});
