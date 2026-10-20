import type {Actor,Db} from '../../contracts/src';
import {mapJob} from './quotes';
import {retentionPage,retentionPageOptions,type RetentionPageOptions,type RetentionCursor} from './retention';
export class History {
 constructor(readonly db:Db){}
 async compare(actor:Actor,sourceVersionId:string,quoteId:string,key:string){return this.db.transaction(async tx=>mapJob((await tx.query<{value:Record<string,any>}>('select pitlane.request_comparison($1,$2,$3) as value',[sourceVersionId,quoteId,key])).rows[0].value),actor)}
 async requestCorrection(actor:Actor,sourceVersionId:string,reason:string,key:string){if(typeof reason!=='string'||reason.trim().length<10||reason.length>1000)throw new Error('INVALID_INPUT');return this.db.transaction(async tx=>mapJob((await tx.query<{value:Record<string,any>}>('select pitlane.request_correction($1,$2,$3) as value',[sourceVersionId,reason,key])).rows[0].value),actor)}
 async proposeAtlas(actor:Actor,projectId:string,title:string,failureVersionId:string){if(typeof title!=='string'||title.trim().length<3||title.length>200)throw new Error('INVALID_INPUT');return this.db.transaction(async tx=>(await tx.query<{value:Record<string,any>}>('select pitlane.propose_atlas($1,$2,$3) as value',[projectId,title,failureVersionId])).rows[0].value,actor)}
 async confirmAtlas(actor:Actor,id:string,fixVersionId:string,regressionArtifactId:string,permission:boolean){return this.db.transaction(async tx=>(await tx.query<{value:Record<string,any>}>('select pitlane.confirm_atlas($1,$2,$3,$4) as value',[id,fixVersionId,regressionArtifactId,permission])).rows[0].value,actor)}
 async withdrawAtlas(actor:Actor,id:string){return this.db.transaction(async tx=>(await tx.query<{value:Record<string,any>}>('select pitlane.withdraw_atlas($1) as value',[id])).rows[0].value,actor)}
 async reuseAtlas(actor:Actor,id:string){return this.db.transaction(async tx=>(await tx.query<{value:Record<string,any>}>('select pitlane.reuse_atlas($1) as value',[id])).rows[0].value,actor)}
 async listAtlas(actor:Actor,projectId:string,options:RetentionPageOptions={}){const {limit,cursor}=retentionPageOptions(options);const rows=await this.db.transaction(async tx=>(await tx.query<{value:(Record<string,unknown>&{cursor:RetentionCursor})[]}>('select pitlane.atlas_page($1,$2,$3,$4) as value',[projectId,limit,cursor?.at??null,cursor?.id??null])).rows[0].value,actor);return retentionPage(rows,limit)}
}
