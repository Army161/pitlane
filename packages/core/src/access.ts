import type {Actor,Scope,Tx} from '../../contracts/src';
export async function authorize(actor:Actor,scope:Scope,action:string,tx:Tx){if(actor.tenantId!==scope.tenantId)throw new Error('NOT_FOUND');const r=await tx.query<{allowed:boolean}>('select pitlane.can_project($1,$2,$3) as allowed',[scope.tenantId,scope.projectId,action!=='read']);if(!r.rows[0]?.allowed)throw new Error('NOT_FOUND')}
