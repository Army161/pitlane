import {z} from 'zod';
import type {Actor,Db} from '../../../../packages/contracts/src';
import {Retention,type RetentionPageOptions} from '../../../../packages/core/src/retention';

const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
const purchaseDto=(value:unknown)=>{const r=value as Record<string,unknown>|null;if(!r)throw new Error('NOT_FOUND');return {id:r.id,state:r.state,planId:r.plan_id,version:r.plan_version,checkoutUrl:r.checkout_url??null,holdUntil:r.hold_until};};
export function pageOptions(url:URL):RetentionPageOptions {
 const raw=url.searchParams.get('cursor');
 const cursor=raw?z.object({at:z.string().max(64),id:z.string().uuid()}).strict().parse(JSON.parse(raw)):null;
 return {limit:z.coerce.number().int().min(1).max(100).parse(url.searchParams.get('limit')??25),cursor};
}
export async function lifecycleRoute(request:Request,actor:Actor,deps:{db:Db;body:()=>Promise<unknown>;billingEnabled:boolean}):Promise<Response|null>{
 const url=new URL(request.url),path=url.pathname,method=request.method,retention=new Retention(deps.db);
 const read=async(sql:string,values?:unknown[])=>deps.db.transaction(tx=>tx.query<{value:unknown}>(sql,values),actor);
 const receipt=/^\/v1\/receipts\/([0-9a-f-]{36})$/.exec(path);
 if(receipt&&method==='GET'){
  const result=await retention.lookupLineage(actor,receipt[1],url.searchParams.get('version_id')??undefined);
  if(!result)throw new Error('NOT_FOUND');
  if(result.kind==='expired')return json({code:'EVIDENCE_EXPIRED',...result},410);
  return json({...result.payload,artifact_id:result.artifactId,expires_at:result.expiresAt});
 }
 const artifact=/^\/v1\/artifacts\/([0-9a-f-]{36})$/.exec(path);
 if(artifact&&method==='GET'){
  const result=await retention.lookupArtifact(actor,artifact[1]);
  if(!result)throw new Error('NOT_FOUND');
  if(result.kind==='expired')return json({code:'EVIDENCE_EXPIRED',...result},410);
 }
 const receipts=/^\/v1\/projects\/([0-9a-f-]{36})\/receipts$/.exec(path);
 if(receipts&&method==='GET'&&url.searchParams.get('page')==='true')return json(await retention.listReceipts(actor,receipts[1],pageOptions(url)));
 if(path==='/v1/jobs'&&method==='GET'&&url.searchParams.get('page')==='true')return json(await retention.listJobs(actor,z.string().uuid().parse(url.searchParams.get('project_id')),pageOptions(url)));
 const tenant=/^\/v1\/tenants\/([0-9a-f-]{36})$/.exec(path);
 if(tenant&&method==='DELETE'){
  if(tenant[1]!==actor.tenantId)throw new Error('NOT_FOUND');
  const input=z.object({confirmation:z.literal('DELETE WORKSPACE')}).strict().parse(await deps.body());
  await retention.deleteTenant(actor);return json({deleted:true,purge:'queued'});
 }
 if(path==='/v1/billing/plans'&&method==='GET')return json(deps.billingEnabled?(await read('select pitlane.subscription_plans() as value')).rows[0].value:[]);
 if(path==='/v1/billing/subscriptions'&&method==='POST'){
  if(!deps.billingEnabled)throw new Error('BILLING_DISABLED');
  const b=z.object({plan_id:z.string().min(1).max(128),version:z.string().min(1).max(64)}).strict().parse(await deps.body());
  const key=z.string().min(16).max(128).parse(request.headers.get('idempotency-key'));
  return json(purchaseDto((await read('select pitlane.purchase_subscription($1,$2,$3) as value',[b.plan_id,b.version,key])).rows[0].value),202);
 }
 const purchase=/^\/v1\/billing\/subscriptions\/([0-9a-f-]{36})$/.exec(path);
 if(purchase&&method==='GET')return json(purchaseDto((await read('select pitlane.subscription_purchase_status($1) as value',[z.string().uuid().parse(purchase[1])])).rows[0].value));
 return null;
}
