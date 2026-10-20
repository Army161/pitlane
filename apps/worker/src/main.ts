import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {PostgresDb} from '../../../packages/adapters/src/postgres';
import {GatewayRpc} from '../../../packages/adapters/src/solana-rpc';
import {ArtifactApiStorage} from '../../../packages/adapters/src/artifact-api';
import {workerEndpoints} from '../../../packages/adapters/src/provider-config';
import {startService,isEntrypoint,installShutdown} from '../../../packages/adapters/src/service-host';
import {loadConfig,databaseUrl,required} from '../../../packages/core/src/config';
import {serviceBuild,validateProviderRegistry} from '../../../packages/core/src/startup';
import {WorkerService} from './service';
export async function main(env:Record<string,string|undefined>=process.env){
 const config=loadConfig(env),build=serviceBuild(env,config),db=new PostgresDb(databaseUrl(env,'WORKER'),'pitlane_worker');
 try{
  const hosted=config.mode!=='local';
  const endpoints=hosted?workerEndpoints(env):undefined;
  const worker=new WorkerService({db,config,id:env.PITLANE_WORKER_ID??`${hostname()}-${randomUUID()}`,mode:config.mode,build,storageRoot:env.PITLANE_LOCAL_STORAGE_DIR??'.data/artifacts',fixtureReadDelayMs:hosted?0:Number(env.PITLANE_FIXTURE_READ_DELAY_MS??0),...(hosted?{
   providers:validateProviderRegistry(JSON.parse(required(env,'PITLANE_WORKER_PROVIDERS'))),
   rpcFactory:l=>new GatewayRpc(endpoints!.gatewayUrl,endpoints!.gatewayToken,l),
   storageFactory:l=>new ArtifactApiStorage(endpoints!.artifactUrl,endpoints!.artifactToken,l)
  }:{})});
  await worker.heartbeat();
  const service=await startService({name:'worker',port:Number(env.PORT??3001),host:hosted?'0.0.0.0':'127.0.0.1',tick:()=>worker.tick(),heartbeat:()=>worker.heartbeat(),details:()=>worker.status,close:async()=>{try{await worker.drain();}finally{await db.close();}}});
  installShutdown(service,config.mode);return service;
 }catch(error){await db.close();throw error;}
}
if(isEntrypoint(import.meta.url))void main().catch(()=>{process.stderr.write('PITLANE worker startup failed.\n');process.exitCode=1;});
