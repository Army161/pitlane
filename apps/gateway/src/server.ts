import {createHash,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {GENESIS,type Db,type RpcPort} from '../../../packages/contracts/src';
import {boundedBody,validateRpcParams,parseRpc,RpcFailure,type RpcReply,type ProviderIdentity} from '../../../packages/adapters/src/solana-rpc';

const bodySchema=z.object({providerId:z.string().min(1).max(64),method:z.string().max(64),params:z.array(z.unknown()).max(2),lease:z.object({jobId:z.string().uuid(),workerId:z.string().min(1).max(128),epoch:z.number().int().positive()}).strict(),intentId:z.string().uuid()}).strict();
const equal=(a:string,b:string)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());

export function gatewayHandler(deps:{token:string;db:Pick<Db,'query'>;rpc:RpcPort;profiles:ProviderIdentity[]}){
 if(deps.token.length<32)throw new Error('GATEWAY_AUTH_REQUIRED');
 const profiles=new Map(deps.profiles.map(p=>[p.id,p]));
 if(profiles.size!==deps.profiles.length||deps.profiles.some(p=>p.genesis!==GENESIS[p.network]||!p.upstreamId||!/^\d+$/.test(p.maximumMicro)))throw new Error('INVALID_GATEWAY_PROFILES');
 return async(request:Request):Promise<Response>=>{
  if(new URL(request.url).pathname!=='/rpc'||request.method!=='POST')return new Response(null,{status:404});
  if(!equal(request.headers.get('authorization')??'',`Bearer ${deps.token}`))return new Response(null,{status:401});
  let value:z.infer<typeof bodySchema>|undefined,dispatched=false;
  try{
   value=bodySchema.parse(JSON.parse(await boundedBody(new Response(request.body),65536)));
   validateRpcParams(value.method,value.params);
   const configured=profiles.get(value.providerId);
   if(!configured)throw new Error('UNKNOWN_PROVIDER');
   const snapshot=(await deps.db.query<{value:ProviderIdentity}>('select pitlane.gateway_dispatch_scoped($1,$2,$3,$4,$5,$6,$7) as value',[value.lease.jobId,value.lease.workerId,value.lease.epoch,value.intentId,value.providerId,value.method,JSON.stringify(value.params)])).rows[0].value;
   dispatched=true;
   if(['id','upstreamId','network','genesis','maximumMicro'].some(k=>configured[k as keyof ProviderIdentity]!==snapshot[k as keyof ProviderIdentity]))throw new Error('GATEWAY_PROFILE_MISMATCH');
   const reply=await deps.rpc.read(value.providerId,value.method,value.params,request.signal) as RpcReply;
   const parsed=parseRpc(reply.rawBody);
   if(value.method==='getGenesisHash'&&parsed.result!==snapshot.genesis)throw new Error('WRONG_GENESIS');
   const row=(await deps.db.query<{stamp:string}>('select pitlane.gateway_record($1,$2,$3,$4,$5) as stamp',[value.lease.jobId,value.lease.workerId,value.lease.epoch,value.intentId,reply.rawBody])).rows[0];
   return new Response(reply.rawBody,{headers:{'content-type':'application/json','cache-control':'no-store','x-pitlane-observed-at':new Date(row.stamp).toISOString()}});
  }catch(error){
   const message=error instanceof Error?error.message:'';
   const failure=error instanceof RpcFailure?error:undefined;
   if(dispatched&&value){
    try{await deps.db.query('select pitlane.gateway_failure($1,$2,$3,$4,$5,$6)',[value.lease.jobId,value.lease.workerId,value.lease.epoch,value.intentId,failure?.category??'invalid',failure?.retryAfterMs??0]);}catch{/* Failure remains conservatively uncertain; never disclose database diagnostics. */}
   }
   const retryable=failure?.retryable===true||message==='PROVIDER_CIRCUIT_OPEN'||message==='PROVIDER_RATE_LIMIT';
   const delay=failure?.retryAfterMs??(message==='PROVIDER_RATE_LIMIT'?60000:30000);
   return new Response(JSON.stringify({code:retryable?'PROVIDER_UNAVAILABLE':'READ_REQUEST_REJECTED'}),{status:retryable?503:422,headers:{'content-type':'application/json','cache-control':'no-store',...(retryable?{'x-pitlane-retry-after-ms':String(delay),'retry-after':String(Math.ceil(delay/1000))}:{})}});
  }
 };
}
