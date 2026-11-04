import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runInboxWorker} from '@/lib/inbox/worker';
const event={webhookEventId:'synthetic-event',timestamp:1793788800000,type:'message',source:{type:'user',userId:'synthetic-user'},message:{id:'synthetic-message',type:'text',text:'synthetic'}};
test('inbox worker default off makes no gateway calls',async()=>{
 let calls=0;const result=await runInboxWorker({enabled:false,accountId:'synthetic-account',call:async()=>{calls++;return {};}});
 assert.equal(calls,0);assert.equal(result.skipped,'disabled');
});
test('inbox worker only validates CRM jobs and never sends LINE or inquiry actions',async()=>{
 const actions:string[]=[];const result=await runInboxWorker({enabled:true,accountId:'synthetic-account',now:()=>1793788800000,call:async(action,args)=>{actions.push(action);if(action==='inbox.claim.v1')return {schema_version:1,jobs:[{job_id:'11111111-1111-4111-8111-111111111111',event_receipt_id:'22222222-2222-4222-8222-222222222222',version:2,lease_token:'33333333-3333-4333-8333-333333333333',lease_expires_at:'2026-11-04T13:00:00Z',expires_at:'2027-11-04T12:00:00Z',event}]};assert.equal(args.p_outcome,'validated');return {schema_version:1,job_id:args.p_job_id,status:'done',version:3};}});
 assert.deepEqual(actions,['inbox.claim.v1','inbox.finish.v1']);assert.equal(result.finished,1);
});
