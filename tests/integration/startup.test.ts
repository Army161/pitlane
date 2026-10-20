import {beforeAll,afterAll,beforeEach,it,expect} from 'vitest';
import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {database,seed,T,P,U} from './support';
import {PostgresDb} from '../../packages/adapters/src/postgres';
import {loadConfig} from '../../packages/core/src/config';
import {GENESIS} from '../../packages/contracts/src';
import {Quotes} from '../../packages/core/src/quotes';
import {Jobs} from '../../packages/core/src/jobs';
import {WorkerService} from '../../apps/worker/src/service';
import {FixtureRpc} from '../../apps/worker/src/runner';
import {input} from '../fixtures/observations';
const startup=await import('../../packages/core/src/startup').catch(()=>({})) as any;
let db:pg.Pool,worker:PostgresDb,web:PostgresDb,restricted:PostgresDb,broad:PostgresDb;
const local=loadConfig({PITLANE_MODE:'local'}),staging=loadConfig({PITLANE_MODE:'staging',PITLANE_ENVIRONMENT_ID:'startup-fixture',PITLANE_EXPECTED_PROJECT_ID:'startup-project'});
const id=randomUUID().replaceAll('-',''),profiles=['devnet','mainnet-beta'].flatMap(network=>['a','b'].map(p=>({id:p+'-'+network,upstreamId:p+'-independent',network:network as 'devnet'|'mainnet-beta',genesis:GENESIS[network as keyof typeof GENESIS],maximumMicro:'0'})));
beforeAll(async()=>{db=await database();const url=process.env.PITLANE_TEST_DATABASE_URL!;web=new PostgresDb(url);worker=new PostgresDb(url,'pitlane_worker');
 for(const suffix of ['restricted','broad']){const name='startup_'+suffix+'_'+id;await db.query(`create role "${name}" login nosuperuser nobypassrls password 'startup-test-only'`);await db.query(`grant pitlane_worker to "${name}"`);if(suffix==='broad')await db.query(`grant pitlane_gateway to "${name}"`);const u=new URL(url);u.username=name;u.password='startup-test-only';if(suffix==='restricted')restricted=new PostgresDb(u.toString(),'pitlane_worker');else broad=new PostgresDb(u.toString(),'pitlane_worker');}
});
beforeEach(async()=>seed(db));afterAll(async()=>{await Promise.all([web.close(),worker.close(),restricted.close(),broad.close()]);await db.end();});
it('checks runtime identity before publishing a heartbeat or accepting work',async()=>{
 const service=new WorkerService({db:worker,id:'foreign-startup',mode:'local',build:'fixture-build',config:{...local,environmentId:'foreign-fixture'}});
 await expect(service.heartbeat()).rejects.toThrow('FOREIGN_ENVIRONMENT');expect((await db.query('select count(*)::int as n from pitlane.workers')).rows[0].n).toBe(0);
});
it('withdraws worker readiness when a later heartbeat finds a changed environment',async()=>{
 const service=new WorkerService({db:worker,id:'changed-startup',mode:'local',build:'fixture-build',config:local});await service.heartbeat();expect(service.status.ready).toBe(true);
 await db.query("update pitlane.runtime set environment_id='foreign-fixture'");await expect(service.heartbeat()).rejects.toThrow('FOREIGN_ENVIRONMENT');expect(service.status.ready).toBe(false);
});
it('accepts a narrow hosted role but rejects privileged or mixed-capability database identities',async()=>{
 await db.query("update pitlane.runtime set mode='staging',environment_id='startup-fixture',auth_project_id='startup-project'");
 await expect(startup.validateStartup(restricted,staging,'pitlane_worker','a'.repeat(40))).resolves.toBeUndefined();
 await expect(startup.validateStartup(worker,staging,'pitlane_worker','a'.repeat(40))).rejects.toThrow('PRIVILEGED_DATABASE_IDENTITY');
 await expect(startup.validateStartup(broad,staging,'pitlane_worker','a'.repeat(40))).rejects.toThrow('MIXED_DATABASE_CAPABILITIES');
});
it('requires a hosted build and compatible schema rather than marking stale services ready',async()=>{
 await expect(startup.validateStartup(worker,local,'pitlane_worker','fixture-build')).resolves.toBeUndefined();
 const stale={query:async()=>({rows:[{value:{mode:'local',environment_id:'local-fixture',billing_mode:'disabled',contract:'1',schema_version:'000'}}],rowCount:1})};
 await expect(startup.validateStartup(stale,local,'pitlane_worker','fixture-build')).rejects.toThrow('INCOMPATIBLE_RUNTIME');
 await expect(startup.validateStartup(restricted,staging,'pitlane_worker','local-development')).rejects.toThrow('HOSTED_BUILD_REQUIRED');
});
it('uses the independently configured pair for the actual job network',async()=>{
 const q=await new Quotes(web).quote({tenantId:T,userId:U},{...input,projectId:P,network:'mainnet-beta'});const j=await new Quotes(web).submit({tenantId:T,userId:U},q.id,'startup-network-job-key');const calls:string[]=[];
 const service=new WorkerService({db:worker,id:'network-worker',mode:'local',build:'fixture-build',providers:profiles,storageRoot:'.data/startup-artifacts',rpcFactory:()=>({read:async(provider,method,params)=>{calls.push(provider);return new FixtureRpc('local','mainnet-beta').read('fixture-a',method,params);}})});
 await service.tick();await service.drain();expect([...new Set(calls)].sort()).toEqual(['a-mainnet-beta','b-mainnet-beta']);expect((await db.query('select state from pitlane.jobs where id=$1',[j.id])).rows[0].state).toBe('completed');
 expect((await db.query('select payload from pitlane.receipt_versions where job_id=$1',[j.id])).rows[0].payload.evidenceManifest).toMatchObject({build:'fixture-build',execution:{workerId:'network-worker',verifierId:'network-worker',leaseEpoch:'1'}});
});
it('does not claim an incompatible template or a network excluded by registered worker capabilities',async()=>{
 const q=await new Quotes(web).quote({tenantId:T,userId:U},{...input,projectId:P,network:'mainnet-beta'});const j=await new Quotes(web).submit({tenantId:T,userId:U},q.id,'startup-unsupported-job-key');
 await worker.query('select pitlane.worker_heartbeat($1,$2,$3,$4)',['limited-worker','fixture-build',0,{contract:'1',networks:['devnet'],corrections:false}]);
 expect(await new Jobs(worker).claim('limited-worker')).toBeNull();
 await db.query("update pitlane.jobs set input=jsonb_set(input,'{templateVersion}','\"2\"') where id=$1",[j.id]);expect(await new Jobs(worker).claim('new-worker')).toBeNull();
});
it('fails closed on absent hosted capabilities and never claims fixture-origin jobs in a hosted runtime',async()=>{
 const q=await new Quotes(web).quote({tenantId:T,userId:U},{...input,projectId:P});const j=await new Quotes(web).submit({tenantId:T,userId:U},q.id,'startup-hosted-capability-key');
 await db.query("update pitlane.runtime set mode='staging',environment_id='startup-fixture',auth_project_id='startup-project'");
 await db.query("insert into pitlane.workers(id,build,active,capabilities) values('missing-contract',$1,0,$2)",['a'.repeat(40),{networks:['devnet'],draining:false,origin:'internal'}]);
 expect(await new Jobs(worker).claim('missing-contract')).toBeNull();
 await worker.query('select pitlane.worker_heartbeat($1,$2,$3,$4)',['proper-hosted','a'.repeat(40),0,{contract:'1',networks:['devnet'],corrections:true,draining:false,origin:'internal'}]);
 expect(await new Jobs(worker).claim('proper-hosted')).toBeNull();await db.query("update pitlane.jobs set origin='internal' where id=$1",[j.id]);
 expect(await new Jobs(worker).claim('proper-hosted')).toMatchObject({jobId:j.id});
});
it('checks exact provider snapshots for both advertised networks',async()=>{
 for(const p of profiles)await db.query('insert into pitlane.provider_profiles(id,upstream_id,network,genesis,maximum_micro,calls_per_minute,enabled) values($1,$2,$3,$4,$5,100,true) on conflict(id) do update set upstream_id=excluded.upstream_id,network=excluded.network,genesis=excluded.genesis,maximum_micro=excluded.maximum_micro,enabled=true',[p.id,p.upstreamId,p.network,p.genesis,p.maximumMicro]);
 await expect(startup.verifyProviderRegistry(worker,profiles)).resolves.toBeUndefined();
 await expect(startup.verifyProviderRegistry(worker,profiles.map(p=>p.id==='a-mainnet-beta'?{...p,maximumMicro:'1'}:p))).rejects.toThrow('GATEWAY_PROFILE_MISMATCH');
});

