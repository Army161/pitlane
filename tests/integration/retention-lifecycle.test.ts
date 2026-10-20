import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {database,seed,T,P,U,T2,U2} from './support';
import {PostgresDb} from '../../packages/adapters/src/postgres';
import {Retention} from '../../packages/core/src/retention';
import {History} from '../../packages/core/src/history';
import {Quotes} from '../../packages/core/src/quotes';
import {Jobs} from '../../packages/core/src/jobs';
import {Artifacts,LocalStorage} from '../../packages/core/src/artifacts';
import {FixtureRpc,Inspector} from '../../apps/worker/src/runner';
import {rawDigest} from '../../packages/evidence/src/canonical';
import {input} from '../fixtures/observations';
import type {Db} from '../../packages/contracts/src';
import {Collaboration} from '../../packages/core/src/collaboration';
import {Team} from '../../packages/core/src/team';

let db:pg.Pool,web:PostgresDb,worker:PostgresDb,maintenance:PostgresDb;
const actor={tenantId:T,userId:U};
const storage=new LocalStorage(`.data/retention-lifecycle-${process.pid}-${Date.now()}`);
const providers=[{id:'fixture-a',upstreamId:'a',maximumMicro:'100'},{id:'fixture-b',upstreamId:'b',maximumMicro:'100'}];
beforeAll(async()=>{db=await database();web=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!);worker=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!,'pitlane_worker');maintenance=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!,'pitlane_maintenance')});
beforeEach(async()=>seed(db));
afterAll(async()=>{await Promise.all([db.end(),web.close(),worker.close(),maintenance.close()])});
const retention=()=>new Retention(web) as any;
const cleanup=()=>new Retention(maintenance,storage);
async function delivered(contradicted=false){
 const accepted={...input,projectId:P,...(contradicted?{templateId:'solana.integration_expectations' as const,expectations:[{id:'precision',path:'decimals',op:'eq' as const,value:8}]}:{})};
 const q=await new Quotes(web).quote(actor,accepted);const job=await new Quotes(web).submit(actor,q.id,randomUUID());
 const jobs=new Jobs(worker);await new Inspector(jobs,new Artifacts(worker,storage),new FixtureRpc('local'),providers).inspect((await jobs.claim('retention-lifecycle'))!);
 return (await db.query('select v.*,a.object_key from pitlane.receipt_versions v join pitlane.artifacts a on a.id=v.artifact_id where v.job_id=$1',[job.id])).rows[0];
}
async function privateCopies(v:any,key=v.object_key,age='0 seconds'){
 const bytes=await storage.get(v.object_key);
 if(key!==v.object_key)await storage.put(key,bytes,'application/json');
 await db.query(`insert into pitlane.artifact_attestations(object_key,job_id,lease_epoch,digest,bytes,payload,created_at,verified_at) values($1,$2,1,$3,$4,$5,now()-$6::interval,now()) on conflict(object_key) do update set created_at=excluded.created_at,verified_at=excluded.verified_at`,[key,v.job_id,rawDigest(bytes),bytes.length,v.payload,age]);
 const intent=randomUUID();await db.query("insert into pitlane.cost_intents(id,tenant_id,project_id,job_id,lease_epoch,provider_id,method,maximum_micro,dispatch_params) values($1,$2,$3,$4,1,'fixture-a','getAccountInfo',0,$5)",[intent,T,P,v.job_id,JSON.stringify([input.mint])]);
 await db.query("insert into pitlane.gateway_observations(intent_id,job_id,lease_epoch,provider_id,upstream_id,network,method,params,raw_body,raw_hash) values($1,$2,1,'fixture-a','a','devnet','getAccountInfo',$3,$4,$5)",[intent,v.job_id,JSON.stringify([input.mint]),JSON.stringify({private:input.mint}),rawDigest(Buffer.from(JSON.stringify({private:input.mint})))]);
}

