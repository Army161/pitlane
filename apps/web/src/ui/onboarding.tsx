'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';
import type {Account,Project} from './protocol';
import {text} from './protocol';
import {RaceHero} from './racing';
import {Icon} from './icons';

/** Optional racing imagery, stored only in this browser. Never sent to the server and never affects inspections. */
export function useCosmetics(){
 const [enabled,setEnabled]=useState(true);
 useEffect(()=>{let on=true;try{on=localStorage.getItem('pitlane.cosmetics')!=='off';}catch{}setEnabled(on);document.documentElement.dataset.cosmetics=on?'on':'off';},[]);
 const change=(value:boolean)=>{setEnabled(value);try{localStorage.setItem('pitlane.cosmetics',value?'on':'off');}catch{}document.documentElement.dataset.cosmetics=value?'on':'off';};
 return [enabled,change] as const;
}
export function useReducedMotion(){
 const [reduced,setReduced]=useState(false);
 useEffect(()=>{let on=false;try{on=localStorage.getItem('pitlane.motion')==='reduced';}catch{}setReduced(on);if(on)document.documentElement.dataset.motion='reduced';},[]);
 const change=(value:boolean)=>{setReduced(value);try{localStorage.setItem('pitlane.motion',value?'reduced':'full');}catch{}document.documentElement.dataset.motion=value?'reduced':'full';};
 return [reduced,change] as const;
}
export function CosmeticPreference({compact=false}:{compact?:boolean}){
 const [enabled,change]=useCosmetics();
 return <label className="toggle"><input type="checkbox" role="switch" checked={enabled} onChange={e=>change(e.target.checked)}/><span><strong>Racing imagery{compact?'':' (optional)'}</strong><small>Garage photos and track art. Saved in this browser only.</small></span></label>;
}
export function MotionPreference(){
 const [reduced,change]=useReducedMotion();
 return <label className="toggle"><input type="checkbox" role="switch" checked={reduced} onChange={e=>change(e.target.checked)}/><span><strong>Reduce motion</strong><small>Stops transitions in this browser.</small></span></label>;
}

const roles=[['creator','Creator','Launching and managing token projects.','users'],['developer','Developer','Building and integrating tokens into apps.','code'],['analyst','Analyst','Researching token configurations.','chart']] as const;
type Step=1|2|3;
const key=(tenant:string|null)=>'pitlane.onboarding.'+(tenant??'new');
function read(name:string){try{return localStorage.getItem(name);}catch{return null;}}
function write(name:string,value:string){try{localStorage.setItem(name,value);}catch{}}

/**
 * Workspace → role → first inspection. Steps 1 and the project are real records; the role is a browser-only
 * preference used to tailor tips. Progress resumes after interruption: server state decides step 1, this browser the rest.
 */
