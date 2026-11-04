import assert from 'node:assert/strict';
import {test} from 'node:test';
import {replayInbox} from '@/lib/inbox/replay';
const events=[{event_receipt_id:'11111111-1111-4111-8111-111111111111',expected_version:4}];
test('manual replay defaults dry run and uses operator auth rather than bot HMAC',async()=>{
 let called=0;
 const result=await replayInbox({accountId:'synthetic-account',requestId:'22222222-2222-4222-8222-222222222222',events,reason:'synthetic review'},{rpc:async args=>{called++;assert.equal(args.p_dry_run,true);return {schema_version:1,request_id:args.p_request_id,dry_run:true,count:1,events:[{event_receipt_id:events[0].event_receipt_id,status:'dead_letter',version:4}]};}});
 assert.equal(called,1);assert.equal(result.count,1);
});
test('manual replay rejects duplicate or unbounded event sets before remote mutation',async()=>{
 let called=0;const deps={rpc:async()=>{called++;return {};}};
 for(const list of [[],[...events,...events],Array.from({length:21},(_,i)=>({event_receipt_id:`11111111-1111-4111-8111-${String(i).padStart(12,'0')}`,expected_version:1}))]) await assert.rejects(()=>replayInbox({accountId:'synthetic-account',requestId:'22222222-2222-4222-8222-222222222222',events:list,reason:'synthetic review'},deps));
 assert.equal(called,0);
});
