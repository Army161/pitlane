import {GENESIS,type Network} from '../../contracts/src';
import type {ProviderProfile} from './solana-rpc';
import {z} from 'zod';
import {validateProviderRegistry} from '../../core/src/startup';
import {required} from '../../core/src/config';
export function workerEndpoints(env:Record<string,string|undefined>){
 const gatewayUrl=required(env,'PITLANE_GATEWAY_URL'),gatewayToken=required(env,'PITLANE_GATEWAY_TOKEN'),artifactUrl=required(env,'PITLANE_ARTIFACT_API_URL'),artifactToken=required(env,'PITLANE_ARTIFACT_API_TOKEN');
 for(const [origin,code] of [[gatewayUrl,'INVALID_GATEWAY_URL'],[artifactUrl,'INVALID_ARTIFACT_API_URL']] as const){
  let url:URL;try{url=new URL(origin);}catch{throw new Error(code);}
  if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw new Error(code);
 }
 if(gatewayToken.length<32)throw new Error('GATEWAY_AUTH_REQUIRED');if(artifactToken.length<32)throw new Error('ARTIFACT_API_AUTH_REQUIRED');
 return {gatewayUrl,gatewayToken,artifactUrl,artifactToken};
}
export function gatewayProfiles(source:string|undefined,mode:string):ProviderProfile[]{
 if(mode==='local'&&!source)return (['devnet','mainnet-beta'] as Network[]).flatMap(network=>['a','b'].map(p=>({id:`fixture-${p}-${network}`,upstreamId:'fixture-'+p,network,genesis:GENESIS[network],maximumMicro:'100',endpoint:'https://fixture.invalid'})));
 if(!source)throw new Error('PITLANE_GATEWAY_PROFILES_REQUIRED');
 const schema=z.array(z.object({id:z.string(),upstreamId:z.string(),network:z.enum(['devnet','mainnet-beta']),genesis:z.string(),maximumMicro:z.string(),endpoint:z.url(),headers:z.record(z.string().regex(/^[A-Za-z0-9-]{1,128}$/),z.string().max(8192)).optional()}).strict()).max(16);
 let parsed:ProviderProfile[];try{parsed=schema.parse(JSON.parse(source));}catch{throw new Error('INVALID_PROVIDER_REGISTRY');}
 validateProviderRegistry(parsed);return parsed;
}
