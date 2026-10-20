import type {Db,Actor} from '../../contracts/src';import {z} from 'zod';
export class Team {
 constructor(readonly db:Db){}
 async createProject(actor:Actor,name:string){if(typeof name!=='string'||name.trim().length<1||Buffer.byteLength(name)>128)throw new Error('INVALID_INPUT');return this.db.transaction(async tx=>(await tx.query<{value:Record<string,any>}>('select pitlane.create_project($1) as value',[name.trim()])).rows[0].value,actor)}
 async setTenantMember(actor:Actor,userId:string,role:'owner'|'admin'|'billing'|'member',active:boolean){z.string().uuid().parse(userId);z.enum(['owner','admin','billing','member']).parse(role);z.boolean().parse(active);await this.db.transaction(tx=>tx.query('select pitlane.set_tenant_member($1,$2,$3)',[userId,role,active]),actor)}
 async setProjectMember(actor:Actor,projectId:string,userId:string,role:'admin'|'developer'|'viewer',active:boolean){z.string().uuid().parse(projectId);z.string().uuid().parse(userId);z.enum(['admin','developer','viewer']).parse(role);z.boolean().parse(active);await this.db.transaction(tx=>tx.query('select pitlane.set_project_member($1,$2,$3,$4)',[projectId,userId,role,active]),actor)}
}