it('cleans only old unregistered reservation keys and retries object removal durably',async()=>{
 const v=await delivered();const old=`${T}/${P}/${v.job_id}/1/independent-orphan.json`;const fresh=`${T}/${P}/${v.job_id}/1/fresh-orphan.json`;
 await privateCopies(v,old,'25 hours');await privateCopies(v,fresh,'23 hours');
 const broken={...storage,put:storage.put.bind(storage),get:storage.get.bind(storage),remove:async()=>{throw new Error('offline')}};
 expect(await new Retention(maintenance,broken).run()).toBe(0);
 expect((await db.query('select count(*)::int n from pitlane.orphan_object_purge')).rows[0].n).toBe(1);
 await db.query('update pitlane.orphan_object_purge set available_at=now()');expect(await cleanup().run()).toBe(1);
 await expect(storage.get(old)).rejects.toThrow();expect(await storage.get(fresh)).toBeTruthy();expect(await storage.get(v.object_key)).toBeTruthy();
 expect((await db.query('select count(*)::int n from pitlane.artifact_attestations where object_key=$1',[old])).rows[0].n).toBe(0);
 expect(await cleanup().run()).toBe(0);
});

it('records the exact local upload key before registration fails and recovers its orphan after 24 hours',async()=>{
 const q=await new Quotes(web).quote(actor,{...input,projectId:P});await new Quotes(web).submit(actor,q.id,randomUUID());
 const failing:Db={transaction:worker.transaction.bind(worker),query:async<T>(sql:string,values?:unknown[])=>{if(sql.startsWith('select pitlane.register_artifact'))throw new Error('DATABASE_UNAVAILABLE');return worker.query<T>(sql,values)}};
 const jobs=new Jobs(worker);await expect(new Inspector(jobs,new Artifacts(failing,storage),new FixtureRpc('local'),providers).inspect((await jobs.claim('orphan-registration-fixture'))!)).rejects.toThrow('DATABASE_UNAVAILABLE');
 const reservation=(await db.query('select object_key from pitlane.artifact_attestations')).rows[0];expect(await storage.get(reservation.object_key)).toBeTruthy();expect((await db.query('select count(*)::int n from pitlane.artifacts')).rows[0].n).toBe(0);
 await db.query("update pitlane.artifact_attestations set created_at=now()-interval '25 hours'");expect(await cleanup().run()).toBe(1);await expect(storage.get(reservation.object_key)).rejects.toThrow();
});

it('expiry hides raw rows, returns honest scoped receipt/artifact tombstones, and scrubs every evidence copy',async()=>{
 const v=await delivered();await privateCopies(v);const r=retention();
 expect(await r.lookupLineage(actor,v.receipt_id)).toMatchObject({kind:'available',versionId:v.id});
 await db.query("update pitlane.receipt_versions set expires_at=now()-interval '1 second'");await db.query("update pitlane.artifacts set expires_at=now()-interval '1 second'");
 expect(await r.lookupLineage(actor,v.receipt_id)).toMatchObject({kind:'expired',evidenceExpired:true,versionId:v.id,digest:v.digest});
 expect(await r.lookupArtifact(actor,v.artifact_id)).toMatchObject({kind:'expired',digest:v.digest});
 expect(await r.lookupLineage({tenantId:T2,userId:U2},v.receipt_id)).toBeNull();
 expect((await web.transaction(tx=>tx.query('select payload from pitlane.receipt_versions'),actor)).rows).toHaveLength(0);
 expect(await cleanup().run()).toBe(1);
 expect((await db.query('select count(*)::int n from pitlane.gateway_observations')).rows[0].n).toBe(0);
 expect((await db.query('select count(*)::int n from pitlane.artifact_attestations')).rows[0].n).toBe(0);
 expect((await db.query('select dispatch_params from pitlane.cost_intents')).rows.every(x=>x.dispatch_params===null)).toBe(true);
 expect(await r.lookupLineage(actor,v.receipt_id,v.id)).toMatchObject({kind:'expired',evidenceExpired:true});
 expect(await r.lookupLineage(actor,randomUUID(),v.id)).toBeNull();
 await db.query('update pitlane.tenant_memberships set active=false where tenant_id=$1',[T]);expect(await r.lookupLineage(actor,v.receipt_id)).toBeNull();
});

