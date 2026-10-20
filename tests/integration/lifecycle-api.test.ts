import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {database,seed,T,P,U,T2,U2} from './support';
import {PostgresDb} from '../../packages/adapters/src/postgres';
import {Api} from '../../apps/web/src/lib/api';
import {Quotes} from '../../packages/core/src/quotes';
import {Jobs} from '../../packages/core/src/jobs';
import {Artifacts,LocalStorage} from '../../packages/core/src/artifacts';
import {Inspector,FixtureRpc} from '../../apps/worker/src/runner';
import {input} from '../fixtures/observations';
import {Orders,FixtureBilling} from '../../packages/core/src/orders';
let db:pg.Pool,web:PostgresDb,worker:PostgresDb;
const storage=new LocalStorage(`.data/lifecycle-http-${process.pid}-${Date.now()}`);
beforeAll(async()=>{db=await database();web=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!);worker=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!,'pitlane_worker');});
beforeEach(async()=>seed(db));afterAll(async()=>{await Promise.all([db.end(),web.close(),worker.close()]);});
const api=(tenantId=T,userId=U)=>new Api({db:web,identity:async()=>({tenantId,userId,csrf:'proof',cookie:true}),origin:'http://localhost',artifacts:new Artifacts(web,storage)});
async function receipt(mint=input.mint){const quotes=new Quotes(web),q=await quotes.quote({tenantId:T,userId:U},{...input,projectId:P,mint});const j=await quotes.submit({tenantId:T,userId:U},q.id,randomUUID());const jobs=new Jobs(worker);await new Inspector(jobs,new Artifacts(worker,storage),new FixtureRpc('local'),[{id:'fixture-a',upstreamId:'a',maximumMicro:'100'},{id:'fixture-b',upstreamId:'b',maximumMicro:'100'}]).inspect((await jobs.claim('lifecycle-http'))!);return (await db.query('select * from pitlane.receipt_versions where job_id=$1',[j.id])).rows[0];}
it('exposes authenticated expiry as410 while foreign scopes remain404',async()=>{
 const r=await receipt();const own=api();
 expect((await own.handle(new Request(`http://localhost/v1/receipts/${r.receipt_id}`))).status).toBe(200);
 await db.query("update pitlane.receipt_versions set expires_at=now()-interval '1 second' where id=$1",[r.id]);
 await db.query("update pitlane.artifacts set expires_at=now()-interval '1 second' where id=$1",[r.artifact_id]);
 for(const path of [`/v1/receipts/${r.receipt_id}`,`/v1/artifacts/${r.artifact_id}`]){
  const response=await own.handle(new Request('http://localhost'+path));expect(response.status).toBe(410);const body=await response.json();expect(body.code).toBe('EVIDENCE_EXPIRED');expect(body.payload).toBeUndefined();
  expect((await api(T2,U2).handle(new Request('http://localhost'+path))).status).toBe(404);
 }
});
it('pages immutable receipt versions without repeating the first page',async()=>{
 const a=await receipt(),b=await receipt('11111111111111111111111111111111');const own=api();
 const first=await (await own.handle(new Request(`http://localhost/v1/projects/${P}/receipts?page=true&limit=1`))).json();expect(first.items).toHaveLength(1);expect(first.nextCursor).toBeTruthy();
 const next=await (await own.handle(new Request(`http://localhost/v1/projects/${P}/receipts?page=true&limit=1&cursor=${encodeURIComponent(JSON.stringify(first.nextCursor))}`))).json();
 expect(next.items).toHaveLength(1);expect(new Set([first.items[0].versionId,next.items[0].versionId])).toEqual(new Set([a.id,b.id]));
 expect((await own.handle(new Request(`http://localhost/v1/projects/${P}/receipts?page=true&limit=1000`))).status).toBe(422);
});
it('requires CSRF and explicit deletion text; disabled billing cannot create a checkout',async()=>{
 const own=api();const remove=(confirmation:string,csrf='proof')=>own.handle(new Request(`http://localhost/v1/tenants/${T}`,{method:'DELETE',headers:{origin:'http://localhost','x-csrf-token':csrf},body:JSON.stringify({confirmation})}));
 expect((await remove('DELETE WORKSPACE','wrong')).status).toBe(403);expect((await remove('delete')).status).toBe(422);
 expect((await own.handle(new Request('http://localhost/v1/billing/subscriptions',{method:'POST',headers:{origin:'http://localhost','x-csrf-token':'proof'},body:'{}'}))).status).toBe(409);
});
it('returns a safe purchase DTO that the checkout UI can render',async()=>{
 await db.query("update pitlane.runtime set billing_mode='sandbox'");
 const plans=[{planId:'solo',version:'2026-10-v1',label:'Solo',priceId:'price_solo_test',amountCents:'2900',units:5,currency:'usd',interval:'month'}];
 await db.query('select pitlane.configure_billing_catalog($1,$2,$3)',['acct_isolated_test','sandbox',JSON.stringify(plans)]);
 const own=new Api({db:web,identity:async()=>({tenantId:T,userId:U,csrf:'proof',cookie:true}),origin:'http://localhost',orders:new Orders(web,web,new FixtureBilling('local'))});
 const response=await own.handle(new Request('http://localhost/v1/billing/subscriptions',{method:'POST',headers:{origin:'http://localhost','x-csrf-token':'proof','idempotency-key':'http-subscription-request'},body:JSON.stringify({plan_id:'solo',version:'2026-10-v1'})}));
 expect(response.status).toBe(202);const purchase=await response.json();expect(purchase).toMatchObject({state:'requested',planId:'solo',version:'2026-10-v1',checkoutUrl:null});expect(Date.parse(purchase.holdUntil)).toBeGreaterThan(Date.now());
 await db.query("update pitlane.subscription_purchases set state='awaiting_checkout',checkout_url='https://checkout.stripe.com/c/pay/fixture' where id=$1",[purchase.id]);
 const status=await (await own.handle(new Request('http://localhost/v1/billing/subscriptions/'+purchase.id))).json();expect(status.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/fixture');expect(status).not.toHaveProperty('request_key');expect(status).not.toHaveProperty('provider_account');
});
