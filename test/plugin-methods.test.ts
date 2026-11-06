// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PluginHost } from '../src/plugins.js';
const context={home:'/tmp',cwd:'/tmp',agent:'fixture'};

test('class commands retain prototype methods and original receiver',async(t)=>{
 const host=new PluginHost();t.after(()=>host.stop());
 class Command {
  name='class_command';help='Example';#prefix='command:';
  async run(args:string){return this.#prefix+args;}
 }
 await host.load([],context,[],[],[{apiVersion:1,activate(api){api.registerCommand(new Command());}}]);
 assert.equal(await host.commands.get('class_command')!.run('ok',{sessionKey:'test'}),'command:ok');
});

test('class tools retain prototype methods and original receiver',async(t)=>{
 const host=new PluginHost();t.after(()=>host.stop());
 class Tool {
  name='plugin_class';description='Example';parameters={type:'object' as const};#prefix='tool:';
  async execute(input:Record<string,unknown>){return this.#prefix+input.text;}
 }
 await host.load([],context,[],[],[{apiVersion:1,activate(api){api.registerTool(new Tool());}}]);
 assert.equal(await host.tools.get('plugin_class')!.execute({text:'ok'},{sessionKey:'test'}),'tool:ok');
});

test('class panels retain prototype methods and original receiver',async(t)=>{
 const host=new PluginHost();t.after(()=>host.stop());
 class Panel {
  name='class_panel';#prefix='panel:';
  render(ctx:{agent:string}){return [this.#prefix+ctx.agent];}
 }
 await host.load([],context,[],[],[{apiVersion:1,activate(api){api.registerPanel(new Panel());}}]);
 assert.deepEqual(host.panels.get('class_panel')!.render({agent:'ok'}),['panel:ok']);
});
