import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {canonicalize,prepareInboxEvent,sha256} from '@/lib/inbox/contract';
const fixtures=JSON.parse(readFileSync(new URL('../docs/linebot-p0-v1-fixtures.json',import.meta.url),'utf8'));
for(const v of fixtures.cases) test(`inbox shared vector ${v.name}`,async()=>{
 const prepared=await prepareInboxEvent(v.input);
 assert.equal(prepared.canonical_event_hash_v1,v.canonical_event_hash_v1);
 assert.equal(prepared.classification,v.expected_status);
 if(v.persisted_event) assert.deepEqual(prepared.event,v.persisted_event);
});
test('canonicalization rejects unsafe numbers and non-JSON objects',()=>{
 for(const value of [NaN,Infinity,9007199254740992,undefined,new Date(),{value:undefined}]) assert.throws(()=>canonicalize(value));
});
test('raw byte digest differs across redelivery but event hash does not',async()=>{
 const base=fixtures.cases.find((v:any)=>v.name==='base');
 const redelivery=fixtures.cases.find((v:any)=>v.name==='redelivery');
 assert.notEqual(await sha256(JSON.stringify(base.input)),await sha256(JSON.stringify(redelivery.input)));
 assert.equal((await prepareInboxEvent(base.input)).canonical_event_hash_v1,(await prepareInboxEvent(redelivery.input)).canonical_event_hash_v1);
});
