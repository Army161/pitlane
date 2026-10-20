import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {database,seed,T,P,U,T2,U2} from './support';
import type {Db,StoragePort} from '../../packages/contracts/src';
import {PostgresDb} from '../../packages/adapters/src/postgres';
import {LocalStorage,Artifacts} from '../../packages/core/src/artifacts';
import {Orders,FixtureBilling} from '../../packages/core/src/orders';
import {Quotes} from '../../packages/core/src/quotes';
import {Jobs} from '../../packages/core/src/jobs';
import {Retention} from '../../packages/core/src/retention';
import {FixtureRpc,Inspector} from '../../apps/worker/src/runner';
import {canonical,rawDigest} from '../../packages/evidence/src/canonical';
import {input} from '../fixtures/observations';

let db:pg.Pool,web:PostgresDb,worker:PostgresDb,billing:PostgresDb,maintenance:PostgresDb;
const actor={tenantId:T,userId:U};const storage=new LocalStorage(`.data/pilot-publication-${process.pid}-${Date.now()}`);
const review={minutes:15,text:'Private fixture operator review of the delivered integration receipt.'};
beforeAll(async()=>{db=await database();const url=process.env.PITLANE_TEST_DATABASE_URL!;web=new PostgresDb(url);worker=new PostgresDb(url,'pitlane_worker');billing=new PostgresDb(url,'pitlane_billing');maintenance=new PostgresDb(url,'pitlane_maintenance')});
beforeEach(async()=>{await seed(db);await db.query("update pitlane.runtime set billing_mode='sandbox'");await db.query('insert into pitlane.platform_operators values($1,true)',[U])});
afterAll(async()=>{await Promise.all([db?.end(),web?.close(),worker?.close(),billing?.close(),maintenance?.close()])});
async function pilot(store:StoragePort=storage){
 const provider=new FixtureBilling('local');const orders=new Orders(web,billing,provider,store);const q=await new Quotes(web).quote(actor,{...input,projectId:P});const order=await orders.authorizeOrder(actor,q.id,randomUUID(),'pilot',1);await orders.dispatchBilling();
 const jobs=new Jobs(worker);await new Inspector(jobs,new Artifacts(worker,storage),new FixtureRpc('local'),[{id:'fixture-a',upstreamId:'a',maximumMicro:'100'},{id:'fixture-b',upstreamId:'b',maximumMicro:'100'}]).inspect((await jobs.claim('pilot-publication-fixture'))!);
 return {orders,provider,order};
}
function failingRegistration():Db{return {query:web.query.bind(web),transaction:(fn,scope)=>web.transaction(tx=>fn({query:async<T>(sql:string,values?:unknown[])=>{if(sql.startsWith('select pitlane.register_pilot_summary'))throw new Error('DATABASE_UNAVAILABLE');return tx.query<T>(sql,values)}}),scope)}}
async function pilotReservations(){return (await db.query("select * from pitlane.artifact_attestations where object_key like '%/pilot-summary/%'")).rows}

it('records the exact private key before upload and cleans a registration-failure orphan after24hours',async()=>{
 let uploadedKey='';const tracked:StoragePort={put:async(key,bytes,type)=>{if(type==='application/vnd.pitlane.pilot-summary+json')uploadedKey=key;await storage.put(key,bytes,type)},get:storage.get.bind(storage),remove:storage.remove.bind(storage)};
 const {order,provider}=await pilot();await expect(new Orders(failingRegistration(),billing,provider,tracked).deliverPilotSummary(actor,order.id,review)).rejects.toThrow('DATABASE_UNAVAILABLE');
 const reservations=await pilotReservations();expect(reservations).toHaveLength(1);expect(reservations[0].object_key).toBe(uploadedKey);expect(reservations[0].verified_at).toBeTruthy();expect(reservations[0].payload.text).toBeUndefined();expect(await storage.get(uploadedKey)).toBeTruthy();expect((await db.query('select summary_artifact_id from pitlane.orders where id=$1',[order.id])).rows[0].summary_artifact_id).toBeNull();
 await db.query("update pitlane.artifact_attestations set created_at=now()-interval '25 hours',pilot_upload_until=now()-interval '1 second' where object_key=$1",[uploadedKey]);expect(await new Retention(maintenance,storage).run()).toBe(1);await expect(storage.get(uploadedKey)).rejects.toThrow();expect(await pilotReservations()).toHaveLength(0);
});