it('expires quote and failed job/event bodies even when no artifact was ever created',async()=>{
 const q=await new Quotes(web).quote(actor,{...input,projectId:P});const accepted=await new Quotes(web).submit(actor,q.id,randomUUID());
 await new Jobs(web).requestCancel(actor,accepted.id);
 const abandoned=await new Quotes(web).quote(actor,{...input,projectId:P});
 await db.query("update pitlane.jobs set body_expires_at=now()-interval '1 second' where id=$1",[accepted.id]);
 await db.query("update pitlane.quotes set expires_at=now()-interval '1 second' where id=$1",[abandoned.id]);
 await db.query('update pitlane.job_events set payload=$1 where job_id=$2',[{private:input.mint},accepted.id]);
 await cleanup().run();
 expect((await db.query('select input from pitlane.jobs where id=$1',[accepted.id])).rows[0].input).toEqual({evidenceExpired:true});
 expect((await db.query('select input from pitlane.quotes')).rows.every(x=>x.input.evidenceExpired)).toBe(true);
 expect((await db.query('select payload from pitlane.job_events')).rows.every(x=>Object.keys(x.payload).length===0)).toBe(true);
 expect((await db.query('select job_id from pitlane.idempotency')).rows[0].job_id).toBe(accepted.id);
});

class FixedMint extends FixtureRpc{async read(...args:Parameters<FixtureRpc['read']>){const reply=await super.read(...args);if(args[1]==='getAccountInfo'){const result=reply.result as any;const bytes=Buffer.from(result.value.data[0],'base64');bytes[44]=8;result.value.data[0]=bytes.toString('base64');reply.rawBody=JSON.stringify({jsonrpc:'2.0',id:1,result})}return reply}}
async function confirmed(){
 const failure=await delivered(true);await privateCopies(failure);
 const history=new History(web);const q=await new Quotes(web).quote(actor,failure.payload.input);const comparison=await history.compare(actor,failure.id,q.id,randomUUID());const jobs=new Jobs(worker);
 await new Inspector(jobs,new Artifacts(worker,storage),new FixedMint('local'),providers).inspect((await jobs.claim('atlas-retention'))!);
 const fix=(await db.query('select * from pitlane.receipt_versions where job_id=$1',[comparison.id])).rows[0];
 const c=await history.proposeAtlas(actor,P,'Private regression',failure.id);await history.confirmAtlas(actor,c.id,fix.id,fix.artifact_id,true);return {failure,fix,c,history};
}

it('Atlas holds all necessary evidence under explicit consent and withdrawal shrinks only its own hold',async()=>{
 const {failure,fix,c,history}=await confirmed();
 expect(await (history as any).reuseAtlas(actor,c.id)).toMatchObject({state:'confirmed',permission:true});
 await db.query("update pitlane.jobs set body_expires_at=now()-interval '1 day'");await cleanup().run();
 expect((await db.query('select count(*)::int n from pitlane.gateway_observations')).rows[0].n).toBe(1);
 const other=await history.proposeAtlas(actor,P,'Second authorized case',failure.id);await history.confirmAtlas(actor,other.id,fix.id,fix.artifact_id,true);
 await history.withdrawAtlas(actor,c.id);
 expect((await db.query("select min(expires_at)>now()+interval '364 days' as held from pitlane.receipt_versions")).rows[0].held).toBe(true);
 await history.withdrawAtlas(actor,other.id);
 expect((await db.query("select max(expires_at)<now()+interval '91 days' as shrunk from pitlane.receipt_versions")).rows[0].shrunk).toBe(true);
 await expect((history as any).reuseAtlas(actor,c.id)).rejects.toThrow('NOT_FOUND');
 await expect(history.confirmAtlas(actor,c.id,fix.id,fix.artifact_id,true)).rejects.toThrow('CASE_WITHDRAWN');
 expect((await db.query("select count(*)::int n from pitlane.audit where type='ATLAS_RETRACTED'")).rows[0].n).toBe(2);
});

