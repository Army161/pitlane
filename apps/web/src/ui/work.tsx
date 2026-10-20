'use client';
import {useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import type {ScreenProps,DataRow,JobInput} from './protocol';
import {date,text,usd} from './protocol';
import {useData} from './data';
import {RaceHero,Workflow} from './racing';
import {Icon,type IconName} from './icons';
import type {CareerState} from '../../../../packages/core/src/career';

export function Status({value}:{value:string}){return <span className={'badge '+value}>{value.replaceAll('_',' ')}</span>;}
export function Load({loading,error}:{loading:boolean;error:string}){return error?<p role="alert" className="notice error">{error}</p>:loading?<p aria-busy="true" className="muted">Loading persisted records…</p>:null;}
export function PageHead({title,description,action,eyebrow='PITLANE / Workshop'}:{title:string;description:string;action?:React.ReactNode;eyebrow?:string}){return <header className="pagehead"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action}</header>;}

/** Plain-English job states. The literal persisted state is always shown in the badge beside these words. */
export const stateWords:Record<string,string>={queued:'Waiting for a free bay',running:'Reading finalized data',verifying:'Verifying recorded evidence',completed:'Inspection finished',retry_wait:'Paused · waiting to retry',awaiting_payment:'Waiting for payment authorization',failed:'Stopped · no unit consumed',cancelled:'Cancelled · no unit consumed',unsupported:'Outside published coverage · no unit consumed',expired:'Records expired under retention policy'};
export const findingWords:Record<string,{label:string;tone:'go'|'conflict'|'unknown';icon:IconName}>={
 supported:{label:'Requirement met',tone:'go',icon:'check'},
 contradicted:{label:'Configuration conflict',tone:'conflict',icon:'alert'},
 insufficient_evidence:{label:'Not enough evidence',tone:'unknown',icon:'question'},
};
const ACTIVE=['queued','running','verifying','retry_wait','awaiting_payment'];
const short=(mint:unknown)=>{const m=typeof mint==='string'?mint:'';return m.length>12?m.slice(0,4)+'…'+m.slice(-4):m||'—';};
type ReceiptSummary={versionId:string;receiptId:string;finding?:string;issuedAt:string;evidenceExpired:boolean};

