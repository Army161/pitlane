// This drill accepts locally owned fixtures only. Production backup provisioning
// and backup expiry are separate operational work.
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import pg from 'pg';
import {z} from 'zod';
import type {StoragePort} from '../packages/contracts/src';
import {applyMigrations} from './migrations';

const objectKey=z.string().min(1).max(1024).regex(/^[A-Za-z0-9_./-]+$/).refine(x=>!x.split('/').includes('..')&&!x.startsWith('/'));
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const entry=z.object({file:z.string(),sha256:digest,bytes:z.number().int().nonnegative()}).strict();
const manifestSchema=z.object({schema:z.literal('pitlane.isolated-backup.v1'),createdAt:z.string(),fixtureDatabase:z.string().regex(/^pitlane_retention_fixture_[a-z0-9_]+$/),database:entry.extend({file:z.literal('database.json')}),migrations:z.array(entry.extend({file:z.string().regex(/^migrations\/\d+_[a-z0-9_]+\.sql$/)})).min(1).max(1000),objects:z.array(entry.extend({key:objectKey,file:z.string().regex(/^objects\/\d{6}\.bin$/)})).max(1000)}).strict();
const snapshotSchema=z.object({format:z.literal('pitlane.fixture-table-snapshot.v1'),tables:z.array(z.object({name:z.string().regex(/^[a-z_][a-z0-9_]*$/),rows:z.array(z.string())}).strict()).max(1000)}).strict();
export type IsolatedBackupManifest=z.infer<typeof manifestSchema>;
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function fixtureDatabase(databaseUrl:string){
 const url=new URL(databaseUrl);const name=url.pathname.slice(1);
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/^pitlane_retention_fixture_[a-z0-9_]+$/.test(name)||url.search||url.hash)throw new Error('ISOLATED_FIXTURE_DATABASE_REQUIRED');
 return {url,name};
}
function bundleFile(directory:string,file:string){const root=resolve(directory),path=resolve(root,file);if(!path.startsWith(root+sep))throw new Error('INVALID_BACKUP_PATH');return path}

export async function backupIsolatedFixture(options:{databaseUrl:string;storage:StoragePort;objectKeys:string[];directory:string;migrationRoot?:string}):Promise<IsolatedBackupManifest>{
 const {name}=fixtureDatabase(options.databaseUrl);
 if(options.objectKeys.length>1000||new Set(options.objectKeys).size!==options.objectKeys.length||options.objectKeys.some(x=>!objectKey.safeParse(x).success))throw new Error('INVALID_BACKUP_OBJECTS');
 await mkdir(resolve(options.directory),{recursive:false});await mkdir(bundleFile(options.directory,'objects'));await mkdir(bundleFile(options.directory,'migrations'));
 const pool=new pg.Pool({connectionString:options.databaseUrl});const client=await pool.connect();const tables:z.infer<typeof snapshotSchema>['tables']=[];const migrations:IsolatedBackupManifest['migrations']=[];
 try{
  await client.query('begin isolation level repeatable read read only');
  const registered=(await client.query<{name:string;sha256:string}>('select name,sha256 from pitlane.schema_migrations order by name')).rows;
  for(const migration of registered){
   if(!/^\d+_[a-z0-9_]+\.sql$/.test(migration.name))throw new Error('INVALID_BACKUP_MIGRATION');
   const bytes=await readFile(resolve(options.migrationRoot??'db/migrations',migration.name));if(sha(bytes)!==migration.sha256)throw new Error('BACKUP_MIGRATION_MISMATCH');
   const file=`migrations/${migration.name}`;await writeFile(bundleFile(options.directory,file),bytes,{flag:'wx'});migrations.push({file,sha256:sha(bytes),bytes:bytes.length});
  }
  const names=(await client.query<{name:string}>("select c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pitlane' and c.relkind='r' order by c.relname")).rows;
  for(const {name:table} of names){if(!/^[a-z_][a-z0-9_]*$/.test(table))throw new Error('INVALID_BACKUP_TABLE');const rows=(await client.query<{body:string}>(`select row_to_json(t)::text as body from pitlane.${table} t order by row_to_json(t)::text`)).rows.map(x=>x.body);tables.push({name:table,rows});}
  await client.query('commit');
 }catch(error){await client.query('rollback').catch(()=>{});throw error}finally{client.release();await pool.end()}
 // JSON row bodies stay encoded strings, preserving Postgres bigint/numeric text.
 const database=Buffer.from(JSON.stringify({format:'pitlane.fixture-table-snapshot.v1',tables}));await writeFile(bundleFile(options.directory,'database.json'),database,{flag:'wx'});
 const objects:IsolatedBackupManifest['objects']=[];
 for(const [index,key] of [...options.objectKeys].sort().entries()){
  const bytes=await options.storage.get(key);const file=`objects/${String(index).padStart(6,'0')}.bin`;await writeFile(bundleFile(options.directory,file),bytes,{flag:'wx'});objects.push({key,file,sha256:sha(bytes),bytes:bytes.length});
 }
 const manifest:IsolatedBackupManifest={schema:'pitlane.isolated-backup.v1',createdAt:new Date().toISOString(),fixtureDatabase:name,database:{file:'database.json',sha256:sha(database),bytes:database.length},migrations,objects};
 await writeFile(bundleFile(options.directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});return manifest;
}

