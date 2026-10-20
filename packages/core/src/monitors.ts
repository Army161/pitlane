import {z} from 'zod';
import type {Actor,Db,JobInput} from '../../contracts/src';
import {parseJobInput} from '../../contracts/src';
import {digest} from '../../evidence/src/canonical';
const settings=z.object({intervalSeconds:z.number().int().min(3600).max(2592000),expiresAt:z.string().datetime(),monthlyUnits:z.number().int().min(1).max(1000),maximumUnitPrice:z.string().regex(/^(0|[1-9][0-9]*)$/),monthlyCostMicro:z.string().regex(/^[1-9][0-9]*$/)}).strict();
export class Monitors {
 constructor(readonly db:Db){}
 async create(actor:Actor,input:JobInput,options:z.infer<typeof settings>){
  const parsed=parseJobInput(input);const config=settings.safeParse(options);
  if(!parsed.ok||!config.success||Date.parse(options.expiresAt)<=Date.now()||Date.parse(options.expiresAt)>Date.now()+366*86400000||BigInt(options.monthlyCostMicro)>1000000000000n||BigInt(options.maximumUnitPrice)>1000000000n)throw new Error('INVALID_INPUT');
  return this.db.transaction(async tx=>(await tx.query<{value:Record<string,any>}>('select pitlane.create_monitor($1,$2,$3) as value',[parsed.value,digest(parsed.value),config.data])).rows[0].value,actor);
 }
 async enable(actor:Actor,id:string){return this.setEnabled(actor,id,true)}
 async disable(actor:Actor,id:string){return this.setEnabled(actor,id,false)}
 private async setEnabled(actor:Actor,id:string,enabled:boolean){return this.db.transaction(async tx=>(await tx.query<{value:Record<string,any>}>('select pitlane.set_monitor_enabled($1,$2) as value',[id,enabled])).rows[0].value,actor)}
 async scheduleDue(limit=20){return (await this.db.query<{n:number}>('select pitlane.schedule_monitors($1) as n',[limit])).rows[0].n}
}
