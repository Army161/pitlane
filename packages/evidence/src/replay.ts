import {GENESIS,parseJobInput,type Receipt,type Result,type Observation} from '../../contracts/src';
import {rawDigest,digest} from './canonical';
import {decodeMint} from './mint';
import {corroborate} from './projections';
import {evaluateExpectations,aggregate} from './expectations';
import {parseRpc,rpcInteger} from './rpc-json';
function accountSource(o:Observation){
 if(!o.rawBody||rawDigest(o.rawBody)!==o.rawHash)throw new Error('MISSING_RETAINED_SOURCE');
 const body=parseRpc(o.rawBody).result as any;const account=body?.value;
 if(account?.executable!==false||account.data?.[1]!=='base64'||typeof account.data[0]!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(account.data[0]))throw new Error('INVALID_RETAINED_SOURCE');
 if(!Number.isSafeInteger(body.context?.slot)||body.context.slot<0||o.slot!==String(body.context.slot)||o.lamports!==rpcInteger(account.lamports))throw new Error('INVALID_RETAINED_CONTEXT');
 return account;
}
export function reparseRetainedEvidence(observations:Observation[],subject:string):Observation[]{return observations.map(o=>{const account=accountSource(o);const mint=decodeMint(Buffer.from(account.data[0],'base64'),account.owner,subject);if(!mint.ok)throw new Error(mint.code);return {...o,mint:mint.value};});}
export function verifyReceiptEvidence(r:Receipt):Result<true>{
 try{
  if(r.schema!=='pitlane.receipt.v1'||r.ruleVersion!=='1'||!parseJobInput(r.input).ok)throw new Error('INVALID_RECEIPT_CONTRACT');
  for(const o of r.observations){
   if(!o.rawBody&&r.origin==='fixture')continue;
   const account=accountSource(o);const mint=decodeMint(Buffer.from(account.data[0],'base64'),account.owner,r.input.mint);
   if(!mint.ok||digest(mint.value)!==digest(o.mint))throw new Error('DECODED_CONFIGURATION_DIFFERS');
   if(!o.reads&&r.origin!=='fixture')throw new Error('MISSING_NETWORK_EVIDENCE');
   if(o.reads){
    if(new Set(o.reads.map(x=>x.method)).size!==o.reads.length)throw new Error('DUPLICATE_READ_EVIDENCE');
    for(const read of o.reads)if(rawDigest(read.rawBody)!==read.sha256)throw new Error('READ_DIGEST_MISMATCH');
    const g=o.reads.find(x=>x.method==='getGenesisHash'),s=o.reads.find(x=>x.method==='getSlot'),a=o.reads.find(x=>x.method==='getAccountInfo');
    if(!g||!s||!a||a.rawBody!==o.rawBody||a.sha256!==o.rawHash)throw new Error('MISSING_ACCOUNT_READ');
    const genesis=parseRpc(g.rawBody).result,anchor=parseRpc(s.rawBody).result;
    if(genesis!==GENESIS[r.input.network]||genesis!==o.genesis||!Number.isSafeInteger(anchor)||(anchor as number)<0||(anchor as number)>Number(o.slot))throw new Error('INVALID_FINALIZED_ANCHOR');
   }
  }
  const p=corroborate(r.observations,r.input);
  if(p.ok){
   if(!r.projection||digest(r.projection)!==digest(p.value))throw new Error('PROJECTION_REPLAY_DIFFERS');
   const assertions=evaluateExpectations(p.value,r.input);
   if(digest(assertions)!==digest(r.assertions)||aggregate(assertions)!==r.finding)throw new Error('ASSERTION_REPLAY_DIFFERS');
   if(p.value.limitations.some(l=>!r.limitations.includes(l)))throw new Error('MISSING_SCOPE_LIMITATION');
  }else if(r.projection!==null||r.assertions.length||r.finding!=='insufficient_evidence')throw new Error('MISSING_REQUIRED_CORROBORATION');
  return {ok:true,value:true};
 }catch(e){return {ok:false,code:'REPLAY_FAILED',message:e instanceof Error?e.message:'REPLAY_FAILED'};}
}
