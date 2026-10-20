import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {database,seed,T,P,U,T2,U2} from './support';
import {PostgresDb} from '../../packages/adapters/src/postgres';
import {Api} from '../../apps/web/src/lib/api';
import {Quotes} from '../../packages/core/src/quotes';
import {Jobs} from '../../packages/core/src/jobs';
import {Artifacts,LocalStorage} from '../../packages/core/src/artifacts';
import {FixtureRpc,Inspector} from '../../apps/worker/src/runner';
import type {Actor,Db,Tx} from '../../packages/contracts/src';
import {input} from '../fixtures/observations';

let db:pg.Pool,web:PostgresDb,worker:PostgresDb;
const actor={tenantId:T,userId:U};const origin='http://127.0.0.1:3000';
const storage=new LocalStorage(`.data/retention-events-api-${process.pid}-${Date.now()}`);
beforeAll(async()=>{db=await database();web=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!);worker=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!,'pitlane_worker')});
beforeEach(async()=>seed(db));
afterAll(async()=>{await Promise.all([db.end(),web.close(),worker.close()])});
function api(port:Db=web,scope:Actor=actor){return new Api({db:port,origin,identity:async()=>({...scope,csrf:'fixture',cookie:false})})}
function request(path:string,headers:Record<string,string>={}){return new Request(origin+path,{headers})}
async function cancelled(){const q=await new Quotes(web).quote(actor,{...input,projectId:P});const j=await new Quotes(web).submit(actor,q.id,randomUUID());await new Jobs(web).requestCancel(actor,j.id);return j.id}
async function events(id:string,count:number,start=1n){
 await db.query('delete from pitlane.job_events where job_id=$1',[id]);
 await db.query("insert into pitlane.job_events(tenant_id,project_id,job_id,seq,type,payload,occurred_at) select $1,$2,$3,s,'fixture',jsonb_build_object('privateMint',$6::text,'position',(s-$4::bigint)::text),now()-interval '91 days' from generate_series($4::bigint,$5::bigint) s",[T,P,id,start.toString(),(start+BigInt(count)-1n).toString(),input.mint]);
}

it('JSON event reads redact expired payloads before maintenance and preserve current payloads',async()=>{
 const id=await cancelled();await db.query("update pitlane.job_events set payload=$1,occurred_at=now()-interval '91 days' where job_id=$2 and seq=1",[{privateMint:input.mint},id]);
 await db.query('update pitlane.job_events set payload=$1 where job_id=$2 and seq=2',[{current:'available'},id]);
 const response=await api().handle(request(`/v1/jobs/${id}/events`));expect(response.status).toBe(200);const rows=await response.json();
 expect(rows[0]).toMatchObject({seq:'1',payload:{},evidence_expired:true});expect(rows[1]).toMatchObject({seq:'2',payload:{current:'available'},evidence_expired:false});
 expect(JSON.stringify(rows)).not.toContain(input.mint);expect((await db.query('select payload from pitlane.job_events where job_id=$1 and seq=1',[id])).rows[0].payload.privateMint).toBe(input.mint);
});

it('JSON pagination covers all events using exact bigint strings, bounds pages and honors Last-Event-ID',async()=>{
 const id=await cancelled();const start=9007199254740993n;await events(id,213,start);
 const seen:string[]=[];let cursor:string|null=(start-1n).toString();
 do{const response=await api().handle(request(`/v1/jobs/${id}/events?page=true&limit=17&cursor=${cursor}`));expect(response.status).toBe(200);const page:{items:{seq:string;payload:unknown}[];nextCursor:string|null}=await response.json();expect(page.items.length).toBeLessThanOrEqual(17);seen.push(...page.items.map(x=>x.seq));expect(page.items.every(x=>JSON.stringify(x.payload)==='{}')).toBe(true);cursor=page.nextCursor}while(cursor);
 expect(seen).toEqual(Array.from({length:213},(_,i)=>(start+BigInt(i)).toString()));
 const response=await api().handle(request(`/v1/jobs/${id}/events?page=true&limit=1&cursor=0`,{'last-event-id':start.toString()}));const page=await response.json();expect(page.items[0].seq).toBe((start+1n).toString());expect(page.nextCursor).toBe((start+1n).toString());
 const legacy=await api().handle(request(`/v1/jobs/${id}/events?limit=2&cursor=${start-1n}`));expect((await legacy.json())).toHaveLength(2);expect(legacy.headers.get('x-next-cursor')).toBe((start+1n).toString());
});

it('terminal SSE drains every remaining page, redacts expiry and preserves exact bigint IDs',async()=>{
 const id=await cancelled();const start=9007199254740993n;await events(id,213,start);
 const response=await api().handle(request(`/v1/jobs/${id}/events?limit=23`,{accept:'text/event-stream','last-event-id':(start-1n).toString()}));expect(response.status).toBe(200);
 const text=await response.text();const ids=[...text.matchAll(/^id: (\d+)$/gm)].map(x=>x[1]);expect(ids).toEqual(Array.from({length:213},(_,i)=>(start+BigInt(i)).toString()));expect(text).not.toContain(input.mint);expect(text).toContain('"evidence_expired":true');expect(text).toContain('"payload":{}');
});

