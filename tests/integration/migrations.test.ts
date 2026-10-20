import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {readdir,readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {applyMigrations} from '../../scripts/migrations';
let admin:pg.Pool,db:pg.Pool;
const identifier='pitlane_migration_'+randomUUID().replaceAll('-','');
const previousRoot='.data/'+identifier+'/previous',badRoot='.data/'+identifier+'/modified';
beforeAll(async()=>{
 if(!/^pitlane_migration_[a-f0-9]{32}$/.test(identifier))throw new Error('INVALID_FIXTURE_DATABASE');
 admin=new pg.Pool({connectionString:process.env.PITLANE_TEST_DATABASE_URL,max:2});await admin.query(`create database "${identifier}"`);
 const url=new URL(process.env.PITLANE_TEST_DATABASE_URL!);url.pathname='/'+identifier;db=new pg.Pool({connectionString:url.toString(),max:5});
 await mkdir(previousRoot,{recursive:true});await mkdir(badRoot,{recursive:true});
 for(const name of (await readdir('db/migrations')).filter(n=>n.endsWith('.sql')&&Number(n.slice(0,3))<=27))await writeFile(previousRoot+'/'+name,await readFile('db/migrations/'+name));
 await writeFile(badRoot+'/001_access.sql',(await readFile('db/migrations/001_access.sql','utf8'))+'\n-- altered applied source\n');
});
afterAll(async()=>{await db?.end();if(admin){await admin.query(`drop database "${identifier}"`);await admin.end();}});
it('migrates an empty database through the previous schema and preserves its rows on upgrade',async()=>{
 await applyMigrations(db,previousRoot);await db.query("insert into pitlane.runtime values(true,'local')");
 await applyMigrations(db);expect((await db.query("select to_regclass('pitlane.jobs') as name")).rows[0].name).toBe('pitlane.jobs');expect((await db.query("select to_regclass('pitlane.receipt_versions') as name")).rows[0].name).toBe('pitlane.receipt_versions');expect((await db.query('select mode from pitlane.runtime')).rows[0].mode).toBe('local');expect((await db.query("select to_regclass('pitlane.provider_health') as name")).rows[0].name).toBe('pitlane.provider_health');
});
it('serializes concurrent migrators and does not reapply recorded migrations',async()=>{
 const before=(await db.query('select name,sha256,applied_at from pitlane.schema_migrations order by name')).rows;
 await Promise.all(Array.from({length:20},()=>applyMigrations(db)));
 expect((await db.query('select name,sha256,applied_at from pitlane.schema_migrations order by name')).rows).toEqual(before);
});
it('refuses altered source for an already-applied migration before applying changes',async()=>{
 await expect(applyMigrations(db,badRoot)).rejects.toThrow('MIGRATION_CHECKSUM_MISMATCH:001_access.sql');expect((await db.query('select mode from pitlane.runtime')).rows[0].mode).toBe('local');
});
