import type {Lease,StoragePort,Db,Receipt,Observation} from '../../contracts/src';import {createHash,timingSafeEqual} from 'node:crypto';import {z} from 'zod';import {boundedBody,boundedBytes} from './solana-rpc';
import {canonical,digest,rawDigest} from '../../evidence/src/canonical';
import {verifyReceiptEvidence} from '../../evidence/src/replay';
import {verifyEvidenceManifest} from '../../evidence/src/manifest';
import type {ExecutionManifestContext} from '../../contracts/src/manifest';
const payload=z.object({operation:z.enum(['put','get']),key:z.string().max(512),lease:z.object({jobId:z.string().uuid(),workerId:z.string().min(1).max(128),epoch:z.number().int().positive()}).strict(),bytes:z.string().max(1398104).optional(),contentType:z.literal('application/json').optional()}).strict();
const equal=(a:string,b:string)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
export class ArtifactApiStorage implements StoragePort{
 constructor(readonly origin:string,readonly token:string,readonly lease:Lease){const u=new URL(origin);if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)))throw new Error('INVALID_ARTIFACT_API_URL');if(token.length<32)throw new Error('ARTIFACT_API_AUTH_REQUIRED')}
 private async request(operation:'get'|'put',key:string,bytes?:Uint8Array){const lease={jobId:this.lease.jobId,workerId:this.lease.workerId,epoch:this.lease.epoch};const response=await fetch(new URL('/internal/artifacts',this.origin),{method:'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},body:JSON.stringify({operation,key,lease,...(bytes?{bytes:Buffer.from(bytes).toString('base64'),contentType:'application/json'}:{})}),signal:AbortSignal.timeout(8000),redirect:'error'});if(!response.ok)throw new Error('ARTIFACT_API_REJECTED');return response}
 async put(key:string,bytes:Uint8Array,_type:string){if(bytes.length>1048576)throw new Error('ARTIFACT_LIMIT');await this.request('put',key,bytes)}
 async get(key:string){return boundedBytes(await this.request('get',key),1048576)}
 async remove(_key:string):Promise<void>{throw new Error('WORKER_DELETE_PROHIBITED')}
}
export function artifactApiHandler(deps:{db:Db;storage:StoragePort;token:string}){
 if(deps.token.length<32)throw new Error('ARTIFACT_API_AUTH_REQUIRED');
 return async(request:Request)=>{
  if(new URL(request.url).pathname!=='/internal/artifacts'||request.method!=='POST')return new Response(null,{status:404});
  if(!equal(request.headers.get('authorization')??'',`Bearer ${deps.token}`))return new Response(null,{status:401});
  try{
   const v=payload.parse(JSON.parse(await boundedBody(new Response(request.body),1500000)));
   const context=(await deps.db.query<{value:EvidenceContext}>('select pitlane.artifact_evidence_context($1,$2,$3) as value',[v.lease.jobId,v.lease.workerId,v.lease.epoch])).rows[0].value;
   const job=context.job;const prefix=`${job.tenant_id}/${job.project_id}/${v.lease.jobId}/${v.lease.epoch}/`;
   if(!v.key.startsWith(prefix)||!/^[-0-9a-f]{36}\.json$/.test(v.key.slice(prefix.length)))throw new Error('INVALID_OBJECT_KEY');
   if(v.operation==='put'){
    if(!v.bytes||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.bytes))throw new Error('INVALID_ARTIFACT');
    const bytes=Buffer.from(v.bytes,'base64');if(bytes.length>1048576)throw new Error('ARTIFACT_LIMIT');
    const body=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);const receipt=JSON.parse(body) as Receipt;
    if(canonical(receipt)!==body)throw new Error('NONCANONICAL_ARTIFACT');verifyPublication(context,receipt);
    const hash=rawDigest(bytes);const values=[v.lease.jobId,v.lease.workerId,v.lease.epoch,v.key];
    // Reserve a single publication slot before any object write, including retries.
    await deps.db.query('select pitlane.reserve_artifact_publication($1,$2,$3,$4,$5,$6,$7)',[...values,body,hash,bytes.length]);
    try{await deps.storage.put(v.key,bytes,'application/json');}catch(e){if(rawDigest(await deps.storage.get(v.key))!==hash)throw e;}
    if(rawDigest(await deps.storage.get(v.key))!==hash)throw new Error('ARTIFACT_READBACK_MISMATCH');
    await deps.db.query('select pitlane.attest_artifact($1,$2,$3,$4,$5)',[...values,hash]);
    return new Response(null,{status:201});
   }
   const bytes=await deps.storage.get(v.key);if(bytes.length>1048576)throw new Error('ARTIFACT_LIMIT');
   await deps.db.query('select pitlane.artifact_access($1,$2,$3)',[v.lease.jobId,v.lease.workerId,v.lease.epoch]);
   return new Response(bytes as BodyInit,{headers:{'content-type':'application/octet-stream','cache-control':'no-store'}});
  }catch{return new Response(null,{status:422});}
 };
}
interface EvidenceContext {mode:string;job:Record<string,any>;original:Receipt|null;sources:Record<string,any>[];manifestContext?:ExecutionManifestContext}
export function verifyPublication(context:EvidenceContext,r:Receipt){
 const {job,original}=context;
 z.string().uuid().parse(r.id);z.string().uuid().parse(r.versionId);
 if(r.jobId!==job.id||digest(r.input)!==digest(job.input)||r.origin!==job.origin||!['completed','unsupported'].includes(r.executionState)||!Number.isFinite(Date.parse(r.issuedAt))||Date.parse(r.issuedAt)<Date.parse(job.created_at)-1000||Date.parse(r.issuedAt)>Date.now()+1000)throw new Error('WRONG_RECEIPT_SCOPE');
 const replay=verifyReceiptEvidence(r);if(!replay.ok)throw new Error(replay.code);
 if(context.mode==='local')return;
 if(!context.manifestContext||!verifyEvidenceManifest(r.evidenceManifest,context.manifestContext))throw new Error('INVALID_EVIDENCE_MANIFEST');
 if(r.origin==='fixture')throw new Error('FIXTURE_PROMOTION_PROHIBITED');
 if(original){
  const retained=(observations:Observation[])=>observations.map(({mint,...rest})=>rest);
  if(r.id!==original.id||r.supersedesReceiptId!==original.id||r.supersedesVersionId!==job.correction_version_id||r.correctionReason!==job.correction_reason||digest(retained(r.observations))!==digest(retained(original.observations)))throw new Error('CHANGED_CORRECTION_SOURCE');
 }else if(r.supersedesReceiptId||r.supersedesVersionId||r.correctionReason)throw new Error('UNREQUESTED_CORRECTION');
 for(const o of r.observations){
  const sources=context.sources.filter(s=>s.provider_id===o.providerId&&s.upstream_id===o.upstreamId&&s.network===r.input.network&&(original||Number(s.lease_epoch)===Number(job.lease_epoch)));
  if(!o.reads||o.reads.length!==3)throw new Error('MISSING_GATEWAY_EVIDENCE');
  for(const read of o.reads){
   const source=sources.find(s=>s.method===read.method&&s.raw_hash===read.sha256&&s.raw_body===read.rawBody&&(read.method!=='getAccountInfo'||s.params[0]===r.input.mint&&Date.parse(s.observed_at)===Date.parse(o.acquiredAt)));
   if(!source)throw new Error('UNRECORDED_GATEWAY_SOURCE');
   if(read.method==='getAccountInfo'&&(source.params[0]!==r.input.mint||Date.parse(source.observed_at)!==Date.parse(o.acquiredAt)))throw new Error('WRONG_GATEWAY_SUBJECT_OR_TIME');
  }
 }
}
