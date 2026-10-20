import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import type pg from 'pg';
import {database,seed,T,P,U,T2,U2} from './support';
import {PostgresDb} from '../../packages/adapters/src/postgres';
import {DatabaseFixtureBilling} from '../../packages/adapters/src/fixture-billing';
import {StripeBilling} from '../../packages/adapters/src/stripe';
import {Orders} from '../../packages/core/src/orders';
import {Quotes} from '../../packages/core/src/quotes';
import {Jobs} from '../../packages/core/src/jobs';
import {input} from '../fixtures/observations';
import * as billingDomain from '../../packages/core/src/billing';

let db:pg.Pool,web:PostgresDb,billing:PostgresDb;
const actor={tenantId:T,userId:U};
const catalog=[{planId:'solo',version:'2026-10-v1',label:'Solo',priceId:'price_solo_test',amountCents:'2900',units:5,currency:'usd',interval:'month'}];
beforeAll(async()=>{db=await database();web=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!);billing=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!,'pitlane_billing')});
beforeEach(async()=>{vi.restoreAllMocks();await seed(db);await db.query("update pitlane.runtime set billing_mode='sandbox'")});
afterAll(async()=>{await Promise.all([db.end(),web.close(),billing.close()])});
function stripe(){return new StripeBilling('sk_test_unconfigured','sandbox','http://127.0.0.1:3000','acct_isolated_test')}
async function order(provider:StripeBilling|DatabaseFixtureBilling){const orders=new Orders(web,billing,provider);const q=await new Quotes(web).quote(actor,{...input,projectId:P});return {orders,order:await orders.authorizeOrder(actor,q.id,'billing-lifecycle-order-key')}}
async function event(id:string,type:string,object:Record<string,unknown>){await billing.query('select pitlane.receive_payment_event($1,$2,$3,$4,$5)',[id,'acct_isolated_test','sandbox',type,{data:{object}}])}

it('expires provider Checkout after admission expiry even without a payment intent',async()=>{
 const provider=stripe();vi.spyOn(provider.stripe.checkout.sessions,'create').mockResolvedValue({id:'cs_expire_test',url:'https://checkout.stripe.com/c/pay/test'} as any);
 vi.spyOn(provider.stripe.checkout.sessions,'retrieve').mockResolvedValue({id:'cs_expire_test',status:'open',mode:'payment',metadata:{},payment_intent:null} as any);
 const expire=vi.spyOn(provider.stripe.checkout.sessions,'expire').mockResolvedValue({id:'cs_expire_test',status:'expired'} as any);
 const {orders,order:o}=await order(provider);await orders.dispatchBilling();await db.query("update pitlane.jobs set deadline=now()-interval '1 second' where order_id=$1",[o.id]);await db.query('select pitlane.reap()');await orders.dispatchBilling();
 expect(expire).toHaveBeenCalledOnce();expect((await db.query('select state,provider_id from pitlane.orders')).rows[0]).toEqual({state:'cancelled',provider_id:null});
});

it('late confirmed authorization cannot resurrect a cancelled hold and gets its own durable cancellation',async()=>{
 const provider=stripe();vi.spyOn(provider.stripe.checkout.sessions,'create').mockResolvedValue({id:'cs_late_test',url:'https://checkout.stripe.com/c/pay/test'} as any);
 const {orders,order:o}=await order(provider);await orders.dispatchBilling();
 vi.spyOn(provider.stripe.checkout.sessions,'retrieve').mockResolvedValue({id:'cs_late_test',status:'complete',mode:'payment',currency:'usd',amount_total:400,metadata:{pitlane_order_id:o.id},payment_intent:'pi_late_test'} as any);
 vi.spyOn(provider,'retrieve').mockResolvedValue({state:'authorized',amount:'400',captureBefore:new Date(Date.now()+3600000).toISOString(),orderId:o.id});
 const cancel=vi.spyOn(provider,'cancel').mockResolvedValue();await billing.query("select pitlane.stop_order($1,'cancelled')",[o.id]);await orders.dispatchBilling();
 await event('evt_late_test','checkout.session.completed',{id:'cs_late_test'});await new billingDomain.OrderReconciler(billing,provider).applyEvents();await orders.dispatchBilling();
 expect(cancel).toHaveBeenCalled();expect((await db.query('select state from pitlane.jobs')).rows[0].state).toBe('cancelled');expect((await db.query("select count(*)::int n from pitlane.payment_outbox where operation='capture'")).rows[0].n).toBe(0);
});