export function Onboarding({account,projects,busy,createWorkspace,createProject}:{account:Account;projects:Project[];busy:boolean;createWorkspace:(workspace:string,project:string)=>Promise<void>;createProject:(project:string)=>Promise<void>}){
 const needsWorkspace=!account.tenant_id,needsProject=!!account.tenant_id&&!projects.length;
 const [step,setStep]=useState<Step>(1);const [role,setRole]=useState('developer');
 const [workspace,setWorkspace]=useState(''),[project,setProject]=useState('First integration');
 useEffect(()=>{
  if(needsWorkspace||needsProject){setStep(1);return;}
  const saved=read(key(account.tenant_id));setStep(saved==='3'||saved==='done'?3:2);
  setRole(read('pitlane.role')??'developer');
 },[account.tenant_id,needsWorkspace,needsProject]);
 const go=(next:Step)=>{setStep(next);write(key(account.tenant_id),String(next));};
 const workspaceName=account.tenants.find(t=>t.id===account.tenant_id)?.name;
 const canCreateProject=needsWorkspace||account.can_admin;
 return <>
  <RaceHero eyebrow="Onboarding" title={<>Welcome to<br/><em>your pit crew.</em></>} description="Set up your workspace and run your first token inspection. PITLANE checks an existing Solana token against your technical requirements and produces a private, evidence-backed report." position="70% center">
   <ol className="stepper" aria-label="Setup progress">{([['Workspace','Name your space'],['Your role','Tell us how you work'],['First inspection','Run your first check']] as const).map(([title,sub],i)=><li key={title} className={step===i+1?'current':step>i+1?'done':''} aria-current={step===i+1?'step':undefined}><strong>{title}</strong>{sub}</li>)}</ol>
  </RaceHero>
  <div className="onboard">
   <section className="panel" aria-labelledby="onboard-step">
    {step===1&&<form className="form" onSubmit={e=>{e.preventDefault();void (needsWorkspace?createWorkspace(workspace.trim(),project.trim()):createProject(project.trim()));}}>
     <h2 id="onboard-step" className="sr-only">Step 1: Workspace</h2>
     {needsWorkspace?<div className="field"><label>Workspace name<input required maxLength={128} autoComplete="organization" value={workspace} onChange={e=>setWorkspace(e.target.value)} placeholder="e.g. Velocity Labs…" aria-describedby="ws-help"/></label><p className="field-help" id="ws-help">This keeps your team’s reports organized. New workspaces start with no paid allowance.</p></div>
      :<p><strong>Workspace:</strong> {text(workspaceName??'Your workspace')}</p>}
     {canCreateProject?<div className="field"><label>First project<input required maxLength={128} value={project} onChange={e=>setProject(e.target.value)} aria-describedby="project-help"/></label><p className="field-help" id="project-help">A project scopes inspections, reports and team access. You can add more later in Crew.</p></div>
      :<p className="notice">This workspace has no project you can access. Ask a workspace admin to create one or add you to a project.</p>}
     {canCreateProject&&<button className="large" disabled={busy}>{busy?'Creating…':'Continue'} <Icon name="arrow"/></button>}
    </form>}
    {step===2&&<form className="form" onSubmit={e=>{e.preventDefault();write('pitlane.role',role);go(3);}}>
     <h2 id="onboard-step">Your role</h2>
     <p className="field-help">Choose the role that best fits how you’ll use PITLANE. It only tailors tips in this browser. It never changes access or checks.</p>
     <fieldset className="role-grid plain"><legend className="sr-only">Role</legend>{roles.map(([id,title,copy,icon])=><label className="role-card" key={id}><input type="radio" name="role" value={id} checked={role===id} onChange={()=>setRole(id)}/><Icon name={icon} size={26}/><strong>{title}</strong><span>{copy}</span></label>)}</fieldset>
     <div className="switch-row"><CosmeticPreference/><button className="large">Continue <Icon name="arrow"/></button></div>
    </form>}
    {step===3&&<div className="form">
     <h2 id="onboard-step">Ready for your first inspection</h2>
     <ol className="checklist">
      <li className="done"><span className="tick"><Icon name="check" size={13}/></span><div><strong>Workspace</strong><span>{text(workspaceName??'Your workspace')}</span></div></li>
      <li className="done"><span className="tick"><Icon name="check" size={13}/></span><div><strong>Project</strong><span>{text(projects[0]?.name??'')}{projects.length>1?` and ${projects.length-1} more`:''}</span></div></li>
      <li className="done"><span className="tick"><Icon name="check" size={13}/></span><div><strong>Role</strong><span>{roles.find(r=>r[0]===role)?.[1]??'Developer'} · <button type="button" className="secondary btn-xs" onClick={()=>go(2)}>Change role</button></span></div></li>
      <li><span className="tick"/><div><strong>First inspection</strong><span>Choose a token and requirements, then review scope and the quote before submitting. Nothing runs or charges until you submit.</span></div></li>
     </ol>
     <div className="row"><Link className="button large" href="/book" onClick={()=>write(key(account.tenant_id),'done')}>Continue to Book a Bay <Icon name="arrow"/></Link><Link className="button secondary" href="/career">Take the free learning track</Link></div>
    </div>}
   </section>
   <aside className="bring" aria-label="What PITLANE does">
    <h2>You bring the token address. <em>PITLANE checks supported settings and explains the evidence.</em></h2>
    <ul>
     <li><Icon name="eye"/>Checks against technical requirements on Solana, within published coverage.</li>
     <li><Icon name="doc"/>Provides a private, evidence-backed report for your workspace.</li>
     <li><Icon name="report"/>Clear results with sources, so you make your own decision.</li>
    </ul>
   </aside>
  </div>
  <div className="trust-strip">
   <div><Icon name="shield"/><span><strong>Technical checks</strong>Program, authority, configuration and more</span></div>
   <div><Icon name="report"/><span><strong>Evidence backed</strong>Results include sources and details</span></div>
   <div><Icon name="lock"/><span><strong>Private</strong>Your inspections stay in your workspace</span></div>
   <div><Icon name="doc"/><span><strong>For builders</strong>A tool for teams, not financial advice</span></div>
  </div>
 </>;
}
