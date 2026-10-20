'use client';
import {useCallback,useEffect,useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import type {Account,Project,Call,ScreenProps} from './protocol';
import {messages,text} from './protocol';
import {Book,Garage} from './work';
import {Records,ReceiptDetail} from './records';
import {Crew,Treasury,Manual} from './workspace';
import {Agents} from './agents';
import {Sprints} from './sprints';

const areas=[['garage','Live Garage'],['crew','Crew'],['records','Service Records'],['agents','Agent workspace'],['sprints','Team sprints'],['treasury','Treasury'],['book','Book a Bay'],['manual','Manual']];
async function response<T>(r:Response):Promise<T>{
 const data=await r.json();if(!r.ok)throw new Error(messages[data.code]??String(data.message??data.code??'Service unavailable'));return data;
}
export default function Workshop({section,receiptId}:{section:string;receiptId?:string}){
 const [account,setAccount]=useState<Account|null>(null),[projects,setProjects]=useState<Project[]>([]),[projectId,setProjectId]=useState('');
 const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [authState,setAuthState]=useState<{nonce:string;mode:string}|null>(null),[email,setEmail]=useState(''),[sent,setSent]=useState(false);
 const [newName,setNewName]=useState('');const router=useRouter();
 const boot=useCallback(async(tenant?:string)=>{
  setError('');setLoaded(false);try{
   const headers:Record<string,string>={};if(tenant)headers['x-tenant-id']=tenant;
   let r=await fetch('/v1/me',{headers,credentials:'same-origin',cache:'no-store'});
   if(r.status===404&&tenant)r=await fetch('/v1/me',{credentials:'same-origin',cache:'no-store'});
   if(r.status===401){setAccount(null);setProjects([]);setAuthState(await response(await fetch('/v1/auth/state',{cache:'no-store'})));return;}
   const me=await response<Account>(r);setAccount(me);if(me.tenant_id){localStorage.setItem('pitlane.workspace',me.tenant_id);const next=await response<Project[]>(await fetch('/v1/projects',{headers:{'x-tenant-id':me.tenant_id},cache:'no-store'}));setProjects(next);
    const saved=localStorage.getItem('pitlane.project.'+me.tenant_id);setProjectId(next.some(p=>p.id===saved)?saved!:next[0]?.id??'');
   }else{setProjects([]);setProjectId('');}
  }catch(e){setError(e instanceof Error?e.message:'Service unavailable');}finally{setLoaded(true);}
 },[]);
 useEffect(()=>{void boot(localStorage.getItem('pitlane.workspace')??undefined);},[boot]);
 const call:Call=useCallback(async<T,>(path:string,body?:unknown,options?:{method?:string;key?:string}):Promise<T>=>{
  const headers:Record<string,string>={'x-tenant-id':account?.tenant_id??''};
  if(body!==undefined||options?.method&&options.method!=='GET'){headers['content-type']='application/json';headers['x-csrf-token']=account?.csrf??'';}
  if(options?.key)headers['idempotency-key']=options.key;
  const r=await fetch(path,{method:options?.method??(body===undefined?'GET':'POST'),headers,credentials:'same-origin',cache:'no-store',body:body===undefined?undefined:JSON.stringify(body)});
  if(r.status===401){setAccount(null);setAuthState(await response(await fetch('/v1/auth/state',{cache:'no-store'})));}
  return response<T>(r);
 },[account]);
 const act=async(task:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');setNotice('');try{await task();}catch(e){setError(e instanceof Error?e.message:'Service unavailable');}finally{setBusy(false);}};
 const login=(fixture?:string)=>act(async()=>{
  if(!authState)throw new Error('Reload the sign-in form.');
  await response(await fetch('/v1/auth/'+(fixture?'fixture':'login'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nonce:authState.nonce,...(fixture?{fixture}:{email})})}));
  if(fixture)await boot();else setSent(true);
 });
 if(!loaded)return <main className="loading" aria-busy="true"><p>Opening the workshop…</p></main>;
 if(!account)return <main className="login"><section><Link href="/" className="brand"><span className="brand-mark" aria-hidden="true">///</span>PITLANE</Link><p className="eyebrow">Solana integration evidence</p><h1>A service record for every declared check.</h1><p>Inspect mint configuration. Verify integration expectations. Keep the exact evidence behind the result.</p><ul className="features"><li>Bounded reads from independent upstreams</li><li>Private, versioned receipts with exact JSON exports</li><li>Units consumed only for supported or contradicted delivery</li></ul></section><section className="panel" aria-label="Sign in"><p className="eyebrow">Your private workshop</p><h2>Sign in to PITLANE</h2>{error&&<p role="alert" className="notice error">{error}</p>}{authState?.mode==='local'?<div className="form"><p className="fixture">Local fixture environment. No live RPC reads or real payments.</p><button disabled={busy} onClick={()=>void login('first')}>Enter fixture workshop</button><button className="secondary" disabled={busy} onClick={()=>void login('second')}>Enter second fixture workspace</button><small>These accounts exist only in the isolated local database.</small></div>:<form className="form" onSubmit={e=>{e.preventDefault();void login();}}><label>Email address<input type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label><button disabled={busy||!authState}>Email sign-in link</button>{sent&&<p role="status">Check your email. Open the link in this browser to complete sign-in.</p>}<small>Your workspace evidence stays private.</small></form>}{!authState&&<button className="secondary" onClick={()=>void boot()}>Retry connection</button>}</section></main>;
 const project=projects.find(p=>p.id===projectId);
 const props:ScreenProps|undefined=project?{account,project,call,act,busy,notify:setNotice}:undefined;
 return <div className="shell"><a className="skip" href="#main">Skip to content</a><aside className="sidebar"><Link href="/garage" className="brand"><span className="brand-mark" aria-hidden="true">///</span>PITLANE</Link><nav aria-label="Workshop">{areas.map(([path,label])=><Link key={path} href={'/'+path} aria-current={section===path?'page':undefined}>{label}</Link>)}</nav><div className="foot">Evidence, recorded.<br/>Two templates. One clear scope.<div className="divider"/>Inspection has no transaction tools.</div></aside><div className="content"><header className="topbar"><label>Workspace<select aria-label="Workspace" value={account.tenant_id??''} onChange={e=>void boot(e.target.value)} disabled={busy}>{account.tenants.map(t=><option key={t.id} value={t.id}>{text(t.name)}</option>)}</select></label><label>Project<select aria-label="Project" value={projectId} onChange={e=>{setProjectId(e.target.value);localStorage.setItem('pitlane.project.'+account.tenant_id,e.target.value);}} disabled={busy||!projects.length}>{projects.map(p=><option key={p.id} value={p.id}>{text(p.name)}</option>)}</select></label><button className="secondary" disabled={busy} onClick={()=>void act(async()=>{await call('/v1/auth/logout',{});localStorage.removeItem('pitlane.workspace');await boot();})}>Sign out</button></header><main id="main" className="main" tabIndex={-1}>
 {account.mode==='local'&&<p className="fixture">LOCAL FIXTURES · Persisted work and accounting; simulated chain observations and payments.</p>}
 {error&&<p className="notice error" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
 {section==='manual'?<Manual/>:!props?<section className="panel"><h1>{!account.tenant_id?'Create your workspace':'Create a project'}</h1><p>A project scopes inspections, receipts and team access. New workspaces start with no paid allowance.</p>{(!account.tenant_id||account.can_admin)&&<form className="form" onSubmit={e=>{e.preventDefault();void act(async()=>{const value=await call<{id:string}>(!account.tenant_id?'/v1/tenants':'/v1/projects',{name:newName});setNewName('');await boot(!account.tenant_id?value.id:undefined);});}}><label>Name<input required maxLength={128} value={newName} onChange={e=>setNewName(e.target.value)}/></label><button disabled={busy}>Create {!account.tenant_id?'workspace':'project'}</button></form>}</section>:section==='agents'?<Agents key={props.project.id} {...props}/>:section==='sprints'?<Sprints key={props.project.id} {...props}/>:section==='book'?<Book key={props.project.id} {...props}/>:section==='garage'?<Garage key={props.project.id} {...props}/>:section==='crew'?<Crew key={props.project.id} {...props} onProjectsChanged={()=>boot()}/>:section==='treasury'?<Treasury key={props.project.id} {...props}/>:receiptId?<ReceiptDetail key={props.project.id+receiptId} {...props} id={receiptId}/>:<Records key={props.project.id} {...props}/>}
 </main></div></div>;
}