it('leases fence old workers across connections and survive a process restart',async()=>{
 await event('evt_lease_test','checkout.session.completed',{id:'cs_unknown'});
 const args=[['checkout.session.completed'],1,'acct_isolated_test','sandbox'];
 const first=(await billing.query<{events:any[]}>('select pitlane.claim_payment_events($1,$2,$3,$4) as events',args)).rows[0].events[0];
 expect((await billing.query<{events:any[]}>('select pitlane.claim_payment_events($1,$2,$3,$4) as events',args)).rows[0].events).toEqual([]);
 await db.query("update pitlane.payment_inbox set lease_until=now()-interval '1 second'");
 const restart=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!,'pitlane_billing');try{
  const next=(await restart.query<{events:any[]}>('select pitlane.claim_payment_events($1,$2,$3,$4) as events',args)).rows[0].events[0];
  await expect(billing.query('select pitlane.complete_payment_event($1,$2)',['evt_lease_test',first.lease_epoch])).rejects.toThrow('PAYMENT_EVENT_LEASE_LOST');
  await restart.query('select pitlane.complete_payment_event($1,$2)',['evt_lease_test',next.lease_epoch]);
 }finally{await restart.close()}
 expect((await db.query('select processed_at is not null done,attempts from pitlane.payment_inbox')).rows[0]).toEqual({done:true,attempts:2});
});

it('quarantines malformed events individually so a good later event still completes',async()=>{
 const provider=stripe();await event('evt_bad_test','checkout.session.completed',{});await event('evt_good_test','checkout.session.completed',{id:'cs_unrelated'});
 expect(await new billingDomain.OrderReconciler(billing,provider).applyEvents()).toBe(1);
 const rows=(await db.query('select event_id,state,processed_at is not null done from pitlane.payment_inbox order by event_id')).rows;
 expect(rows).toEqual([{event_id:'evt_bad_test',state:'quarantined',done:false},{event_id:'evt_good_test',state:'processed',done:true}]);
});

