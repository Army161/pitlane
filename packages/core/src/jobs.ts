import type {Db,Actor,Lease,Job,Receipt,ArtifactManifest} from '../../contracts/src';import {mapJob} from './quotes';
import type {ExecutionManifestContext} from '../../contracts/src/manifest';
export class Jobs {
 constructor(readonly db:Db){}
 async claim(workerId:string):Promise<Lease|null>{const r=(await this.db.query<{value:Record<string,any>|null}>('select pitlane.claim($1) as value',[workerId])).rows[0].value;return r?{jobId:r.id,workerId,epoch:Number(r.lease_epoch),expiresAt:new Date(r.lease_until).toISOString()}:null}
 async get(lease:Lease):Promise<Job>{return mapJob((await this.db.query<{value:Record<string,any>}>("select pitlane.leased_job($1,$2,$3) || jsonb_build_object('correction',pitlane.correction_context($1)) as value",[lease.jobId,lease.workerId,lease.epoch])).rows[0].value)}
 async manifestContext(l:Lease):Promise<ExecutionManifestContext>{return (await this.db.query<{value:ExecutionManifestContext}>('select pitlane.execution_manifest_context($1,$2,$3) as value',[l.jobId,l.workerId,l.epoch])).rows[0].value;}
 async verifying(l:Lease){await this.db.query('select pitlane.verifying($1,$2,$3)',[l.jobId,l.workerId,l.epoch])}
 async heartbeat(l:Lease){return (await this.db.query<{ok:boolean}>('select pitlane.heartbeat($1,$2,$3) as ok',[l.jobId,l.workerId,l.epoch])).rows[0].ok}
 async reap(){return (await this.db.query<{n:number}>('select pitlane.reap() as n')).rows[0].n}
 async requestCancel(actor:Actor,jobId:string){return this.db.transaction(async tx=>mapJob((await tx.query<{value:Record<string,any>}>('select pitlane.cancel_job($1) as value',[jobId])).rows[0].value),actor)}
 async finalize(l:Lease,result:Receipt,manifest:ArtifactManifest):Promise<Job>{return mapJob((await this.db.query<{value:Record<string,any>}>('select pitlane.finalize($1,$2,$3,$4,$5) as value',[l.jobId,l.workerId,l.epoch,result,manifest.id])).rows[0].value)}
 async costIntent(l:Lease,providerId:string,method:string,maximumMicro:string){return (await this.db.query<{id:string}>('select pitlane.cost_intent($1,$2,$3,$4,$5,$6) as id',[l.jobId,l.workerId,l.epoch,providerId,method,maximumMicro])).rows[0].id}
}
