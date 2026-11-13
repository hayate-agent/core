import assert from "node:assert/strict";
import { test } from "node:test";
import { completionProviderForProfile } from "../src/completion-profile.js";
import { ValidatorRegistry } from "../src/validator.js";

test("existing profile omitting optional completion block preserves its configured legacy execution baseline", () => {
 const registry = new ValidatorRegistry(); let calls = 0;
 registry.register({apiVersion:1,name:"legacy-llm",version:1,async assess(){calls++;return{state:"completed"};}});
 registry.select(completionProviderForProfile({}));
 assert.equal(registry.selected,"legacy-llm");assert.equal(registry.current?.name,"legacy-llm");assert.equal(calls,0,"selection never probes or sends network traffic");
});

for(const [name,completionCheck,expected] of [
 ["explicit incomplete block",{},undefined],
 ["explicit TypeSafe",{provider:"typesafe"},"typesafe"],
 ["unknown selected name",{provider:"missing"},"missing"],
 ["operator disabled",{provider:false},false],
 ["explicit legacy",{provider:"legacy-llm"},"legacy-llm"],
] as const)test(`profile compatibility never overrides ${name}`,()=>{
 const registry=new ValidatorRegistry();registry.register({apiVersion:1,name:"legacy-llm",version:1,async assess(){throw Error("unselected legacy must never run");}});
 const chosen=completionProviderForProfile({completionCheck}); assert.equal(chosen,expected);
 if(expected===undefined){assert.throws(()=>registry.select(chosen),/required/);return;}
 registry.select(chosen);assert.equal(registry.selected,expected);
 if(expected!==false&&expected!=="legacy-llm")assert.throws(()=>registry.current,/not registered/);
 else assert.equal(registry.current?.name,expected==="legacy-llm"?"legacy-llm":undefined);
});

test("embedding registry without explicit selection remains fail closed",()=>{
 const registry=new ValidatorRegistry();registry.register({apiVersion:1,name:"legacy-llm",version:1,async assess(){throw Error("must never run");}});
 assert.throws(()=>registry.current,/required/);
});