it('creates an isolated durable subscription Checkout, trusts the verified link, and grants only paid invoice settlement',async()=>{
 const provider=stripe();const Purchases=(billingDomain as any).SubscriptionPurchases;expect(Purchases).toBeTypeOf('function');
 vi.spyOn(provider.stripe.prices,'retrieve').mockResolvedValue({id:'price_solo_test',active:true,currency:'usd',unit_amount:2900,type:'recurring',recurring:{interval:'month',interval_count:1},livemode:false} as any);
 const customer=vi.spyOn(provider.stripe.customers,'create').mockResolvedValue({id:'cus_isolated_test',livemode:false} as any);
 const create=vi.spyOn(provider.stripe.checkout.sessions,'create').mockResolvedValue({id:'cs_subscription_test',url:'https://checkout.stripe.com/c/pay/test'} as any);
 const purchases=new Purchases(web,billing,provider,catalog);await purchases.configureCatalog();
 expect(await purchases.listPlans(actor)).toEqual([expect.objectContaining({planId:'solo',version:'2026-10-v1',units:5,amountCents:'2900'})]);
 const request=await purchases.purchase(actor,'solo','2026-10-v1','subscription-request-test-key');await purchases.dispatch();
 expect(customer).toHaveBeenCalledOnce();expect(create.mock.calls[0][0]).toMatchObject({mode:'subscription',customer:'cus_isolated_test',line_items:[{price:'price_solo_test',quantity:1}]});
 expect((await purchases.status(actor,request.id)).checkoutUrl).toContain('https://checkout.stripe.com/');
 await expect(purchases.status({tenantId:T2,userId:U2},request.id)).rejects.toThrow('NOT_FOUND');
 vi.spyOn(provider.stripe.checkout.sessions,'retrieve').mockResolvedValue({id:'cs_subscription_test',mode:'subscription',status:'complete',customer:'cus_isolated_test',subscription:'sub_isolated_test',metadata:{pitlane_purchase_id:request.id},livemode:false} as any);
 vi.spyOn(provider.stripe.subscriptions,'retrieve').mockResolvedValue({id:'sub_isolated_test',customer:'cus_isolated_test',metadata:{pitlane_purchase_id:request.id},items:{data:[{price:{id:'price_solo_test'},quantity:1}]},livemode:false} as any);
 await event('evt_subscription_checkout_test','checkout.session.completed',{id:'cs_subscription_test'});await new billingDomain.OrderReconciler(billing,provider).applyEvents();
 expect((await db.query("select count(*)::int n from pitlane.entitlement_lots where source_key like 'invoice/%'")).rows[0].n).toBe(0);
 const seconds=Math.floor(Date.now()/1000);const invoice={id:'in_isolated_test',status:'paid',currency:'usd',amount_paid:2900,customer:'cus_isolated_test',parent:{subscription_details:{subscription:'sub_isolated_test'}},lines:{data:[{amount:2900,quantity:1,parent:{subscription_item_details:{subscription_item:'si_test',proration:false}},pricing:{price_details:{price:'price_solo_test'}},period:{start:seconds,end:seconds+2592000}}]},payments:{has_more:false,data:[{status:'paid',currency:'usd',amount_paid:2900,invoice:'in_isolated_test',livemode:false,payment:{type:'payment_intent',payment_intent:{id:'pi_subscription_test',status:'succeeded',currency:'usd',amount_received:2900,livemode:false}}}]},livemode:false};
 vi.spyOn(provider.stripe.invoices,'retrieve').mockResolvedValue(invoice as any);await event('evt_invoice_test','invoice.paid',{id:invoice.id});await new billingDomain.SubscriptionReconciler(billing,provider).applyEvents();
 await event('evt_invoice_duplicate_test','invoice.paid',{id:invoice.id});await new billingDomain.SubscriptionReconciler(billing,provider).applyEvents();
 expect((await db.query("select granted,origin from pitlane.entitlement_lots where source_key='invoice/in_isolated_test'")).rows).toEqual([{granted:5,origin:'internal'}]);expect((await db.query("select count(*)::int n from pitlane.journals where source_key='invoice/in_isolated_test'")).rows[0].n).toBe(1);
});

it('freezes each catalog version and cannot remap an already accepted price to different units',async()=>{
 const Purchases=(billingDomain as any).SubscriptionPurchases;const provider=stripe();await new Purchases(web,billing,provider,catalog).configureCatalog();
 await expect(new Purchases(web,billing,provider,[{...catalog[0],units:500}]).configureCatalog()).rejects.toThrow('IMMUTABLE_BILLING_CATALOG');
});

it('database fixture payment capture and refund dedupe survive fresh adapter instances',async()=>{
 const {orders,order:o}=await order(new DatabaseFixtureBilling(billing,'local'));await orders.dispatchBilling();const id='fixture_'+o.id;
 expect(await new DatabaseFixtureBilling(billing,'local').capture(id,'400','fixture-restart-capture')).toBe('settled');expect(await new DatabaseFixtureBilling(billing,'local').capture(id,'400','fixture-restart-capture')).toBe('settled');
 expect(await new DatabaseFixtureBilling(billing,'local').refund(id,'400','fixture-restart-refund')).toBe('settled');expect(await new DatabaseFixtureBilling(billing,'local').refund(id,'400','fixture-restart-refund')).toBe('settled');
 expect((await db.query('select refunded from pitlane.fixture_payments where id=$1',[id])).rows[0].refunded).toBe('400');
});

