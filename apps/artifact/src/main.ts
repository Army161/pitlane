import {PostgresDb} from '../../../packages/adapters/src/postgres';
import {artifactApiHandler} from '../../../packages/adapters/src/artifact-api';
import {serviceStorage} from '../../../packages/adapters/src/service-storage';
import {startService,isEntrypoint,installShutdown} from '../../../packages/adapters/src/service-host';
import {loadConfig,databaseUrl,required} from '../../../packages/core/src/config';
import {serviceBuild,validateStartup} from '../../../packages/core/src/startup';
export async function main(env:Record<string,string|undefined>=process.env){
 const config=loadConfig(env),build=serviceBuild(env,config),db=new PostgresDb(databaseUrl(env,'ARTIFACT'),'pitlane_artifact');
 try{
  await validateStartup(db,config,'pitlane_artifact',build);const storage=await serviceStorage(env,config);
  const handler=artifactApiHandler({db,storage,token:required(env,'PITLANE_ARTIFACT_API_TOKEN')});
  const service=await startService({name:'artifact',port:Number(env.PORT??3003),host:config.mode==='local'?'127.0.0.1':'0.0.0.0',handler,details:()=>({mode:config.mode,build}),heartbeat:()=>validateStartup(db,config,'pitlane_artifact',build),close:()=>db.close()});
  installShutdown(service,config.mode);return service;
 }catch(error){await db.close();throw error;}
}
if(isEntrypoint(import.meta.url))void main().catch(()=>{process.stderr.write('PITLANE artifact startup failed.\n');process.exitCode=1;});