export async function verifyIsolatedBackup(directory:string):Promise<IsolatedBackupManifest>{
 if((await stat(bundleFile(directory,'manifest.json'))).size>1024*1024)throw new Error('INVALID_BACKUP_MANIFEST');
 const manifest=manifestSchema.parse(JSON.parse(await readFile(bundleFile(directory,'manifest.json'),'utf8')));
 if(new Set(manifest.objects.map(x=>x.key)).size!==manifest.objects.length||new Set(manifest.objects.map(x=>x.file)).size!==manifest.objects.length||new Set(manifest.migrations.map(x=>x.file)).size!==manifest.migrations.length)throw new Error('INVALID_BACKUP_MANIFEST');
 for(const item of [manifest.database,...manifest.migrations,...manifest.objects]){const bytes=await readFile(bundleFile(directory,item.file));if(bytes.length!==item.bytes||sha(bytes)!==item.sha256)throw new Error('BACKUP_DIGEST_MISMATCH');}
 return manifest;
}

export async function restoreIsolatedFixture(options:{databaseUrl:string;storage:StoragePort;directory:string}):Promise<IsolatedBackupManifest>{
 fixtureDatabase(options.databaseUrl);const manifest=await verifyIsolatedBackup(options.directory);
 const snapshot=snapshotSchema.parse(JSON.parse(await readFile(bundleFile(options.directory,manifest.database.file),'utf8')));
 if(new Set(snapshot.tables.map(x=>x.name)).size!==snapshot.tables.length||!snapshot.tables.some(x=>x.name==='schema_migrations'))throw new Error('INVALID_BACKUP_SNAPSHOT');
 const pool=new pg.Pool({connectionString:options.databaseUrl});try{
  if((await pool.query("select exists(select from pg_namespace where nspname='pitlane') as present")).rows[0].present)throw new Error('RESTORE_TARGET_NOT_EMPTY');
  await applyMigrations(pool,bundleFile(options.directory,'migrations'));
  const client=await pool.connect();try{
   await client.query('begin');await client.query("set local session_replication_role='replica'");
   await client.query(`truncate ${snapshot.tables.map(x=>`pitlane.${x.name}`).join(',')} cascade`);
   for(const table of snapshot.tables)for(const row of table.rows)await client.query(`insert into pitlane.${table.name} select (json_populate_record(null::pitlane.${table.name},$1::json)).*`,[row]);
   await client.query('commit');
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }finally{await pool.end()}
 for(const item of manifest.objects){const bytes=await readFile(bundleFile(options.directory,item.file));await options.storage.put(item.key,bytes,'application/json');if(sha(await options.storage.get(item.key))!==item.sha256)throw new Error('RESTORED_OBJECT_DIGEST_MISMATCH');}
 return manifest;
}