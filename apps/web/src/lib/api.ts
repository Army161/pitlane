import {featureRoute} from './features';
import {lifecycleRoute} from './lifecycle-api';
import {collaborationRoute} from './collaboration-api';
import type {Collaboration} from '../../../../packages/core/src/collaboration';
import type {StoragePort} from '../../../../packages/contracts/src';
import type {Orders} from '../../../../packages/core/src/orders';
import {Retention} from '../../../../packages/core/src/retention';
import {randomUUID} from 'node:crypto';import {z} from 'zod';import type {Db,Actor} from '../../../../packages/contracts/src';import {EXTENSIONS,LIMITS} from '../../../../packages/contracts/src';import {Quotes,mapJob} from '../../../../packages/core/src/quotes';import {Jobs} from '../../../../packages/core/src/jobs';import {authorize} from '../../../../packages/core/src/access';import type {Artifacts} from '../../../../packages/core/src/artifacts';import {boundedBody} from '../../../../packages/adapters/src/solana-rpc';
export interface ApiIdentity extends Actor {csrf:string;cookie:boolean}
const quoteSchema=z.object({project_id:z.string().uuid(),template_id:z.enum(['solana.mint_configuration','solana.integration_expectations']),template_version:z.literal('1').default('1'),network:z.enum(['devnet','mainnet-beta']),mint:z.string(),expectations:z.array(z.unknown()).optional()}).strict();
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
const jobRead=`select j.*, (j.input='{"evidenceExpired":true}'::jsonb or
 (j.state in('completed','unsupported','failed','expired','cancelled') and j.body_expires_at<=now() and not exists(
  select from pitlane.receipt_versions v join pitlane.artifacts a on a.id=v.artifact_id
  where v.job_id=j.id and v.expires_at>now() and a.expires_at>now() and a.state='published' and v.payload<>'{"evidenceExpired":true}'::jsonb
 ))) as evidence_expired from pitlane.jobs j`;
