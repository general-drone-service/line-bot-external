export interface ReplayInput {accountId:string;requestId:string;events:{event_receipt_id:string;expected_version:number}[];reason:string;apply?:boolean;}
export interface ReplayDeps {rpc:(args:Record<string,unknown>)=>Promise<unknown>;}
const uuid=(v:unknown)=>typeof v==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
export async function replayInbox(input:ReplayInput,deps:ReplayDeps):Promise<{count:number;dry_run:boolean;states:Record<string,number>}> {
 if(typeof input.accountId!=='string' || input.accountId.length<1 || input.accountId.length>255 || !uuid(input.requestId) || typeof input.reason!=='string' || input.reason.trim().length<1 || input.reason.trim().length>500 || !Array.isArray(input.events) || input.events.length<1 || input.events.length>20) throw new Error('invalid_replay_input');
 const ids=new Set<string>();
 for(const event of input.events){
  if(!event || !uuid(event.event_receipt_id) || !Number.isSafeInteger(event.expected_version) || event.expected_version<1 || ids.has(event.event_receipt_id) || Object.keys(event).sort().join(',')!=='event_receipt_id,expected_version') throw new Error('invalid_replay_input');
  ids.add(event.event_receipt_id);
 }
 const dryRun=input.apply!==true;
 const response=await deps.rpc({p_account_id:input.accountId,p_request_id:input.requestId,p_events:input.events,p_reason:input.reason.trim(),p_dry_run:dryRun});
 if(!response || typeof response!=='object') throw new Error('invalid_replay_receipt');
 const result=response as {schema_version?:unknown;request_id?:unknown;dry_run?:unknown;count?:unknown;events?:unknown};
 if(result.schema_version!==1 || result.request_id!==input.requestId || result.dry_run!==dryRun || result.count!==ids.size || !Array.isArray(result.events) || result.events.length!==ids.size) throw new Error('invalid_replay_receipt');
 const states:Record<string,number>={};const seen=new Set<string>();
 for(const event of result.events){
  if(!event || !ids.has(event.event_receipt_id) || seen.has(event.event_receipt_id) || !['retry','dead_letter'].includes(event.status) || !Number.isSafeInteger(event.version)) throw new Error('invalid_replay_receipt');
  seen.add(event.event_receipt_id);states[event.status]=(states[event.status]??0)+1;
 }
 return {count:ids.size,dry_run:dryRun,states}; // No payload, LINE ID, event ID or token in CLI output.
}
