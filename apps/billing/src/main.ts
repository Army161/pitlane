import {PostgresDb} from '../../../packages/adapters/src/postgres';
import {StripeBilling} from '../../../packages/adapters/src/stripe';
import {DatabaseFixtureBilling} from '../../../packages/adapters/src/fixture-billing';
import {boundedBytes} from '../../../packages/adapters/src/solana-rpc';
import {startService,isEntrypoint,installShutdown} from '../../../packages/adapters/src/service-host';
import {loadConfig,databaseUrl,required} from '../../../packages/core/src/config';
import {serviceBuild,validateStartup} from '../../../packages/core/src/startup';
import {Orders} from '../../../packages/core/src/orders';
import {BillingInbox,PaymentReconciler,SubscriptionPurchases,SubscriptionCancellationDispatcher} from '../../../packages/core/src/billing';
export async function main(env:Record<string,string|undefined>=process.env){
 const config=loadConfig(env),build=serviceBuild(env,config),db=new PostgresDb(databaseUrl(env,'BILLING'),'pitlane_billing');
 try{
  await validateStartup(db,config,'pitlane_billing',build);
  const enabled=config.billingMode!=='disabled';
  const provider=!enabled?undefined:config.mode==='local'?new DatabaseFixtureBilling(db,'local'):new StripeBilling(required(env,'PITLANE_STRIPE_SECRET_KEY'),config.billingMode as 'sandbox'|'live',required(env,'PITLANE_ORIGIN'),required(env,'PITLANE_STRIPE_ACCOUNT_ID'));
  const orders=provider?new Orders(db,db,provider):undefined;
  const stripe=provider instanceof StripeBilling?provider:undefined;
  const account=stripe?required(env,'PITLANE_STRIPE_ACCOUNT_ID'):undefined;
  if(stripe&&(await stripe.stripe.accounts.retrieve(null)).id!==account)throw new Error('FOREIGN_PAYMENT_ENVIRONMENT');
  const inbox=stripe?new BillingInbox(db,required(env,'PITLANE_STRIPE_WEBHOOK_SECRET'),stripe.mode,account!):undefined;
  const purchases=stripe?new SubscriptionPurchases(db,db,stripe,JSON.parse(env.PITLANE_BILLING_CATALOG??'[]')):undefined;
  await purchases?.configureCatalog();
  const reconciler=stripe?new PaymentReconciler(db,stripe):undefined;
  const cancellations=stripe?new SubscriptionCancellationDispatcher(db,stripe):undefined;
  const service=await startService({name:'billing',port:Number(env.PORT??3004),host:config.mode==='local'?'127.0.0.1':'0.0.0.0',details:()=>({mode:config.mode,build,billing:config.billingMode}),heartbeat:()=>validateStartup(db,config,'pitlane_billing',build),tick:async()=>{
   await cancellations?.dispatch();await orders?.dispatchBilling();await purchases?.dispatch();await reconciler?.applyEvents();
  },handler:async request=>{
   if(!inbox||request.method!=='POST'||new URL(request.url).pathname!=='/webhooks/stripe')return new Response(null,{status:404});
   try{const signature=request.headers.get('stripe-signature');if(!signature||signature.length>8192)return new Response(null,{status:400});await inbox.ingestWebhook(await boundedBytes(new Response(request.body),1048576),signature);return new Response(null,{status:204});}catch{return new Response(null,{status:400});}
  },close:()=>db.close()});installShutdown(service,config.mode);return service;
 }catch(error){await db.close();throw error;}
}
if(isEntrypoint(import.meta.url))void main().catch(()=>{process.stderr.write('PITLANE billing startup failed.\n');process.exitCode=1;});
