import {callGateway} from '@/lib/botdb/gateway';
import {prepareInboxEvent} from './contract';
export interface InboxWorkerDeps {
 enabled?:boolean;
 accountId?:string;
 now?:()=>number;
 call?:(action:string,args:Record<string,unknown>)=>Promise<unknown>;
}
type Job={job_id:string;event_receipt_id:string;version:number;lease_token:string;lease_expires_at:string;expires_at:string;event:unknown};
const object=(v:unknown):v is Record<string,unknown>=>!!v && typeof v==='object' && !Array.isArray(v);
export async function runInboxWorker(deps:InboxWorkerDeps={}) {
 if(!(deps.enabled??process.env.LINE_P0_WORKER_ENABLED==='true')) return {skipped:'disabled',finished:0};
 const account=deps.accountId??process.env.LINE_P0_ACCOUNT_ID;
 if(!account) throw new Error('inbox_worker_missing_account');
 const now=deps.now??Date.now;const call=deps.call??callGateway;const deadline=now()+25_000;
 const response=await call('inbox.claim.v1',{p_account_id:account,p_limit:10,p_lease_seconds:300});
 if(!object(response) || response.schema_version!==1 || !Array.isArray(response.jobs) || response.jobs.length>10) throw new Error('inbox_invalid_claim_receipt');
 let finished=0;let failed=0;
 for(const value of response.jobs) {
  if(now()>=deadline) break; // Unstarted claims expire and are recovered by the next bounded run.
  if(!object(value) || typeof value.job_id!=='string' || typeof value.lease_token!=='string' || !Number.isSafeInteger(value.version) || Number(value.version)<1 || typeof value.lease_expires_at!=='string' || typeof value.expires_at!=='string') throw new Error('inbox_invalid_claim_receipt');
  const job=value as Job;
  if(!Number.isFinite(Date.parse(job.lease_expires_at)) || !Number.isFinite(Date.parse(job.expires_at))) throw new Error('inbox_invalid_claim_receipt');
  if(Date.parse(job.lease_expires_at)<=now()) {failed++;continue;}
  try {
   // This processor only validates durable CRM input; it cannot reply/push/ingest inquiry.
   let outcome='validated';let error:string|null=null;
   if(Date.parse(job.expires_at)>now()) {
    try {
     const prepared=await prepareInboxEvent(job.event);
     if(prepared.classification!=='pending') {outcome='quarantined';error='schema_unknown';}
    } catch {outcome='quarantined';error='schema_unknown';}
   }
   const result=await call('inbox.finish.v1',{p_account_id:account,p_job_id:job.job_id,p_lease_token:job.lease_token,p_expected_version:job.version,p_outcome:outcome,p_error_code:error});
   if(!object(result) || result.schema_version!==1 || result.job_id!==job.job_id || result.version!==job.version+1 || !['done','quarantined_schema','withdrawn','expired'].includes(String(result.status))) throw new Error('inbox_invalid_finish_receipt');
   finished++;
  } catch {failed++;} // Unknown completion results are recovered by token/version or lease expiry.
 }
 return {claimed:response.jobs.length,finished,failed};
}
