import {PostgresDb} from '../../../packages/adapters/src/postgres';
import {serviceStorage} from '../../../packages/adapters/src/service-storage';
import {startService,isEntrypoint,installShutdown} from '../../../packages/adapters/src/service-host';
import {loadConfig,databaseUrl} from '../../../packages/core/src/config';
import {serviceBuild,validateStartup} from '../../../packages/core/src/startup';
import {Retention} from '../../../packages/core/src/retention';
export async function main(env:Record<string,string|undefined>=process.env){
 const config=loadConfig(env),build=serviceBuild(env,config),db=new PostgresDb(databaseUrl(env,'MAINTENANCE'),'pitlane_maintenance');
 try{
  await validateStartup(db,config,'pitlane_maintenance',build);const retention=new Retention(db,await serviceStorage(env,config));
  const service=await startService({name:'maintenance',port:Number(env.PORT??3005),host:config.mode==='local'?'127.0.0.1':'0.0.0.0',tick:()=>retention.run(),intervalMs:60000,details:()=>({mode:config.mode,build}),heartbeat:()=>validateStartup(db,config,'pitlane_maintenance',build),close:()=>db.close()});
  installShutdown(service,config.mode);return service;
 }catch(error){await db.close();throw error;}
}
if(isEntrypoint(import.meta.url))void main().catch(()=>{process.stderr.write('PITLANE maintenance startup failed.\n');process.exitCode=1;});