it('reserves before any object bytes and replays without another upload or capture',async()=>{
 let uploads=0;const checked:StoragePort={put:async(key,bytes,type)=>{if(type==='application/vnd.pitlane.pilot-summary+json'){uploads++;const rows=(await db.query('select digest,bytes,verified_at from pitlane.artifact_attestations where object_key=$1',[key])).rows;expect(rows).toHaveLength(1);expect(rows[0].digest).toBe(rawDigest(bytes));expect(String(rows[0].bytes)).toBe(String(bytes.length));expect(rows[0].verified_at).toBeNull()}await storage.put(key,bytes,type)},get:storage.get.bind(storage),remove:storage.remove.bind(storage)};
 const {orders,order,provider}=await pilot(checked);await orders.deliverPilotSummary(actor,order.id,review);await orders.deliverPilotSummary(actor,order.id,review);await expect(orders.deliverPilotSummary(actor,order.id,{...review,text:review.text+' Changed.'})).rejects.toThrow('IDEMPOTENCY_CONFLICT');expect(uploads).toBe(1);
 await orders.dispatchBilling();await orders.dispatchBilling();expect(provider.captured).toBe(1);expect((await db.query("select count(*)::int n from pitlane.artifacts where content_type='application/vnd.pitlane.pilot-summary+json'")).rows[0].n).toBe(1);
});

it('requires a matching verified pilot reservation and denies receipt-worker reservation privileges',async()=>{
 const {order}=await pilot();const context=(await web.transaction(tx=>tx.query<{value:Record<string,any>}>('select pitlane.pilot_summary_context($1) as value',[order.id]),actor)).rows[0].value;
 const bytes=Buffer.from(canonical({schema:'pitlane.pilot-summary.v1',orderId:order.id,actorId:U,...review,origin:context.origin}));const hash=rawDigest(bytes),key=`${T}/${P}/${context.job_id}/pilot-summary/${order.id}/${hash}.json`,artifact=randomUUID();
 await expect(web.transaction(tx=>tx.query('select pitlane.register_pilot_summary($1,$2,$3,$4,$5,$6)',[order.id,artifact,key,hash,bytes.length,review.minutes]),actor)).rejects.toThrow('PILOT_PUBLICATION_REQUIRED');
 const reservation=(await web.transaction(tx=>tx.query<{value:any}>('select pitlane.reserve_pilot_summary($1,$2,$3,$4,$5,$6) as value',[order.id,artifact,key,hash,bytes.length,review.minutes]),actor)).rows[0].value;expect(reservation.artifact_id).toBe(artifact);
 await expect(web.transaction(tx=>tx.query('select pitlane.register_pilot_summary($1,$2,$3,$4,$5,$6)',[order.id,artifact,key,hash,bytes.length,review.minutes]),actor)).rejects.toThrow('PILOT_PUBLICATION_REQUIRED');
 await expect(worker.query('select pitlane.reserve_pilot_summary($1,$2,$3,$4,$5,$6)',[order.id,artifact,key,hash,bytes.length,review.minutes])).rejects.toThrow('permission denied');
 const receipt=(await db.query("select count(*)::int n from pitlane.artifact_attestations where object_key not like '%/pilot-summary/%'")).rows[0].n;expect(receipt).toBe(1);
});

it('denies foreign or revoked scopes before upload and retains a cleanup key when revocation occurs after upload',async()=>{
 let uploads=0;const revoked:StoragePort={put:async(key,bytes,type)=>{uploads++;await storage.put(key,bytes,type);await db.query('update pitlane.tenant_memberships set active=false where tenant_id=$1 and user_id=$2',[T,U])},get:storage.get.bind(storage),remove:storage.remove.bind(storage)};
 const {order,provider}=await pilot();const orders=new Orders(web,billing,provider,revoked);
 await expect(orders.deliverPilotSummary({tenantId:T2,userId:U2},order.id,review)).rejects.toThrow();expect(uploads).toBe(0);
 await expect(orders.deliverPilotSummary(actor,order.id,review)).rejects.toThrow('NOT_FOUND');expect(uploads).toBe(1);const reservations=await pilotReservations();expect(reservations).toHaveLength(1);expect(await storage.get(reservations[0].object_key)).toBeTruthy();
 await expect(orders.deliverPilotSummary(actor,order.id,review)).rejects.toThrow('NOT_FOUND');expect(uploads).toBe(1);
});

