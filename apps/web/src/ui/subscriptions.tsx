'use client';
import {useState} from 'react';
import type {ScreenProps} from './protocol';
import {date,usd} from './protocol';
import {useData} from './data';
import {Load,Status} from './work';
type Plan={planId:string;version:string;label:string;amountCents:string;units:number;currency:string;interval:string};
type Purchase={id:string;state:string;checkoutUrl:string|null;holdUntil:string};
export function Subscriptions({call,act,busy,notify}:ScreenProps){
 const plans=useData(()=>call<Plan[]>('/v1/billing/plans'),[],[call]);
 const [purchase,setPurchase]=useState<Purchase|null>(null),[pending,setPending]=useState<{plan:string;version:string;key:string}|null>(null);
 const status=useData(()=>purchase?call<Purchase>('/v1/billing/subscriptions/'+purchase.id):Promise.resolve(null),null,[call,purchase?.id],purchase?5000:0);
 const current=status.value??purchase;
 const checkout=current?.checkoutUrl&&/^https:\/\/checkout\.stripe\.com\//.test(current.checkoutUrl)?current.checkoutUrl:null;
 return <section className="panel"><h2>Subscription allowance</h2><p>Choose a configured plan. Units are granted only after a confirmed paid invoice for its actual allowance period.</p><Load {...plans}/>{!plans.loading&&!plans.error&&!plans.value.length&&<p className="empty">No subscription plans are published for this environment.</p>}<div className="grid">{plans.value.map(plan=><article className="panel" key={plan.planId+plan.version}><h3>{plan.label}</h3><p><strong>{usd(plan.amountCents)} USD / {plan.interval}</strong></p><p>{plan.units} standard units per confirmed period</p><small>Plan {plan.planId} · version {plan.version}</small><button disabled={busy||!!pending&&(pending.plan!==plan.planId||pending.version!==plan.version)} onClick={()=>void act(async()=>{const attempt=pending??{plan:plan.planId,version:plan.version,key:crypto.randomUUID()};setPending(attempt);const result=await call<Purchase>('/v1/billing/subscriptions',{plan_id:attempt.plan,version:attempt.version},{key:attempt.key});setPurchase(result);setPending(null);notify('Subscription checkout requested. Allowance follows confirmed invoice payment.');})}>Request checkout</button></article>)}</div>{current&&<div className="notice"><Status value={current.state}/><p>Checkout request {current.id}<br/>Reserved until {date(current.holdUntil)}</p>{checkout&&<a className="button" href={checkout} rel="noreferrer">Open secure checkout</a>}<Load {...status}/></div>}</section>;
}
