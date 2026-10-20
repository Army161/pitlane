import {randomUUID} from 'node:crypto';
import type {Db,Actor,Order,BillingPort,PaymentState,StoragePort} from '../../contracts/src';
import {canonical,rawDigest} from '../../evidence/src/canonical';
import {mapJob} from './quotes';
export class FixtureBilling implements BillingPort {
 captured=0;refunded=0;private payments=new Map<string,{state:PaymentState;amount:string;captureBefore:string}>();private capturedKeys=new Set<string>();private refundKeys=new Map<string,{id:string;amount:string}>();private refundedAmounts=new Map<string,bigint>();
 constructor(mode:string){if(mode!=='local'||process.env.PITLANE_MODE==='production')throw new Error('FIXTURE_PAYMENTS_PROHIBITED')}
 async authorize(o:Order,_key:string){const providerId='fixture_'+o.id;const p={state:'authorized' as const,amount:o.amount.baseUnits,captureBefore:new Date(Date.now()+3600000).toISOString()};this.payments.set(providerId,p);return {providerId,...p}}
 async capture(id:string,amount:string,key:string):Promise<PaymentState>{const p=this.payments.get(id);if(!p||p.amount!==amount||Date.parse(p.captureBefore)<=Date.now())return 'authorization_expired';if(!this.capturedKeys.has(key)){this.captured++;this.capturedKeys.add(key)}p.state='settled';return 'settled'}
 async cancel(id:string,_key:string){const p=this.payments.get(id);if(p&&p.state!=='settled')p.state='cancelled'}
 async retrieve(id:string){const p=this.payments.get(id);if(!p)throw new Error('PAYMENT_UNAVAILABLE');return {...p}}
 async refund(id:string,amount:string,key:string):Promise<'settled'|'pending_reconciliation'|'failed'>{const prior=this.refundKeys.get(key);if(prior){if(prior.id!==id||prior.amount!==amount)throw new Error('IDEMPOTENCY_CONFLICT');return 'settled'}const payment=this.payments.get(id);const refunded=this.refundedAmounts.get(id)??0n;if(!payment||payment.state!=='settled'||BigInt(amount)<=0n||refunded+BigInt(amount)>BigInt(payment.amount))throw new Error('REFUND_EXCEEDS_SETTLEMENT');this.refundKeys.set(key,{id,amount});this.refundedAmounts.set(id,refunded+BigInt(amount));this.refunded++;return 'settled'}
}
function mapOrder(r:Record<string,any>):Order{return {id:r.id,tenantId:r.tenant_id,projectId:r.project_id,kind:r.kind,state:r.state,amount:{asset:'USD',scale:2,baseUnits:String(r.amount_cents)},providerId:r.provider_id,captureBefore:r.capture_before,deliveredVersionId:r.delivered_version_id}}
export class Orders {
 constructor(readonly web:Db,readonly billing:Db,readonly provider:BillingPort,readonly storage?:StoragePort){}
 async authorizeOrder(actor:Actor,quoteId:string,key:string,kind:'unit'|'pilot'='unit',initialUnits=1){return this.web.transaction(async tx=>mapOrder((await tx.query<{value:Record<string,any>}>('select pitlane.create_order($1,$2,$3,$4) as value',[quoteId,key,kind,initialUnits])).rows[0].value),actor)}
 async requestRefund(actor:Actor,orderId:string,amount:string,key:string){if(!/^[1-9][0-9]*$/.test(amount)||BigInt(amount)>1000000000n)throw new Error('INVALID_INPUT');return this.web.transaction(async tx=>(await tx.query<{value:Record<string,any>}>('select pitlane.request_refund($1,$2,$3) as value',[orderId,amount,key])).rows[0].value,actor)}
 async recordPilotSummary(actor:Actor,id:string,artifactId:string,minutes:number){await this.web.transaction(tx=>tx.query('select pitlane.pilot_summary($1,$2,$3)',[id,artifactId,minutes]),actor);return mapOrder((await this.billing.query<{value:Record<string,any>}>('select pitlane.billing_order($1) as value',[id])).rows[0].value)}
 async addInitialQuote(actor:Actor,orderId:string,quoteId:string,key:string){return this.web.transaction(async tx=>mapJob((await tx.query<{value:Record<string,any>}>('select pitlane.pilot_add_quote($1,$2,$3) as value',[orderId,quoteId,key])).rows[0].value),actor)}
 async deliverPilotSummary(actor:Actor,id:string,review:{minutes:number;text:string}){
  if(!Number.isInteger(review.minutes)||review.minutes<1||review.minutes>45||typeof review.text!=='string'||review.text.trim().length<20||Buffer.byteLength(review.text)>32768)throw new Error('INVALID_INPUT');
  const context=await this.web.transaction(async tx=>(await tx.query<{value:Record<string,any>}>('select pitlane.pilot_summary_context($1) as value',[id])).rows[0].value,actor);
  if(!this.storage)throw new Error('STORAGE_UNAVAILABLE');
  const bytes=Buffer.from(canonical({schema:'pitlane.pilot-summary.v1',orderId:id,actorId:actor.userId,minutes:review.minutes,text:review.text,origin:context.origin}));const hash=rawDigest(bytes);
  const key=`${context.tenant_id}/${context.project_id}/${context.job_id}/pilot-summary/${id}/${hash}.json`;
  const reservation=await this.web.transaction(async tx=>(await tx.query<{value:{artifact_id:string;registered:boolean;upload_until?:string}}>('select pitlane.reserve_pilot_summary($1,$2,$3,$4,$5,$6) as value',[id,randomUUID(),key,hash,bytes.length,review.minutes])).rows[0].value,actor);
  if(reservation.registered)return;
  // Three bounded 30-second storage requests fit inside this remaining lease.
  const uploadUntil=Date.parse(reservation.upload_until??'');if(!Number.isFinite(uploadUntil)||uploadUntil-Date.now()<120000)throw new Error('PILOT_UPLOAD_LEASE_EXPIRED');
  try{await this.storage.put(key,bytes,'application/vnd.pitlane.pilot-summary+json')}catch(e){try{if(rawDigest(await this.storage.get(key))!==hash)throw e}catch{throw e}}
  if(rawDigest(await this.storage.get(key))!==hash)throw new Error('ARTIFACT_DIGEST_MISMATCH');
  await this.web.transaction(tx=>tx.query('select pitlane.attest_pilot_summary($1,$2,$3,$4)',[id,key,hash,bytes.length]),actor);
  await this.web.transaction(tx=>tx.query('select pitlane.register_pilot_summary($1,$2,$3,$4,$5,$6)',[id,reservation.artifact_id,key,hash,bytes.length,review.minutes]),actor);
 }
 async dispatchBilling(limit=10){const rows=(await this.billing.query<{value:Record<string,any>[]}>('select pitlane.billing_outbox($1) as value',[limit])).rows[0].value;let n=0;
 for(const op of rows){const raw=(await this.billing.query<{value:Record<string,any>}>('select pitlane.billing_order($1) as value',[op.order_id])).rows[0].value;const order=mapOrder(raw);try{
 if(op.operation==='authorize'&&order.state==='awaiting_authorization'){if(raw.hold_until&&Date.parse(raw.hold_until)<=Date.now()){await this.billing.query("select pitlane.stop_order($1,'authorization_expired')",[order.id]);}else{const r=await this.provider.authorize(order,op.business_key);if(r.state==='requires_customer_action')await this.billing.query('select pitlane.checkout_created($1,$2,$3)',[order.id,r.checkoutId,r.url]);else await this.billing.query('select pitlane.order_authorized($1,$2,$3,$4)',[order.id,r.providerId,r.captureBefore,r.amount]);}}
 if(op.operation==='capture'){if(!order.providerId)throw new Error('PAYMENT_UNAVAILABLE');const status=await this.provider.retrieve(order.providerId);if(status.amount!==order.amount.baseUnits)throw new Error('PAYMENT_AMOUNT_MISMATCH');let state:PaymentState=status.state;if(state==='authorized'){state=status.captureBefore&&Date.parse(status.captureBefore)>Date.now()?await this.provider.capture(order.providerId,order.amount.baseUnits,op.business_key):'authorization_expired'}if(!['settled','pending_reconciliation','authorization_expired','collection_failed','cancelled'].includes(state))state='collection_failed';await this.billing.query('select pitlane.collection_result($1,$2)',[order.id,state]);if(state==='pending_reconciliation')throw new Error('PENDING_RECONCILIATION');}
 if(op.operation==='cancel'){if(order.providerId){const status=await this.provider.retrieve(order.providerId);if(status.state==='settled'||status.state==='pending_reconciliation')throw new Error('PENDING_RECONCILIATION');if(status.state!=='cancelled')await this.provider.cancel(order.providerId,op.business_key)}else if(raw.checkout_id){if(!this.provider.cancelCheckout)throw new Error('CHECKOUT_CANCELLATION_UNAVAILABLE');await this.provider.cancelCheckout(raw.checkout_id,op.business_key)}await this.billing.query("select pitlane.collection_result($1,'cancelled')",[order.id]);}
 if(op.operation==='refund'){if(!order.providerId)throw new Error('PAYMENT_UNAVAILABLE');const state=await this.provider.refund(order.providerId,String(op.amount_cents),op.business_key);await this.billing.query('select pitlane.refund_result($1,$2)',[op.id,state]);if(state==='pending_reconciliation')throw new Error('PENDING_RECONCILIATION');}
 await this.billing.query('select pitlane.finish_billing_operation($1)',[op.id]);n++;
 }catch{if(op.operation==='capture')await this.billing.query("select pitlane.collection_result($1,'pending_reconciliation')",[order.id]);if(op.operation==='refund')await this.billing.query("select pitlane.refund_result($1,'pending_reconciliation')",[op.id]);await this.billing.query('select pitlane.retry_billing_operation($1)',[op.id]);}
 }return n;
 }
}
