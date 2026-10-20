import Stripe from 'stripe';
import {expect,it,vi} from 'vitest';
import type {Db,Order} from '../../packages/contracts/src';
import {StripeBilling} from '../../packages/adapters/src/stripe';
import {BillingInbox,validateBillingCatalog} from '../../packages/core/src/billing';

const order:Order={id:'10000000-0000-4000-8000-000000000001',tenantId:'tenant-isolated-fixture',projectId:'project-isolated-fixture',kind:'unit',state:'awaiting_authorization',amount:{asset:'USD',scale:2,baseUnits:'400'},providerId:null,captureBefore:null,deliveredVersionId:null};
function provider(){return new StripeBilling('sk_test_unconfigured','sandbox','http://127.0.0.1:3000','acct_isolated_test')}
it('uses only the pinned SDK card filter and explicit manual capture for one-off Checkout',async()=>{
 const billing=provider();const create=vi.spyOn(billing.stripe.checkout.sessions,'create').mockResolvedValue({id:'cs_fixture_test',url:'https://checkout.stripe.com/c/pay/test',livemode:false} as any);
 await billing.authorize(order,'isolated-order/authorize');
 expect(create.mock.calls[0][0]).toMatchObject({allowed_payment_method_types:['card'],payment_intent_data:{capture_method:'manual',metadata:{pitlane_order_id:order.id}}});
});
it('refuses automatic-capture, wrong currency and cross-environment provider authorization',async()=>{
 const billing=provider();const retrieve=vi.spyOn(billing.stripe.paymentIntents,'retrieve');
 const payment={id:'pi_isolated_test',status:'requires_capture',amount:400,currency:'usd',capture_method:'automatic',payment_method:{type:'card'},latest_charge:{payment_method_details:{card:{capture_before:Math.floor(Date.now()/1000)+3600}}},metadata:{pitlane_order_id:order.id},livemode:false};
 retrieve.mockResolvedValue(payment as any);await expect(billing.retrieve(payment.id)).rejects.toThrow('UNSUPPORTED_PAYMENT_METHOD');
 retrieve.mockResolvedValue({...payment,capture_method:'manual',currency:'eur'} as any);await expect(billing.retrieve(payment.id)).rejects.toThrow('FOREIGN_PAYMENT_SCOPE');
 retrieve.mockResolvedValue({...payment,capture_method:'manual',livemode:true} as any);await expect(billing.retrieve(payment.id)).rejects.toThrow('FOREIGN_PAYMENT_ENVIRONMENT');
});
it('expires an open Checkout and reconciles a complete one before cancellation',async()=>{
 const billing=provider();const sessions=vi.spyOn(billing.stripe.checkout.sessions,'retrieve').mockResolvedValue({id:'cs_isolated_test',status:'open',mode:'payment',livemode:false} as any);
 const expire=vi.spyOn(billing.stripe.checkout.sessions,'expire').mockResolvedValue({id:'cs_isolated_test',status:'expired'} as any);
 await billing.cancelCheckout('cs_isolated_test','isolated-order/cancel');expect(expire).toHaveBeenCalledOnce();
 sessions.mockResolvedValue({id:'cs_isolated_test',status:'complete',mode:'payment',payment_intent:'pi_isolated_test',livemode:false} as any);
 vi.spyOn(billing,'retrieve').mockResolvedValue({state:'settled',amount:'400',captureBefore:null,orderId:order.id});const cancel=vi.spyOn(billing,'cancel');
 await expect(billing.cancelCheckout('cs_isolated_test','isolated-order/cancel')).rejects.toThrow('PENDING_RECONCILIATION');expect(cancel).not.toHaveBeenCalled();
});
it('rejects duplicate catalog mappings and validates exact integer commercial units',()=>{
 const plan={planId:'solo',version:'v1',label:'Solo',priceId:'price_isolated_test',amountCents:'2900',units:5,currency:'usd',interval:'month'};
 expect(validateBillingCatalog([])).toEqual([]);expect(validateBillingCatalog([plan])).toEqual([plan]);
 expect(()=>validateBillingCatalog([plan,plan])).toThrow('INVALID_BILLING_CATALOG');expect(()=>validateBillingCatalog([{...plan,units:0.5}])).toThrow('INVALID_BILLING_CATALOG');expect(()=>validateBillingCatalog([{...plan,amountCents:'29.00'}])).toThrow('INVALID_BILLING_CATALOG');
});
it('authenticates raw inbox signatures and rejects signed foreign scope before database ingestion',async()=>{
 const query=vi.fn().mockResolvedValue({rows:[],rowCount:1});const db={query,transaction:vi.fn()} as unknown as Db;
 const secret='whsec_isolated_unit_fixture_only';const inbox=new BillingInbox(db,secret,'sandbox','acct_isolated_test');
 const payload=JSON.stringify({id:'evt_signed_fixture',object:'event',type:'checkout.session.completed',livemode:false,account:'acct_isolated_test',data:{object:{id:'cs_fixture'}}});
 const signature=Stripe.webhooks.generateTestHeaderString({payload,secret});await inbox.ingestWebhook(Buffer.from(payload),signature);expect(query).toHaveBeenCalledOnce();
 await expect(inbox.ingestWebhook(Buffer.from(payload+' '),signature)).rejects.toThrow();
 const foreign=JSON.stringify({id:'evt_signed_foreign_fixture',type:'checkout.session.completed',livemode:false,account:'acct_foreign_fixture',data:{object:{id:'cs_foreign'}}});
 await expect(inbox.ingestWebhook(Buffer.from(foreign),Stripe.webhooks.generateTestHeaderString({payload:foreign,secret}))).rejects.toThrow('FOREIGN_PAYMENT_ENVIRONMENT');expect(query).toHaveBeenCalledOnce();
});