it('SSE rechecks project membership before the next page and cannot emit its body after revocation',async()=>{
 const id=await cancelled();await events(id,213);
 await db.query("update pitlane.tenant_memberships set role='member' where tenant_id=$1 and user_id=$2",[T,U]);await db.query("insert into pitlane.project_memberships values($1,$2,$3,'viewer',true)",[T,P,U]);
 let resolveStarted!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{resolveStarted=r});const gate=new Promise<void>(r=>{release=r});let reads=0;
 const guarded:Db={query:web.query.bind(web),transaction:<R>(fn:(tx:Tx)=>Promise<R>,scope?:Actor)=>web.transaction(async tx=>fn({query:async<Q>(sql:string,values?:unknown[])=>{if(sql.includes('pitlane.event_page')||sql.includes('from pitlane.job_events')){reads++;if(reads===2){resolveStarted();await gate}}return tx.query<Q>(sql,values)}}),scope)};
 const response=await api(guarded).handle(request(`/v1/jobs/${id}/events`,{accept:'text/event-stream'}));expect(response.status).toBe(200);const reader=response.body!.getReader();
 try{
  for(let i=0;i<100;i++)expect((await reader.read()).done).toBe(false);
  const pending=reader.read();expect(await Promise.race([started.then(()=>'next-page'),pending.then(x=>x.done?'closed':'emitted')])).toBe('next-page');
  await db.query('update pitlane.project_memberships set active=false where tenant_id=$1 and project_id=$2 and user_id=$3',[T,P,U]);release();expect((await pending).done).toBe(true);expect(reads).toBe(2);
  expect((await api().handle(request(`/v1/jobs/${id}/events`))).status).toBe(404);
 }finally{release();await reader.cancel().catch(()=>{})}
});

it('event cursor/range validation rejects overflow, coercion and unbounded pages without scope leakage',async()=>{
 const id=await cancelled();
 for(const cursor of ['9223372036854775808','-1','1.5','1e3','+1','not-a-cursor'])expect((await api().handle(request(`/v1/jobs/${id}/events?cursor=${encodeURIComponent(cursor)}`))).status).toBe(422);
 for(const limit of ['0','101','1.5','unbounded'])expect((await api().handle(request(`/v1/jobs/${id}/events?limit=${limit}`))).status).toBe(422);
 expect((await api().handle(request(`/v1/jobs/${id}/events?cursor=0`,{'last-event-id':'9223372036854775808'}))).status).toBe(422);
 expect((await api().handle(request(`/v1/jobs/${id}/events?cursor=9223372036854775807`))).status).toBe(200);
 expect((await api(web,{tenantId:T2,userId:U2}).handle(request(`/v1/jobs/${id}/events?cursor=0`))).status).toBe(404);
});

it('job GET, cancel replay and legacy list suppress expired input before maintenance',async()=>{
 const id=await cancelled();await db.query("update pitlane.jobs set body_expires_at=now()-interval '1 second' where id=$1",[id]);
 for(const req of [request(`/v1/jobs/${id}`),request(`/v1/jobs?project_id=${P}`),new Request(origin+`/v1/jobs/${id}/cancel`,{method:'POST'})]){
  const response=await api().handle(req);expect([200,202]).toContain(response.status);const body=await response.json();const row=Array.isArray(body)?body[0]:body;expect(row).toMatchObject({input:{evidenceExpired:true},evidence_expired:true});expect(JSON.stringify(body)).not.toContain(input.mint);
 }
 expect((await db.query('select input from pitlane.jobs where id=$1',[id])).rows[0].input.mint).toBe(input.mint);
 expect((await api(web,{tenantId:T2,userId:U2}).handle(request(`/v1/jobs/${id}`))).status).toBe(404);
});

it('job input remains available while a published live receipt holds it, then disappears when the evidence expires',async()=>{
 const q=await new Quotes(web).quote(actor,{...input,projectId:P});const job=await new Quotes(web).submit(actor,q.id,randomUUID());const jobs=new Jobs(worker);
 await new Inspector(jobs,new Artifacts(worker,storage),new FixtureRpc('local'),[{id:'fixture-a',upstreamId:'a',maximumMicro:'100'},{id:'fixture-b',upstreamId:'b',maximumMicro:'100'}]).inspect((await jobs.claim('http-retention-hold'))!);
 await db.query("update pitlane.jobs set body_expires_at=now()-interval '1 day' where id=$1",[job.id]);
 const retained=await api().handle(request(`/v1/jobs/${job.id}`));expect((await retained.json()).input.mint).toBe(input.mint);
 await db.query("update pitlane.artifacts set expires_at=now()-interval '1 second' where job_id=$1",[job.id]);const expired=await api().handle(request(`/v1/jobs/${job.id}`));expect(await expired.json()).toMatchObject({input:{evidenceExpired:true},evidence_expired:true});
});
