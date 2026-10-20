import {PostgresDb} from '../../../packages/adapters/src/postgres';
import {SolanaRpc,type RpcReply} from '../../../packages/adapters/src/solana-rpc';
import {FixtureRpc} from '../../worker/src/runner';
import {gatewayProfiles} from '../../../packages/adapters/src/provider-config';
import {startService,isEntrypoint,installShutdown} from '../../../packages/adapters/src/service-host';
import {loadConfig,databaseUrl,required} from '../../../packages/core/src/config';
import {serviceBuild,validateStartup,verifyProviderRegistry} from '../../../packages/core/src/startup';
import {gatewayHandler} from './server';
export async function main(env:Record<string,string|undefined>=process.env){
 const config=loadConfig(env),build=serviceBuild(env,config),db=new PostgresDb(databaseUrl(env,'GATEWAY'),'pitlane_gateway');
 try{
  const profiles=gatewayProfiles(env.PITLANE_GATEWAY_PROFILES,config.mode);
  await validateStartup(db,config,'pitlane_gateway',build);await verifyProviderRegistry(db,profiles);
  const rpc=config.mode==='local'?{read:async(provider:string,method:any,params:unknown[]):Promise<RpcReply>=>{const p=profiles.find(p=>p.id===provider);if(!p)throw new Error('UNKNOWN_PROVIDER');return new FixtureRpc('local',p.network).read('fixture-a',method,params);}}:new SolanaRpc(profiles);
  const handler=gatewayHandler({db,rpc,profiles,token:required(env,'PITLANE_GATEWAY_TOKEN')});
  const service=await startService({name:'gateway',port:Number(env.PORT??3002),host:config.mode==='local'?'127.0.0.1':'0.0.0.0',handler,details:()=>({mode:config.mode,build}),heartbeat:()=>validateStartup(db,config,'pitlane_gateway',build),close:()=>db.close()});installShutdown(service,config.mode);return service;
 }catch(error){await db.close();throw error;}
}
if(isEntrypoint(import.meta.url))void main().catch(()=>{process.stderr.write('PITLANE gateway startup failed.\n');process.exitCode=1;});
