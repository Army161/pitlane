import pg from 'pg';
import next from 'next';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {startLocalPostgres} from './local-postgres';
import {applyMigrations} from './migrations';
import {seedLocalFixtures} from './local-fixtures';
import {PostgresDb} from '../packages/adapters/src/postgres';
import {WorkerService} from '../apps/worker/src/service';
if(process.env.PITLANE_MODE && process.env.PITLANE_MODE !== 'local') throw new Error('LOCAL_DEV_PROHIBITED');
const port = Number(process.env.PITLANE_LOCAL_DB_PORT ?? 55432);
const webPort = Number(process.env.PITLANE_WEB_PORT ?? 3000);
const cluster = await startLocalPostgres(process.env.PITLANE_LOCAL_DB_DIR ?? '.data/dev-postgres', port);
const pool = new pg.Pool({connectionString:cluster.url,max:1});
try { await applyMigrations(pool); await seedLocalFixtures(pool); } finally { await pool.end(); }
Object.assign(process.env, {PITLANE_MODE:'local',PITLANE_LOCAL_DB_PORT:String(port),PITLANE_WEB_DATABASE_URL:cluster.url,PITLANE_AUTH_DATABASE_URL:cluster.url,PITLANE_ORIGIN:`http://127.0.0.1:${webPort}`,NEXT_TELEMETRY_DISABLED:'1'});
const db = new PostgresDb(cluster.url,'pitlane_worker');
const worker = new WorkerService({db,id:'local-development-worker',mode:'local',build:'local-development',storageRoot:process.env.PITLANE_LOCAL_STORAGE_DIR ?? '.data/artifacts'});
await worker.heartbeat();
const timer = setInterval(()=>void worker.tick().catch(()=>process.stderr.write('Local worker attempt interrupted.\n')),1000);
const beat = setInterval(()=>void worker.heartbeat().catch(()=>{}),15000);
// A custom coordinator is used for local tests only; hosted builds use next start.
const app = next({dev:process.env.PITLANE_E2E_PRODUCTION !== 'true',dir:resolve('apps/web'),hostname:'127.0.0.1',port:webPort});
await app.prepare();
const server = createServer((req,res)=>void app.getRequestHandler()(req,res));
await new Promise<void>(r=>server.listen(webPort,'127.0.0.1',r));
let stopping=false;
let control:ReturnType<typeof createServer>|undefined;
async function stop() {
 if(stopping)return;stopping=true;clearInterval(timer);clearInterval(beat);
 control?.close();server.close();server.closeIdleConnections();
 await worker.drain().catch(()=>{});await app.close();
 await (globalThis as typeof globalThis&{__pitlaneRuntime?:{close:()=>Promise<void>}}).__pitlaneRuntime?.close();
 await db.close();await cluster.stop();process.exit(0);
}
if(process.env.PITLANE_TEST_CONTROL_TOKEN && process.env.PITLANE_TEST_CONTROL_PORT) {
 const token=process.env.PITLANE_TEST_CONTROL_TOKEN;
 control=createServer((req,res)=>{
  if(req.method!=='POST'||req.url!=='/stop'||req.headers.authorization!==`Bearer ${token}`){res.writeHead(404).end();return;}
  res.writeHead(200).end('stopping');setTimeout(()=>void stop(),10);
 });
 await new Promise<void>(r=>control!.listen(Number(process.env.PITLANE_TEST_CONTROL_PORT),'127.0.0.1',r));
}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
console.log(`PITLANE fixture workshop http://127.0.0.1:${webPort}`);
