import {callGateway} from '@/lib/botdb/gateway';
import type {LineEvent} from '@/lib/line/types';
import {canonicalize,projectEvent,sha256} from './contract';
export interface DurableInbox {
 accountId:string;
 record:(raw:string,accountId:string,events:LineEvent[])=>Promise<void>;
}
/** Missing explicit enablement preserves the legacy path. Enabled misconfiguration fails closed. */
export function configuredInbox():DurableInbox|undefined {
 if(process.env.LINE_P0_INBOX_ENABLED!=='true') return undefined;
 return {accountId:process.env.LINE_P0_ACCOUNT_ID??'',record:recordVerifiedDelivery};
}
export async function recordVerifiedDelivery(raw:string,accountId:string,events:LineEvent[]):Promise<void> {
 if(new TextEncoder().encode(raw).byteLength>256*1024 || events.length>100) throw new Error('inbox_input_limit');
 const requestId=crypto.randomUUID();
 const entries=await Promise.all(events.map(async event=>{
   const projection=projectEvent(event);
   return {event:projection,canonical_event_hash_v1:await sha256(canonicalize(projection))};
 }));
 const receipt=await callGateway<unknown>('inbox.record.v1',{p_account_id:accountId,p_request_id:requestId,p_delivery_raw_digest:await sha256(raw),p_events:entries});
 if(!receipt || typeof receipt!=='object') throw new Error('inbox_invalid_receipt');
 const r=receipt as {schema_version?:unknown;request_id?:unknown;events?:unknown};
 if(r.schema_version!==1 || r.request_id!==requestId || !Array.isArray(r.events)) throw new Error('inbox_invalid_receipt');
 const expected=new Set(events.map(e=>e.webhookEventId));const seen=new Set<string>();
 for(const e of r.events){
   if(!e || typeof e!=='object' || typeof e.webhook_event_id!=='string' || !expected.has(e.webhook_event_id) || seen.has(e.webhook_event_id) || typeof e.event_receipt_id!=='string' || !/^[a-f0-9-]{36}$/i.test(e.event_receipt_id) || !Number.isSafeInteger(e.version) || e.version<1 || !['pending','quarantined_schema','withdrawn','expired','done','dead_letter','processing','retry'].includes(e.status)) throw new Error('inbox_invalid_receipt');
   seen.add(e.webhook_event_id);
 }
 if(seen.size!==expected.size) throw new Error('inbox_incomplete_receipt');
}
