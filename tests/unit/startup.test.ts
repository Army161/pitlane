import {it,expect,vi} from 'vitest';
import {PostgresDb} from '../../packages/adapters/src/postgres';
import {loadConfig} from '../../packages/core/src/config';
import * as providerConfig from '../../packages/adapters/src/provider-config';
import {GENESIS} from '../../packages/contracts/src';
import {WorkerService} from '../../apps/worker/src/service';
import {FixtureRpc} from '../../apps/worker/src/runner';
const startup=await import('../../packages/core/src/startup').catch(()=>({})) as any;
it('requires complete independent pairs with exact network genesis',()=>{
 expect(()=>startup.validateProviderRegistry([])).toThrow('INDEPENDENT_PROVIDERS_REQUIRED');
});
it('rechecks runtime identity before every claim after an earlier successful heartbeat',async()=>{
 let foreign=false,claims=0;const db={query:async(sql:string)=>{if(sql.includes('runtime_info'))return {rows:[{value:{mode:'local',environment_id:foreign?'foreign-fixture':'local-fixture',billing_mode:'disabled',contract:'1',schema_version:startup.SERVICE_SCHEMA_VERSION}}],rowCount:1};if(sql.includes('pitlane.claim'))claims++;return {rows:[{value:null,n:0}],rowCount:1};}};
 const service=new WorkerService({db:db as any,id:'controlled-fixture',mode:'local',build:'fixture-build'});await service.heartbeat();foreign=true;await expect(service.tick()).rejects.toThrow('FOREIGN_ENVIRONMENT');expect(claims).toBe(0);
});
it('prohibits fixture RPC construction in staging and production',()=>{
 try{for(const mode of ['staging','production']){vi.stubEnv('PITLANE_MODE',mode);expect(()=>new FixtureRpc('local')).toThrow('FIXTURE_MODE_PROHIBITED');}}finally{vi.unstubAllEnvs();}
});
it('does not let connection-string options bypass verified remote TLS',async()=>{
 for(const url of ['postgres://fixture@remote.invalid/postgres?sslmode=require&uselibpqcompat=true','postgres://fixture@remote.invalid/postgres?sslmode=verify-full&sslmode=no-verify','postgres://fixture@127.0.0.1/postgres?host=remote.invalid'])expect(()=>new PostgresDb(url)).toThrow();
 for(const url of ['postgres://fixture@remote.invalid/postgres?sslmode=verify-full','postgres://fixture@remote.invalid/postgres?sslmode=verify-full&uselibpqcompat=true']){const valid=new PostgresDb(url);await valid.close();}
});
it('requires a hosted compiled build and exact runtime identity',()=>{
 const config=loadConfig({PITLANE_MODE:'staging',PITLANE_ENVIRONMENT_ID:'startup-fixture',PITLANE_EXPECTED_PROJECT_ID:'startup-project'}),sha='a'.repeat(40);
 expect(()=>startup.serviceBuild({PITLANE_BUILD_SHA:sha},config,'local-development')).toThrow('HOSTED_COMPILED_BUILD_REQUIRED');
 expect(()=>startup.serviceBuild({PITLANE_BUILD_SHA:'b'.repeat(40)},config,sha)).toThrow('BUILD_IDENTITY_MISMATCH');
 expect(()=>startup.serviceBuild({PITLANE_BUILD_SHA:'local-development'},config,sha)).toThrow('HOSTED_BUILD_REQUIRED');
 expect(startup.serviceBuild({PITLANE_BUILD_SHA:sha},config,sha)).toBe(sha);
 expect(startup.serviceBuild({},loadConfig({PITLANE_MODE:'local'}),'local-development')).toBe('local-development');
});
it('rejects hosted fixture profiles and requires exact independent profiles for both networks',()=>{
 expect(()=>providerConfig.gatewayProfiles(undefined,'staging')).toThrow('PITLANE_GATEWAY_PROFILES_REQUIRED');
 const profiles=['devnet','mainnet-beta'].flatMap(network=>['a','b'].map(p=>({id:p+'-'+network,upstreamId:p+'-independent',network,genesis:GENESIS[network as keyof typeof GENESIS],maximumMicro:'0',endpoint:'https://provider.invalid'})));
 expect(providerConfig.gatewayProfiles(JSON.stringify(profiles),'staging')).toHaveLength(4);
 expect(()=>providerConfig.gatewayProfiles(JSON.stringify(profiles.map(p=>({...p,upstreamId:'same-upstream'}))),'staging')).toThrow('INDEPENDENT_PROVIDERS_REQUIRED');
 expect(()=>providerConfig.gatewayProfiles(JSON.stringify(profiles.map(p=>({...p,genesis:'foreign'}))),'staging')).toThrow('INVALID_PROVIDER_REGISTRY');
});
it('validates every hosted worker connection before accepting work',()=>{
 const endpoints=(providerConfig as any).workerEndpoints,env={PITLANE_GATEWAY_URL:'https://gateway.invalid',PITLANE_GATEWAY_TOKEN:'x'.repeat(32),PITLANE_ARTIFACT_API_URL:'https://artifact.invalid',PITLANE_ARTIFACT_API_TOKEN:'y'.repeat(32)};
 expect(typeof endpoints).toBe('function');expect(endpoints(env)).toMatchObject({gatewayUrl:env.PITLANE_GATEWAY_URL,artifactUrl:env.PITLANE_ARTIFACT_API_URL});
 expect(()=>endpoints({...env,PITLANE_ARTIFACT_API_TOKEN:undefined})).toThrow('PITLANE_ARTIFACT_API_TOKEN_REQUIRED');
 expect(()=>endpoints({...env,PITLANE_GATEWAY_TOKEN:'short'})).toThrow('GATEWAY_AUTH_REQUIRED');
 expect(()=>endpoints({...env,PITLANE_ARTIFACT_API_URL:'https://embedded:credential@artifact.invalid'})).toThrow('INVALID_ARTIFACT_API_URL');
 expect(()=>endpoints({...env,PITLANE_GATEWAY_URL:'http://remote.invalid'})).toThrow('INVALID_GATEWAY_URL');
});
