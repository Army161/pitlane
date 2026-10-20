import type {Db,BillingPort,Order,PaymentState} from '../../contracts/src';
export class DatabaseFixtureBilling implements BillingPort {
 constructor(readonly db:Db,mode:string){if(mode!=='local')throw new Error('FIXTURE_PAYMENTS_PROHIBITED')}
 private async operation(op:string,id:string,amount:string,key:string){return (await this.db.query<{value:Record<string,any>}>('select pitlane.fixture_payment($1,$2,$3,$4) as value',[op,id,amount,key])).rows[0].value}
 async authorize(order:Order,key:string){const value=await this.operation('authorize','fixture_'+order.id,order.amount.baseUnits,key);return {state:'authorized' as const,providerId:'fixture_'+order.id,amount:String(value.amount),captureBefore:String(value.captureBefore)}}
 async retrieve(id:string){const value=await this.operation('retrieve',id,'0','');return {state:value.state as PaymentState,amount:String(value.amount),captureBefore:String(value.captureBefore)}}
 async capture(id:string,amount:string,key:string){return (await this.operation('capture',id,amount,key)).state as PaymentState}
 async cancel(id:string,key:string){await this.operation('cancel',id,'0',key)}
 async refund(id:string,amount:string,key:string){await this.operation('refund',id,amount,key);return 'settled' as const}
}
