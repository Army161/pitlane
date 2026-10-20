'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import type {Call} from './protocol';
import {date} from './protocol';
import {Load,Status} from './work';
type Cursor={at:string;id:string};
type Summary={versionId:string;receiptId:string;finding?:string;origin?:string;issuedAt:string;expiresAt:string;evidenceExpired:boolean};
type Page={items:Summary[];nextCursor:Cursor|null};
export function ReceiptHistory({call,projectId}:{call:Call;projectId:string}){
 const [items,setItems]=useState<Summary[]>([]),[cursor,setCursor]=useState<Cursor|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const path=`/v1/projects/${projectId}/receipts?page=true&limit=25`;
 useEffect(()=>{let active=true;setLoading(true);setError('');void call<Page>(path).then(p=>{if(active){setItems(p.items);setCursor(p.nextCursor);}}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[call,path]);
 async function more(){if(!cursor||loading)return;setLoading(true);setError('');try{const p=await call<Page>(path+'&cursor='+encodeURIComponent(JSON.stringify(cursor)));setItems(old=>[...old,...p.items.filter(v=>!old.some(o=>o.versionId===v.versionId))]);setCursor(p.nextCursor);}catch(e){setError(e instanceof Error?e.message:'History unavailable');}finally{setLoading(false);}}
 return <section className="panel"><h2>Receipt history</h2><Load loading={loading} error={error}/>{!loading&&!error&&!items.length?<p className="empty">No receipts have been issued for this project.</p>:<div className="table-scroll"><table><thead><tr><th>Receipt / version</th><th>Finding</th><th>Origin</th><th>Issued / retained until</th></tr></thead><tbody>{items.map(r=><tr key={r.versionId}><td><Link href={'/records/'+r.receiptId+'?version_id='+r.versionId} className="mono">{r.receiptId}</Link><small className="mono">{r.versionId}</small></td><td><Status value={r.evidenceExpired?'expired':r.finding??'recorded'}/></td><td>{r.origin??'Retained audit record'}</td><td>{date(r.issuedAt)}<br/><small>{date(r.expiresAt)}</small></td></tr>)}</tbody></table></div>}{cursor&&<button className="secondary" disabled={loading} onClick={()=>void more()}>Load older receipts</button>}<small>{items.length} receipt versions loaded</small></section>;
}
