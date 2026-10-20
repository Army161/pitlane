import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {dirname,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {startLocalPostgres} from './local-postgres';
import {applyMigrations} from './migrations';
import {seedLocalFixtures,LOCAL} from './local-fixtures';
import {SERVICE_SCHEMA_VERSION} from '../packages/core/src/startup';
import {isEntrypoint} from '../packages/adapters/src/service-host';

const workspace=resolve(import.meta.dirname,'..');
async function freePort(){
 return new Promise<number>((done,reject)=>{
  const server=createServer();server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>{const port=(server.address() as {port:number}).port;server.close(error=>error?reject(error):done(port));});
 });
}
function ensure(condition:unknown,code:string):asserts condition{if(!condition)throw new Error(code);}
async function stopChild(child:ChildProcess){
 if(!child.pid||child.exitCode!==null||child.signalCode!==null)return;
 let finished=false;const exited=new Promise<void>(done=>child.once('exit',()=>{finished=true;done();}));
 child.kill('SIGTERM');await Promise.race([exited,delay(5000,undefined,{ref:false})]);
 if(!finished){child.kill('SIGKILL');await Promise.race([exited,delay(5000,undefined,{ref:false})]);}
 ensure(finished,'STANDALONE_PROCESS_CLEANUP_FAILED');
}
function cookiePair(response:Response,name:string){
 const value=response.headers.getSetCookie().find(value=>value.startsWith(name+'='));
 ensure(value,'STANDALONE_AUTH_COOKIE_MISSING');return value.split(';')[0];
}
export async function verifyStandalone(){
 ensure(!process.env.PITLANE_MODE||process.env.PITLANE_MODE==='local','LOCAL_STANDALONE_CHECK_REQUIRED');
 const serverFile=resolve(workspace,'apps/web/.next/standalone/apps/web/server.js'),nextRoot=resolve(dirname(serverFile),'.next');
 await access(serverFile);
 const manifest=JSON.parse(await readFile(resolve(workspace,'.dist/build-manifest.json'),'utf8'));
 const requiredFiles=JSON.parse(await readFile(resolve(nextRoot,'required-server-files.json'),'utf8'));
 const webBuild=requiredFiles.config?.env?.PITLANE_WEB_COMPILED_BUILD;
 const nextBuildId=(await readFile(resolve(nextRoot,'BUILD_ID'),'utf8')).trim();
 ensure(manifest.schema==='pitlane.build.v1'&&manifest.serviceSchema===SERVICE_SCHEMA_VERSION,'STANDALONE_BUILD_SCHEMA_MISMATCH');
 ensure(typeof webBuild==='string'&&webBuild===manifest.build&&nextBuildId,'STANDALONE_BUILD_IDENTITY_MISMATCH');
 const directory=resolve(workspace,'.data','standalone-'+randomUUID());await mkdir(directory,{recursive:true});
 const evidenceFile=resolve(directory,'verification.json');
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),90000);timeout.unref();
 const interrupt=()=>controller.abort();process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
 let postgres:Awaited<ReturnType<typeof startLocalPostgres>>|undefined,pool:pg.Pool|undefined,child:ChildProcess|undefined;
 let failure:unknown;const checks:Record<string,unknown>={};const cleanupErrors:string[]=[];let output='';
 try{
  postgres=await startLocalPostgres(resolve(directory,'postgres'),await freePort(),'pitlane_standalone');
  pool=new pg.Pool({connectionString:postgres.url,max:1,connectionTimeoutMillis:3000,statement_timeout:10000});
  await applyMigrations(pool,resolve(workspace,'db/migrations'));await seedLocalFixtures(pool);
  const runtime=(await pool.query('select pitlane.runtime_info() as value')).rows[0].value;
  ensure(runtime.schema_version===SERVICE_SCHEMA_VERSION&&runtime.mode==='local','STANDALONE_DATABASE_SCHEMA_MISMATCH');
  checks.databaseSchema=runtime.schema_version;
  const port=await freePort(),origin=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,[serverFile],{cwd:workspace,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
   NODE_ENV:'production',NODE_OPTIONS:'',NEXT_TELEMETRY_DISABLED:'1',HOSTNAME:'127.0.0.1',PORT:String(port),
   PITLANE_MODE:'local',PITLANE_ENVIRONMENT_ID:'local-fixture',PITLANE_AUTH_MODE:'fixture',PITLANE_STORAGE_MODE:'local',
   PITLANE_RPC_MODE:'fixture',PITLANE_BILLING_MODE:'disabled',PITLANE_AI_MODE:'disabled',PITLANE_BUILD_SHA:webBuild,
   PITLANE_WEB_DATABASE_URL:postgres.url,PITLANE_AUTH_DATABASE_URL:postgres.url,PITLANE_ORIGIN:origin,
   PITLANE_LOCAL_STORAGE_DIR:resolve(directory,'artifacts')
  }});
  let spawnError:Error|undefined;child.once('error',error=>{spawnError=error;});
  const capture=(bytes:Buffer)=>{output=(output+bytes.toString()).slice(-8192);};child.stdout!.on('data',capture);child.stderr!.on('data',capture);
  const request=async(path:string,init:RequestInit={})=>{
   const url=new URL(path,origin);ensure(url.origin===origin,'STANDALONE_EXTERNAL_REQUEST_PROHIBITED');
   return fetch(url,{...init,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])});
  };
  const deadline=Date.now()+30000;let healthy=false;
  while(Date.now()<deadline){
   controller.signal.throwIfAborted();if(spawnError)throw spawnError;
   ensure(child.exitCode===null&&child.signalCode===null,'STANDALONE_SERVER_EXITED');
   try{const response=await request('/health');if(response.status===200){const health=await response.json();ensure(health.ready===true&&health.mode==='local'&&health.origin==='fixture','STANDALONE_HEALTH_IDENTITY_MISMATCH');healthy=true;checks.health=200;break;}}catch(error){if(controller.signal.aborted)throw error;}
   await delay(100,undefined,{signal:controller.signal});
  }
  ensure(healthy,'STANDALONE_HEALTH_TIMEOUT');
  const htmlResponse=await request('/garage');ensure(htmlResponse.status===200,'STANDALONE_HTML_REJECTED');
  const html=await htmlResponse.text();ensure(/<html\b/i.test(html)&&html.includes('PITLANE'),'STANDALONE_HTML_MISSING');checks.html=200;
  const assets=[...html.matchAll(/(?:href|src)="([^"]*\/_next\/static\/[^"]+)"/g)].map(match=>match[1].replaceAll('&amp;','&'));
  const asset=assets.find(path=>{const url=new URL(path,origin);return url.origin===origin&&url.pathname.startsWith('/_next/static/');});
  ensure(asset,'STANDALONE_STATIC_ASSET_MISSING');const staticResponse=await request(asset);ensure(staticResponse.status===200&&(await staticResponse.arrayBuffer()).byteLength>0,'STANDALONE_STATIC_ASSET_REJECTED');checks.staticAsset=asset;checks.staticStatus=200;
  const stateResponse=await request('/v1/auth/state');ensure(stateResponse.status===200,'STANDALONE_AUTH_STATE_REJECTED');
  const state=await stateResponse.json();ensure(typeof state.nonce==='string'&&state.mode==='local','STANDALONE_AUTH_STATE_MISSING');
  const login=await request('/v1/auth/fixture',{method:'POST',headers:{'content-type':'application/json',origin,cookie:cookiePair(stateResponse,'pitlane_login_nonce')},body:JSON.stringify({fixture:'first',nonce:state.nonce})});
  ensure(login.status===200,'STANDALONE_FIXTURE_LOGIN_REJECTED');const session=cookiePair(login,'pitlane_session');
  const meResponse=await request('/v1/me',{headers:{cookie:session}});ensure(meResponse.status===200,'STANDALONE_AUTHENTICATED_REQUEST_REJECTED');
  const me=await meResponse.json();ensure(me.user_id===LOCAL.user&&me.tenant_id===LOCAL.tenant&&me.origin==='fixture','STANDALONE_ACCOUNT_SCOPE_MISMATCH');checks.authenticatedFixture=true;
  const logout=await request('/v1/auth/logout',{method:'POST',headers:{cookie:session,origin,'x-csrf-token':me.csrf}});ensure(logout.status===200,'STANDALONE_LOGOUT_REJECTED');
  ensure((await request('/v1/me',{headers:{cookie:session}})).status===401,'STANDALONE_LOGOUT_NOT_REVOKED');checks.logoutRevoked=true;
 }catch(error){failure=error;}
 finally{
  clearTimeout(timeout);process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
  if(child)try{await stopChild(child);}catch(error){cleanupErrors.push(error instanceof Error?error.message:'STANDALONE_PROCESS_CLEANUP_FAILED');}
  if(pool)try{await pool.end();}catch{cleanupErrors.push('STANDALONE_POOL_CLEANUP_FAILED');}
  if(postgres)try{await postgres.stop();}catch{cleanupErrors.push('STANDALONE_DATABASE_CLEANUP_FAILED');}
 }
 const result={schema:'pitlane.standalone-verification.v1',passed:!failure&&cleanupErrors.length===0,serviceSchema:SERVICE_SCHEMA_VERSION,build:webBuild,nextBuildId,entrypoint:serverFile,checks,cleanup:{serverStopped:!child||child.exitCode!==null||child.signalCode!==null,databaseStopped:!cleanupErrors.includes('STANDALONE_DATABASE_CLEANUP_FAILED'),errors:cleanupErrors},...(failure?{error:failure instanceof Error?failure.message:'STANDALONE_VERIFICATION_FAILED',serverOutput:output}:{})};
 await writeFile(evidenceFile,JSON.stringify(result,null,2)+'\n');
 process.stdout.write(JSON.stringify({...result,evidenceFile})+'\n');
 ensure(result.passed,'STANDALONE_VERIFICATION_FAILED');return result;
}
if(isEntrypoint(import.meta.url)){
 try{await verifyStandalone();}
 catch(error){
  await new Promise<void>(done=>process.stderr.write((error instanceof Error?error.message:'STANDALONE_VERIFICATION_FAILED')+'\n',()=>done()));
  // Verification and owned-process cleanup have completed; report failure deterministically.
  process.exit(1);
 }
}
