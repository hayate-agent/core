import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillSearchPlugin } from '../src/skill-search-plugin.js';

test('metadata search stops at the slice-equivalent result limit', async () => {
  for (const limit of [1, 1.5, 2.9, 8, 20]) {
    let reads = 0;
    const skills = Array.from({length:1000}, (_,i) => ({
      get name(){ reads++; return `match-${i}`; }, description:'fixture', filePath:`/fixture/${i}/SKILL.md`,
    }));
    let tool: any;
    await skillSearchPlugin({skills, async refresh(){}} as any).activate({registerTool(t:any){tool=t;}} as any);
    const text = await tool.execute({query:'match',limit}, {sessionKey:'fixture'});
    assert.equal((text.match(/"filePath":/g) ?? []).length, Math.trunc(limit));
    assert.equal(reads, 2 * Math.trunc(limit));
  }
});
