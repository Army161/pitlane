import {beforeAll,afterAll,beforeEach,it,expect} from 'vitest';
import type pg from 'pg';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {database,seed,T,P,U} from './support';
import {input} from '../fixtures/observations';
import {GENESIS} from '../../packages/contracts/src';
import {PostgresDb} from '../../packages/adapters/src/postgres';
import {Quotes} from '../../packages/core/src/quotes';
import {Jobs} from '../../packages/core/src/jobs';
import {Artifacts,LocalStorage} from '../../packages/core/src/artifacts';
import {Inspector,FixtureRpc} from '../../apps/worker/src/runner';
import {gatewayHandler} from '../../apps/gateway/src/server';
import {GatewayRpc,RpcFailure} from '../../packages/adapters/src/solana-rpc';
import {artifactApiHandler,ArtifactApiStorage} from '../../packages/adapters/src/artifact-api';
import {serveHttp} from '../../packages/adapters/src/http-server';
import {buildReceipt} from '../../packages/evidence/src/receipt';
import {evaluateExpectations} from '../../packages/evidence/src/expectations';
import {corroborate} from '../../packages/evidence/src/projections';
import {rawDigest,canonical} from '../../packages/evidence/src/canonical';
import {makeEvidenceManifest} from '../../packages/evidence/src/manifest';
let db:pg.Pool,web:PostgresDb,worker:PostgresDb,gateway:PostgresDb,artifact:PostgresDb;
const token='boundary-test-capability-with-at-least-32-bytes';
const workerBuild='a'.repeat(40);
const providers=[{id:'fixture-a',upstreamId:'controlled-upstream-a',maximumMicro:'100',network:'devnet' as const,genesis:GENESIS.devnet},{id:'fixture-b',upstreamId:'controlled-upstream-b',maximumMicro:'100',network:'devnet' as const,genesis:GENESIS.devnet}];
beforeAll(async()=>{db=await database();const url=process.env.PITLANE_TEST_DATABASE_URL!;web=new PostgresDb(url);worker=new PostgresDb(url,'pitlane_worker');gateway=new PostgresDb(url,'pitlane_gateway');artifact=new PostgresDb(url,'pitlane_artifact');});
beforeEach(async()=>{await seed(db);await db.query('truncate pitlane.provider_profiles cascade');for(const p of providers)await db.query('insert into pitlane.provider_profiles values($1,$2,$3,$4,100,60,true)',[p.id,p.upstreamId,'devnet',GENESIS.devnet]);});
afterAll(async()=>{await Promise.all([web.close(),worker.close(),gateway.close(),artifact.close()]);await db.end();});
async function work(){const q=await new Quotes(web).quote({tenantId:T,userId:U},{...input,projectId:P});const j=await new Quotes(web).submit({tenantId:T,userId:U},q.id,randomUUID());await worker.query('select pitlane.worker_heartbeat($1,$2,$3,$4)',['boundary-worker',workerBuild,0,{contract:'1',networks:['devnet'],corrections:true,draining:false,origin:'internal'}]);return {j,lease:(await new Jobs(worker).claim('boundary-worker'))!};}
const request=(lease:any,intentId:string,method:string,params:unknown[])=>new Request('http://127.0.0.1/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify({providerId:'fixture-a',method,params,lease:{jobId:lease.jobId,workerId:lease.workerId,epoch:lease.epoch},intentId})});
it('the gateway refuses an account outside the leased subject before upstream dispatch',async()=>{
 const {lease}=await work();const intent=await new Jobs(worker).costIntent(lease,'fixture-a','getAccountInfo','100');let calls=0;
 const handler=gatewayHandler({db:gateway,token,profiles:providers,rpc:{read:async()=>{calls++;return {result:null,rawBody:'{"result":null}'};}}});
 const result=await handler(request(lease,intent,'getAccountInfo',['11111111111111111111111111111111',{commitment:'finalized',encoding:'base64',minContextSlot:0}]));
 expect(result.status).toBe(422);expect(calls).toBe(0);
});
it('the gateway independently records exact source hashes and acquisition time',async()=>{
 const {lease}=await work();const intent=await new Jobs(worker).costIntent(lease,'fixture-a','getGenesisHash','100');const handler=gatewayHandler({db:gateway,token,profiles:providers,rpc:new FixtureRpc('local')});
 const result=await handler(request(lease,intent,'getGenesisHash',[]));expect(result.status).toBe(200);expect(result.headers.get('x-pitlane-observed-at')).toBeTruthy();const raw=await result.text();
 const row=(await db.query('select * from pitlane.gateway_observations where intent_id=$1',[intent])).rows[0];expect(row.raw_hash).toBe(rawDigest(raw));expect(row.raw_body).toBe(raw);expect(row.upstream_id).toBe(providers[0].upstreamId);
});
it('hosted workers cannot self-attest a fabricated or unverified artifact',async()=>{
 const {j,lease}=await work();await db.query("update pitlane.runtime set mode='staging'");
 await expect(worker.query('select pitlane.register_artifact($1,$2,$3,$4)',[j.id,lease.workerId,lease.epoch,{id:randomUUID(),key:`${T}/${P}/${j.id}/${lease.epoch}/unverified.json`,sha256:'a'.repeat(64),bytes:100,contentType:'application/json'}])).rejects.toThrow('ARTIFACT_ATTESTATION_REQUIRED');
});
it('independent gateway and artifact services accept recorded sources but reject invented payload changes',async()=>{
 const {j,lease}=await work();await db.query("update pitlane.runtime set mode='staging'");await db.query("update pitlane.jobs set origin='internal' where id=$1",[j.id]);
 const gatewayErrors:string[]=[];const tracedGateway={query:async<T>(sql:string,values?:unknown[])=>{try{return await gateway.query<T>(sql,values);}catch(e){gatewayErrors.push((e as Error).message);throw e;}}};
 const rpcServer=serveHttp(gatewayHandler({db:tracedGateway,token,profiles:providers,rpc:new FixtureRpc('local')}),0);const storage=new LocalStorage('.data/boundary-artifacts');const artifactServer=serveHttp(artifactApiHandler({db:artifact,token,storage}),0);
 await Promise.all([once(rpcServer,'listening'),once(artifactServer,'listening')]);
 try{
  class LostReplyRpc extends GatewayRpc{lost=false;override async read(...args:Parameters<GatewayRpc['read']>){const reply=await super.read(...args);if(args[1]==='getAccountInfo'&&!this.lost){this.lost=true;throw new RpcFailure('GATEWAY_TRANSPORT_ERROR',true,0,'transient');}return reply;}}
  const rpc=new LostReplyRpc(`http://127.0.0.1:${(rpcServer.address() as any).port}`,token,lease);const remote=new ArtifactApiStorage(`http://127.0.0.1:${(artifactServer.address() as any).port}`,token,lease);const artifacts=new Artifacts(worker,remote);const jobs=new Jobs(worker);const inspector=new Inspector(jobs,artifacts,rpc,providers,{build:workerBuild});
  const observations=await inspector.collect(j.input,lease,AbortSignal.timeout(15000)).catch(e=>{throw new Error(gatewayErrors.join('; ')||e.message);});const projection=corroborate(observations,j.input);if(!projection.ok)throw new Error(projection.message);const r=buildReceipt(j.input,observations,evaluateExpectations(projection.value,j.input),{jobId:j.id,origin:'internal'});
  const invented=observations.map(o=>({...o,upstreamId:'invented-'+o.providerId}));const fakeProjection=corroborate(invented,j.input);if(!fakeProjection.ok)throw new Error(fakeProjection.message);const fake=buildReceipt(j.input,invented,evaluateExpectations(fakeProjection.value,j.input),{jobId:j.id,origin:'internal'});const rejectedKey=`${T}/${P}/${j.id}/${lease.epoch}/${randomUUID()}.json`;
  r.evidenceManifest=makeEvidenceManifest(await jobs.manifestContext(lease),workerBuild);fake.evidenceManifest=r.evidenceManifest;
  await expect(remote.put(rejectedKey,Buffer.from(canonical(fake)),'application/json')).rejects.toThrow('ARTIFACT_API_REJECTED');await expect(storage.get(rejectedKey)).rejects.toThrow();expect((await db.query('select count(*)::int as n from pitlane.artifact_attestations')).rows[0].n).toBe(0);
  const manifest=await artifacts.publish(lease,r);await remote.put(manifest.key,Buffer.from(canonical(r)),'application/json');
  const excessKey=`${T}/${P}/${j.id}/${lease.epoch}/${randomUUID()}.json`;await expect(remote.put(excessKey,Buffer.from(canonical(r)),'application/json')).rejects.toThrow('ARTIFACT_API_REJECTED');await expect(storage.get(excessKey)).rejects.toThrow();
  await expect(jobs.finalize(lease,{...r,limitations:[...r.limitations,'Invented post-upload payload']},manifest)).rejects.toThrow('ARTIFACT_PAYLOAD_MISMATCH');
  const finished=await jobs.finalize(lease,r,manifest);expect(finished.state).toBe('completed');expect((await db.query('select count(*)::int as n from pitlane.gateway_observations where job_id=$1',[j.id])).rows[0].n).toBe(7);expect((await db.query('select consumed,reserved from pitlane.entitlement_lots where tenant_id=$1',[T])).rows[0]).toMatchObject({consumed:1,reserved:0});
 }finally{await Promise.all([new Promise<void>(r=>rpcServer.close(()=>r())),new Promise<void>(r=>artifactServer.close(()=>r()))]);}
});
