import {LIMITS,type RpcPort,type RpcMethod,type Network,type Lease} from '../../contracts/src';
import {validateMintAddress} from '../../evidence/src/mint';
import {parseRpc} from '../../evidence/src/rpc-json';
export {parseRpc} from '../../evidence/src/rpc-json';

export interface ProviderIdentity {id:string;upstreamId:string;network:Network;genesis:string;maximumMicro:string}
export interface ProviderProfile extends ProviderIdentity {endpoint:string;headers?:Record<string,string>}
export interface RpcReply {result:unknown;rawBody:string;observedAt?:string}
export type ProviderFailureCategory='transient'|'rate_limit'|'auth'|'invalid';
export class RpcFailure extends Error {
 constructor(message:string,readonly retryable:boolean,readonly retryAfterMs:number,readonly category:ProviderFailureCategory){super(message);this.name='RpcFailure';}
}
export function retryAfterMs(value:string|null,now=Date.now()):number {
 if(!value)return 0;
 const milliseconds=/^\d+(?:\.\d+)?$/.test(value)?Math.min(2147483647,Number(value)*1000):Date.parse(value)-now;
 return Number.isFinite(milliseconds)?Math.max(0,Math.min(2147483647,Math.ceil(milliseconds))):0;
}
function httpFailure(response:Response){
 const status=response.status;
 return new RpcFailure(status===429?'RPC_RATE_LIMIT':`RPC_HTTP_${status}`,status===429||[500,502,503,504].includes(status),retryAfterMs(response.headers.get('retry-after')),status===429?'rate_limit':[401,403].includes(status)?'auth':[500,502,503,504].includes(status)?'transient':'invalid');
}
export function validateRpcParams(method:string,params:unknown[]):asserts method is RpcMethod {
 if(!['getGenesisHash','getAccountInfo','getSlot','getBlockTime'].includes(method))throw new Error('PROHIBITED_RPC');
 const finalized=(v:unknown)=>!!v&&typeof v==='object'&&(v as Record<string,unknown>).commitment==='finalized';
 if(method==='getGenesisHash'&&params.length===0)return;
 if(method==='getSlot'&&params.length===1&&finalized(params[0])&&Object.keys(params[0] as object).length===1)return;
 if(method==='getBlockTime'&&params.length===1&&Number.isSafeInteger(params[0])&&(params[0] as number)>=0)return;
 if(method==='getAccountInfo'&&params.length===2&&typeof params[0]==='string'&&validateMintAddress(params[0]).ok&&finalized(params[1])){
  const o=params[1] as Record<string,unknown>;
  if(o.encoding==='base64'&&Number.isSafeInteger(o.minContextSlot)&&(o.minContextSlot as number)>=0&&Object.keys(o).every(k=>['commitment','encoding','minContextSlot'].includes(k)))return;
 }
 throw new Error('INVALID_RPC_PARAMS');
}
export async function boundedBytes(response:Response,cap:number=LIMITS.responseBytes){
 if(Number(response.headers.get('content-length'))>cap)throw new Error('RPC_RESPONSE_LIMIT');
 if(!response.body)throw new Error('EMPTY_RPC_BODY');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{
  for(;;){
   let part:ReadableStreamReadResult<Uint8Array>;
   try{part=await reader.read();}catch{throw new RpcFailure('RPC_TRANSPORT_ERROR',true,0,'transient');}
   if(part.done)break;
   size+=part.value.length;
   if(size>cap){await reader.cancel();throw new Error('RPC_RESPONSE_LIMIT');}
   chunks.push(part.value);
  }
 }finally{reader.releaseLock();}
 return Buffer.concat(chunks);
}
export async function boundedBody(response:Response,cap:number=LIMITS.responseBytes){
 const bytes=await boundedBytes(response,cap);
 try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new Error('INVALID_RPC_UTF8');}
}
function callSignal(signal?:AbortSignal){
 signal?.throwIfAborted();
 return signal?AbortSignal.any([signal,AbortSignal.timeout(LIMITS.callTimeoutMs)]):AbortSignal.timeout(LIMITS.callTimeoutMs);
}
export class SolanaRpc implements RpcPort {
 private profiles=new Map<string,ProviderProfile>();
 constructor(profiles:ProviderProfile[],readonly transport:typeof fetch=fetch){
  for(const p of profiles){
   const u=new URL(p.endpoint);
   if(u.protocol!=='https:'||u.username||u.password||u.hash||!/^\d+$/.test(p.maximumMicro)||!p.upstreamId||this.profiles.has(p.id))throw new Error('INVALID_PROVIDER_URL');
   this.profiles.set(p.id,p);
  }
 }
 async read(providerId:string,method:RpcMethod,params:unknown[],signal?:AbortSignal):Promise<RpcReply>{
  validateRpcParams(method,params);
  const p=this.profiles.get(providerId);
  if(!p)throw new Error('UNKNOWN_PROVIDER');
  const combined=callSignal(signal);let response:Response;
  try{response=await this.transport(p.endpoint,{method:'POST',headers:{'content-type':'application/json',...p.headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),redirect:'error',signal:combined});}
  catch{signal?.throwIfAborted();throw new RpcFailure('RPC_TRANSPORT_ERROR',true,0,'transient');}
  if(!response.ok)throw httpFailure(response);
  const reply=parseRpc(await boundedBody(response));
  if(method!=='getAccountInfo'&&typeof reply.result==='bigint')throw new Error('UNSAFE_RPC_NUMBER');
  return reply;
 }
}
export class GatewayRpc implements RpcPort {
 constructor(readonly origin:string,readonly token:string,readonly lease:Pick<Lease,'jobId'|'workerId'|'epoch'>,readonly transport:typeof fetch=fetch){
  const u=new URL(origin);
  if(u.username||u.password||u.search||u.hash||u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)))throw new Error('INVALID_GATEWAY_URL');
  if(token.length<32)throw new Error('GATEWAY_AUTH_REQUIRED');
 }
 async read(providerId:string,method:RpcMethod,params:unknown[],signal?:AbortSignal,intentId?:string):Promise<RpcReply>{
  validateRpcParams(method,params);
  if(!intentId)throw new Error('UNPRICED_DISPATCH');
  const lease={jobId:this.lease.jobId,workerId:this.lease.workerId,epoch:this.lease.epoch};
  const combined=callSignal(signal);let response:Response;
  try{response=await this.transport(new URL('/rpc',this.origin),{method:'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},body:JSON.stringify({providerId,method,params,lease,intentId}),redirect:'error',signal:combined});}
  catch{signal?.throwIfAborted();throw new RpcFailure('GATEWAY_TRANSPORT_ERROR',true,0,'transient');}
  if(!response.ok){
   const delay=response.headers.get('x-pitlane-retry-after-ms');
   throw new RpcFailure(`GATEWAY_${response.status}`,response.status===503,delay&&/^\d+$/.test(delay)?Math.min(2147483647,Number(delay)):0,'transient');
  }
  const reply=parseRpc(await boundedBody(response));
  if(method!=='getAccountInfo'&&typeof reply.result==='bigint')throw new Error('UNSAFE_RPC_NUMBER');
  const stamp=response.headers.get('x-pitlane-observed-at');
  if(!stamp||!Number.isFinite(Date.parse(stamp)))throw new Error('MISSING_GATEWAY_TIMESTAMP');
  return {...reply,observedAt:new Date(stamp).toISOString()};
 }
}
