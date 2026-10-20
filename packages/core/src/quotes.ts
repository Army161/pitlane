import type {Actor,Db,Quote,Job,JobInput} from '../../contracts/src';import {parseJobInput} from '../../contracts/src';import {digest} from '../../evidence/src/canonical';
export function mapJob(r:Record<string,any>):Job{return {id:r.id,tenantId:r.tenant_id,projectId:r.project_id,input:r.input,state:r.state,origin:r.origin,deadline:new Date(r.deadline).toISOString(),leaseEpoch:Number(r.lease_epoch),attempts:r.attempts,receiptId:r.receipt_id,createdAt:new Date(r.created_at).toISOString(),correction:r.correction??undefined}}
export class Quotes {
 constructor(readonly db:Db){}
 async quote(actor:Actor,input:JobInput):Promise<Quote>{const v=parseJobInput(input);if(!v.ok)throw new Error(v.code);return this.db.transaction(async tx=>{const r=(await tx.query<{value:Record<string,any>}>('select pitlane.create_quote($1,$2) as value',[v.value,digest(v.value)])).rows[0].value;return {id:r.id,scope:{tenantId:r.tenant_id,projectId:r.project_id},input:r.input,inputsHash:r.inputs_hash,expiresAt:new Date(r.expires_at).toISOString(),units:r.units,price:{asset:'USD',scale:2,baseUnits:String(r.price_cents)},policyVersion:r.policy_version}},actor)}
 async submit(actor:Actor,quoteId:string,key:string):Promise<Job>{return this.db.transaction(async tx=>mapJob((await tx.query<{value:Record<string,any>}>('select pitlane.admit($1,$2) as value',[quoteId,key])).rows[0].value),actor)}
}