export function Garage(props:ScreenProps){
 const {project,call}=props;
 const jobs=useData(()=>call<DataRow[]>('/v1/jobs?project_id='+project.id),[],[call,project.id],2000);
 const receipts=useData(()=>call<{items:ReceiptSummary[]}>(`/v1/projects/${project.id}/receipts?page=true&limit=25`),{items:[]},[call,project.id],10000);
 const career=useData<CareerState|null>(()=>call<CareerState>('/v1/career').catch(()=>null),null,[call]);
 const active=jobs.value.filter(j=>ACTIVE.includes(j.execution_state));
 const byReceipt=new Map(receipts.value.items.map(r=>[r.receiptId,r]));
 const ready=receipts.value.items.filter(r=>!r.evidenceExpired);
 const review=ready.filter(r=>r.finding==='contradicted'||r.finding==='insufficient_evidence');
 const lessons=career.value?.milestones.length??0;
 return <>
  <RaceHero eyebrow="Race control" title={<>Your next <br/>inspection <br/><em>starts here.</em></>} description="Run read-only Solana token checks against the technical requirements your app needs, and get private, evidence-backed reports." side={<>Same checks.<em>Cleaner launches.</em></>}>
   <div className="hero-actions">{project.can_write?<Link className="button large" href="/book"><Icon name="calendar"/>Book a Bay <Icon name="arrow"/></Link>:<p className="notice">This project is read only for your account.</p>}</div>
  </RaceHero>
  <div className="cols-main-side">
   <div className="stack">
    <div className="stats" role="list" aria-label="Latest activity in this project">
     <div className="stat" role="listitem"><span className="stat-icon"><Icon name="report"/></span><div><span className="label">Reports ready</span><strong>{receipts.loading&&!receipts.value.items.length?'–':ready.length}</strong><p>In the latest 25 report versions for this project.</p></div></div>
     <div className="stat" role="listitem"><span className="stat-icon go"><Icon name="clock"/></span><div><span className="label">In progress</span><strong>{jobs.loading&&!jobs.value.length?'–':active.length}</strong><p>Active among the latest 25 inspections. Up to 2 run at once.</p></div></div>
     <div className="stat" role="listitem"><span className="stat-icon caution"><Icon name="alert"/></span><div><span className="label">Needs review</span><strong>{receipts.loading&&!receipts.value.items.length?'–':review.length}</strong><p>Conflicts or unknowns in the latest 25 reports.</p></div></div>
    </div>
    {active.length>0&&<section aria-labelledby="live-title"><div className="section-title"><h2 id="live-title">Live track <small>persisted job stages</small></h2></div><div className="stack">{active.map(j=><JobCard key={j.job_id} job={j} {...props} refresh={jobs.refresh}/>)}</div></section>}
    <section className="panel" aria-labelledby="recent-title">
     <div className="panel-title"><div><h2 id="recent-title">Recent inspections</h2><p className="muted" style={{margin:0}}>Your latest token checks and results. Job status and report outcome are shown separately.</p></div></div>
     <Load {...jobs}/>
     {!jobs.loading&&!jobs.error&&!jobs.value.length?<div className="empty"><p><strong>No inspections in this project yet.</strong></p><p>Book a bay to check your first token. Nothing runs or charges until you review the quote and submit.</p>{project.can_write&&<Link className="button" href="/book">Book a Bay</Link>}</div>
     :jobs.value.length>0&&<div className="table-scroll" tabIndex={0} role="region" aria-label="Recent inspections table"><table className="data-table"><thead><tr><th scope="col">Token</th><th scope="col">Job status</th><th scope="col">Report outcome</th><th scope="col">Accepted</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>{jobs.value.map(j=>{const receipt=j.receipt_id?byReceipt.get(j.receipt_id):undefined;const f=receipt?.finding?findingWords[receipt.finding]:undefined;return <tr key={j.job_id} data-job-id={j.job_id}>
      <td><div className="token-cell"><span className="token-avatar" aria-hidden="true">{short(j.input?.mint).slice(0,2).toUpperCase()}</span><div><strong className="mono" title={text(j.input?.mint??'')}>{j.evidence_expired?'Inputs removed':short(j.input?.mint)}</strong><span className="mono">{j.input?.network??'retention policy'} · {j.input?.templateId?.endsWith('integration_expectations')?'Expectations':'Configuration'} · job {String(j.job_id).slice(0,8)}</span></div></div></td>
      <td><Status value={j.execution_state}/><span className="cell-sub">{stateWords[j.execution_state]??''}</span></td>
      <td>{f?<><span className={'badge '+receipt!.finding}>{receipt!.finding!.replaceAll('_',' ')}</span><span className="cell-sub">{f.label} · evidence in report</span></>:j.receipt_id?<span className="cell-sub">{receipt?.evidenceExpired?'Evidence expired':'Report issued'}</span>:<span className="cell-sub">{ACTIVE.includes(j.execution_state)?'Report pending':'No report'}</span>}</td>
      <td><span className="cell-sub" style={{marginTop:0}}>{date(j.created_at)}</span></td>
      <td>{j.receipt_id?<Link className="button secondary" href={'/records/'+j.receipt_id}>View report</Link>:ACTIVE.includes(j.execution_state)?<a className="link-arrow" href={'#job-'+j.job_id}>Live track</a>:null}</td>
     </tr>;})}</tbody></table></div>}
     {jobs.value.length>0&&<p className="muted" style={{margin:'.8rem 0 0'}}><small>Showing the latest {jobs.value.length} of this project’s inspections. Full history lives in <Link href="/records">Reports</Link>.</small></p>}
    </section>
   </div>
   <aside className="stack" aria-label="Your crew">
    <section className="panel">
     <div className="panel-title"><h2>{lessons>=6?'Race engineer':lessons>=3?'Pit crew':'Rookie crew'}</h2><span className="muted">{lessons}/6 lessons</span></div>
     <div className="progress-bar" role="progressbar" aria-label="Free learning lessons" aria-valuemin={0} aria-valuemax={6} aria-valuenow={lessons}><span style={{width:`${lessons/6*100}%`}}/></div>
     <p className="muted" style={{marginTop:'.8rem'}}>Your crew level comes only from free lessons on reading reports. Inspections, results and spending never change it.</p>
     <Link className="link-arrow" href="/career">Open my garage <Icon name="arrow" size={16}/></Link>
    </section>
    <section className="dark-panel" aria-labelledby="deck-title">
     <h2 id="deck-title">On deck</h2>
     <ol className="checklist">
      <li className={jobs.value.length?'done':''}><span className="tick">{jobs.value.length>0&&<Icon name="check" size={13}/>}</span><Link href="/book"><strong>Book a Bay</strong><span>{jobs.value.length?'You have run an inspection in this project.':'Start a new inspection.'}</span></Link></li>
      <li className={ready.length?'done':''}><span className="tick">{ready.length>0&&<Icon name="check" size={13}/>}</span><Link href="/records"><strong>Review reports</strong><span>{ready.length?`${ready.length} report version${ready.length===1?'':'s'} ready.`:'Reports appear after an inspection finishes.'}</span></Link></li>
      <li className={lessons>=6?'done':''}><span className="tick">{lessons>=6&&<Icon name="check" size={13}/>}</span><Link href="/career"><strong>Learn to read a report</strong><span>{lessons}/6 free lessons complete.</span></Link></li>
      <li><span className="tick"/><Link href="/manual"><strong>Explore the manual</strong><span>Coverage, findings and payment rules.</span></Link></li>
     </ol>
    </section>
   </aside>
  </div>
 </>;
}
const stages=['queued','running','verifying','completed'];
const branches:Record<string,string>={retry_wait:'An attempt was interrupted. PITLANE will retry within the deadline; up to 3 attempts. Nothing extra is charged.',awaiting_payment:'This job waits for payment authorization before it can be queued.',failed:'This job stopped without a deliverable report. No unit was consumed.',cancelled:'This job was cancelled. No unit was consumed.',unsupported:'The inputs are outside published coverage. No unit was consumed.',expired:'Its records expired under the retention policy.'};
function JobCard({job:j,refresh,...props}:ScreenProps&{job:DataRow;refresh:()=>void}){
 const {call,project,act,busy}=props;const stage=stages.indexOf(j.execution_state);
 const reachedUntil=stage>=0?stage:j.execution_state==='retry_wait'?1:-1;
 const events=useData(()=>call<DataRow[]>(`/v1/jobs/${j.job_id}/events`),[],[call,j.job_id],['running','verifying','queued','retry_wait'].includes(j.execution_state)?2000:0);
 return <article className="panel job-card" id={'job-'+j.job_id} aria-labelledby={'job-title-'+j.job_id}>
  <header className="row spread"><div><p className="eyebrow">{j.input?.templateId?.endsWith('integration_expectations')?'Integration expectations':'Mint configuration'} · {j.input?.network??'Evidence expired'}</p><h3 id={'job-title-'+j.job_id}>{j.job_id}</h3></div><div className="row"><Status value={j.execution_state}/></div></header>
  <p className="mono" style={{margin:0,fontSize:'.82rem'}}>{text(j.input?.mint??'Inputs removed under retention policy')}</p>
  <ol className="job-track" aria-label="Persisted inspection stages">{stages.map((s,i)=><li key={s} className={(reachedUntil>=i?'reached ':'')+(stage===i?'current ':'')+(s==='completed'&&stage===3?'finished':'')} aria-current={stage===i?'step':undefined}>{s}{reachedUntil>=i?<span className="sr-only"> (reached)</span>:null}</li>)}</ol>
  {branches[j.execution_state]&&<p className={'branch-note'+(['failed','cancelled','unsupported','expired'].includes(j.execution_state)?' stop':'')}><Icon name="info" size={18}/><span><strong>{j.execution_state.replaceAll('_',' ')}:</strong> {branches[j.execution_state]}</span></p>}
  <div className="row spread"><small>Accepted {date(j.created_at)} · deadline {date(j.deadline)} · {j.attempts} attempt{j.attempts===1?'':'s'} · {j.origin}</small><div className="row">{j.receipt_id&&<Link href={'/records/'+j.receipt_id} className="button secondary">View report</Link>}{project.can_write&&ACTIVE.includes(j.execution_state)&&<button className="secondary" disabled={busy} onClick={()=>void act(async()=>{if(!window.confirm('Cancel this inspection? No unit is consumed for a cancelled job.'))return;await call(`/v1/jobs/${j.job_id}/cancel`,{});refresh();})}>Cancel inspection</button>}</div></div>
  <details><summary>Stage events</summary><Load {...events}/><ul className="list">{events.value.map(e=><li key={e.seq}><Status value={e.type}/><small> {date(e.occurred_at)}</small><pre>{text(e.payload)}</pre></li>)}</ul></details>
 </article>;
}