async function settledSubscription(){
 await billing.query('select pitlane.configure_billing_catalog($1,$2,$3)',['acct_isolated_test','sandbox',JSON.stringify(catalog)]);
 await billing.query('select pitlane.link_billing_customer($1,$2,$3,$4)',[T,'cus_adjust_test','acct_isolated_test','sandbox']);
 await db.query("insert into pitlane.billing_subscriptions(provider_subscription_id,tenant_id,provider_customer_id,plan_version,provider_account,origin,plan_id,price_id) values('sub_adjust_test',$1,'cus_adjust_test','2026-10-v1','acct_isolated_test','sandbox','solo','price_solo_test')",[T]);
 await billing.query('select pitlane.subscription_settle_verified($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',['in_adjust_test','sub_adjust_test','cus_adjust_test','price_solo_test',new Date().toISOString(),new Date(Date.now()+2592000000).toISOString(),'2900','pi_adjust_test','acct_isolated_test','sandbox']);
}
function confirmedAdjustmentProvider(){const provider=stripe();vi.spyOn(provider.stripe.paymentIntents,'retrieve').mockResolvedValue({id:'pi_adjust_test',status:'succeeded',currency:'usd',amount_received:2900,metadata:{},livemode:false} as any);return provider}

it('provider-confirmed external refund and dispute are unique, capped, balanced and restrict allowance',async()=>{
 await settledSubscription();const provider=confirmedAdjustmentProvider();
 vi.spyOn(provider.stripe.refunds,'retrieve').mockResolvedValue({id:'re_external_test',status:'succeeded',currency:'usd',amount:400,payment_intent:'pi_adjust_test',metadata:{}} as any);
 const disputes=vi.spyOn(provider.stripe.disputes,'retrieve').mockResolvedValue({id:'dp_external_test',status:'needs_response',currency:'usd',amount:2900,payment_intent:'pi_adjust_test'} as any);
 await event('evt_external_refund_test','refund.created',{id:'re_external_test'});await event('evt_external_dispute_test','charge.dispute.created',{id:'dp_external_test'});
 await new billingDomain.OrderReconciler(billing,provider).applyEvents();
 await event('evt_external_refund_dup_test','refund.updated',{id:'re_external_test'});await event('evt_external_dispute_dup_test','charge.dispute.updated',{id:'dp_external_test'});await new billingDomain.OrderReconciler(billing,provider).applyEvents();
 expect((await db.query('select refunded_cents,disputed_cents from pitlane.payment_settlements')).rows).toEqual([{refunded_cents:'400',disputed_cents:'2500'}]);
 expect((await db.query("select count(*)::int n from pitlane.journals where source_key like 'provider/%'")).rows[0].n).toBe(2);
 expect((await db.query('select count(*)::int n from(select journal_id,asset,scale from pitlane.journal_lines group by journal_id,asset,scale having sum(base_units)<>0) x')).rows[0].n).toBe(0);
 expect((await db.query("select ends_at<=now() restricted from pitlane.entitlement_lots where source_key='invoice/in_adjust_test'")).rows[0].restricted).toBe(true);
 disputes.mockResolvedValue({id:'dp_external_test',status:'won',currency:'usd',amount:2900,payment_intent:'pi_adjust_test'} as any);
 await event('evt_dispute_won_test','charge.dispute.closed',{id:'dp_external_test'});await new billingDomain.OrderReconciler(billing,provider).applyEvents();
 expect((await db.query('select disputed_cents from pitlane.payment_settlements')).rows[0].disputed_cents).toBe('0');
 expect((await db.query("select ends_at<=now() restricted from pitlane.entitlement_lots where source_key='invoice/in_adjust_test'")).rows[0].restricted).toBe(true);
});

it('an adjustment arriving before settlement retries durably and settles after the owned invoice',async()=>{
 const provider=confirmedAdjustmentProvider();vi.spyOn(provider.stripe.refunds,'retrieve').mockResolvedValue({id:'re_early_test',status:'succeeded',currency:'usd',amount:400,payment_intent:'pi_adjust_test',metadata:{}} as any);
 await event('evt_early_refund_test','refund.updated',{id:'re_early_test'});await new billingDomain.OrderReconciler(billing,provider).applyEvents();
 expect((await db.query('select state,last_error from pitlane.payment_inbox')).rows[0]).toEqual({state:'retry',last_error:'UNCONFIRMED_SETTLEMENT'});
 await settledSubscription();await db.query('update pitlane.payment_inbox set available_at=now()');const restart=new PostgresDb(process.env.PITLANE_TEST_DATABASE_URL!,'pitlane_billing');try{await new billingDomain.OrderReconciler(restart,provider).applyEvents()}finally{await restart.close()}
 expect((await db.query('select state,attempts from pitlane.payment_inbox')).rows[0]).toEqual({state:'processed',attempts:2});expect((await db.query('select refunded_cents from pitlane.payment_settlements')).rows[0].refunded_cents).toBe('400');
});

