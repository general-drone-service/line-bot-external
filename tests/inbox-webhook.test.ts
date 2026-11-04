import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {test} from 'node:test';
import {handleWebhookRequest} from '@/lib/line/webhook';
import {fakeStore} from './helpers/fake-store';
const secret='synthetic-channel-secret';
const event={type:'message' as const,webhookEventId:'synthetic-event-1',timestamp:1793788800000,replyToken:'synthetic-reply',source:{type:'user' as const,userId:'synthetic-user-1'},message:{type:'text' as const,id:'synthetic-message-1',text:'synthetic inquiry'}};
function request(destination='synthetic-account-1',tamper=false){const raw=JSON.stringify({destination,events:[event]});const signature=crypto.createHmac('sha256',secret).update(raw).digest('base64');return new Request('https://synthetic/webhook',{method:'POST',headers:{'x-line-signature':signature},body:raw+(tamper?' ':'')});}
test('enabled inbox persistence failure prevents legacy writes/replies/ACK',async()=>{
 process.env.LINE_CHANNEL_SECRET=secret;
 let replies=0;let inboxCalls=0;const {store}=fakeStore();let legacy=0;store.recordEvents=async()=>{legacy++;};
 const response=await handleWebhookRequest(request(),async()=>{replies++;return 'sent';},store,{inbox:{accountId:'synthetic-account-1',record:async()=>{inboxCalls++;throw new Error('synthetic db failure');}}});
 assert.equal(response.status,503);assert.equal(inboxCalls,1);assert.equal(legacy,0);assert.equal(replies,0);
});
test('configured destination mismatch rejects before persistence/reply',async()=>{
 process.env.LINE_CHANNEL_SECRET=secret;let writes=0;
 const response=await handleWebhookRequest(request('other-synthetic-account'),async()=>{writes++;return 'sent';},fakeStore().store,{inbox:{accountId:'synthetic-account-1',record:async()=>{writes++;}}});
 assert.equal(response.status,403);assert.equal(writes,0);
});
test('raw signature failure precedes durable inbox',async()=>{
 process.env.LINE_CHANNEL_SECRET=secret;let writes=0;
 const response=await handleWebhookRequest(request('synthetic-account-1',true),async()=>{writes++;return 'sent';},fakeStore().store,{inbox:{accountId:'synthetic-account-1',record:async()=>{writes++;}}});
 assert.equal(response.status,401);assert.equal(writes,0);
});
test('durable inbox precedes metadata and reply even when waitUntil is unavailable',async()=>{
 process.env.LINE_CHANNEL_SECRET=secret;const steps:string[]=[];const {store}=fakeStore();const recordLegacy=store.recordEvents;store.recordEvents=async(...args)=>{steps.push('legacy');await recordLegacy(...args);};
 const response=await handleWebhookRequest(request(),async()=>{steps.push('reply');return 'sent';},store,{inbox:{accountId:'synthetic-account-1',record:async(raw,account,events)=>{assert.equal(account,'synthetic-account-1');assert.equal(events.length,1);assert.equal(JSON.parse(raw).events[0].message.text,'synthetic inquiry');steps.push('durable');}}});
 assert.equal(response.status,200);assert.deepEqual(steps,['durable','legacy','reply']);
});