it('expired Atlas drafts redact titles and cannot acquire consent or future reuse',async()=>{
 const failure=await delivered(true);const h=new History(web);const c=await h.proposeAtlas(actor,P,'Confidential customer title',failure.id);
 await db.query("update pitlane.atlas_cases set expires_at=now()-interval '1 second' where id=$1",[c.id]);await cleanup().run();
 expect((await db.query('select title,permission,redacted_at from pitlane.atlas_cases where id=$1',[c.id])).rows[0]).toMatchObject({title:'[evidence expired]',permission:false,redacted_at:expect.any(Date)});
 await expect((h as any).reuseAtlas(actor,c.id)).rejects.toThrow('NOT_FOUND');
 await expect(h.confirmAtlas(actor,c.id,failure.id,failure.artifact_id,true)).rejects.toThrow('NOT_FOUND');
});

it('tenant deletion authorizes and atomically disables/cancels, then durably purges without erasing financial records',async()=>{
 const v=await delivered();await privateCopies(v);
 await db.query("insert into pitlane.monitors(tenant_id,project_id,input,enabled,next_due,expires_at,unit_cap,enabled_by) values($1,$2,$3,true,now(),now()+interval '1 day',10,$4)",[T,P,{...input,projectId:P},U]);
 const q=await new Quotes(web).quote(actor,{...input,projectId:P,templateId:'solana.integration_expectations',expectations:[{id:'pending',path:'decimals',op:'eq',value:9}]});const pending=await new Quotes(web).submit(actor,q.id,randomUUID());
 await expect(retention().deleteTenant({tenantId:T2,userId:U2})).rejects.toThrow('NOT_FOUND');
 const lots=(await db.query('select * from pitlane.entitlement_lots')).rows;
 await retention().deleteTenant(actor);
 expect((await db.query('select state,cancel_requested from pitlane.jobs where id=$1',[pending.id])).rows[0]).toMatchObject({state:'cancelled',cancel_requested:true});
 expect((await db.query('select enabled from pitlane.monitors')).rows[0].enabled).toBe(false);
 await expect(new Artifacts(web,storage).download(actor,v.artifact_id)).rejects.toThrow('NOT_FOUND');
 expect((await db.query("select status,due_at<=now()+interval '30 days' as bounded from pitlane.deletion_requests")).rows[0]).toMatchObject({status:'pending',bounded:true});
 await cleanup().run();await expect(storage.get(v.object_key)).rejects.toThrow();
 expect((await db.query('select status from pitlane.deletion_requests')).rows[0].status).toBe('completed');
 expect((await db.query('select granted,consumed from pitlane.entitlement_lots')).rows[0]).toMatchObject({granted:lots[0].granted,consumed:lots[0].consumed});
 expect((await db.query('select input from pitlane.monitors')).rows[0].input).toEqual({evidenceExpired:true});
 expect((await db.query('select name from pitlane.tenants where id=$1',[T])).rows[0].name).toBe('[deleted tenant]');
});

it('receipt pagination has bounded stable cursors and covers records beyond a fixed recent limit',async()=>{
 const v=await delivered();for(let i=0;i<105;i++)await db.query('insert into pitlane.receipt_versions(id,receipt_id,tenant_id,project_id,job_id,payload,digest,artifact_id,supersedes_id,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval \'1 day\')',[randomUUID(),v.receipt_id,T,P,v.job_id,v.payload,v.digest,v.artifact_id,v.id]);
 const r=retention();let cursor:unknown=undefined;const ids:string[]=[];
 do{const page=await r.listReceipts(actor,P,{limit:20,cursor});expect(page.items.length).toBeLessThanOrEqual(20);ids.push(...page.items.map((x:any)=>x.versionId));cursor=page.nextCursor}while(cursor);
 expect(new Set(ids).size).toBe(106);expect(ids).toHaveLength(106);
 await expect(r.listReceipts(actor,P,{limit:101})).rejects.toThrow('INVALID_PAGE');
 await expect(r.listReceipts({tenantId:T2,userId:U2},P,{limit:20})).rejects.toThrow('NOT_FOUND');
 const summary=(await r.listReceipts(actor,P,{limit:1})).items[0];expect(summary).toMatchObject({finding:'supported',origin:'fixture'});expect(summary).not.toHaveProperty('payload');
 await db.query('insert into pitlane.job_events(tenant_id,project_id,job_id,seq,type,payload) select $1,$2,$3,s,\'fixture\',\'{}\'::jsonb from generate_series(100,205) s',[T,P,v.job_id]);
 const seen:string[]=[];let sequence:string|null=null;do{const page:{items:{seq:string}[];nextCursor:string|null}=await r.listEvents(actor,v.job_id,{limit:20,cursor:sequence});seen.push(...page.items.map(x=>x.seq));sequence=page.nextCursor}while(sequence);
 expect(new Set(seen).size).toBe(seen.length);expect(seen.length).toBeGreaterThan(100);
 await expect(r.listEvents(actor,v.job_id,{cursor:'9223372036854775808'})).rejects.toThrow('INVALID_PAGE');
});

