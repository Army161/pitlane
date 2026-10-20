import Stripe from 'stripe';
import {z} from 'zod';
import type {Actor,Db} from '../../contracts/src';
import {StripeBilling} from '../../adapters/src/stripe';

export class BillingInbox {
 constructor(readonly db:Db,readonly webhookSecret:string,readonly mode:'sandbox'|'live',readonly accountId:string){}
 async ingestWebhook(raw:Uint8Array,signature:string){const event=Stripe.webhooks.constructEvent(Buffer.from(raw),signature,this.webhookSecret,300);if(event.livemode!==(this.mode==='live')||(event.account&&event.account!==this.accountId))throw new Error('FOREIGN_PAYMENT_ENVIRONMENT');await this.db.query('select pitlane.receive_payment_event($1,$2,$3,$4,$5)',[event.id,this.accountId,this.mode,event.type,event])}
}

type InboxEvent={event_id:string;event_type:string;origin:string;provider_account:string;lease_epoch:string;payload:any};
type QueryDb=Pick<Db,'query'>;
type Apply=(tx:QueryDb)=>Promise<unknown>;
const permanentCodes=new Set(['MALFORMED_PAYMENT_EVENT','FOREIGN_PAYMENT_ENVIRONMENT','FOREIGN_PAYMENT_SCOPE','UNSUPPORTED_PAYMENT_METHOD','UNSUPPORTED_SUBSCRIPTION_PLAN','UNSUPPORTED_INVOICE_SCOPE','INVALID_SETTLEMENT','INVALID_PAYMENT_ADJUSTMENT','PAYMENT_AMOUNT_MISMATCH','PAYMENT_EVENT_IDENTITY_CONFLICT','PAYMENT_SETTLEMENT_IDENTITY_CONFLICT','PAYMENT_ADJUSTMENT_IDENTITY_CONFLICT','REFUND_EXCEEDS_SETTLEMENT','CAPTURE_WITHOUT_DELIVERY']);
function failure(error:unknown){const message=error instanceof Error?error.message:'';const code=/^[A-Z_]{1,80}$/.test(message)?message:'PROVIDER_RETRY_REQUIRED';return {code,permanent:permanentCodes.has(code)}}
async function drain(db:Db,provider:StripeBilling,kinds:string[]|null,prepare:(event:InboxEvent)=>Promise<Apply|undefined>,maximum=100){
 let completed=0;
 // Claim immediately before provider work; never age a batch's later leases.
 for(let n=0;n<maximum;n++){
  const event=(await db.query<{events:InboxEvent[]}>('select pitlane.claim_payment_events($1,$2,$3,$4) as events',[kinds,1,provider.accountId??null,provider.mode])).rows[0].events[0];if(!event)break;
  try{const object=event.payload?.data?.object;if(!object||typeof object.id!=='string'||!object.id)throw new Error('MALFORMED_PAYMENT_EVENT');const apply=await prepare(event);await db.transaction(async tx=>{await apply?.(tx);await tx.query('select pitlane.complete_payment_event($1,$2)',[event.event_id,event.lease_epoch])});completed++;}
  catch(error){const {code,permanent}=failure(error);try{await db.query('select pitlane.fail_payment_event($1,$2,$3,$4)',[event.event_id,event.lease_epoch,code,permanent])}catch(leaseError){if(!(leaseError instanceof Error&&leaseError.message.includes('PAYMENT_EVENT_LEASE_LOST')))throw leaseError}}
 }
 return completed;
}
async function value(db:QueryDb,sql:string,args:unknown[]=[]){return (await db.query<{value:any}>(sql,args)).rows[0]?.value}
const catalogSchema=z.array(z.object({planId:z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),version:z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),label:z.string().min(1).max(80),priceId:z.string().regex(/^price_[a-zA-Z0-9_]{1,128}$/),amountCents:z.string().max(10).regex(/^[1-9][0-9]*$/).refine(v=>/^[1-9][0-9]*$/.test(v)&&v.length<=10&&BigInt(v)<=1000000000n),units:z.number().int().min(1).max(10000),currency:z.literal('usd'),interval:z.literal('month')})).max(32);
export type BillingCatalogPlan=z.infer<typeof catalogSchema>[number];
export function validateBillingCatalog(input:unknown):BillingCatalogPlan[]{const result=catalogSchema.safeParse(input);if(!result.success||new Set(result.data.map(p=>p.planId+'/'+p.version)).size!==result.data.length||new Set(result.data.map(p=>p.priceId)).size!==result.data.length)throw new Error('INVALID_BILLING_CATALOG');return result.data}
export type SubscriptionPurchase={id:string;state:'requested'|'awaiting_checkout'|'linked'|'expired'|'failed';planId:string;version:string;checkoutUrl:string|null;holdUntil:string};
export function mapSubscriptionPurchase(r:any):SubscriptionPurchase{return {id:r.id,state:r.state,planId:r.plan_id,version:r.plan_version,checkoutUrl:r.checkout_url??null,holdUntil:r.hold_until}}
export class SubscriptionPurchases {
 readonly catalog:BillingCatalogPlan[];
 constructor(readonly web:Db,readonly billing:Db,readonly provider:StripeBilling,catalog:unknown=[]){this.catalog=validateBillingCatalog(catalog);if(!provider.accountId)throw new Error('PAYMENT_ACCOUNT_REQUIRED')}
 async configureCatalog(){await this.billing.query('select pitlane.configure_billing_catalog($1,$2,$3)',[this.provider.accountId,this.provider.mode,JSON.stringify(this.catalog)])}
 async listPlans(actor:Actor){return this.web.transaction(async tx=>(await tx.query<{value:Omit<BillingCatalogPlan,'priceId'>[]}>('select pitlane.subscription_plans() as value')).rows[0].value,actor)}
 async purchase(actor:Actor,planId:string,version:string,key:string){return this.web.transaction(async tx=>mapSubscriptionPurchase(await value(tx,'select pitlane.purchase_subscription($1,$2,$3) as value',[planId,version,key])),actor)}
 async status(actor:Actor,id:string){return this.web.transaction(async tx=>mapSubscriptionPurchase(await value(tx,'select pitlane.subscription_purchase_status($1) as value',[id])),actor)}
 async dispatch(maximum=10){let completed=0;for(let n=0;n<maximum;n++){
  const p=(await this.billing.query<{value:any[]}>('select pitlane.claim_subscription_purchases($1,$2) as value',[this.provider.accountId,this.provider.mode])).rows[0].value[0];if(!p)break;
  try{
   if(Date.parse(p.hold_until)<=Date.now()){
    if(p.checkout_attempted){const customer=await value(this.billing,'select pitlane.billing_customer($1,$2,$3) as value',[p.tenant_id,this.provider.accountId,this.provider.mode]);if(!customer)throw new Error('PENDING_RECONCILIATION');const session=await this.provider.subscriptionCheckout({...p,provider_customer_id:customer.provider_customer_id},p.id+'/checkout',true);await this.billing.query('select pitlane.subscription_checkout_created($1,$2,$3,$4,$5)',[p.id,p.lease_epoch,customer.provider_customer_id,session.checkoutId,session.url]);if(session.status==='complete'||session.status==='expired')await new OrderReconciler(this.billing,this.provider).reconcileCheckout(session.checkoutId);continue;}
    throw new Error('SUBSCRIPTION_HOLD_EXPIRED');
   }await this.provider.validateSubscriptionPrice(p.catalog);
   let customer=await value(this.billing,'select pitlane.billing_customer($1,$2,$3) as value',[p.tenant_id,this.provider.accountId,this.provider.mode]);
   if(!customer){const prior=await value(this.billing,'select pitlane.subscription_external_attempt($1,$2,$3) as value',[p.id,p.lease_epoch,'customer']);const id=await this.provider.subscriptionCustomer(p.tenant_id,p.id+'/customer',prior);await this.billing.query('select pitlane.link_billing_customer($1,$2,$3,$4)',[p.tenant_id,id,this.provider.accountId,this.provider.mode]);customer={provider_customer_id:id};}
   const prior=await value(this.billing,'select pitlane.subscription_external_attempt($1,$2,$3) as value',[p.id,p.lease_epoch,'checkout']);const session=await this.provider.subscriptionCheckout({...p,provider_customer_id:customer.provider_customer_id},p.id+'/checkout',prior);
   await this.billing.query('select pitlane.subscription_checkout_created($1,$2,$3,$4,$5)',[p.id,p.lease_epoch,customer.provider_customer_id,session.checkoutId,session.url]);if(session.status==='complete'||session.status==='expired')await new OrderReconciler(this.billing,this.provider).reconcileCheckout(session.checkoutId);completed++;
  }catch(error){const {code,permanent}=failure(error);try{await this.billing.query('select pitlane.fail_subscription_purchase($1,$2,$3,$4)',[p.id,p.lease_epoch,code,permanent||code==='SUBSCRIPTION_HOLD_EXPIRED'])}catch(leaseError){if(!(leaseError instanceof Error&&leaseError.message.includes('PAYMENT_EVENT_LEASE_LOST')))throw leaseError}}
 }
 const expiring=(await this.billing.query<{value:any[]}>('select pitlane.expiring_subscription_checkouts($1,$2) as value',[this.provider.accountId,this.provider.mode])).rows[0].value;
 for(const p of expiring){try{await this.provider.cancelCheckout(p.checkout_id,p.id+'/expire');await this.billing.query('select pitlane.expire_subscription_checkout($1)',[p.id])}catch{/* Durable Checkout remains available for the next reconciliation. */}}
 return completed;
 }
}