it('keeps fresh interrupted pilot uploads tracked during deletion, then erases their exact keys within the deletion deadline',async()=>{
 const {order,provider}=await pilot();await expect(new Orders(failingRegistration(),billing,provider,storage).deliverPilotSummary(actor,order.id,review)).rejects.toThrow('DATABASE_UNAVAILABLE');const reservation=(await pilotReservations())[0];expect(reservation).toBeTruthy();
 await new Retention(web).deleteTenant(actor);await new Retention(maintenance,storage).run();expect(await storage.get(reservation.object_key)).toBeTruthy();expect((await db.query('select status from pitlane.deletion_requests where subject_id=$1',[T])).rows[0].status).toBe('pending');
 await db.query("update pitlane.artifact_attestations set created_at=now()-interval '25 hours',pilot_upload_until=now()-interval '1 second' where object_key=$1",[reservation.object_key]);expect(await new Retention(maintenance,storage).run()).toBe(1);await expect(storage.get(reservation.object_key)).rejects.toThrow();expect((await db.query('select status from pitlane.deletion_requests where subject_id=$1',[T])).rows[0].status).toBe('completed');expect(await pilotReservations()).toHaveLength(0);
});

it('fences orphan cleanup while an accepted retry crosses the original 24-hour expiry',async()=>{
 const {order,provider}=await pilot();await expect(new Orders(failingRegistration(),billing,provider,storage).deliverPilotSummary(actor,order.id,review)).rejects.toThrow('DATABASE_UNAVAILABLE');const reservation=(await pilotReservations())[0];await storage.remove(reservation.object_key);
 await db.query("update pitlane.artifact_attestations set created_at=now()-interval '24 hours'+interval '1 second',pilot_upload_until=now()-interval '1 second' where object_key=$1",[reservation.object_key]);
 let uploads=0;const delayed:StoragePort={put:async(key,bytes,type)=>{uploads++;expect(Date.parse((await pilotReservations())[0].pilot_upload_until)-Date.now()).toBeGreaterThan(240000);await db.query("update pitlane.artifact_attestations set created_at=now()-interval '25 hours' where object_key=$1",[key]);expect(await new Retention(maintenance,storage).run()).toBe(0);expect(await pilotReservations()).toHaveLength(1);await storage.put(key,bytes,type)},get:storage.get.bind(storage),remove:storage.remove.bind(storage)};
 await new Orders(web,billing,provider,delayed).deliverPilotSummary(actor,order.id,review);expect(uploads).toBe(1);expect((await db.query('select summary_artifact_id from pitlane.orders where id=$1',[order.id])).rows[0].summary_artifact_id).toBe(reservation.pilot_artifact_id);expect(await storage.get(reservation.object_key)).toBeTruthy();
});

it('denies a queued cleanup retry and registration with an expired upload lease',async()=>{
 const {order,provider}=await pilot();await expect(new Orders(failingRegistration(),billing,provider,storage).deliverPilotSummary(actor,order.id,review)).rejects.toThrow('DATABASE_UNAVAILABLE');const reservation=(await pilotReservations())[0];
 await db.query("update pitlane.artifact_attestations set created_at=now()-interval '25 hours',pilot_upload_until=now()-interval '1 second' where object_key=$1",[reservation.object_key]);
 await expect(web.transaction(tx=>tx.query('select pitlane.register_pilot_summary($1,$2,$3,$4,$5,$6)',[order.id,reservation.pilot_artifact_id,reservation.object_key,reservation.digest,reservation.bytes,review.minutes]),actor)).rejects.toThrow('ARTIFACT_EXPIRED');
 const purge=(await maintenance.query<{value:any[]}>('select pitlane.prepare_purge(10) as value')).rows[0].value;expect(purge).toHaveLength(1);expect(purge[0].object_key).toBe(reservation.object_key);
 let uploads=0;const tracked:StoragePort={put:async()=>{uploads++},get:storage.get.bind(storage),remove:storage.remove.bind(storage)};await expect(new Orders(web,billing,provider,tracked).deliverPilotSummary(actor,order.id,review)).rejects.toThrow('ARTIFACT_EXPIRED');expect(uploads).toBe(0);expect((await db.query('select count(*)::int n from pitlane.orphan_object_purge')).rows[0].n).toBe(1);
});
