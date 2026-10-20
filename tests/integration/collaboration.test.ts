import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import type pg from 'pg';
import {database,seed,scoped,T,P,U,T2,P2,U2} from './support';
import {PostgresDb} from '../../packages/adapters/src/postgres';
import type {AiChatInput,AiChatPort,AiAllowance} from '../../packages/contracts/src/collaboration';
import {AiProviderError} from '../../packages/contracts/src/collaboration';
import {Quotes} from '../../packages/core/src/quotes';
import {input as inspectionInput} from '../fixtures/observations';
const module=await import('../../packages/core/src/collaboration').catch(()=>({}));
let db:pg.Pool,web:PostgresDb;
const actor={tenantId:T,userId:U};
const allowance:AiAllowance={dailyRequests:5,dailyTokens:100000,dailyCostMicro:'100000',inputMicroPerMillion:'1000000',outputMicroPerMillion:'2000000'};
class FixtureProvider implements AiChatPort {
 readonly provider='fixture' as const;readonly origin='fixture' as const;readonly model='deterministic-test-fixture';readonly maxOutputTokens=100;
 calls=0;contexts:string[]=[];failure:Error|null=null;gate:Promise<void>|null=null;
 async respond(input:AiChatInput){this.calls++;this.contexts.push(input.context);await this.gate;if(this.failure)throw this.failure;return {responseId:'fixture-response-'+input.requestId,content:'Fixture explanation of linked persisted evidence.',usage:{inputTokens:30,outputTokens:8,totalTokens:38}}}
}
const service=(provider?:FixtureProvider,caps=allowance)=>new (module as any).Collaboration(web,{provider,allowance:caps});
beforeAll(async()=>{db=await database();web=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!)});
beforeEach(async()=>seed(db));afterAll(async()=>{await Promise.all([db?.end(),web?.close()])});
it('persists unavailable messages and isolates reads, writes, revoked membership and deleted projects',async()=>{
 const c=service();const conversation=await c.createConversation(actor,P,'Private evidence review');
 const result=await c.sendMessage(actor,P,conversation.id,{content:'Explain this project.'},'message-unavailable-1');
 expect(result.request.status).toBe('unavailable');expect(result.reply).toBeNull();expect((await c.listMessages(actor,P,conversation.id))[0].content).toBe('Explain this project.');
 await expect(c.listMessages({tenantId:T2,userId:U2},P,conversation.id)).rejects.toThrow('NOT_FOUND');
 await db.query("insert into pitlane.tenant_memberships values($1,$2,'member',true)",[T,U2]);await db.query("insert into pitlane.project_memberships values($1,$2,$3,'viewer',true)",[T,P,U2]);
 expect(await c.listConversations({tenantId:T,userId:U2},P)).toHaveLength(1);await expect(c.sendMessage({tenantId:T,userId:U2},P,conversation.id,{content:'Forbidden'},'viewer-message-1')).rejects.toThrow('NOT_FOUND');
 await db.query('update pitlane.project_memberships set active=false where user_id=$1',[U2]);await expect(c.listConversations({tenantId:T,userId:U2},P)).rejects.toThrow('NOT_FOUND');
 await db.query('update pitlane.projects set deleted_at=now() where id=$1',[P]);await expect(c.listMessages(actor,P,conversation.id)).rejects.toThrow('NOT_FOUND');
 expect((await scoped(db,c=>c.query('select * from pitlane.collaboration_messages'))).rows).toHaveLength(0);
});
it('concurrent send replay calls the provider once, appends one reply and measures actual usage',async()=>{
 const provider=new FixtureProvider();let release!:()=>void;provider.gate=new Promise<void>(r=>release=r);const c=service(provider);const conversation=await c.createConversation(actor,P,'Concurrency');
 const first=c.sendMessage(actor,P,conversation.id,{content:'Explain current state'},'concurrent-message-1');
 for(let i=0;i<100&&provider.calls===0;i++)await new Promise(r=>setTimeout(r,5));expect(provider.calls).toBe(1);
 const replay=await c.sendMessage(actor,P,conversation.id,{content:'Explain current state'},'concurrent-message-1');expect(replay.request.status).toBe('running');release();const result=await first;
 expect(result.request).toMatchObject({status:'completed',origin:'fixture',usage:{inputTokens:30,outputTokens:8,totalTokens:38},costMicro:'46'});expect(result.reply.origin).toBe('fixture');expect(provider.calls).toBe(1);expect(await c.listMessages(actor,P,conversation.id)).toHaveLength(2);
 await expect(c.sendMessage(actor,P,conversation.id,{content:'Changed content'},'concurrent-message-1')).rejects.toThrow('IDEMPOTENCY_CONFLICT');
 await expect(scoped(db,tx=>tx.query("update pitlane.collaboration_messages set content='tampered'"))).rejects.toThrow('permission denied');
});
it('tracks uncertain/failed calls, retains user text, never retries a dispatched key and enforces concurrent daily caps',async()=>{
 const provider=new FixtureProvider();provider.failure=new AiProviderError('PROVIDER_UNCERTAIN',true);const c=service(provider,{...allowance,dailyRequests:1});const conversation=await c.createConversation(actor,P,'Failure');
 const failed=await c.sendMessage(actor,P,conversation.id,{content:'Keep this message'},'uncertain-message-1');expect(failed.request.status).toBe('uncertain');expect(failed.reply).toBeNull();
 expect((await c.sendMessage(actor,P,conversation.id,{content:'Keep this message'},'uncertain-message-1')).request.status).toBe('uncertain');
 const capped=await c.sendMessage(actor,P,conversation.id,{content:'Next message'},'capped-message-1');expect(capped.request.status).toBe('capped');expect(provider.calls).toBe(1);
 expect((await db.query('select attempts,charged_tokens from pitlane.collaboration_ai_days')).rows[0]).toMatchObject({attempts:1,charged_tokens:'16100'});
});
it('rejects linked records outside the project, bounds pages, and includes only permitted persisted context',async()=>{
 const provider=new FixtureProvider();const c=service(provider);const conversation=await c.createConversation(actor,P,'Context');const item=await c.createWorkItem(actor,P,{title:'Review decimals',description:'Private raw description'},'context-work-create');
 await expect(c.sendMessage(actor,P,conversation.id,{content:'Foreign work',workItemIds:['40000000-0000-4000-8000-000000000001']},'foreign-link-message')).rejects.toThrow('NOT_FOUND');
 const result=await c.sendMessage(actor,P,conversation.id,{content:'Explain work state',workItemIds:[item.id]},'linked-message-1');expect(result.request.status).toBe('completed');expect(provider.contexts[0]).toContain('Review decimals');expect(provider.contexts[0]).not.toContain('Private raw description');
 await expect(c.listMessages(actor,P,conversation.id,{limit:51})).rejects.toThrow('INVALID_INPUT');await expect(c.sendMessage(actor,P,conversation.id,{content:'a'.repeat(4001)},'huge-message-1')).rejects.toThrow('INVALID_INPUT');
 const other=await c.createConversation(actor,P2,'Invalid').catch((e:Error)=>e.message);expect(other).toBe('NOT_FOUND');
});
it('records actual sprint assignments, rejects inaccessible assignees, serializes optimistic edits and replay',async()=>{
 const c=service();const sprint=await c.createSprint(actor,P,{title:'Receipt follow-ups',state:'active'},'sprint-create-key');const item=await c.createWorkItem(actor,P,{title:'Verify mint',sprintId:sprint.id,assigneeId:U},'work-create-key');
 await expect(c.createWorkItem(actor,P,{title:'Foreign owner',assigneeId:U2},'foreign-assignee-key')).rejects.toThrow('NOT_FOUND');
 const change={expectedVersion:item.version,state:'in_progress'};const results=await Promise.allSettled([c.updateWorkItem(actor,P,item.id,change,'work-update-first'),c.updateWorkItem(actor,P,item.id,{expectedVersion:item.version,state:'done'},'work-update-second')]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.message).toContain('VERSION_CONFLICT');
 const winner=results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>;const key=winner.value.state==='in_progress'?'work-update-first':'work-update-second';const patch=winner.value.state==='in_progress'?change:{expectedVersion:item.version,state:'done'};
 expect(await c.updateWorkItem(actor,P,item.id,patch,key)).toEqual(winner.value);expect(winner.value.version).toBe(2);
 expect(await c.listMembers(actor,P)).toContainEqual({userId:U,tenantRole:'owner',projectRole:null,canWrite:true});
 const completed=await c.updateSprint(actor,P,sprint.id,{expectedVersion:1,state:'completed'},'sprint-complete-key');expect(completed.updatedBy).toBe(U);expect((await c.listWorkItems(actor,P))[0].assigneeId).toBe(U);
});
it('serializes two different concurrent AI requests against one project allowance',async()=>{
 const provider=new FixtureProvider();let release!:()=>void;provider.gate=new Promise<void>(r=>release=r);const c=service(provider,{...allowance,dailyRequests:1});const conversation=await c.createConversation(actor,P,'Single request allowance');
 const first=c.sendMessage(actor,P,conversation.id,{content:'First request'},'budget-race-first');for(let i=0;i<100&&provider.calls===0;i++)await new Promise(r=>setTimeout(r,5));expect(provider.calls).toBe(1);
 const second=await c.sendMessage(actor,P,conversation.id,{content:'Competing request'},'budget-race-second');expect(second.request.status).toBe('capped');release();expect((await first).request.status).toBe('completed');expect(provider.calls).toBe(1);
 expect((await db.query('select attempts,charged_tokens from pitlane.collaboration_ai_days')).rows[0]).toMatchObject({attempts:1,charged_tokens:'38'});
});
it('revocation while awaiting the provider blocks reply persistence and a crashed dispatch becomes uncertain without a replay',async()=>{
 const provider=new FixtureProvider();let release!:()=>void;provider.gate=new Promise<void>(r=>release=r);const c=service(provider);const conversation=await c.createConversation(actor,P,'Revocation');
 const pending=c.sendMessage(actor,P,conversation.id,{content:'Keep the original'},'revocation-flight-1');for(let i=0;i<100&&provider.calls===0;i++)await new Promise(r=>setTimeout(r,5));
 await db.query('update pitlane.tenant_memberships set active=false where tenant_id=$1 and user_id=$2',[T,U]);release();await expect(pending).rejects.toThrow('NOT_FOUND');expect((await db.query('select role from pitlane.collaboration_messages')).rows).toEqual([{role:'user'}]);
 await db.query('update pitlane.tenant_memberships set active=true where tenant_id=$1 and user_id=$2',[T,U]);await db.query("update pitlane.collaboration_ai_requests set deadline=now()-interval '1 second'");
 expect((await c.listMessages(actor,P,conversation.id))[0].request.status).toBe('uncertain');expect((await c.sendMessage(actor,P,conversation.id,{content:'Keep the original'},'revocation-flight-1')).request.status).toBe('uncertain');expect(provider.calls).toBe(1);
});
it('binds receipt/work links through composite scope and omits raw observations, arbitrary payload and secrets from provider context',async()=>{
 const provider=new FixtureProvider();const c=service(provider);const conversation=await c.createConversation(actor,P,'Actual receipt context');const quote=await new Quotes(web).quote(actor,{...inspectionInput,projectId:P});const job=await new Quotes(web).submit(actor,quote.id,'collaboration-receipt-fixture');
 const artifact='50000000-0000-4000-8000-000000000001',versionId='60000000-0000-4000-8000-000000000001';
 await db.query("insert into pitlane.artifacts(id,tenant_id,project_id,job_id,lease_epoch,object_key,digest,bytes,content_type,state,expires_at,base_expires_at) values($1,$2,$3,$4,0,'fixture-collaboration-evidence',$5,10,'application/json','published',now()+interval '1 day',now()+interval '1 day')",[artifact,T,P,job.id,'a'.repeat(64)]);
 await db.query("insert into pitlane.receipt_versions(id,receipt_id,tenant_id,project_id,job_id,payload,digest,artifact_id,expires_at,base_expires_at) values($1,$1,$2,$3,$4,$5,$6,$7,now()+interval '1 day',now()+interval '1 day')",[versionId,T,P,job.id,{origin:'fixture',finding:'contradicted',ruleVersion:'1',assertions:[{id:'precision',path:'decimals',state:'contradicted',expected:8,observed:6,reason:'Do not leak arbitrary payload'}],observations:[{rawBody:'PRIVATE RAW ARTIFACT'}],secret:'PRIVATE SECRET'},'b'.repeat(64),artifact]);
 const costs=(await db.query('select key,reserved,spent from pitlane.budgets order by key')).rows;const inspectionState=(await db.query('select id,state,cost_used,calls from pitlane.jobs order by id')).rows;
 const result=await c.sendMessage(actor,P,conversation.id,{content:'Explain linked finding; api_key=sk-test-sensitive-secret',receiptVersionIds:[versionId]},'receipt-context-send');expect(result.request.status).toBe('completed');expect(result.message.receiptVersionIds).toEqual([versionId]);expect(provider.contexts[0]).toContain('contradicted');expect(provider.contexts[0]).toContain('decimals');expect(provider.contexts[0]).not.toMatch(/PRIVATE RAW|PRIVATE SECRET|Do not leak|sk-test-sensitive/);
 expect((await db.query('select key,reserved,spent from pitlane.budgets order by key')).rows).toEqual(costs);expect((await db.query('select id,state,cost_used,calls from pitlane.jobs order by id')).rows).toEqual(inspectionState);
 const otherProject='20000000-0000-4000-8000-000000000003';await db.query("insert into pitlane.projects values($1,$2,'Same tenant other project',null)",[otherProject,T]);const other=await c.createConversation(actor,otherProject,'Other project');
 await expect(c.sendMessage(actor,otherProject,other.id,{content:'Foreign evidence',receiptVersionIds:[versionId]},'foreign-receipt-send')).rejects.toThrow('NOT_FOUND');
 await expect(db.query('insert into pitlane.collaboration_message_receipts values($1,$2,$3,$4)',[result.reply.id,T,otherProject,versionId])).rejects.toThrow('foreign key');
 await db.query('update pitlane.receipt_versions set expires_at=now() where id=$1',[versionId]);await expect(c.createWorkItem(actor,P,{title:'Expired evidence',receiptVersionIds:[versionId]},'expired-work-create')).rejects.toThrow('NOT_FOUND');
});
it('a measured provider failure remains a failed request with no invented reply',async()=>{
 const provider=new FixtureProvider();provider.failure=new AiProviderError('PROVIDER_REJECTED',false,{inputTokens:3,outputTokens:0,totalTokens:3},'fixture-failed-response',429,'failed');const c=service(provider);const conversation=await c.createConversation(actor,P,'Rejected provider');
 const result=await c.sendMessage(actor,P,conversation.id,{content:'Preserve user intent'},'failed-provider-message');expect(result.request).toMatchObject({status:'failed',httpStatus:429,providerStatus:'failed',usage:{inputTokens:3,outputTokens:0,totalTokens:3},costMicro:'3'});expect(result.reply).toBeNull();
});
it('rechecks current membership after a write waits on the project concurrency lock',async()=>{
 const blocker=await db.connect();await blocker.query('begin');await blocker.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[T+P+'/collaboration']);
 const queued=service().createConversation(actor,P,'No stale authorization');const denied=expect(queued).rejects.toThrow('NOT_FOUND');
 try {
  let waiting=false;for(let i=0;i<100&&!waiting;i++){waiting=(await db.query("select exists(select from pg_stat_activity where wait_event='advisory') as waiting")).rows[0].waiting;if(!waiting)await new Promise(r=>setTimeout(r,5))}expect(waiting).toBe(true);
  await db.query('update pitlane.tenant_memberships set active=false where tenant_id=$1 and user_id=$2',[T,U]);await blocker.query('commit');await denied;
  expect((await db.query('select count(*)::int as n from pitlane.collaboration_conversations')).rows[0].n).toBe(0);
 } finally {await blocker.query('rollback').catch(()=>{});blocker.release()}
});