it('a lost subscription customer response reconciles persisted identity instead of creating again',async()=>{
 const provider=stripe();vi.spyOn(provider.stripe.prices,'retrieve').mockResolvedValue({id:'price_solo_test',active:true,currency:'usd',unit_amount:2900,type:'recurring',recurring:{interval:'month',interval_count:1},livemode:false} as any);
 const createCustomer=vi.spyOn(provider.stripe.customers,'create').mockRejectedValue(new Error('SIMULATED_PROVIDER_TIMEOUT'));
 vi.spyOn(provider.stripe.checkout.sessions,'create').mockResolvedValue({id:'cs_restart_test',url:'https://checkout.stripe.com/c/pay/test'} as any);
 const purchases=new billingDomain.SubscriptionPurchases(web,billing,provider,catalog);await purchases.configureCatalog();const p=await purchases.purchase(actor,'solo','2026-10-v1','subscription-restart-test-key');await purchases.dispatch();
 const search=vi.spyOn(provider.stripe.customers,'search').mockResolvedValue({data:[{id:'cus_recovered_test',livemode:false}],has_more:false} as any);
 await db.query('update pitlane.subscription_purchases set available_at=now()');await new billingDomain.SubscriptionPurchases(web,billing,provider,catalog).dispatch();
 expect(createCustomer).toHaveBeenCalledOnce();expect(search).toHaveBeenCalledOnce();expect((await purchases.status(actor,p.id)).state).toBe('awaiting_checkout');
});

it('out-of-order dispute then refund then won dispute retains the actual refund without exceeding cash',async()=>{
 await settledSubscription();await billing.query('select pitlane.apply_payment_adjustment($1,$2,$3,$4,$5,$6)',['dp_first_test','pi_adjust_test','dispute','2900','confirmed',null]);
 await billing.query('select pitlane.apply_payment_adjustment($1,$2,$3,$4,$5,$6)',['re_after_test','pi_adjust_test','refund','400','confirmed',null]);
 expect((await db.query('select refunded_cents,disputed_cents from pitlane.payment_settlements')).rows[0]).toEqual({refunded_cents:'400',disputed_cents:'2500'});
 await billing.query('select pitlane.apply_payment_adjustment($1,$2,$3,$4,$5,$6)',['dp_first_test','pi_adjust_test','dispute','2900','released',null]);
 expect((await db.query('select refunded_cents,disputed_cents from pitlane.payment_settlements')).rows[0]).toEqual({refunded_cents:'400',disputed_cents:'0'});
 expect((await db.query("select sum(base_units)::text cash from pitlane.journal_lines where account='processor_receivable'")).rows[0].cash).toBe('2500');
});

it('claims quarantine an exhausted crashed lease and account scope cannot claim another account',async()=>{
 await event('evt_exhausted_test','checkout.session.completed',{id:'cs_unknown'});await db.query("update pitlane.payment_inbox set state='processing',attempts=10,lease_until=now()-interval '1 second'");
 await billing.query('select pitlane.claim_payment_events($1,$2,$3,$4)',[['checkout.session.completed'],1,'acct_isolated_test','sandbox']);
 expect((await db.query('select state,last_error from pitlane.payment_inbox')).rows[0]).toEqual({state:'quarantined',last_error:'PAYMENT_EVENT_RETRIES_EXHAUSTED'});
 await billing.query('select pitlane.receive_payment_event($1,$2,$3,$4,$5)',['evt_other_account','acct_other_test','sandbox','checkout.session.completed',{data:{object:{id:'cs_other'}}}]);await new billingDomain.OrderReconciler(billing,stripe()).applyEvents();
 expect((await db.query("select state from pitlane.payment_inbox where event_id='evt_other_account'")).rows[0].state).toBe('pending');
});