export class SubscriptionReconciler {
 // Only persisted catalog rows determine allowance. Legacy mutable maps are ignored.
 constructor(readonly db:Db,readonly provider:StripeBilling,_legacyPlanUnits?:Record<string,number>){}
 async applyEvents(maximum=100){return drain(this.db,this.provider,['invoice.paid','invoice.payment_failed','customer.subscription.deleted','customer.subscription.updated'],e=>this.prepare(e),maximum)}
 async applySubscriptionEvent(_eventId:string){return this.applyEvents()}
 async prepare(event:InboxEvent):Promise<Apply|undefined>{
  const id=event.payload.data.object.id;
  if(event.event_type.startsWith('customer.subscription.')){const s=await this.provider.stripe.subscriptions.retrieve(id);this.provider.assertEnvironment(s);const customer=typeof s.customer==='string'?s.customer:s.customer.id;const link=await value(this.db,'select pitlane.subscription_link($1,$2) as value',[id,customer]);if(!link)return;if(link.origin!==this.provider.mode||link.provider_account!==this.provider.accountId)throw new Error('FOREIGN_PAYMENT_SCOPE');const reason=restrictionReason(s.status);if(reason)return tx=>tx.query('select pitlane.restrict_subscription($1,$2)',[id,reason]);if(s.status==='active')return tx=>tx.query('select pitlane.recover_subscription($1,$2,$3,$4)',[id,customer,this.provider.accountId,this.provider.mode]);return;}
  const invoice=await this.provider.stripe.invoices.retrieve(id,{expand:['payments.data.payment.payment_intent']});this.provider.assertEnvironment(invoice);
  const subscriptionId=invoice.parent?.subscription_details?.subscription;if(typeof subscriptionId!=='string'||typeof invoice.customer!=='string')throw new Error('UNSUPPORTED_INVOICE_SCOPE');
  const link=await value(this.db,'select pitlane.subscription_link($1,$2) as value',[subscriptionId,invoice.customer]);if(!link)throw new Error('UNRELATED_SUBSCRIPTION');if(link.origin!==this.provider.mode||link.provider_account!==this.provider.accountId)throw new Error('FOREIGN_PAYMENT_SCOPE');
  const subscription=await this.provider.stripe.subscriptions.retrieve(subscriptionId);this.provider.assertEnvironment(subscription);if(subscription.customer!==invoice.customer)throw new Error('FOREIGN_PAYMENT_SCOPE');
  if(event.event_type==='invoice.payment_failed'){if(invoice.status==='paid')return;const reason=restrictionReason(subscription.status);if(reason)return tx=>tx.query('select pitlane.restrict_subscription($1,$2)',[subscriptionId,reason]);return;}
  if(invoice.status!=='paid')throw new Error('UNCONFIRMED_INVOICE_SETTLEMENT');
  const lines=invoice.lines.data;const line=lines.length===1&&!invoice.lines.has_more?lines[0]:undefined;const priceId=line?.pricing?.price_details?.price;
  if(!line||priceId!==link.catalog.price_id||line.quantity!==1||line.parent?.subscription_item_details?.proration===true||!line.parent?.subscription_item_details?.subscription_item||String(line.amount)!==String(link.catalog.amount_cents)||invoice.currency!=='usd'||String(invoice.amount_paid)!==String(link.catalog.amount_cents)||!Number.isSafeInteger(line.period?.start)||!Number.isSafeInteger(line.period?.end)||line.period.end<=line.period.start)throw new Error('UNSUPPORTED_SUBSCRIPTION_PLAN');
  const payments=invoice.payments?.data.filter(p=>p.status==='paid'&&p.payment?.type==='payment_intent');const invoicePayment=payments?.length===1?payments[0]:undefined;const intent=invoicePayment?.payment.payment_intent;
  if(!invoicePayment||invoice.payments?.has_more||invoicePayment.currency!=='usd'||String(invoicePayment.amount_paid)!==String(invoice.amount_paid)||(typeof invoicePayment.invoice==='string'?invoicePayment.invoice:invoicePayment.invoice.id)!==invoice.id||!intent||typeof intent!=='object'||intent.status!=='succeeded'||typeof intent.id!=='string'||intent.currency!=='usd'||String(intent.amount_received)!==String(invoice.amount_paid))throw new Error('UNCONFIRMED_INVOICE_SETTLEMENT');this.provider.assertEnvironment(invoicePayment);this.provider.assertEnvironment(intent);
  return async tx=>{if(subscription.status==='active')await tx.query('select pitlane.recover_subscription($1,$2,$3,$4)',[subscriptionId,invoice.customer,this.provider.accountId,this.provider.mode]);else{const reason=restrictionReason(subscription.status);if(reason)await tx.query('select pitlane.restrict_subscription($1,$2)',[subscriptionId,reason]);}await tx.query('select pitlane.subscription_settle_verified($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[invoice.id,subscriptionId,invoice.customer,priceId,new Date(line.period.start*1000).toISOString(),new Date(line.period.end*1000).toISOString(),String(invoice.amount_paid),intent.id,this.provider.accountId,this.provider.mode]);};
 }
}

function restrictionReason(status:string){return ['canceled','incomplete_expired'].includes(status)?'cancelled':['unpaid','past_due','paused'].includes(status)?'delinquent':undefined}

const orderEventTypes=['checkout.session.completed','checkout.session.expired','checkout.session.async_payment_failed','payment_intent.succeeded','payment_intent.canceled','payment_intent.payment_failed','payment_intent.amount_capturable_updated','refund.created','refund.updated','refund.failed','charge.refunded','charge.dispute.created','charge.dispute.updated','charge.dispute.closed','charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated'];
export class OrderReconciler {
 constructor(readonly db:Db,readonly provider:StripeBilling){}
 async applyEvents(maximum=100){return drain(this.db,this.provider,orderEventTypes,e=>this.prepare(e),maximum)}
 async reconcileCheckout(id:string){const apply=await this.checkout(id,'checkout.session.completed');if(apply)await this.db.transaction(tx=>apply(tx))}
 async prepare(event:InboxEvent):Promise<Apply|undefined>{
  const type=event.event_type,id=event.payload.data.object.id;if(type.startsWith('checkout.session.'))return this.checkout(id,type);
  if(type.startsWith('payment_intent.')){
   const order=await value(this.db,'select pitlane.order_for_payment($1) as value',[id]);if(!order)return;const p=await this.provider.retrieve(id);if(p.orderId!==order.id||p.amount!==String(order.amount_cents))throw new Error('FOREIGN_PAYMENT_SCOPE');
   if(p.state==='settled')return tx=>tx.query("select pitlane.collection_result($1,'settled')",[order.id]);if(p.state==='cancelled')return tx=>tx.query("select pitlane.stop_order($1,'cancelled')",[order.id]);if(p.state==='authorization_expired')return tx=>tx.query("select pitlane.stop_order($1,'authorization_expired')",[order.id]);return;
  }
  if(type.startsWith('refund.'))return this.refund(id);
  if(type==='charge.refunded'){
   const charge=await this.provider.stripe.charges.retrieve(id);this.provider.assertEnvironment(charge);if(charge.currency!=='usd')throw new Error('FOREIGN_PAYMENT_SCOPE');
   const adjustments:Apply[]=[];let after:string|undefined;for(let n=0;n<10;n++){const page=await this.provider.stripe.refunds.list({charge:id,limit:100,...(after?{starting_after:after}:{})});for(const refund of page.data)if(refund.status==='succeeded'){const apply=await this.refund(refund.id);if(apply)adjustments.push(apply)}if(!page.has_more)return async tx=>{for(const apply of adjustments)await apply(tx)};after=page.data.at(-1)?.id;if(!after)break}throw new Error('REFUND_RECONCILIATION_REQUIRED');
  }
  if(type.startsWith('charge.dispute.'))return this.dispute(id);
 }
 private async checkout(id:string,type:string):Promise<Apply|undefined>{
  const order=await value(this.db,'select pitlane.order_for_checkout($1) as value',[id]);const purchase=order?undefined:await value(this.db,'select pitlane.subscription_for_checkout($1) as value',[id]);if(!order&&!purchase)return;
  const checkout=await this.provider.stripe.checkout.sessions.retrieve(id);this.provider.assertEnvironment(checkout);
  if(order){
   if(checkout.mode!=='payment'||checkout.currency!=='usd'||String(checkout.amount_total)!==String(order.amount_cents)||checkout.metadata?.pitlane_order_id!==order.id)throw new Error('FOREIGN_PAYMENT_SCOPE');
   if(checkout.status==='expired'||type==='checkout.session.async_payment_failed')return tx=>tx.query("select pitlane.stop_order($1,'authorization_expired')",[order.id]);
   if(checkout.status==='complete'&&typeof checkout.payment_intent==='string'){
    const p=await this.provider.retrieve(checkout.payment_intent);if(p.orderId!==order.id||p.amount!==String(order.amount_cents))throw new Error('FOREIGN_PAYMENT_SCOPE');if(p.state==='cancelled')return tx=>tx.query("select pitlane.stop_order($1,'cancelled')",[order.id]);if(p.state==='authorization_expired')return tx=>tx.query("select pitlane.stop_order($1,'authorization_expired')",[order.id]);if(p.state!=='authorized'||!p.captureBefore)throw new Error('UNCONFIRMED_AUTHORIZATION');return tx=>tx.query('select pitlane.order_authorized($1,$2,$3,$4)',[order.id,checkout.payment_intent,p.captureBefore,p.amount]);
   }throw new Error('UNCONFIRMED_AUTHORIZATION');
  }
  if(purchase.provider_account!==this.provider.accountId||purchase.origin!==this.provider.mode||checkout.mode!=='subscription'||checkout.customer!==purchase.provider_customer_id||checkout.metadata?.pitlane_purchase_id!==purchase.id)throw new Error('FOREIGN_PAYMENT_SCOPE');if(checkout.status==='expired')return tx=>tx.query('select pitlane.expire_subscription_checkout($1)',[purchase.id]);if(checkout.status!=='complete'||typeof checkout.subscription!=='string')throw new Error('UNCONFIRMED_SUBSCRIPTION');
  const s=await this.provider.stripe.subscriptions.retrieve(checkout.subscription);this.provider.assertEnvironment(s);if(s.customer!==purchase.provider_customer_id||s.metadata.pitlane_purchase_id!==purchase.id||s.items.data.length!==1||s.items.data[0].price.id!==purchase.catalog.price_id||s.items.data[0].quantity!==1)throw new Error('FOREIGN_PAYMENT_SCOPE');
  if(purchase.state==='expired'||Date.parse(purchase.hold_until)<=Date.now()){await this.provider.cancelCheckout(id,purchase.id+'/expire');return async tx=>{await tx.query('select pitlane.trust_subscription_checkout($1,$2,$3)',[purchase.id,checkout.customer,checkout.subscription]);await tx.query('select pitlane.restrict_subscription($1,$2)',[s.id,'cancelled']);};}return async tx=>{await tx.query('select pitlane.trust_subscription_checkout($1,$2,$3)',[purchase.id,checkout.customer,checkout.subscription]);const reason=restrictionReason(s.status);if(reason)await tx.query('select pitlane.restrict_subscription($1,$2)',[s.id,reason]);};
 }
 private async settlement(paymentId:string){
  const s=await value(this.db,'select pitlane.payment_settlement($1) as value',[paymentId]);if(!s)throw new Error('UNCONFIRMED_SETTLEMENT');if(s.origin!=='fixture'&&(s.origin!==this.provider.mode||s.provider_account&&s.provider_account!==this.provider.accountId))throw new Error('FOREIGN_PAYMENT_SCOPE');
  const p=await this.provider.stripe.paymentIntents.retrieve(paymentId);this.provider.assertEnvironment(p);if(p.status!=='succeeded'||p.currency!=='usd'||String(p.amount_received)!==String(s.amount_cents)||s.order_id&&p.metadata.pitlane_order_id!==s.order_id)throw new Error('UNCONFIRMED_SETTLEMENT');return s;
 }
 private async refund(id:string):Promise<Apply|undefined>{const r=await this.provider.stripe.refunds.retrieve(id);if(r.status!=='succeeded')return;if(r.currency!=='usd'||typeof r.payment_intent!=='string')throw new Error('FOREIGN_PAYMENT_SCOPE');await this.settlement(r.payment_intent);return tx=>tx.query('select pitlane.apply_payment_adjustment($1,$2,$3,$4,$5,$6)',[r.id,r.payment_intent,'refund',String(r.amount),'confirmed',r.metadata?.pitlane_business_key??null]);}
 private async dispute(id:string):Promise<Apply|undefined>{const d=await this.provider.stripe.disputes.retrieve(id);this.provider.assertEnvironment(d);if(d.currency!=='usd'||typeof d.payment_intent!=='string')throw new Error('FOREIGN_PAYMENT_SCOPE');await this.settlement(d.payment_intent);const state=['won','warning_closed'].includes(d.status)?'released':['needs_response','under_review','lost'].includes(d.status)?'confirmed':undefined;if(!state)return;return tx=>tx.query('select pitlane.apply_payment_adjustment($1,$2,$3,$4,$5,$6)',[d.id,d.payment_intent,'dispute',String(d.amount),state,null]);}
}

/** One dispatcher claims every account-owned event; irrelevant provider events
 * are durably acknowledged without inventing financial or entitlement state. */
export class PaymentReconciler {
 readonly orders:OrderReconciler;readonly subscriptions:SubscriptionReconciler;
 constructor(readonly db:Db,readonly provider:StripeBilling){this.orders=new OrderReconciler(db,provider);this.subscriptions=new SubscriptionReconciler(db,provider)}
 async applyEvents(maximum=100){return drain(this.db,this.provider,null,event=>event.event_type.startsWith('invoice.')||event.event_type.startsWith('customer.subscription.')?this.subscriptions.prepare(event):this.orders.prepare(event),maximum)}
}

/** Durable obligations survive membership revocation and soft deletion. */
export class SubscriptionCancellationDispatcher {
 constructor(readonly db:Db,readonly provider:StripeBilling){if(!provider.accountId)throw new Error('PAYMENT_ACCOUNT_REQUIRED')}
 async dispatch(maximum=10){let completed=0;for(let n=0;n<maximum;n++){
  const op=(await this.db.query<{value:any[]}>('select pitlane.claim_subscription_cancellations($1,$2) as value',[this.provider.accountId,this.provider.mode])).rows[0].value[0];if(!op)break;
  try{
   if(op.kind==='subscription')await this.provider.cancelSubscription(op.provider_id,op.business_key,op.provider_customer_id);
   else if(op.kind==='checkout'){await this.provider.cancelCheckout(op.provider_id,op.business_key);await new OrderReconciler(this.db,this.provider).reconcileCheckout(op.provider_id);}
   else if(op.kind==='discover_checkout'){
    const customer=op.provider_customer_id??await this.provider.subscriptionCustomer(op.tenant_id,op.purchase_id+'/customer',true);if(!op.provider_customer_id)await this.db.query('select pitlane.link_billing_customer($1,$2,$3,$4)',[op.tenant_id,customer,this.provider.accountId,this.provider.mode]);
    let after:string|undefined,found=false;
    for(let page=0;page<10;page++){
     const sessions=await this.provider.stripe.checkout.sessions.list({customer,limit:100,...(after?{starting_after:after}:{})});
     const matches=sessions.data.filter(s=>s.metadata?.pitlane_business_key===op.purchase_id+'/checkout');
     for(const session of matches){this.provider.assertEnvironment(session);await this.db.query('select pitlane.record_deleted_subscription_checkout($1,$2,$3)',[op.purchase_id,session.id,customer]);await this.provider.cancelCheckout(session.id,op.business_key+'/'+session.id);await new OrderReconciler(this.db,this.provider).reconcileCheckout(session.id);found=true;}
     if(!sessions.has_more)break;after=sessions.data.at(-1)?.id;if(!after||page===9)throw new Error('CHECKOUT_RECONCILIATION_REQUIRED');
    }
    if(!found&&Date.parse(op.discover_until)>Date.now())throw new Error('PENDING_RECONCILIATION');
   }else throw new Error('INVALID_PAYMENT_OPERATION');
   await this.db.query('select pitlane.finish_subscription_cancellation($1,$2)',[op.id,op.lease_epoch]);completed++;
  }catch(error){const {code,permanent}=failure(error);try{await this.db.query('select pitlane.retry_subscription_cancellation($1,$2,$3,$4)',[op.id,op.lease_epoch,code,permanent])}catch(leaseError){if(!(leaseError instanceof Error&&leaseError.message.includes('PAYMENT_EVENT_LEASE_LOST')))throw leaseError}}
 }return completed;
 }
}
