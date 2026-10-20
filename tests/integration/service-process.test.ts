import {beforeAll,afterAll,beforeEach,it,expect} from 'vitest';
import type pg from 'pg';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {buildServices} from '../../scripts/build-services';
import {database,seed,T,P,U} from './support';
import {PostgresDb} from '../../packages/adapters/src/postgres';
import {Quotes} from '../../packages/core/src/quotes';
import {input} from '../fixtures/observations';
import {gatewayProfiles} from '../../packages/adapters/src/provider-config';
let db:pg.Pool,web:PostgresDb;const children=new Set<ChildProcess>();
const compiledBuild='a'.repeat(40);
beforeAll(async()=>{await buildServices({PITLANE_BUILD_SHA:compiledBuild});db=await database();web=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!);});
beforeEach(async()=>seed(db));
afterAll(async()=>{for(const child of children)if(child.exitCode===null){child.kill();await once(child,'exit').catch(()=>{});}await web.close();await db.end();});
async function until(test:()=>Promise<boolean>,milliseconds=15000){const end=Date.now()+milliseconds;while(Date.now()<end){if(await test())return;await new Promise(r=>setTimeout(r,50));}throw new Error('FIXTURE_PROCESS_CONDITION_TIMEOUT');}
async function localService(name:'worker'|'gateway'|'artifact'|'maintenance',extra:Record<string,string>={}){
 const token=randomUUID();const child=spawn(process.execPath,[`.dist/${name}.mjs`],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,PITLANE_MODE:'local',PITLANE_ENVIRONMENT_ID:'local-fixture',PITLANE_AUTH_MODE:'fixture',PITLANE_STORAGE_MODE:'local',PITLANE_RPC_MODE:'fixture',PITLANE_BILLING_MODE:'disabled',PITLANE_BUILD_SHA:'packaged-fixture-build',[`PITLANE_${name.toUpperCase()}_DATABASE_URL`]:process.env.PITLANE_TEST_DATABASE_URL,PITLANE_LOCAL_STORAGE_DIR:'.data/packaged-worker-artifacts',PITLANE_GATEWAY_TOKEN:'g'.repeat(32),PITLANE_ARTIFACT_API_TOKEN:'a'.repeat(32),PITLANE_TEST_CONTROL_TOKEN:token,PORT:'0',...extra}});
 children.add(child);let output='';child.stdout!.on('data',bytes=>output+=bytes);let errors='';child.stderr!.on('data',bytes=>errors+=bytes);
 await until(async()=>{if(child.exitCode!==null)throw new Error(`Packaged ${name} exited: `+errors);return output.includes('"event":"listening"');});
 const line=output.split('\n').find(line=>line.includes('"event":"listening"'))!;const port=JSON.parse(line).port;
 expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
 return {child,port,drain:async()=>{const exit=once(child,'exit');child.send({type:'drain',token});await exit;expect(child.exitCode).toBe(0);children.delete(child);}};
}
async function worker(delay=0){return localService('worker',{PITLANE_FIXTURE_READ_DELAY_MS:String(delay)});}
async function job(key:string){const q=await new Quotes(web).quote({tenantId:T,userId:U},{...input,projectId:P});return new Quotes(web).submit({tenantId:T,userId:U},q.id,key);}
it('runs packaged Node services without a TypeScript loader or development-only imports',async()=>{
 const manifest=JSON.parse(await readFile('.dist/build-manifest.json','utf8'));expect(manifest.build).toBe(compiledBuild);const pkg=JSON.parse(await readFile('package.json','utf8'));const allowed=new Set(Object.keys(pkg.dependencies));
 for(const output of Object.values(manifest.outputs) as any[])for(const dependency of output.imports)if(dependency.external&&!dependency.path.startsWith('node:'))expect(allowed.has(dependency.path.split('/').slice(0,dependency.path.startsWith('@')?2:1).join('/'))).toBe(true);
 const process=await worker();await process.drain();
});
it('starts and drains the packaged gateway, artifact and maintenance services',async()=>{
 for(const p of gatewayProfiles(undefined,'local'))await db.query('insert into pitlane.provider_profiles(id,upstream_id,network,genesis,maximum_micro,calls_per_minute,enabled) values($1,$2,$3,$4,$5,100,true) on conflict(id) do update set upstream_id=excluded.upstream_id,network=excluded.network,genesis=excluded.genesis,maximum_micro=excluded.maximum_micro,enabled=true',[p.id,p.upstreamId,p.network,p.genesis,p.maximumMicro]);
 for(const name of ['gateway','artifact','maintenance'] as const){const service=await localService(name);try{const health=await (await fetch(`http://127.0.0.1:${service.port}/health`)).json();expect(health).toMatchObject({service:name,ready:true,mode:'local',build:'packaged-fixture-build'});const path=name==='gateway'?'/rpc':name==='artifact'?'/internal/artifacts':'/private/control';expect((await fetch(`http://127.0.0.1:${service.port}${path}`,{method:'POST'})).status).toBe(name==='maintenance'?404:401);}finally{await service.drain();}}
});
it('rejects an actual hosted process with a build different from its packaged identity',async()=>{
 const child=spawn(process.execPath,['.dist/worker.mjs'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PITLANE_MODE:'staging',PITLANE_ENVIRONMENT_ID:'startup-fixture',PITLANE_EXPECTED_PROJECT_ID:'startup-project',PITLANE_AUTH_MODE:'supabase',PITLANE_STORAGE_MODE:'supabase',PITLANE_RPC_MODE:'gateway',PITLANE_BILLING_MODE:'disabled',PITLANE_BUILD_SHA:'b'.repeat(40),PORT:'0'}});children.add(child);let output='',errors='';child.stdout!.on('data',bytes=>output+=bytes);child.stderr!.on('data',bytes=>errors+=bytes);await once(child,'exit');children.delete(child);expect(child.exitCode).toBe(1);expect(output).not.toContain('listening');expect(errors.trim()).toBe('PITLANE worker startup failed.');
});
it('recovers a killed owned worker from durable state without duplicating delivery or quota settlement',async()=>{
 const j=await job('packaged-worker-kill-key');const first=await worker(1000);await until(async()=>(await db.query('select calls from pitlane.jobs where id=$1',[j.id])).rows[0].calls>=1);
 const exited=once(first.child,'exit');first.child.kill('SIGKILL');await exited;children.delete(first.child);
 await db.query("update pitlane.jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[j.id]);const second=await worker();
 await until(async()=>(await db.query('select state from pitlane.jobs where id=$1',[j.id])).rows[0].state==='completed');await second.drain();
 expect((await db.query('select attempts,lease_epoch from pitlane.jobs where id=$1',[j.id])).rows[0]).toMatchObject({attempts:2,lease_epoch:'2'});expect((await db.query('select count(*)::int as n from pitlane.receipt_versions where job_id=$1',[j.id])).rows[0].n).toBe(1);expect((await db.query('select consumed,reserved from pitlane.entitlement_lots where tenant_id=$1',[T])).rows[0]).toMatchObject({consumed:1,reserved:0});
 const saved=(await db.query('select payload from pitlane.receipt_versions where job_id=$1',[j.id])).rows[0].payload.evidenceManifest;const registered=(await db.query('select build from pitlane.workers where id=$1',[saved.execution.workerId])).rows[0];expect(saved).toMatchObject({build:'packaged-fixture-build',execution:{leaseEpoch:'2',verification:'same_trusted_deployment'}});expect(registered.build).toBe(saved.build);
});
it('drains already accepted work through a private local parent channel before closing the database',async()=>{
 const j=await job('packaged-worker-drain-key');const process=await worker(100);await until(async()=>(await db.query('select calls from pitlane.jobs where id=$1',[j.id])).rows[0].calls>=1);await process.drain();
 expect((await db.query('select state from pitlane.jobs where id=$1',[j.id])).rows[0].state).toBe('completed');expect((await db.query("select capabilities->>'draining' as draining from pitlane.workers")).rows[0].draining).toBe('true');
});