const fields=['decimals','program','mintAuthority','freezeAuthority','closeAuthority','metadataPointer.authority','metadataPointer.address','metadata.updateAuthority','metadata.name','metadata.symbol','metadata.uri','network','transferFee','extensions'];
const fieldLabels:Record<string,string>={decimals:'Decimals',program:'Token program',mintAuthority:'Mint authority',freezeAuthority:'Freeze authority',closeAuthority:'Close authority','metadataPointer.authority':'Metadata pointer authority','metadataPointer.address':'Metadata pointer address','metadata.updateAuthority':'Metadata update authority','metadata.name':'Metadata name','metadata.symbol':'Metadata symbol','metadata.uri':'Metadata URI',network:'Network',transferFee:'Transfer fee',extensions:'Token-2022 extensions'};
const extensionNames=['TransferFeeConfig','MintCloseAuthority','MetadataPointer','TokenMetadata'];
interface Draft {key:string;path:string;value:string;op:string;bps:string;max:string;required:string[];forbidden:string[];accepted:string[]}
const newDraft=(change:Partial<Draft>={}):Draft=>({key:crypto.randomUUID(),path:'decimals',value:'9',op:'eq',bps:'0',max:'0',required:[],forbidden:[],accepted:[],...change});
/** Quick-add presets only prefill the existing structured predicates. They never widen coverage or skip the quote. */
const presets:{id:string;title:string;copy:string;icon:IconName;draft:Partial<Draft>}[]=[
 {id:'fee',title:'Transfer fee',copy:'Require no transfer fee, or set maximum fee bounds.',icon:'swap',draft:{path:'transferFee',op:'absent',value:''}},
 {id:'mint',title:'Mint authority',copy:'Require that no one can mint more supply.',icon:'key',draft:{path:'mintAuthority',value:'__null__'}},
 {id:'freeze',title:'Freeze authority',copy:'Require that no one can freeze holder accounts.',icon:'lock',draft:{path:'freezeAuthority',value:'__null__'}},
 {id:'meta',title:'Metadata',copy:'Require the in-mint metadata name you expect.',icon:'doc',draft:{path:'metadata.name',value:''}},
];
const describe=(p:Draft)=>p.path==='transferFee'?(p.op==='absent'?'Transfer fee must be absent':`Transfer fee ≤ ${p.bps} bps and ≤ ${p.max} base units`):p.path==='extensions'?`Extensions: ${p.required.length} required, ${p.forbidden.length} forbidden`:`${fieldLabels[p.path]??p.path} = ${p.value==='__null__'?'none (revoked)':p.value||'…'}`;