for(const deletion of ['project','tenant'] as const)it(`${deletion} deletion erases private collaboration bodies and arbitrary keys while preserving scoped cost measurements`,async()=>{
 const c=new Collaboration(web);const conversation=await c.createConversation(actor,P,'Private customer title');
 const sprint=await c.createSprint(actor,P,{title:'Private sprint',goal:'Private customer goal'},'private-sprint-key@example.test');
 await c.createWorkItem(actor,P,{title:'Private customer work',description:'Private customer details',sprintId:sprint.id},'private-work-key@example.test');
 const sent=await c.sendMessage(actor,P,conversation.id,{content:'Private customer message'},'private-chat-key@example.test');
 await db.query('update pitlane.collaboration_ai_requests set input_tokens=1,output_tokens=2,total_tokens=3,cost_micro=10 where id=$1',[sent.request.id]);
 const peer=await new Team(web).createProject(actor,'Other live project');await c.createConversation(actor,peer.id,'Private peer title');
 if(deletion==='project')await retention().deleteProject(actor,P);else await retention().deleteTenant(actor);
 await cleanup().run();
 const rows=(await db.query('select * from pitlane.collaboration_conversations where project_id=$1',[P])).rows;expect(rows[0].title).toBe('[deleted]');
 expect((await db.query('select title,goal from pitlane.collaboration_sprints where project_id=$1',[P])).rows[0]).toMatchObject({title:'[deleted]',goal:''});
 expect((await db.query('select title,description from pitlane.collaboration_work_items where project_id=$1',[P])).rows[0]).toMatchObject({title:'[deleted]',description:''});
 expect((await db.query('select content from pitlane.collaboration_messages where project_id=$1',[P])).rows[0].content).toBe('[deleted]');
 expect((await db.query('select result,key from pitlane.collaboration_mutations where project_id=$1',[P])).rows.every(x=>JSON.stringify(x.result)==='{}'&&/^[a-f0-9]{64}$/.test(x.key))).toBe(true);
 const measurement=(await db.query('select key,total_tokens,cost_micro,retention_redacted_at from pitlane.collaboration_ai_requests where id=$1',[sent.request.id])).rows[0];expect(measurement).toMatchObject({key:expect.stringMatching(/^[a-f0-9]{64}$/),total_tokens:3,cost_micro:'10',retention_redacted_at:expect.any(Date)});
 await cleanup().run();expect((await db.query('select key from pitlane.collaboration_ai_requests where id=$1',[sent.request.id])).rows[0].key).toBe(measurement.key);
 expect((await db.query('select title from pitlane.collaboration_conversations where project_id=$1',[peer.id])).rows[0].title).toBe(deletion==='tenant'?'[deleted]':'Private peer title');
 await expect(c.sendMessage(actor,P,conversation.id,{content:'Future private message'},randomUUID())).rejects.toThrow('NOT_FOUND');
 await expect(db.query("update pitlane.collaboration_messages set content='Revived private message' where project_id=$1",[P])).rejects.toThrow('NOT_FOUND');
 expect((await db.query('select status from pitlane.deletion_requests')).rows.every(x=>x.status==='completed')).toBe(true);
});