const jobDto=(r:Record<string,any>|undefined)=>{if(!r)throw new Error('NOT_FOUND');return {job_id:r.id,execution_state:r.state,origin:r.origin,input:r.evidence_expired?{evidenceExpired:true}:r.input,evidence_expired:!!r.evidence_expired,body_expires_at:r.body_expires_at,deadline:r.deadline,attempts:r.attempts,receipt_id:r.receipt_id,created_at:r.created_at}};
const eventDto=(r:Record<string,unknown>)=>({seq:String(r.seq),type:r.type,payload:r.payload,occurred_at:r.occurredAt,evidence_expired:r.evidenceExpired});
function eventOptions(request:Request,url:URL){
 const cursor=request.headers.get('last-event-id')??url.searchParams.get('cursor')??'0';
 if(!/^\d{1,19}$/.test(cursor)||BigInt(cursor)>9223372036854775807n)throw new Error('INVALID_PAGE');
 const limit=z.coerce.number().int().min(1).max(100).parse(url.searchParams.get('limit')??100);
 return {cursor,limit};
}
export class Api {
 constructor(readonly deps:{db:Db;identity:(request:Request)=>Promise<ApiIdentity>;origin:string;artifacts?:Artifacts;storage?:StoragePort;orders?:Orders;collaboration?:Collaboration}){}
 async handle(request:Request):Promise<Response>{const requestId=randomUUID();try{const identity=await this.deps.identity(request);if(!['GET','HEAD'].includes(request.method)&&identity.cookie&&(request.headers.get('origin')!==this.deps.origin||request.headers.get('x-csrf-token')!==identity.csrf))return json({code:'CSRF_REQUIRED',request_id:requestId},403);const actor:Actor={userId:identity.userId,tenantId:identity.tenantId};const u=new URL(request.url),path=u.pathname;const db=this.deps.db;
 const body=async()=>JSON.parse(await boundedBody(new Response(request.body),65536));
 const read=async<T=Record<string,any>>(sql:string,values?:unknown[])=>db.transaction(tx=>tx.query<T>(sql,values),actor);
 const lifecycle=await lifecycleRoute(request,actor,{db,body,billingEnabled:!!this.deps.orders});if(lifecycle)return lifecycle;
 if(path==='/v1/templates'&&request.method==='GET')return json(['solana.mint_configuration','solana.integration_expectations'].map(id=>({template_id:id,template_version:'1',extensions:EXTENSIONS,limits:{deadline_seconds:180,maximum_predicates:32},evidence_policy:'two_finalized_independent_upstreams',description:id.endsWith('mint_configuration')?'Reproducible mint configuration':'Declared configuration predicates'})));
 if(path==='/v1/projects'&&request.method==='GET')return json((await read('select id,name,tenant_id,pitlane.can_project(tenant_id,id,true) as can_write,pitlane.can_project_admin(tenant_id,id) as can_admin from pitlane.projects order by name')).rows);
 if(path==='/v1/quotes'&&request.method==='POST'){const v=quoteSchema.parse(await body());const q=await new Quotes(db).quote(actor,{projectId:v.project_id,templateId:v.template_id,templateVersion:v.template_version,network:v.network,mint:v.mint,expectations:(v.expectations??[]) as any});return json({quote_id:q.id,inputs_hash:q.inputsHash,expires_at:q.expiresAt,units:q.units,price:q.price,max_charge:q.price,policy_versions:{rules:'1',evidence:'1',price:'1'}})}
 if(path==='/v1/jobs'&&request.method==='POST'){const v=z.object({quote_id:z.string().uuid()}).strict().parse(await body());const key=z.string().min(16).max(128).parse(request.headers.get('idempotency-key'));const j=await new Quotes(db).submit(actor,v.quote_id,key);return json({job_id:j.id,execution_state:j.state,origin:j.origin,events_url:`/v1/jobs/${j.id}/events`},202)}
 if(path==='/v1/jobs'&&request.method==='GET'){const p=z.string().uuid().parse(u.searchParams.get('project_id'));const limit=z.coerce.number().int().min(1).max(100).parse(u.searchParams.get('limit')??25);await db.transaction(tx=>authorize(actor,{tenantId:actor.tenantId,projectId:p},'read',tx),actor);return json((await read(jobRead+' where j.project_id=$1 order by j.created_at desc,j.id desc limit $2',[p,limit])).rows.map(jobDto))}
 const match=/^\/v1\/jobs\/([0-9a-f-]{36})(\/cancel|\/events)?$/.exec(path);
 if(match){
  const id=z.string().uuid().parse(match[1]);
  if(match[2]==='/cancel'&&request.method==='POST'){await new Jobs(db).requestCancel(actor,id);return json(jobDto((await read(jobRead+' where j.id=$1',[id])).rows[0]),202)}
  if(match[2]==='/events'&&request.method==='GET'){
   if(!(await read('select id from pitlane.jobs where id=$1',[id])).rows[0])throw new Error('NOT_FOUND');
   const {cursor,limit}=eventOptions(request,u);
   if(request.headers.get('accept')?.includes('text/event-stream'))return this.streamEvents(actor,id,cursor,request.signal,limit);
   const page=await new Retention(db).listEvents(actor,id,{cursor,limit});const items=page.items.map(eventDto);
   const response=json(u.searchParams.get('page')==='true'?{items,nextCursor:page.nextCursor}:items);
   if(page.nextCursor)response.headers.set('x-next-cursor',page.nextCursor);return response;
  }
  if(!match[2]&&request.method==='GET')return json(jobDto((await read(jobRead+' where j.id=$1',[id])).rows[0]));
 }
 const records=/^\/v1\/projects\/([0-9a-f-]{36})\/receipts$/.exec(path);if(records&&request.method==='GET'){const p=z.string().uuid().parse(records[1]);await db.transaction(tx=>authorize(actor,{tenantId:actor.tenantId,projectId:p},'read',tx),actor);return json((await read('select v.id,v.receipt_id,v.payload->>\'finding\' as finding,v.payload->>\'origin\' as origin,v.issued_at,v.expires_at from pitlane.receipt_versions v join pitlane.receipt_heads h on h.version_id=v.id join pitlane.artifacts a on a.id=v.artifact_id where v.project_id=$1 and v.expires_at>now() and a.expires_at>now() and a.state=\'published\' order by v.issued_at desc limit 25',[p])).rows)}
 const download=/^\/v1\/artifacts\/([0-9a-f-]{36})$/.exec(path);if(download&&request.method==='GET'){if(!this.deps.artifacts)throw new Error('STORAGE_UNAVAILABLE');return new Response(await this.deps.artifacts.downloadStream(actor,z.string().uuid().parse(download[1])),{headers:{'content-type':'application/json','content-disposition':`attachment; filename="pitlane-${download[1]}.json"`,'cache-control':'no-store','x-content-type-options':'nosniff'}})}
 const usage=/^\/v1\/tenants\/([0-9a-f-]{36})\/(usage|billing)$/.exec(path);if(usage&&request.method==='GET'){if(usage[1]!==actor.tenantId)throw new Error('NOT_FOUND');if(usage[2]==='billing'&&!(await read<{ok:boolean}>('select pitlane.can_billing($1) as ok',[actor.tenantId])).rows[0].ok)throw new Error('NOT_FOUND');const lots=(await read('select granted,reserved,consumed,starts_at,ends_at,origin from pitlane.entitlement_lots where tenant_id=$1',[actor.tenantId])).rows;const runtime=(await read('select pitlane.runtime_info() as value')).rows[0].value;const cost=usage[2]==='billing'?(await read('select pitlane.tenant_cost_usage($1) as value',[actor.tenantId])).rows[0].value:null;return json({lots,billing_enabled:runtime.billing_mode!=='disabled',collection:runtime.billing_mode,mode:runtime.mode,cost})}
 if(this.deps.collaboration){const result=await collaborationRoute(request,actor,this.deps.collaboration,body);if(result)return result;}
 const feature=await featureRoute(request,actor,{db,body,storage:this.deps.storage,orders:this.deps.orders});if(feature)return feature;return json({code:'NOT_FOUND',request_id:requestId},404);
 }catch(e){const code=e instanceof z.ZodError||e instanceof SyntaxError?'INVALID_INPUT':e instanceof Error?e.message:'INTERNAL_ERROR';const status=code==='UNAUTHENTICATED'?401:code==='NOT_FOUND'?404:['QUOTE_EXPIRED','QUOTA_EXHAUSTED','ACTIVE_LIMIT','IDEMPOTENCY_CONFLICT','COST_BUDGET_EXHAUSTED','BILLING_DISABLED','LAST_OWNER','PROJECT_LIMIT','REGISTERED_USER_REQUIRED','ACTIVE_TENANT_MEMBER_REQUIRED','VERSION_CONFLICT','POLICY_REACCEPTANCE_REQUIRED','CONSENT_EXPIRED','REFUND_EXCEEDS_SETTLEMENT','OPERATOR_REVIEW_REQUIRED','EXPLICIT_PERMISSION_REQUIRED','VERIFIED_FIX_AND_REGRESSION_REQUIRED','VERIFIED_FAILURE_REQUIRED','INITIAL_DELIVERY_INCOMPLETE','INVALID_ORDER_STATE','SUBSCRIPTION_ALREADY_EXISTS'].includes(code)?409:['INVALID_INPUT','INVALID_PAGE','UNSUPPORTED_SCOPE','CONTRADICTORY_INPUT','INVALID_ADDRESS','UNSUPPORTED_SUBSCRIPTION_PLAN'].includes(code)?422:503;return json({code:status===503?'SERVICE_UNAVAILABLE':code,message:status===503?'The requested service is unavailable':code,request_id:requestId,retryable:status===503},status)}}
 async streamEvents(actor:Actor,id:string,start:string,signal:AbortSignal,limit=100){
  let cursor=start,cancelled=false;const db=this.deps.db,encoder=new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
   async pull(controller){
    if(cancelled)return;if(signal.aborted){controller.close();return}
    try{
     const result=await db.transaction(async tx=>{
      const job=await tx.query<{id:string;state:string}>('select id,state from pitlane.jobs where id=$1',[id]);if(!job.rows[0])throw new Error('NOT_FOUND');
      const scoped:Db={transaction:async fn=>fn(tx),query:async(sql,values)=>tx.query(sql,values)};
      const page=await new Retention(scoped).listEvents(actor,id,{cursor,limit});
      return {page,terminal:['completed','failed','expired','cancelled','unsupported'].includes(job.rows[0].state)};
     },actor);
     if(cancelled)return;if(signal.aborted){controller.close();return}
     for(const row of result.page.items){const event=eventDto(row);cursor=event.seq;controller.enqueue(encoder.encode(`id: ${cursor}\nevent: job\ndata: ${JSON.stringify(event)}\n\n`))}
     if(result.page.nextCursor)return;
     if(result.terminal){controller.close();return}
     if(!result.page.items.length)controller.enqueue(encoder.encode(': heartbeat\n\n'));
     await new Promise(resolve=>setTimeout(resolve,1000));
    }catch{if(!cancelled)controller.close()}
   },cancel(){cancelled=true}
  }),{headers:{'content-type':'text/event-stream','cache-control':'no-store','x-accel-buffering':'no'}});
 }
}
