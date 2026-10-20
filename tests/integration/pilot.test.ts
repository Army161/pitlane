import {beforeAll,afterAll,beforeEach,it,expect} from 'vitest';import type pg from 'pg';import {database,seed,T,P,U} from './support';
import {PostgresDb} from '../../packages/adapters/src/postgres';
import {Quotes} from '../../packages/core/src/quotes';
import {Jobs} from '../../packages/core/src/jobs';
import {Artifacts,LocalStorage} from '../../packages/core/src/artifacts';
import {FixtureRpc,Inspector} from '../../apps/worker/src/runner';
import {input} from '../fixtures/observations';
const m=await import('../../packages/core/src/orders').catch(()=>({}));
let db:pg.Pool;beforeAll(async()=>{db=await database()});beforeEach(async()=>seed(db));afterAll(async()=>db.end());
it('exports guarded pilot summary and one-time retest grant capabilities',async()=>{expect((await db.query("select to_regprocedure('pitlane.pilot_summary(uuid,uuid,integer)') is not null as ok")).rows[0].ok).toBe(true)});
it('a tenant owner is not automatically a platform human reviewer',async()=>{expect((await db.query('select pitlane.is_operator($1) as ok',[U])).rows[0].ok).toBe(false)});

it('captures one pilot only after both initial receipts and an operator summary, then grants five scoped retests once',async()=>{
 const web=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!);const worker=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!,'pitlane_worker');const billing=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!,'pitlane_billing');
 try{
  await db.query("update pitlane.runtime set billing_mode='sandbox'");const storage=new LocalStorage('.data/pilot-artifacts');const provider=new (m as any).FixtureBilling('local');const orders=new (m as any).Orders(web,billing,provider,storage);const actor={tenantId:T,userId:U};const quotes=new Quotes(web);
  const q1=await quotes.quote(actor,{...input,projectId:P});const order=await orders.authorizeOrder(actor,q1.id,'pilot-first-request-123','pilot',2);await orders.dispatchBilling();const q2=await quotes.quote(actor,{...input,projectId:P});const second=await orders.addInitialQuote(actor,order.id,q2.id,'pilot-second-request-123');expect((await orders.addInitialQuote(actor,order.id,q2.id,'pilot-second-request-123')).id).toBe(second.id);
  const jobs=new Jobs(worker);const inspector=new Inspector(jobs,new Artifacts(worker,storage),new FixtureRpc('local'),[{id:'fixture-a',upstreamId:'fixture-a',maximumMicro:'100'},{id:'fixture-b',upstreamId:'fixture-b',maximumMicro:'100'}]);
  await inspector.inspect((await jobs.claim('pilot-worker'))!);await orders.dispatchBilling();expect(provider.captured).toBe(0);await inspector.inspect((await jobs.claim('pilot-worker'))!);await orders.dispatchBilling();expect(provider.captured).toBe(0);
  await expect(orders.deliverPilotSummary(actor,order.id,{minutes:15,text:'Fixture operator review: both receipts and integration requirements reviewed.'})).rejects.toThrow('OPERATOR_REVIEW_REQUIRED');await db.query('insert into pitlane.platform_operators values($1,true) on conflict(user_id) do update set active=true',[U]);const inspectionArtifact=(await db.query('select artifact_id from pitlane.receipt_versions limit 1')).rows[0].artifact_id;await expect(orders.recordPilotSummary(actor,order.id,inspectionArtifact,15)).rejects.toThrow('NOT_FOUND');await orders.deliverPilotSummary(actor,order.id,{minutes:15,text:'Fixture operator review: both receipts and integration requirements reviewed.'});
  await orders.dispatchBilling();await orders.dispatchBilling();expect(provider.captured).toBe(1);expect((await db.query('select settled_cents,retest_granted from pitlane.orders where id=$1',[order.id])).rows[0]).toMatchObject({settled_cents:'19900',retest_granted:true});const retest=(await db.query("select granted,reserved,consumed,scope_hashes from pitlane.entitlement_lots where source_key=$1",['pilot/'+order.id+'/retest'])).rows;expect(retest).toHaveLength(1);expect(retest[0]).toMatchObject({granted:5,reserved:0,consumed:0});expect(retest[0].scope_hashes).toContain(q1.inputsHash);expect((await db.query("select reserved,consumed from pitlane.entitlement_lots where source_key='local-fixture'")).rows[0]).toMatchObject({reserved:0,consumed:0});
 }finally{await Promise.all([web.close(),worker.close(),billing.close()])}
});
