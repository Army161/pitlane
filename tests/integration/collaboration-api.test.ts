import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import type pg from 'pg';
import {database,seed,T,P,U,T2,P2,U2} from './support';
import {PostgresDb} from '../../packages/adapters/src/postgres';
import {Collaboration} from '../../packages/core/src/collaboration';
import {Api} from '../../apps/web/src/lib/api';

let db:pg.Pool,web:PostgresDb;
const origin='http://127.0.0.1:3000',csrf='collaboration-api-csrf';
const endpoint=(area:string,project=P)=>`/v1/projects/${project}/${area}`;
function api(userId=U,tenantId=T){return new Api({db:web,origin,identity:async()=>({userId,tenantId,csrf,cookie:true}),collaboration:new Collaboration(web)})}
function get(path:string){return new Request(origin+path)}
function post(path:string,input:unknown,requestKey?:string,proof=csrf,requestOrigin=origin){return new Request(origin+path,{method:'POST',headers:{'content-type':'application/json',origin:requestOrigin,...(proof?{'x-csrf-token':proof}:{}),...(requestKey?{'idempotency-key':requestKey}:{})},body:JSON.stringify(input)})}
beforeAll(async()=>{db=await database();web=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!)});
beforeEach(async()=>seed(db));
afterAll(async()=>{await Promise.all([db?.end(),web?.close()])});

it('persists a scoped conversation and saved user message with explicit unavailable provider status',async()=>{
 const handler=api();const created=await handler.handle(post(endpoint('conversations'),{title:'Receipt conversation'}));expect(created.status).toBe(201);const conversation=await created.json();expect(conversation).toMatchObject({projectId:P,tenantId:T,createdBy:U,version:1});
 const sent=await handler.handle(post(endpoint(`conversations/${conversation.id}/messages`),{content:'Please explain the actual receipts.'},'http-unavailable-message'));expect(sent.status).toBe(201);const result=await sent.json();expect(result.message).toMatchObject({role:'user',authorId:U,content:'Please explain the actual receipts.'});expect(result.request).toMatchObject({status:'unavailable',provider:null,origin:null,reason:'AI_UNAVAILABLE',usage:null});expect(result.reply).toBeNull();
 const messages=await handler.handle(get(endpoint(`conversations/${conversation.id}/messages`)));expect(messages.status).toBe(200);expect(messages.headers.get('cache-control')).toBe('no-store');expect(await messages.json()).toHaveLength(1);
 const replay=await handler.handle(post(endpoint(`conversations/${conversation.id}/messages`),{content:'Please explain the actual receipts.'},'http-unavailable-message'));expect((await replay.json()).message.id).toBe(result.message.id);expect((await db.query('select content from pitlane.collaboration_messages')).rows).toEqual([{content:'Please explain the actual receipts.'}]);
 const status=await handler.handle(get(endpoint('collaboration')));expect(status.status).toBe(200);expect(await status.json()).toMatchObject({availability:{available:false,reason:'AI_UNAVAILABLE'},members:[{userId:U,canWrite:true}]});
});

it('rejects missing CSRF and foreign origins before creating records',async()=>{
 const handler=api();const noProof=await handler.handle(post(endpoint('conversations'),{title:'Should not persist'},undefined,''));expect(noProof.status).toBe(403);expect((await noProof.json()).code).toBe('CSRF_REQUIRED');
 const foreign=await handler.handle(post(endpoint('sprints'),{title:'Foreign origin sprint'},'http-foreign-origin-sprint',csrf,'https://attacker.invalid'));expect(foreign.status).toBe(403);
 expect((await db.query('select count(*)::int as n from pitlane.collaboration_conversations')).rows[0].n).toBe(0);expect((await db.query('select count(*)::int as n from pitlane.collaboration_sprints')).rows[0].n).toBe(0);
});

it('returns 404 for foreign tenant/project and mismatched conversation IDs without exposing content',async()=>{
 const handler=api();await db.query("update pitlane.tenant_memberships set role='owner' where tenant_id=$1 and user_id=$2",[T2,U2]);const other=await new Collaboration(web).createConversation({tenantId:T2,userId:U2},P2,'Foreign private title');
 const requests=[get(endpoint('conversations',P2)),post(endpoint('conversations',P2),{title:'Foreign write'}),get(endpoint(`conversations/${other.id}/messages`)),post(endpoint(`conversations/${other.id}/messages`),{content:'Foreign message'},'http-foreign-message-key'),get(endpoint('collaboration',P2))];
 for(const request of requests){const response=await handler.handle(request);expect(response.status).toBe(404);expect((await response.json()).code).toBe('NOT_FOUND')}
 expect((await db.query('select count(*)::int as n from pitlane.collaboration_messages')).rows[0].n).toBe(0);
});

