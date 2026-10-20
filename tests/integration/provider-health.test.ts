import {beforeAll,afterAll,beforeEach,it,expect} from 'vitest';
import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {database,seed,T,P,U} from './support';
import {input} from '../fixtures/observations';
import {GENESIS} from '../../packages/contracts/src';
import {PostgresDb} from '../../packages/adapters/src/postgres';
import {Quotes} from '../../packages/core/src/quotes';
import {Jobs} from '../../packages/core/src/jobs';
import {gatewayHandler} from '../../apps/gateway/src/server';
import {FixtureRpc} from '../../apps/worker/src/runner';
import {RpcFailure} from '../../packages/adapters/src/solana-rpc';
let db:pg.Pool,web:PostgresDb,worker:PostgresDb,gateway:PostgresDb;
const token='provider-test-capability-with-at-least-32-bytes';
const profiles=[{id:'fixture-a',upstreamId:'controlled-a',network:'devnet' as const,genesis:GENESIS.devnet,maximumMicro:'100'},{id:'fixture-b',upstreamId:'controlled-b',network:'devnet' as const,genesis:GENESIS.devnet,maximumMicro:'100'}];
beforeAll(async()=>{db=await database();const url=process.env.PITLANE_TEST_DATABASE_URL!;web=new PostgresDb(url);worker=new PostgresDb(url,'pitlane_worker');gateway=new PostgresDb(url,'pitlane_gateway');});
beforeEach(async()=>{await seed(db);await db.query('truncate pitlane.provider_profiles cascade');for(const p of profiles)await db.query('insert into pitlane.provider_profiles values($1,$2,$3,$4,100,60,true)',[p.id,p.upstreamId,p.network,p.genesis]);});
afterAll(async()=>{await Promise.all([web.close(),worker.close(),gateway.close()]);await db.end();});
async function work(){const q=await new Quotes(web).quote({tenantId:T,userId:U},{...input,projectId:P});await new Quotes(web).submit({tenantId:T,userId:U},q.id,randomUUID());return (await new Jobs(worker).claim('provider-worker'))!;}
async function request(lease:any){const intent=await new Jobs(worker).costIntent(lease,'fixture-a','getGenesisHash','100');return {intent,request:new Request('http://127.0.0.1/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify({providerId:'fixture-a',method:'getGenesisHash',params:[],lease:{jobId:lease.jobId,workerId:lease.workerId,epoch:lease.epoch},intentId:intent})})};}
it('keeps the dispatched provider snapshot even if configuration changes during HTTP',async()=>{
 const lease=await work();const r=await request(lease);const rpc=new FixtureRpc('local');
 const handler=gatewayHandler({db:gateway,token,profiles,rpc:{read:async(...args)=>{await db.query("update pitlane.provider_profiles set upstream_id='new-upstream',genesis='new-genesis',enabled=false where id='fixture-a'");return rpc.read(args[0],args[1],args[2]);}}});
 expect((await handler(r.request)).status).toBe(200);
 const row=(await db.query('select * from pitlane.gateway_observations where intent_id=$1',[r.intent])).rows[0];expect(row.upstream_id).toBe('controlled-a');expect(row.profile_snapshot).toMatchObject({genesis:GENESIS.devnet,maximumMicro:'100'});
});
it('rejects trusted gateway configuration drift before any upstream call',async()=>{
 const lease=await work();const r=await request(lease);let calls=0;const handler=gatewayHandler({db:gateway,token,profiles:profiles.map(p=>({...p,upstreamId:'wrong-'+p.id})),rpc:{read:async()=>{calls++;return {result:GENESIS.devnet,rawBody:JSON.stringify({result:GENESIS.devnet})};}}});
 expect((await handler(r.request)).status).toBe(422);expect(calls).toBe(0);expect((await db.query('select count(*)::int as n from pitlane.gateway_observations')).rows[0].n).toBe(0);
});
it('shares a circuit across replicas and counts an outcome only once',async()=>{
 const lease=await work();let calls=0;const make=()=>gatewayHandler({db:gateway,token,profiles,rpc:{read:async()=>{calls++;throw new RpcFailure('RPC_HTTP_503',true,0,'transient');}}});const first=make(),second=make();let last='';
 for(let i=0;i<3;i++){const r=await request(lease);last=r.intent;expect((await (i%2?second:first)(r.request)).status).toBe(503);}
 expect(calls).toBe(3);const blocked=await request(lease);expect((await second(blocked.request)).status).toBe(503);expect(calls).toBe(3);
 await gateway.query('select pitlane.gateway_failure($1,$2,$3,$4,$5,$6)',[lease.jobId,lease.workerId,lease.epoch,last,'transient',0]);
 expect((await db.query("select failures from pitlane.provider_health where provider_id='fixture-a'")).rows[0].failures).toBe(3);
 await db.query("update pitlane.provider_health set open_until=clock_timestamp()-interval '1 second' where provider_id='fixture-a'");
 const recovered=gatewayHandler({db:gateway,token,profiles,rpc:new FixtureRpc('local')});const r=await request(lease);expect((await recovered(r.request)).status).toBe(200);expect((await db.query("select failures from pitlane.provider_health where provider_id='fixture-a'")).rows[0].failures).toBe(0);
});
it('checks hosted coverage at quote and admission without reserving any quota',async()=>{
 const q=await new Quotes(web).quote({tenantId:T,userId:U},{...input,projectId:P});await db.query("update pitlane.runtime set mode='staging'");await db.query("update pitlane.provider_profiles set enabled=false where id='fixture-b'");
 await expect(new Quotes(web).quote({tenantId:T,userId:U},{...input,projectId:P})).rejects.toThrow('PROVIDER_COVERAGE_UNAVAILABLE');await expect(new Quotes(web).submit({tenantId:T,userId:U},q.id,randomUUID())).rejects.toThrow('PROVIDER_COVERAGE_UNAVAILABLE');
 expect((await db.query('select reserved,consumed from pitlane.entitlement_lots where tenant_id=$1',[T])).rows[0]).toMatchObject({reserved:0,consumed:0});
});
it('retries only transient reads with a fresh persisted priced intent',async()=>{
 const {SolanaRpc}=await import('../../packages/adapters/src/solana-rpc');const {Inspector}=await import('../../apps/worker/src/runner');const {Artifacts,LocalStorage}=await import('../../packages/core/src/artifacts');
 const lease=await work();const fixture=new FixtureRpc('local');let calls=0;
 const rpc=new SolanaRpc(profiles.map(p=>({...p,endpoint:'https://controlled.invalid/'+p.id})),async(url,options)=>{calls++;if(calls===1)return new Response('{}',{status:503,headers:{'retry-after':'0'}});const body=JSON.parse(String(options?.body));return new Response((await fixture.read(String(url).endsWith('fixture-a')?'fixture-a':'fixture-b',body.method,body.params)).rawBody);});
 const inspector=new Inspector(new Jobs(worker),new Artifacts(worker,new LocalStorage('.data/provider-retry-artifacts')),rpc,profiles);
 expect((await inspector.collect({...input,projectId:P},lease,AbortSignal.timeout(15000))).length).toBe(2);expect(calls).toBe(7);expect((await db.query('select calls,cost_used from pitlane.jobs where id=$1',[lease.jobId])).rows[0]).toMatchObject({calls:7,cost_used:'700'});
});
it('does not retry authentication failures or exceed the persisted remaining cost budget',async()=>{
 const {SolanaRpc}=await import('../../packages/adapters/src/solana-rpc');const {Inspector}=await import('../../apps/worker/src/runner');const {Artifacts,LocalStorage}=await import('../../packages/core/src/artifacts');
 const lease=await work();let calls=0;const make=(status:number)=>new Inspector(new Jobs(worker),new Artifacts(worker,new LocalStorage('.data/provider-retry-artifacts')),new SolanaRpc(profiles.map(p=>({...p,endpoint:'https://controlled.invalid/'+p.id})),async()=>{calls++;return new Response('{}',{status});}),profiles);
 await expect(make(401).collect({...input,projectId:P},lease,AbortSignal.timeout(15000))).rejects.toThrow('RPC_HTTP_401');expect(calls).toBe(1);
 await db.query('update pitlane.jobs set cost_cap=250 where id=$1',[lease.jobId]);calls=0;
 await expect(make(503).collect({...input,projectId:P},lease,AbortSignal.timeout(15000))).rejects.toThrow('COST_BUDGET_EXHAUSTED');expect(calls).toBe(1);
});

it('opens a shared authentication circuit without retrying credentials and respects rate-limit delay',async()=>{
 const lease=await work();let calls=0;const auth=gatewayHandler({db:gateway,token,profiles,rpc:{read:async()=>{calls++;throw new RpcFailure('RPC_HTTP_401',false,0,'auth');}}});
 expect((await auth((await request(lease)).request)).status).toBe(422);expect((await auth((await request(lease)).request)).status).toBe(422);expect(calls).toBe(1);expect((await db.query("select blocked from pitlane.provider_health where provider_id='fixture-a'")).rows[0].blocked).toBe(true);
 await db.query('truncate pitlane.provider_health');
 const rate=gatewayHandler({db:gateway,token,profiles,rpc:{read:async()=>{calls++;throw new RpcFailure('RPC_RATE_LIMIT',true,2000,'rate_limit');}}});
 const busy=await rate((await request(lease)).request);expect(busy.status).toBe(503);expect(busy.headers.get('x-pitlane-retry-after-ms')).toBe('2000');expect((await rate((await request(lease)).request)).status).toBe(503);expect(calls).toBe(2);
});
it('does not clear newer failures when an older successful request finishes late',async()=>{
 const lease=await work();const slow=await request(lease);let release:()=>void=()=>{};const ready=new Promise<void>(r=>release=r);let begin:()=>void=()=>{};const begun=new Promise<void>(r=>begin=r);
 const success=gatewayHandler({db:gateway,token,profiles,rpc:{read:async(...args)=>{begin();await ready;return new FixtureRpc('local').read(args[0],args[1],args[2]);}}});
 const running=success(slow.request);await begun;
 const fail=gatewayHandler({db:gateway,token,profiles,rpc:{read:async()=>{throw new RpcFailure('RPC_HTTP_503',true,0,'transient');}}});
 for(let i=0;i<3;i++)expect((await fail((await request(lease)).request)).status).toBe(503);
 release();expect((await running).status).toBe(200);expect((await db.query("select failures from pitlane.provider_health where provider_id='fixture-a'")).rows[0].failures).toBe(3);
});
it('does not shorten a provider Retry-After that exceeds the remaining deadline',async()=>{
 const {SolanaRpc}=await import('../../packages/adapters/src/solana-rpc');const {Inspector}=await import('../../apps/worker/src/runner');const {Artifacts,LocalStorage}=await import('../../packages/core/src/artifacts');
 const lease=await work();let calls=0;const rpc=new SolanaRpc(profiles.map(p=>({...p,endpoint:'https://controlled.invalid/'+p.id})),async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'6000'}});});
 const inspector=new Inspector(new Jobs(worker),new Artifacts(worker,new LocalStorage('.data/provider-retry-artifacts')),rpc,profiles);
 await expect(inspector.collect({...input,projectId:P},lease,AbortSignal.timeout(15000),Date.now()+10000)).rejects.toThrow('RPC_RATE_LIMIT');expect(calls).toBe(1);
});