export function Book({account,project,call,act,busy,notify}:ScreenProps){
 const router=useRouter();const [mint,setMint]=useState(''),[network,setNetwork]=useState<'devnet'|'mainnet-beta'>('devnet'),[template,setTemplate]=useState<JobInput['templateId']>('solana.mint_configuration');
 const [predicates,setPredicates]=useState<Draft[]>([]),[quote,setQuote]=useState<DataRow|null>(null),[input,setInput]=useState<JobInput|null>(null),[submissionKey,setSubmissionKey]=useState('');
 const [interval,setInterval]=useState('86400'),[monthlyUnits,setMonthlyUnits]=useState('30'),[maximumCost,setMaximumCost]=useState('1000000'),[expiry,setExpiry]=useState(''),[consent,setConsent]=useState(false);
 const invalidate=()=>{setQuote(null);setInput(null);setConsent(false);};
 const update=(key:string,change:Partial<Draft>)=>{setPredicates(rows=>rows.map(r=>r.key===key?{...r,...change}:r));invalidate();};
 const addPreset=(draft:Partial<Draft>)=>{if(!project.can_write)return;setTemplate('solana.integration_expectations');setPredicates(rows=>rows.length>=32?rows:[...rows,newDraft(draft)]);invalidate();};
 const getQuote=()=>act(async()=>{
  const expectations=template==='solana.integration_expectations'?predicates.map((p,i)=>({id:'expectation-'+(i+1),path:p.path,op:p.path==='extensions'?'extensions':p.path==='transferFee'?p.op:'eq',value:p.path==='decimals'?Number(p.value):p.path==='transferFee'?(p.op==='absent'?null:{basisPoints:Number(p.bps),maximumFee:p.max}):p.path==='extensions'?{required:p.required,forbidden:p.forbidden,accepted:p.accepted}:p.value==='__null__'?null:p.value})):[];
  const declared={projectId:project.id,templateId:template,templateVersion:'1',network,mint,expectations} as JobInput;
  const result=await call('/v1/quotes',{project_id:project.id,template_id:template,template_version:'1',network,mint,expectations});setQuote(result);setInput(declared);setSubmissionKey(crypto.randomUUID());
 });
 const billingText=account.billing==='disabled'?'Payments are disabled here. Submitting uses your workspace’s active allowance.':'Subscription: submitting reserves one unit from your allowance. One-off: authorize now; capture only after a billable report is delivered.';
 return <>
  <RaceHero compact eyebrow="Book a Bay" title="Check a token’s configuration" description="We inspect an existing Solana token against your technical requirements and produce a private, evidence-backed report. Read-only checks. No trading, token creation, or profitability or safety guarantees." position="72% 40%"/>
  <div className="cols-main-side">
   <section className="panel" aria-labelledby="token-title">
    <p className="eyebrow" id="token-title">Token to inspect</p>
    {!project.can_write&&<p className="notice">This project is read only for your account.</p>}
    <form className="form" onSubmit={e=>{e.preventDefault();void getQuote();}}>
     <div className="split">
      <label>Network<select name="network" value={network} onChange={e=>{setNetwork(e.target.value as typeof network);invalidate();}} disabled={!project.can_write}>{account.mode==='local'?<option value="devnet">Solana devnet · fixture observations</option>:<><option value="devnet">Solana devnet</option><option value="mainnet-beta">Solana mainnet beta</option></>}</select></label>
      <label>Template<select name="template" value={template} onChange={e=>{setTemplate(e.target.value as typeof template);setPredicates(e.target.value.endsWith('integration_expectations')?[newDraft()]:[]);invalidate();}} disabled={!project.can_write}><option value="solana.mint_configuration">Mint configuration record · v1</option><option value="solana.integration_expectations">My integration requirements · v1</option></select></label>
     </div>
     <div className="field"><label>Token mint address<input name="mint" className="mono" value={mint} onChange={e=>{setMint(e.target.value);invalidate();}} required minLength={32} maxLength={44} placeholder="Paste the full token mint address…" autoComplete="off" spellCheck={false} disabled={!project.can_write} aria-describedby="mint-help"/></label><p className="field-help" id="mint-help">The mint address identifies the token itself, not a wallet that holds it. Use the complete base58 address; symbols, aliases and RPC URLs are not accepted.</p></div>
     {account.mode==='local'&&<button type="button" className="secondary" onClick={()=>{setMint('So11111111111111111111111111111111111111112');invalidate();}}>Use local fixture address</button>}
     <div>
      <p className="eyebrow">Technical requirements</p>
      <div className="req-cards">{presets.map(p=><button type="button" key={p.id} className="req-card" disabled={!project.can_write||predicates.length>=32} onClick={()=>addPreset(p.draft)}><Icon name={p.icon} size={24}/><strong>{p.title}</strong><span>{p.copy}</span></button>)}</div>
      <p className="field-help">{template==='solana.mint_configuration'?'The configuration record captures program, decimals, supply, authorities and supported extensions. Add a requirement to compare against what your app needs.':'Each card adds a structured requirement you can edit below. Free-text requirements are never turned into checks.'}</p>
     </div>
     {template==='solana.integration_expectations'&&<div className="stack">
      <h2 className="sub-heading">Your requirements · {predicates.length}/32</h2>
      {predicates.map((p,i)=><fieldset className="panel form" key={p.key} style={{boxShadow:'none',background:'#fffaf2'}}><legend className="eyebrow" style={{padding:'0 .3rem'}}>Requirement {i+1}</legend>
       <label>Field<select value={p.path} onChange={e=>update(p.key,{path:e.target.value,value:e.target.value==='decimals'?'9':'',op:e.target.value==='transferFee'?'absent':'eq'})}>{fields.map(f=><option key={f} value={f}>{fieldLabels[f]} · {f}</option>)}</select></label>
       {p.path==='transferFee'?<><label>Fee policy<select value={p.op} onChange={e=>update(p.key,{op:e.target.value})}><option value="absent">Must be absent</option><option value="fee_caps">Maximum bounds for both schedules</option></select></label>{p.op==='fee_caps'&&<div className="split"><label>Maximum basis points (100 = 1%)<input type="number" inputMode="numeric" min={0} max={10000} value={p.bps} onChange={e=>update(p.key,{bps:e.target.value})}/></label><label>Maximum base-unit fee<input inputMode="numeric" pattern="[0-9]+" value={p.max} onChange={e=>update(p.key,{max:e.target.value})}/></label></div>}</>
       :p.path==='extensions'?<>{(['required','forbidden','accepted'] as const).map(group=><div key={group}><small>{group} extensions</small>{extensionNames.map(ext=><label className="checkbox" key={ext}><input type="checkbox" checked={p[group].includes(ext)} onChange={e=>update(p.key,{[group]:e.target.checked?[...p[group],ext]:p[group].filter(v=>v!==ext)})}/>{ext}</label>)}</div>)}<small>Every required extension must also be accepted. Unaccepted present extensions contradict this policy.</small></>
       :p.path==='program'?<label>Expected program<select value={p.value} onChange={e=>update(p.key,{value:e.target.value})} required><option value="">Select program</option><option value="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">Original Token</option><option value="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb">Token-2022</option></select></label>
       :p.path==='network'?<label>Expected network<select value={p.value} onChange={e=>update(p.key,{value:e.target.value})} required><option value="">Select network</option><option>devnet</option><option>mainnet-beta</option></select></label>
       :<div className="field"><label>Expected value<input aria-describedby={"help-"+p.key} value={p.value} type={p.path==='decimals'?'number':'text'} inputMode={p.path==='decimals'?'numeric':undefined} min={p.path==='decimals'?0:undefined} max={p.path==='decimals'?255:undefined} onChange={e=>update(p.key,{value:e.target.value})} required={p.path==='decimals'||p.path.startsWith('metadata.')&&p.path!=='metadata.updateAuthority'} spellCheck={false} placeholder={/Authority|authority|address/.test(p.path)?'Full address, or __null__ for none':'Exact recorded value…'}/></label>{p.path==='decimals'&&<p className="field-help" id={"help-"+p.key}>Decimals: how many places the token’s smallest unit is divided into (6 means 1 token = 1,000,000 base units).</p>}{/Authority|authority|address/.test(p.path)&&<p className="field-help" id={"help-"+p.key}>An authority is the account allowed to change a setting. Use __null__ to require that no such account exists.</p>}</div>}
       <button type="button" className="secondary" onClick={()=>{setPredicates(rows=>rows.filter(r=>r.key!==p.key));invalidate();}}>Remove requirement {i+1}</button>
      </fieldset>)}
      <button type="button" className="secondary" disabled={predicates.length>=32} onClick={()=>{setPredicates(rows=>[...rows,newDraft()]);invalidate();}}>Add another requirement</button>
     </div>}
     <button className="large" disabled={busy||!project.can_write||template==='solana.integration_expectations'&&!predicates.length}>{busy?'Validating…':'Get quote'} <Icon name="arrow"/></button>
    </form>
   </section>
   <div className="stack">
    <section className="panel" aria-labelledby="scope-title">
     <p className="eyebrow" id="scope-title">Review scope before submitting</p>
     <dl className="scope-list">
      <dt><Icon name="doc" size={18}/>Network</dt><dd>{network==='devnet'?'Solana devnet':'Solana mainnet beta'}</dd>
      <dt><Icon name="check" size={18}/>Technical checks</dt><dd>{template==='solana.mint_configuration'?'Full mint configuration record':predicates.length?<ul>{predicates.map(p=><li key={p.key}>{describe(p)}</li>)}</ul>:'Add at least one requirement'}</dd>
      <dt><Icon name="treasury" size={18}/>Pricing</dt><dd>{billingText}</dd>
      <dt><Icon name="shield" size={18}/>Not charged</dt><dd>Unsupported scope, cancellation, failure or insufficient evidence.</dd>
     </dl>
     {!quote?<p className="empty">Get a quote to see the exact price, expiry and inputs. Nothing runs until you submit.</p>:<div className="form">
      <div className="row spread"><strong>1 standard unit</strong><span className="badge queued">Quote ready</span></div>
      <dl><dt>One-off authorization ceiling</dt><dd>{usd(quote.max_charge.baseUnits)} USD</dd><dt>Quote expires</dt><dd>{date(quote.expires_at)}</dd><dt>Exact inputs hash</dt><dd className="mono">{quote.inputs_hash}</dd><dt>Rules / evidence / price versions</dt><dd>{quote.policy_versions.rules} / {quote.policy_versions.evidence} / {quote.policy_versions.price}</dd></dl>
      <p className="muted">Submit reserves one available unit. Supported and contradicted reports consume that unit. Unsupported scope, cancellation, failure or insufficient evidence release it.</p>
      <button className="large" disabled={busy||!project.can_write} onClick={()=>void act(async()=>{await call('/v1/jobs',{quote_id:quote.quote_id},{key:submissionKey});router.push('/garage');})}>Submit inspection <Icon name="arrow"/></button>
      {account.billing!=='disabled'&&account.can_billing&&<button className="secondary" disabled={busy} onClick={()=>void act(async()=>{const order=await call('/v1/billing/checkout',{quote_id:quote.quote_id,kind:'unit',initial_units:1},{key:submissionKey});notify('Payment authorization requested. Open Treasury to follow order '+order.id);router.push('/treasury');})}>Authorize one-off payment</button>}
      {account.billing==='disabled'&&<small>Payments are disabled. This submission uses the workspace’s active allowance.</small>}
     </div>}
    </section>
    <section className="panel"><h2>Published coverage</h2><p>Finalized mint data from two independent providers; original Token and four supported Token-2022 extensions.</p><ul className="list">{extensionNames.map(e=><li key={e}>{e}</li>)}</ul><p className="muted">No transaction execution, wallet signing, arbitrary code, URL fetching, liquidity forecast or safety certification. Observations are not an atomic chain snapshot.</p><Link href="/manual">Read the Manual →</Link></section>
    {quote&&input&&<section className="panel"><h2>Optional monitoring</h2><p>Monitoring starts disabled. Configure limits, then separately enable it in Reports.</p><form className="form" onSubmit={e=>{e.preventDefault();void act(async()=>{await call('/v1/monitors',{input,settings:{intervalSeconds:Number(interval),expiresAt:new Date(expiry).toISOString(),monthlyUnits:Number(monthlyUnits),maximumUnitPrice:quote.price.baseUnits,monthlyCostMicro:maximumCost}});notify('Monitor saved disabled. Review and enable it in Reports.');});}}><label>Cadence<select value={interval} onChange={e=>setInterval(e.target.value)}><option value="86400">Daily</option><option value="3600">Hourly</option><option value="604800">Weekly</option></select></label><div className="split"><label>Monthly unit cap<input type="number" min={1} max={1000} value={monthlyUnits} onChange={e=>setMonthlyUnits(e.target.value)}/></label><label>Monthly cost cap · USD micro-units<input pattern="[1-9][0-9]*" value={maximumCost} onChange={e=>setMaximumCost(e.target.value)}/></label></div><label>Consent expires<input type="datetime-local" required value={expiry} onChange={e=>setExpiry(e.target.value)}/></label><label className="checkbox"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>I accept these frozen inputs, maximum unit price and monitoring limits.</label><button className="secondary" disabled={busy||!consent}>Save disabled monitor</button></form></section>}
   </div>
  </div>
  <Workflow/>
 </>;
}