it('returns version conflict 409 for stale work/sprint edits and preserves exact idempotent replay',async()=>{
 const handler=api();const sprintResponse=await handler.handle(post(endpoint('sprints'),{title:'Actual sprint',state:'active'},'http-sprint-create-key'));expect(sprintResponse.status).toBe(201);const sprint=await sprintResponse.json();
 const workResponse=await handler.handle(post(endpoint('work-items'),{title:'Follow up receipt',sprintId:sprint.id,assigneeId:U},'http-work-create-key'));expect(workResponse.status).toBe(201);const work=await workResponse.json();
 const update={expectedVersion:1,state:'in_progress'};const changed=await handler.handle(post(endpoint(`work-items/${work.id}`),update,'http-work-update-key'));expect(changed.status).toBe(200);const changedItem=await changed.json();expect(changedItem).toMatchObject({version:2,state:'in_progress',updatedBy:U,assigneeId:U});
 const stale=await handler.handle(post(endpoint(`work-items/${work.id}`),{expectedVersion:1,state:'done'},'http-work-stale-key'));expect(stale.status).toBe(409);expect((await stale.json()).code).toBe('VERSION_CONFLICT');
 const replay=await handler.handle(post(endpoint(`work-items/${work.id}`),update,'http-work-update-key'));expect(replay.status).toBe(200);expect(await replay.json()).toEqual(changedItem);
 const done=await handler.handle(post(endpoint(`sprints/${sprint.id}`),{expectedVersion:1,state:'completed'},'http-sprint-finish-key'));expect(done.status).toBe(200);expect((await done.json()).version).toBe(2);
 const staleSprint=await handler.handle(post(endpoint(`sprints/${sprint.id}`),{expectedVersion:1,state:'cancelled'},'http-sprint-stale-key'));expect(staleSprint.status).toBe(409);expect((await staleSprint.json()).code).toBe('VERSION_CONFLICT');
 const list=await handler.handle(get(endpoint('work-items')));expect((await list.json())[0]).toMatchObject({id:work.id,state:'in_progress',assigneeId:U});
});

it('allows viewer reads, denies writes and immediately hides history after current membership revocation',async()=>{
 const writer=api();const conversation=await (await writer.handle(post(endpoint('conversations'),{title:'Membership history'}))).json();await writer.handle(post(endpoint(`conversations/${conversation.id}/messages`),{content:'Private history'},'http-membership-message'));
 await db.query("insert into pitlane.tenant_memberships values($1,$2,'member',true)",[T,U2]);await db.query("insert into pitlane.project_memberships values($1,$2,$3,'viewer',true)",[T,P,U2]);const viewer=api(U2);
 expect((await viewer.handle(get(endpoint(`conversations/${conversation.id}/messages`)))).status).toBe(200);expect((await viewer.handle(post(endpoint(`conversations/${conversation.id}/messages`),{content:'Viewer cannot write'},'http-viewer-message-key'))).status).toBe(404);
 await db.query('update pitlane.project_memberships set active=false where tenant_id=$1 and project_id=$2 and user_id=$3',[T,P,U2]);expect((await viewer.handle(get(endpoint(`conversations/${conversation.id}/messages`)))).status).toBe(404);
 expect((await db.query('select count(*)::int as n from pitlane.collaboration_messages')).rows[0].n).toBe(1);
});

it('rejects unbounded pages, missing mutation keys and invalid work assignments before writes',async()=>{
 const handler=api();const conversation=await (await handler.handle(post(endpoint('conversations'),{title:'Input boundary'}))).json();
 const page=await handler.handle(get(endpoint('conversations')+'?limit=51'));expect(page.status).toBe(422);
 const missingKey=await handler.handle(post(endpoint(`conversations/${conversation.id}/messages`),{content:'No mutation key'}));expect(missingKey.status).toBe(422);
 const unknown=await handler.handle(post(endpoint('work-items'),{title:'Unknown assignee',assigneeId:U2},'http-unknown-member-key'));expect(unknown.status).toBe(404);
 expect((await db.query('select count(*)::int as n from pitlane.collaboration_messages')).rows[0].n).toBe(0);expect((await db.query('select count(*)::int as n from pitlane.collaboration_work_items')).rows[0].n).toBe(0);
});
