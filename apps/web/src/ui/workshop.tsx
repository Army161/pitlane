'use client';
import {useCallback,useEffect,useState} from 'react';
import Link from 'next/link';
import type {Account,Project,Call,ScreenProps} from './protocol';
import {messages,text} from './protocol';
import {Book,Garage} from './work';
import {Records,ReceiptDetail} from './records';
import {Crew,Treasury,Manual} from './workspace';
import {Agents} from './agents';
import {Sprints} from './sprints';
import {HeroPhoto} from './racing';
import {Onboarding,CosmeticPreference,MotionPreference} from './onboarding';
import {Career} from './career';
import {Brand,Icon,type IconName} from './icons';

/** Racing labels always sit beside a plain description of the area. Routes are unchanged. */
const areas:[string,string,string,IconName][]=[
 ['garage','Race control','Dashboard','flag'],
 ['book','Book a Bay','New inspection','calendar'],
 ['records','Reports','Evidence records','report'],
 ['career','My garage','Learning · cosmetics','car'],
 ['crew','Crew','Team and workers','crew'],
 ['agents','Agents','Evidence assistant','radio'],
 ['sprints','Sprints','Team work records','sprint'],
 ['treasury','Treasury','Units and billing','treasury'],
 ['manual','Manual','Coverage and rules','manual'],
];
async function response<T>(r:Response):Promise<T>{
 const data=await r.json().catch(()=>({code:'SERVICE_UNAVAILABLE'}));if(!r.ok)throw new Error(messages[data.code]??String(data.message??data.code??'Service unavailable'));return data;
}
function stored(name:string){try{return localStorage.getItem(name);}catch{return null;}}
function store(name:string,value:string|null){try{if(value===null)localStorage.removeItem(name);else localStorage.setItem(name,value);}catch{}}
export default function Workshop({section,receiptId}:{section:string;receiptId?:string}){
 const [account,setAccount]=useState<Account|null>(null),[projects,setProjects]=useState<Project[]>([]),[projectId,setProjectId]=useState('');
 const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [authState,setAuthState]=useState<{nonce:string;mode:string}|null>(null),[email,setEmail]=useState(''),[sent,setSent]=useState(false);
 const boot=useCallback(async(tenant?:string)=>{
  setError('');setLoaded(false);try{
   const headers:Record<string,string>={};if(tenant)headers['x-tenant-id']=tenant;
   let r=await fetch('/v1/me',{headers,credentials:'same-origin',cache:'no-store'});
   if(r.status===404&&tenant)r=await fetch('/v1/me',{credentials:'same-origin',cache:'no-store'});
   if(r.status===401){setAccount(null);setProjects([]);setAuthState(await response(await fetch('/v1/auth/state',{cache:'no-store'})));return;}
   const me=await response<Account>(r);setAccount(me);if(me.tenant_id){store('pitlane.workspace',me.tenant_id);const next=await response<Project[]>(await fetch('/v1/projects',{headers:{'x-tenant-id':me.tenant_id},cache:'no-store'}));setProjects(next);
    const saved=stored('pitlane.project.'+me.tenant_id);setProjectId(next.some(p=>p.id===saved)?saved!:next[0]?.id??'');
   }else{setProjects([]);setProjectId('');}
  }catch(e){setError(e instanceof Error?e.message:'Service unavailable');}finally{setLoaded(true);}
 },[]);
 useEffect(()=>{void boot(stored('pitlane.workspace')??undefined);},[boot]);
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
 /** Creates the workspace, then its first project under that workspace's scope. Both are real, authorized records. */
 const post=async(path:string,tenant:string,body:unknown)=>response<{id:string}>(await fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json','x-csrf-token':account?.csrf??'','x-tenant-id':tenant},body:JSON.stringify(body)}));
 const createWorkspace=(workspace:string,project:string)=>act(async()=>{const tenant=await post('/v1/tenants','',{name:workspace});const created=await post('/v1/projects',tenant.id,{name:project});store('pitlane.project.'+tenant.id,created.id);store('pitlane.onboarding.'+tenant.id,'2');await boot(tenant.id);});
 const createProject=(project:string)=>act(async()=>{if(!account?.tenant_id)return;const created=await post('/v1/projects',account.tenant_id,{name:project});store('pitlane.project.'+account.tenant_id,created.id);store('pitlane.onboarding.'+account.tenant_id,'2');await boot(account.tenant_id);});

 if(!loaded)return <main className="loading" aria-busy="true"><p>Opening the workshop…</p></main>;
 if(!account)return <main className="login">
  <div className="login-photo"><HeroPhoto priority position="62% center"/></div>
  <section><Brand/><p className="eyebrow">Solana token checks · private evidence</p><h1>Welcome to<br/><em>your pit crew.</em></h1><p>Check an existing Solana token against the requirements your app needs, and keep a private, evidence-backed report for your team.</p>
   <ul className="features"><li><Icon name="lock"/>Read-only checks. No wallet signing.</li><li><Icon name="doc"/>Private reports with recorded evidence.</li><li><Icon name="eye"/>Review scope and your quote before submitting.</li></ul></section>
  <section className="panel" aria-labelledby="signin-title"><p className="eyebrow">Your private workshop</p><h2 id="signin-title">Sign in to PITLANE</h2>{error&&<p role="alert" className="notice error">{error}</p>}
   {authState?.mode==='local'?<div className="form"><p className="fixture">Local fixture environment. No live RPC reads or real payments.</p><button disabled={busy} onClick={()=>void login('first')}>Enter fixture workshop</button><button className="secondary" disabled={busy} onClick={()=>void login('second')}>Enter second fixture workspace</button><small>These accounts exist only in the isolated local database.</small></div>
   :<form className="form" onSubmit={e=>{e.preventDefault();void login();}}><label>Email address<input type="email" name="email" autoComplete="email" spellCheck={false} required value={email} onChange={e=>setEmail(e.target.value)}/></label><button disabled={busy||!authState}>{busy?'Sending…':'Email sign-in link'}</button>{sent&&<p role="status" className="notice">Check your email. Open the link in this browser to complete sign-in.</p>}<small>Your workspace evidence stays private.</small></form>}
   {!authState&&<button className="secondary" onClick={()=>void boot()}>Retry connection</button>}
   <p><small><Link href="/">What is PITLANE?</Link></small></p></section>
 </main>;
 const project=projects.find(p=>p.id===projectId);
 const props:ScreenProps|undefined=project?{account,project,call,act,busy,notify:setNotice}:undefined;
 const tenant=account.tenants.find(t=>t.id===account.tenant_id);
 return <div className="shell"><a className="skip" href="#main">Skip to content</a>
  <aside className="sidebar" aria-label="Workshop sidebar">
   <div className="sidebar-head"><Brand href="/garage"/><span className="brand-tag">Inspect · Verify · Understand</span></div>
   <nav aria-label="Workshop">{areas.map(([path,label,plain,icon])=><Link key={path} href={'/'+path} aria-current={section===path?'page':undefined}><Icon name={icon}/><span>{label}<small>{plain}</small></span></Link>)}</nav>
   <div className="foot"><p className="sidebar-slogan">Same standards.<br/><em>Every lap.</em></p><CosmeticPreference compact/><div className="divider"/><MotionPreference/><div className="divider"/>Inspections have no transaction tools. Cosmetics never change results, access or billing.</div>
  </aside>
  <div className="content">
   <header className="topbar">
    <label>Workspace<select aria-label="Workspace" value={account.tenant_id??''} onChange={e=>void boot(e.target.value)} disabled={busy}>{!account.tenant_id&&<option value="">No workspace yet</option>}{account.tenants.map(t=><option key={t.id} value={t.id}>{text(t.name)}</option>)}</select></label>
    <label>Project<select aria-label="Project" value={projectId} onChange={e=>{setProjectId(e.target.value);store('pitlane.project.'+account.tenant_id,e.target.value);}} disabled={busy||!projects.length}>{!projects.length&&<option value="">No project yet</option>}{projects.map(p=><option key={p.id} value={p.id}>{text(p.name)}</option>)}</select></label>
    <span className="spacer"/>
    <span className="crew-chip"><span className="avatar" aria-hidden="true">{text(tenant?.name??'P').trim().slice(0,1).toUpperCase()}</span><span>{text(tenant?.name??'New crew')}<small>{tenant?.role??'Crew member'}</small></span></span>
    <button className="secondary" disabled={busy} onClick={()=>void act(async()=>{await call('/v1/auth/logout',{});store('pitlane.workspace',null);await boot();})}>Sign out</button>
   </header>
   <main id="main" className="main" tabIndex={-1}>
    {account.mode==='local'&&<p className="fixture">LOCAL FIXTURES · Persisted work and accounting; simulated chain observations and payments.</p>}
    {error&&<p className="notice error" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
    {section==='manual'?<Manual/>
    :!props||section==='onboarding'?<Onboarding account={account} projects={projects} busy={busy} createWorkspace={createWorkspace} createProject={createProject}/>
    :section==='career'?<Career key={account.tenant_id+account.user_id} {...props}/>
    :section==='agents'?<Agents key={props.project.id} {...props}/>
    :section==='sprints'?<Sprints key={props.project.id} {...props}/>
    :section==='book'?<Book key={props.project.id} {...props}/>
    :section==='garage'?<Garage key={props.project.id} {...props}/>
    :section==='crew'?<Crew key={props.project.id} {...props} onProjectsChanged={()=>boot()}/>
    :section==='treasury'?<Treasury key={props.project.id} {...props}/>
    :receiptId?<ReceiptDetail key={props.project.id+receiptId} {...props} id={receiptId}/>
    :<Records key={props.project.id} {...props}/>}
   </main>
  </div>
 </div>;
}
