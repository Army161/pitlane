import {setTimeout as delay} from 'node:timers/promises';
import {rpcInteger} from '../../../packages/evidence/src/rpc-json';
import {reparseRetainedEvidence} from '../../../packages/evidence/src/replay';
import {makeEvidenceManifest} from '../../../packages/evidence/src/manifest';
import {GENESIS,PROGRAMS,LIMITS,type Lease,type JobInput,type Observation,type RpcPort,type RpcMethod} from '../../../packages/contracts/src';
import {Jobs} from '../../../packages/core/src/jobs';import {Artifacts} from '../../../packages/core/src/artifacts';import {decodeMint} from '../../../packages/evidence/src/mint';import {corroborate} from '../../../packages/evidence/src/projections';import {evaluateExpectations} from '../../../packages/evidence/src/expectations';import {buildReceipt} from '../../../packages/evidence/src/receipt';import {rawDigest} from '../../../packages/evidence/src/canonical';import {validateRpcParams,type RpcReply,GatewayRpc,RpcFailure} from '../../../packages/adapters/src/solana-rpc';
export interface InspectionProvider {id:string;upstreamId:string;maximumMicro:string}
export class FixtureRpc implements RpcPort {
 constructor(mode:string,readonly network:'devnet'|'mainnet-beta'='devnet',readonly delayMs=0){if(mode!=='local'||process.env.PITLANE_MODE==='production'||process.env.PITLANE_MODE==='staging')throw new Error('FIXTURE_MODE_PROHIBITED');if(!Number.isInteger(delayMs)||delayMs<0||delayMs>5000)throw new Error('INVALID_FIXTURE_DELAY')}
 async read(providerId:string,method:RpcMethod,params:unknown[]):Promise<RpcReply>{validateRpcParams(method,params);if(!['fixture-a','fixture-b'].includes(providerId))throw new Error('UNKNOWN_FIXTURE_PROVIDER');if(this.delayMs)await delay(this.delayMs);let result:unknown;
 if(method==='getGenesisHash')result=GENESIS[this.network];else if(method==='getSlot')result=100;else if(method==='getBlockTime')result=null;else{const b=Buffer.alloc(82);b.writeBigUInt64LE(100n,36);b[44]=9;b[45]=1;result={context:{slot:100},value:{owner:PROGRAMS.original,executable:false,lamports:1000000,data:[b.toString('base64'),'base64'],rentEpoch:0}}}
 const rawBody=JSON.stringify({jsonrpc:'2.0',id:1,result});return {result,rawBody};
 }
}
export class Inspector {
 constructor(readonly jobs:Jobs,readonly artifacts:Artifacts,readonly rpc:RpcPort,readonly providers:InspectionProvider[],readonly execution:{build:string}={build:'local-development'}){}
 async collect(input:JobInput,l:Lease,signal:AbortSignal,deadline=Date.now()+LIMITS.deadlineMs):Promise<Observation[]>{
 if(this.providers.length!==2||this.providers[0].upstreamId===this.providers[1].upstreamId)throw new Error('INDEPENDENT_PROVIDERS_REQUIRED');const observations:Observation[]=[];
 for(const p of this.providers){const call=async(method:RpcMethod,params:unknown[]):Promise<RpcReply>=>{
  for(let attempt=0;attempt<3;attempt++){
   signal.throwIfAborted();
   if(Date.now()>=deadline)throw new Error('INSPECTION_DEADLINE');
   const intent=await this.jobs.costIntent(l,p.id,method,p.maximumMicro);
   try{return await (this.rpc instanceof GatewayRpc?this.rpc.read(p.id,method,params,signal,intent):this.rpc.read(p.id,method,params,signal)) as RpcReply;}
   catch(error){
    if(!(error instanceof RpcFailure)||!error.retryable||attempt===2||signal.aborted)throw error;
    const wait=Math.max(error.retryAfterMs,200*2**attempt+Math.floor(Math.random()*200));
    if(Date.now()+wait>=deadline)throw error;
    await delay(wait,undefined,{signal});
   }
  }
  throw new Error('RPC_RETRY_EXHAUSTED');
 };
 const genesis=await call('getGenesisHash',[]);if(genesis.result!==GENESIS[input.network])throw new Error('WRONG_GENESIS');const anchor=await call('getSlot',[{commitment:'finalized'}]);if(!Number.isSafeInteger(anchor.result)||(anchor.result as number)<0)throw new Error('INVALID_SLOT');const account=await call('getAccountInfo',[input.mint,{commitment:'finalized',encoding:'base64',minContextSlot:anchor.result}]);
 const r=account.result as {context?:{slot?:number};value?:{owner?:string;executable?:boolean;lamports?:number|bigint;data?:unknown[]}};
 if(!r?.value||r.value.executable!==false||typeof r.value.owner!=='string')throw new Error('UNSUPPORTED_ACCOUNT');
 if(!Number.isSafeInteger(r.context?.slot)||r.context!.slot!<(anchor.result as number))throw new Error('INVALID_ACCOUNT_CONTEXT');
 if(!Array.isArray(r.value.data)||r.value.data[1]!=='base64'||typeof r.value.data[0]!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.value.data[0]))throw new Error('INVALID_ACCOUNT_BYTES');
 const decoded=decodeMint(Buffer.from(r.value.data[0],'base64'),r.value.owner,input.mint);if(!decoded.ok)throw new Error(decoded.code);
 observations.push({providerId:p.id,upstreamId:p.upstreamId,network:input.network,genesis:String(genesis.result),slot:String(r.context!.slot),acquiredAt:account.observedAt??new Date().toISOString(),commitment:'finalized',rawHash:rawDigest(account.rawBody),rawBody:account.rawBody,reads:[{method:'getGenesisHash',rawBody:genesis.rawBody,sha256:rawDigest(genesis.rawBody)},{method:'getSlot',rawBody:anchor.rawBody,sha256:rawDigest(anchor.rawBody)},{method:'getAccountInfo',rawBody:account.rawBody,sha256:rawDigest(account.rawBody)}],mint:decoded.value,lamports:rpcInteger(r.value.lamports)});
 }return observations;
 }
 async inspect(l:Lease){const j=await this.jobs.get(l);const controller=new AbortController();const remaining=Date.parse(j.deadline)-Date.now();if(remaining<=0)return;const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(remaining)]);
 const timer=setInterval(()=>{void this.jobs.heartbeat(l).then(ok=>{if(!ok)controller.abort()}).catch(()=>controller.abort())},LIMITS.heartbeatMs);let observations:Observation[]=[];const limitations:string[]=[];let unsupported=false;
 try{try{observations=j.correction?reparseRetainedEvidence(j.correction.observations,j.input.mint):await this.collect(j.input,l,signal,Date.parse(j.deadline))}catch(e){const code=e instanceof Error?e.message:'INSPECTION_FAILED';limitations.push(code);unsupported=code.startsWith('UNSUPPORTED')}
 await this.jobs.verifying(l);const p=corroborate(observations,j.input);const assertions=p.ok?evaluateExpectations(p.value,j.input):[];const receipt=buildReceipt(j.input,observations,assertions,{jobId:j.id,origin:j.origin,limitations});if(j.correction){receipt.id=j.correction.receiptId;receipt.supersedesReceiptId=j.correction.receiptId;receipt.supersedesVersionId=j.correction.versionId;receipt.correctionReason=j.correction.reason}if(unsupported)receipt.executionState='unsupported';receipt.evidenceManifest=makeEvidenceManifest(await this.jobs.manifestContext(l),this.execution.build);const manifest=await this.artifacts.publish(l,receipt);await this.jobs.finalize(l,receipt,manifest);
 }finally{clearInterval(timer)}
 }
}
