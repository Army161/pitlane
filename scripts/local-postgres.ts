import EmbeddedPostgres from 'embedded-postgres';
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {dirname,join,resolve} from 'node:path';import {mkdir,access} from 'node:fs/promises';import {spawn,execFile} from 'node:child_process';import {promisify} from 'node:util';import pg from 'pg';
export async function startLocalPostgres(dir:string,port:number,user='pitlane_local'){
 const path=resolve(dir);await mkdir(path,{recursive:true});const init=new EmbeddedPostgres({databaseDir:path,port,user,password:'local-test-only',persistent:true,createPostgresUser:false,initdbFlags:['--encoding=UTF8'],onLog:()=>{},onError:()=>{}});
 try{await access(join(path,'PG_VERSION'))}catch{await init.initialise()}
 const req=createRequire(import.meta.url);const binaryModule=await import(pathToFileURL(join(dirname(req.resolve('embedded-postgres')),'binary.js')).href);const bins=await binaryModule.default();
 const child=spawn(bins.postgres,['-D',path,'-p',String(port),'-h','127.0.0.1'],{windowsHide:true,stdio:'ignore'});let spawnError:Error|undefined;child.on('error',e=>{spawnError=e});
 const url=`postgres://${user}:local-test-only@127.0.0.1:${port}/postgres`;let ready=false;
 for(let i=0;i<100;i++){if(spawnError)throw spawnError;if(child.exitCode!==null)throw new Error('Local Postgres exited');const c=new pg.Client({connectionString:url,connectionTimeoutMillis:200});try{await c.connect();await c.end();ready=true;break}catch{await c.end().catch(()=>{});await new Promise(r=>setTimeout(r,100))}}
 if(!ready){child.kill();throw new Error('Local Postgres did not become ready')}
 return {url,stop:async()=>{await promisify(execFile)(join(dirname(bins.postgres),process.platform==='win32'?'pg_ctl.exe':'pg_ctl'),['-D',path,'-m','fast','-w','stop'],{windowsHide:true,timeout:15000})}};
}
