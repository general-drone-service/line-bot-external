/** Bounded operator-only CRM replay. Never run against production without explicit authorization. */
import {readFile} from 'node:fs/promises';
import {replayInbox,type ReplayInput} from '../src/lib/inbox/replay';
async function main(){
 const args=process.argv.slice(2);
 if(args.length<1 || args.length>2 || args.length===2 && args[1]!=='--apply') throw new Error('usage: replay-line-inbox.ts <synthetic-or-authorized-input.json> [--apply]');
 const input=JSON.parse(await readFile(args[0],'utf8')) as ReplayInput;
 // Only the command switch can request mutation; input JSON cannot quietly enable it.
 input.apply=args[1]==='--apply';
 const url=process.env.LINE_INBOX_CRM_URL;const token=process.env.LINE_INBOX_OPERATOR_TOKEN;const key=process.env.LINE_INBOX_PUBLISHABLE_KEY;
 if(!url || !token || !key) throw new Error('operator_configuration_required');
 const origin=new URL(url);
 if(origin.origin!=='https://wowjbqafysobqnlpdtcg.supabase.co' || origin.pathname!=='/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('unapproved_crm_origin');
 // This is a misuse guard, not authentication: CRM validates the token and admin role itself.
 let claims:{role?:string};try{claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));}catch{throw new Error('operator_token_required');}
 if(claims.role!=='authenticated') throw new Error('operator_token_required');
 const result=await replayInbox(input,{rpc:async body=>{
  const response=await fetch(new URL('/rest/v1/rpc/line_bot_inbox_replay_v1',origin),{method:'POST',headers:{apikey:key,authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
  if(!response.ok) throw new Error(`replay_http_${response.status}`);
  return await response.json();
 }});
 console.log(JSON.stringify(result));
}
main().catch(()=>{console.error('Replay failed; no event payload or credentials logged. Keep the same request ID after uncertain results.');process.exitCode=1;});
