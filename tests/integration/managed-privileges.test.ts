import {afterAll,beforeAll,expect,it} from 'vitest';
import pg from 'pg';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {mkdir,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {startLocalPostgres} from '../../scripts/local-postgres';
import {applyMigrations} from '../../scripts/migrations';
/**
 * Managed Postgres hosts (for example Supabase) give the migrator an administrator that is not a superuser.
 * This proves every migration applies in a fresh cluster under that privilege shape, with no pre-existing PITLANE roles.
 */
let cluster:{url:string;stop:()=>Promise<void>}|undefined,admin:pg.Pool|undefined,owner:pg.Pool|undefined;const dir=resolve('.data','managed-'+randomUUID());
const password='managed-test-only';
beforeAll(async()=>{
 const port=await new Promise<number>(done=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const p=(server.address() as {port:number}).port;server.close(()=>done(p))})});
 await mkdir(dir,{recursive:true});cluster=await startLocalPostgres(dir,port,'pitlane_cluster');admin=new pg.Pool({connectionString:cluster.url,max:1});
 await admin.query(`create role managed_admin login password '${password}' nosuperuser createrole createdb bypassrls`);
 await admin.query('create database managed owner managed_admin');
 const url=new URL(cluster.url);url.username='managed_admin';url.password=password;url.pathname='/managed';owner=new pg.Pool({connectionString:url.toString(),max:2});
},120000);
afterAll(async()=>{await owner?.end();await admin?.end();await cluster?.stop();await rm(dir,{recursive:true,force:true});});
it('applies every migration as a non-superuser administrator and leaves service roles without login or RLS bypass',async()=>{
 const self=(await owner!.query('select rolsuper from pg_roles where rolname=current_user')).rows[0];expect(self.rolsuper).toBe(false);
 await applyMigrations(owner!);
 const applied=(await owner!.query('select count(*)::int as n,max(name) as last from pitlane.schema_migrations')).rows[0];
 expect(applied.n).toBeGreaterThanOrEqual(37);expect(applied.last).toMatch(/^037_/);
 const roles=(await owner!.query("select rolname,rolcanlogin,rolbypassrls,rolsuper from pg_roles where rolname like 'pitlane\\_%' and rolname<>'pitlane_cluster' order by rolname")).rows;
 expect(roles.map(r=>r.rolname)).toEqual(['pitlane_artifact','pitlane_auth','pitlane_billing','pitlane_gateway','pitlane_maintenance','pitlane_web','pitlane_worker']);
 for(const role of roles)expect([role.rolcanlogin,role.rolbypassrls,role.rolsuper]).toEqual([false,false,false]);
 const definers=(await owner!.query("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='pitlane' and p.prosecdef and pg_get_userbyid(p.proowner)<>'managed_admin'")).rows[0];
 expect(definers.n).toBe(0);
 await applyMigrations(owner!);expect((await owner!.query('select count(*)::int as n from pitlane.schema_migrations')).rows[0].n).toBe(applied.n);
},180000);
