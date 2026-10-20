import {afterAll,beforeAll,expect,it} from 'vitest';
import pg from 'pg';
import {resolve} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {database,seed,T,P,U} from './support';
import {applyMigrations} from '../../scripts/migrations';
import {backupIsolatedFixture,restoreIsolatedFixture,verifyIsolatedBackup} from '../../scripts/retention-backup';
import {PostgresDb} from '../../packages/adapters/src/postgres';
import {Quotes} from '../../packages/core/src/quotes';
import {Jobs} from '../../packages/core/src/jobs';
import {Artifacts,LocalStorage} from '../../packages/core/src/artifacts';
import {FixtureRpc,Inspector} from '../../apps/worker/src/runner';
import {rawDigest} from '../../packages/evidence/src/canonical';
import {verifyReceiptEvidence} from '../../packages/evidence/src/replay';
import {input} from '../fixtures/observations';

let admin:pg.Pool;const suffix=`${process.pid}_${Date.now()}`;
const sourceName=`pitlane_retention_fixture_source_${suffix}`,targetName=`pitlane_retention_fixture_target_${suffix}`;
const root=resolve('.data',`retention-backup-${suffix}`);
beforeAll(async()=>{admin=await database();await admin.query(`create database ${sourceName}`);await admin.query(`create database ${targetName}`)});
afterAll(async()=>{await admin.query(`drop database if exists ${sourceName} with (force)`);await admin.query(`drop database if exists ${targetName} with (force)`);await admin.end()});
function fixtureUrl(name:string){const url=new URL(process.env.PITLANE_TEST_DATABASE_URL!);url.pathname=`/${name}`;return url.toString()}

it('restores an owned fixture database and exact object bytes, verifies manifest digests, and rejects corruption before restore',async()=>{
 const source=new pg.Pool({connectionString:fixtureUrl(sourceName)});const web=new PostgresDb(fixtureUrl(sourceName));const worker=new PostgresDb(fixtureUrl(sourceName),'pitlane_worker');
 const original=new LocalStorage(resolve(root,'original-objects'));const restored=new LocalStorage(resolve(root,'restored-objects'));
 try{
  await applyMigrations(source);await seed(source);await source.query("insert into pitlane.budgets(key,maximum) values('backup-bigint-fixture',9007199254740993)");const actor={tenantId:T,userId:U};const q=await new Quotes(web).quote(actor,{...input,projectId:P});await new Quotes(web).submit(actor,q.id,'isolated-backup-fixture-request');
  const jobs=new Jobs(worker);await new Inspector(jobs,new Artifacts(worker,original),new FixtureRpc('local'),[{id:'fixture-a',upstreamId:'a',maximumMicro:'100'},{id:'fixture-b',upstreamId:'b',maximumMicro:'100'}]).inspect((await jobs.claim('isolated-backup-fixture'))!);
  const objects=(await source.query('select object_key,digest from pitlane.artifacts')).rows;const bundle=resolve(root,'bundle');
  const manifest=await backupIsolatedFixture({databaseUrl:fixtureUrl(sourceName),storage:original,objectKeys:objects.map(x=>x.object_key),directory:bundle});
  expect(manifest.objects).toHaveLength(1);expect(manifest.database.bytes).toBeGreaterThan(1000);
  expect(await verifyIsolatedBackup(bundle)).toEqual(manifest);
  await restoreIsolatedFixture({databaseUrl:fixtureUrl(targetName),storage:restored,directory:bundle});
  const target=new pg.Pool({connectionString:fixtureUrl(targetName)});
  try{
   const receipt=(await target.query('select * from pitlane.receipt_versions')).rows[0];
   expect(verifyReceiptEvidence(receipt.payload)).toMatchObject({ok:true});
   const bytes=await restored.get(objects[0].object_key);expect(rawDigest(bytes)).toBe(objects[0].digest);expect(JSON.parse(Buffer.from(bytes).toString('utf8'))).toEqual(receipt.payload);
   expect((await target.query('select count(*)::int n from pitlane.schema_migrations')).rows[0].n).toBe((await source.query('select count(*)::int n from pitlane.schema_migrations')).rows[0].n);
   expect((await target.query("select maximum::text value from pitlane.budgets where key='backup-bigint-fixture'")).rows[0].value).toBe('9007199254740993');
  }finally{await target.end()}
  const saved=await readFile(resolve(bundle,manifest.objects[0].file));await writeFile(resolve(bundle,manifest.objects[0].file),Buffer.from('corrupt evidence'));
  await expect(verifyIsolatedBackup(bundle)).rejects.toThrow('BACKUP_DIGEST_MISMATCH');
  await expect(restoreIsolatedFixture({databaseUrl:fixtureUrl(targetName),storage:restored,directory:bundle})).rejects.toThrow('BACKUP_DIGEST_MISMATCH');
  await writeFile(resolve(bundle,manifest.objects[0].file),saved);
  await expect(restoreIsolatedFixture({databaseUrl:fixtureUrl(targetName),storage:restored,directory:bundle})).rejects.toThrow('RESTORE_TARGET_NOT_EMPTY');
 }finally{await Promise.all([source.end(),web.close(),worker.close()])}
});

it('refuses regular or remote database URLs so the isolated drill cannot copy tenant resources',async()=>{
 const s=new LocalStorage(resolve(root,'guard-objects'));
 await expect(backupIsolatedFixture({databaseUrl:process.env.PITLANE_TEST_DATABASE_URL!,storage:s,objectKeys:[],directory:resolve(root,'guard-bundle')})).rejects.toThrow('ISOLATED_FIXTURE_DATABASE_REQUIRED');
 await expect(backupIsolatedFixture({databaseUrl:'postgres://fixture:local@db.example/pitlane_retention_fixture_a',storage:s,objectKeys:[],directory:resolve(root,'guard-bundle')})).rejects.toThrow('ISOLATED_FIXTURE_DATABASE_REQUIRED');
});
