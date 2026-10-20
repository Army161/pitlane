import type {Actor,Db,Receipt,StoragePort} from '../../contracts/src';
import {z} from 'zod';

export interface ExpiredReceipt {kind:'expired';evidenceExpired:true;versionId:string;receiptId:string;digest:string;expiredAt:string}
export interface AvailableReceipt {kind:'available';versionId:string;receiptId:string;artifactId:string;expiresAt:string;payload:Receipt}
export type ReceiptLookup=ExpiredReceipt|AvailableReceipt|null;
export type ArtifactLookup={kind:'expired';evidenceExpired:true;artifactId:string;digest:string;expiredAt:string}|{kind:'available';artifactId:string;digest:string;expiresAt:string}|null;
export interface RetentionCursor {at:string;id:string}
export interface RetentionPageOptions {limit?:number;cursor?:RetentionCursor|null}
export interface RetentionPage<T> {items:T[];nextCursor:RetentionCursor|null}
export interface ReceiptSummary {versionId:string;receiptId:string;artifactId:string;digest:string;expiresAt:string;evidenceExpired:boolean;issuedAt:string;finding:'supported'|'contradicted'|'insufficient_evidence'|null;origin:'fixture'|'internal'|'customer'}

export function retentionPageOptions(options:RetentionPageOptions={}){
 const limit=options.limit??50;
 if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('INVALID_PAGE');
 const cursor=options.cursor??null;
 if(cursor&&(!z.string().uuid().safeParse(cursor.id).success||typeof cursor.at!=='string'||cursor.at.length>64||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/.test(cursor.at)||!Number.isFinite(Date.parse(cursor.at))))throw new Error('INVALID_PAGE');
 return {limit,cursor};
}
export function retentionPage<T>(rows:(T&{cursor:RetentionCursor})[],limit:number):RetentionPage<T>{
 const visible=rows.slice(0,limit);const nextCursor=rows.length>limit?visible[visible.length-1].cursor:null;
 return {items:visible.map(({cursor:_,...item})=>item as T),nextCursor};
}

export class Retention {
 constructor(readonly db:Db,readonly storage?:StoragePort){}
 async deleteProject(actor:Actor,id:string){z.string().uuid().parse(id);await this.db.transaction(tx=>tx.query('select pitlane.delete_project($1)',[id]),actor)}
 async deleteTenant(actor:Actor){await this.db.transaction(tx=>tx.query('select pitlane.delete_tenant()'),actor)}
 async lookupReceipt(actor:Actor,versionId:string):Promise<ReceiptLookup>{z.string().uuid().parse(versionId);return this.db.transaction(async tx=>(await tx.query<{value:ReceiptLookup}>('select pitlane.receipt_version_lookup($1) as value',[versionId])).rows[0].value,actor)}
 async lookupLineage(actor:Actor,receiptId:string,versionId?:string):Promise<ReceiptLookup>{z.string().uuid().parse(receiptId);if(versionId!==undefined)z.string().uuid().parse(versionId);return this.db.transaction(async tx=>(await tx.query<{value:ReceiptLookup}>('select pitlane.receipt_lookup($1,$2) as value',[receiptId,versionId??null])).rows[0].value,actor)}
 async lookupArtifact(actor:Actor,artifactId:string):Promise<ArtifactLookup>{z.string().uuid().parse(artifactId);return this.db.transaction(async tx=>(await tx.query<{value:ArtifactLookup}>('select pitlane.artifact_lookup($1) as value',[artifactId])).rows[0].value,actor)}
 async listReceipts(actor:Actor,projectId:string,options:RetentionPageOptions={}):Promise<RetentionPage<ReceiptSummary>>{
  z.string().uuid().parse(projectId);const {limit,cursor}=retentionPageOptions(options);
  const rows=await this.db.transaction(async tx=>(await tx.query<{value:(ReceiptSummary&{cursor:RetentionCursor})[]}>('select pitlane.receipt_page($1,$2,$3,$4) as value',[projectId,limit,cursor?.at??null,cursor?.id??null])).rows[0].value,actor);
  return retentionPage(rows,limit);
 }
 async listJobs(actor:Actor,projectId:string,options:RetentionPageOptions={}):Promise<RetentionPage<Record<string,unknown>>>{
  z.string().uuid().parse(projectId);const {limit,cursor}=retentionPageOptions(options);
  const rows=await this.db.transaction(async tx=>(await tx.query<{value:(Record<string,unknown>&{cursor:RetentionCursor})[]}>('select pitlane.job_page($1,$2,$3,$4) as value',[projectId,limit,cursor?.at??null,cursor?.id??null])).rows[0].value,actor);
  return retentionPage(rows,limit);
 }
 async listEvents(actor:Actor,jobId:string,options:{limit?:number;cursor?:string|null}={}):Promise<{items:Record<string,unknown>[];nextCursor:string|null}>{
  z.string().uuid().parse(jobId);const {limit}=retentionPageOptions({limit:options.limit});
  const cursor=options.cursor??null;if(cursor!==null&&(!/^\d{1,19}$/.test(cursor)||BigInt(cursor)>9223372036854775807n))throw new Error('INVALID_PAGE');
  const rows=await this.db.transaction(async tx=>(await tx.query<{value:Record<string,unknown>[]}>('select pitlane.event_page($1,$2,$3) as value',[jobId,limit,cursor])).rows[0].value,actor);
  const items=rows.slice(0,limit);return {items,nextCursor:rows.length>limit?String(items[items.length-1].seq):null};
 }
 async run(limit=100){
  if(!Number.isInteger(limit)||limit<1||limit>500)throw new Error('INVALID_PURGE_LIMIT');if(!this.storage)throw new Error('STORAGE_REQUIRED');
  const pending=(await this.db.query<{value:{id:string;object_key:string;kind:'artifact'|'orphan'}[]}>('select pitlane.prepare_purge($1) as value',[limit])).rows[0].value;
  let completed=0;for(const object of pending){try{await this.storage.remove(object.object_key);await this.db.query('select pitlane.complete_purge($1)',[object.id]);completed++}catch{await this.db.query('select pitlane.retry_purge($1)',[object.id])}}return completed;
 }
}
