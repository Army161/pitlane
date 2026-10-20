'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import type {ScreenProps} from './protocol';
import type {CareerState,Livery,NumberStyle,Lighting} from '../../../../packages/core/src/career';
import {UNLOCKS} from '../../../../packages/core/src/career';
import {useData} from './data';
import {Load} from './work';
import {HeroPhoto,TrackPhoto} from './racing';
import {Icon} from './icons';

const lessons=[
 {id:'purpose',title:'Know what PITLANE checks',short:'Read your first sample report',body:'PITLANE checks an existing Solana token against your app’s technical requirements. It does not predict prices or certify safety.',question:'What does an inspection establish?',options:[['technical-fit','Whether supported settings meet declared requirements'],['future-value','Whether a token will rise in value'],['safe','Whether a token is completely safe']]},
 {id:'outcomes',title:'Read the three findings',short:'Learn report outcomes',body:'Supported means the evidence matches a requirement. Contradicted means it conflicts. Insufficient evidence means the check cannot establish either answer.',question:'What does insufficient evidence mean?',options:[['safe','The requirement is definitely met'],['not-enough-evidence','There is not enough evidence to decide'],['failure','The token has failed every requirement']]},
 {id:'coverage',title:'Understand bounded coverage',short:'Explore technical checks',body:'The current Token-2022 scope is TransferFeeConfig, MintCloseAuthority, MetadataPointer and TokenMetadata. Other extensions are unsupported.',question:'Which Token-2022 coverage is promised?',options:[['all-extensions','Every present and future extension'],['four-listed-extensions','Only the four listed extensions'],['trading','Trading and liquidity forecasting']]},
 {id:'evidence',title:'Interpret evidence in time',short:'Read evidence over time',body:'A report retains the rule version and provider observations behind its finding. Two finalized observations are not an atomic snapshot or a promise about future configuration.',question:'What does a report describe?',options:[['forever','An unchanging guarantee'],['point-in-time','The recorded observations within the stated scope'],['profit','Expected future profit']]},
 {id:'privacy',title:'Keep the crew’s records private',short:'Keep records private',body:'Reports belong to the authorized workspace and project. Your learning record is private. The optional team board shares only your chosen alias and completed lesson count with current workspace members.',question:'Who can see an opted-in team-board entry?',options:[['everyone','Anyone on the internet'],['private-workspace','Current members of this private workspace'],['buyers','Everyone who bought an inspection']]},
 {id:'cosmetics',title:'Separate style from standards',short:'Complete the garage tour',body:'Garage cosmetics celebrate learning. They never change results, access, quotas, queue priority or billing. Repeated inspections and spending earn no progress.',question:'What can a garage upgrade change?',options:[['priority','Queue priority'],['appearance-only','Appearance only'],['findings','Inspection findings']]},
] as const;
/** Stop positions on the original track photograph (percent). The list beside it carries the same information. */
const stops=[[9,30],[27,67],[47,22],[61,52],[83,31],[78,84]] as const;
const liveries:[Livery,string][]=[['factory','Factory orange'],['ivory','Ivory accent'],['night','Night blue']];
const plates:[NumberStyle,string][]=[['classic','Classic'],['block','Block'],['outline','Outline']];
const lights:[Lighting,string][]=[['workshop','Workshop'],['dusk','Dusk'],['floodlight','Floodlight']];
const ranks=(n:number)=>n>=6?'Race engineer':n>=3?'Pit crew':'Rookie crew';
type Tab='garage'|'track'|'board';

export function Career({account,call,act,busy,notify}:ScreenProps){
 const data=useData<CareerState|null>(()=>call('/v1/career'),null,[call,account.tenant_id]);
 const [tab,setTabState]=useState<Tab>('garage');
 useEffect(()=>{const v=new URLSearchParams(location.search).get('view');if(v==='track'||v==='board')setTabState(v);},[]);
 /** Keeps the open view in the URL so it can be linked and survives reload. */
 const setTab=(next:Tab)=>{setTabState(next);const u=new URL(location.href);if(next==='garage')u.searchParams.delete('view');else u.searchParams.set('view',next);history.replaceState(history.state,'',u);};const [answers,setAnswers]=useState<Record<string,string>>({});
 const [alias,setAlias]=useState<string|null>(null);const [latest,setLatest]=useState<CareerState|null>(null),[pending,setPending]=useState<Partial<CareerState>>({});
 const base=latest??data.value;const state=base?{...base,...pending}:null;const completed=new Set(state?.milestones.map(m=>m.id)??[]);const count=completed.size;
 /** Shows the choice immediately; the server re-validates every unlock and returns the stored state. */
 const save=async(change:Partial<Pick<CareerState,'optIn'|'livery'|'numberStyle'|'lighting'|'alias'>>,message:string)=>{if(!base)return;setPending(change);try{const next=await call<CareerState>('/v1/career/profile',{alias:change.alias??alias??base.alias,optIn:change.optIn??base.optIn,livery:change.livery??base.livery,numberStyle:change.numberStyle??base.numberStyle,lighting:change.lighting??base.lighting});setLatest(next);notify(message);}finally{setPending({});}};
 const goLesson=(id:string)=>{setTab('track');requestAnimationFrame(()=>document.getElementById('lesson-'+id)?.scrollIntoView({block:'start'}));};
 const tabs:[Tab,string][]=[['garage','My garage'],['track','Track map'],['board','Team leaderboard']];
 return <div className="career">
  <header className="garage-head"><div><p className="eyebrow">My garage · learning and cosmetics</p><h1>My garage</h1><p>Your crew. Your progress. Same standards on every lap.</p></div><p className="muted" style={{maxWidth:'26rem',letterSpacing:0,textTransform:'none',fontWeight:500}}>Free lessons unlock cosmetic choices. Nothing here changes inspection results, access, quotas, queue priority or billing.</p></header>
  <div className="tabs" role="tablist" aria-label="Garage views">{tabs.map(([id,label])=><button key={id} id={'tab-'+id} role="tab" aria-selected={tab===id} aria-controls={'panel-'+id} tabIndex={tab===id?0:-1} onClick={()=>setTab(id)} onKeyDown={e=>{const i=tabs.findIndex(t=>t[0]===tab);if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();const next=tabs[(i+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length][0];setTab(next);document.getElementById('tab-'+next)?.focus();}}}>{label}</button>)}</div>
  <Load {...data}/>
  {state&&!data.error&&<>
  {tab==='garage'&&<div role="tabpanel" id="panel-garage" aria-labelledby="tab-garage">
   <div className="career-top">
    <section className="career-scene" data-livery={state.livery} data-lighting={state.lighting} aria-label="Your number 27 car with your selected cosmetics">
     <HeroPhoto priority position="center 60%"/><span className="lighting" aria-hidden="true"/>
     <span className={'number-plate '+state.numberStyle} aria-hidden="true">27</span>
     <p className="scene-caption">Cosmetic preview · {liveries.find(l=>l[0]===state.livery)?.[1]} · {plates.find(p=>p[0]===state.numberStyle)?.[1]} number · {lights.find(l=>l[0]===state.lighting)?.[1]} lighting</p>
    </section>
    <BoardCard state={state} alias={alias} setAlias={setAlias} busy={busy} onJoin={()=>void act(()=>save({optIn:true},'You are listed on your workspace board.'))} onLeave={()=>void act(()=>save({optIn:false},'You are no longer listed.'))}/>
   </div>
   <div className="career-bottom">
    <section className="dark-panel career-card" aria-labelledby="crew-career"><h2 id="crew-career"><Icon name="car"/>Your crew career</h2><p>{ranks(count)} · {count}/6 lessons. Complete free learning milestones to build your career. Progress never changes inspection results, access or billing.</p>
     <div className="milestone-cards">{lessons.slice(0,4).map(l=><button type="button" key={l.id} className={'milestone-card'+(completed.has(l.id)?' done':'')} onClick={()=>goLesson(l.id)} style={{border:0,textAlign:'left',minHeight:0,fontWeight:400}}><span className="tick"><Icon name="check" size={13}/></span><span><strong>{l.short}</strong><span>{completed.has(l.id)?'Complete':'Short lesson and knowledge check'}</span></span></button>)}</div>
     <button type="button" className="link-arrow" style={{background:'none',border:0,color:'var(--orange-on-dark)',padding:'.8rem 0 0',minHeight:0}} onClick={()=>setTab('track')}>See all six lessons <Icon name="arrow" size={16}/></button>
    </section>
    <section className="dark-panel career-card" aria-labelledby="milestones-title"><div className="section-title" style={{marginBottom:0}}><h2 id="milestones-title"><Icon name="flag"/>Learning milestones</h2><span className="muted">{count} / 6 completed</span></div>
     <div className="track-map"><TrackPhoto/>{lessons.map((l,i)=><a key={l.id} href={'#lesson-'+l.id} className={'stop'+(completed.has(l.id)?' done':'')+(stops[i][0]>70?' left':'')} style={{left:stops[i][0]+'%',top:stops[i][1]+'%'}} onClick={e=>{e.preventDefault();goLesson(l.id);}} aria-label={`Lesson ${i+1}: ${l.short}${completed.has(l.id)?', complete':''}`}><span className="pin">{completed.has(l.id)?<Icon name="check" size={13}/>:<span style={{color:'#fff',fontWeight:800,fontSize:'.75rem'}}>{i+1}</span>}</span><span className="label" aria-hidden="true">{i+1}. {l.short}</span></a>)}</div>
     <p className="cosmetic-note"><Icon name="info" size={16}/>The map mirrors the lesson list in the Track map tab. Markers move only when the server records a completed lesson.</p>
    </section>
    <section className="dark-panel career-card" aria-labelledby="upgrades-title"><h2 id="upgrades-title"><Icon name="wrench"/>Garage upgrades <small>Cosmetic only</small></h2><p>Customize your garage. These choices change appearance only and do not affect inspection results, access, quotas, queue priority or billing.</p>
     <div className="upgrade-grid">
      <Upgrade title="Livery" copy="Paint style on your car." swatch="livery" options={liveries} unlock={UNLOCKS.livery} value={state.livery} count={count} busy={busy} onChange={v=>void act(()=>save({livery:v as Livery},'Livery saved. Inspection settings are unchanged.'))}/>
      <Upgrade title="Number plate" copy="Style for your #27." swatch="plate" options={plates} unlock={UNLOCKS.numberStyle} value={state.numberStyle} count={count} busy={busy} onChange={v=>void act(()=>save({numberStyle:v as NumberStyle},'Number style saved. Inspection settings are unchanged.'))}/>
      <Upgrade title="Garage lighting" copy="Mood of your garage." swatch="light" options={lights} unlock={UNLOCKS.lighting} value={state.lighting} count={count} busy={busy} onChange={v=>void act(()=>save({lighting:v as Lighting},'Lighting saved. Inspection settings are unchanged.'))}/>
     </div>
     <p className="cosmetic-note"><Icon name="lock" size={16}/>Unlocks come only from free lessons. No purchases, tokens, prizes or rewards for inspections or results.</p>
    </section>
   </div>
  </div>}
  {tab==='track'&&<div role="tabpanel" id="panel-track" aria-labelledby="tab-track" className="cols-main-side">
   <div className="stack">{lessons.map((lesson,i)=><section className="panel lesson" key={lesson.id} id={'lesson-'+lesson.id} aria-labelledby={'lesson-title-'+lesson.id}>
    <p className="eyebrow">Lesson {i+1} of 6</p><h2 id={'lesson-title-'+lesson.id}>{lesson.title}{completed.has(lesson.id)&&<span className="badge done">complete</span>}</h2><p>{lesson.body}</p>
    <form className="form" onSubmit={e=>{e.preventDefault();void act(async()=>{setLatest(await call<CareerState>('/v1/career/milestones',{milestone:lesson.id,answer:answers[lesson.id]}));notify('Lesson recorded once. Thanks for learning how reports work.');});}}>
     <fieldset className="lesson-options" disabled={busy||completed.has(lesson.id)}><legend style={{fontWeight:700,marginBottom:'.5rem'}}>{lesson.question}</legend>{lesson.options.map(([value,label])=><label key={value}><input type="radio" name={'q-'+lesson.id} value={value} checked={answers[lesson.id]===value} onChange={()=>setAnswers({...answers,[lesson.id]:value})}/>{label}</label>)}</fieldset>
     <button disabled={busy||completed.has(lesson.id)||!answers[lesson.id]}>{completed.has(lesson.id)?'Lesson complete':'Check understanding'}</button>
    </form>
   </section>)}</div>
   <aside className="dark-panel" aria-label="Lesson list"><h2>Learning track · {count}/6</h2><p>Each lesson has a short knowledge check. A correct answer is recorded once by the server. No purchase or inspection is required.</p><ol className="track-list">{lessons.map(l=><li key={l.id} className={completed.has(l.id)?'done':''}><a href={'#lesson-'+l.id}>{l.title}<span>{completed.has(l.id)?'Complete':'To learn'}</span></a></li>)}</ol></aside>
  </div>}
  {tab==='board'&&<div role="tabpanel" id="panel-board" aria-labelledby="tab-board" className="cols-2-1">
   <BoardCard state={state} alias={alias} setAlias={setAlias} busy={busy} full onJoin={()=>void act(()=>save({optIn:true},state.optIn?'Board alias saved.':'You are listed on your workspace board.'))} onLeave={()=>void act(()=>save({optIn:false},'You are no longer listed.'))}/>
   <section className="dark-panel" aria-labelledby="board-rules"><h2 id="board-rules">How the board works</h2><ul className="checklist">
    <li><span className="tick"><Icon name="lock" size={12}/></span><div><strong>Off by default</strong><span>Each person opts in for themselves. Admins cannot opt anyone in.</span></div></li>
    <li><span className="tick"><Icon name="users" size={12}/></span><div><strong>Private to this workspace</strong><span>Only current members see it. No global board, bots or sample entries.</span></div></li>
    <li><span className="tick"><Icon name="trophy" size={12}/></span><div><strong>One metric</strong><span>Free lessons completed, 0 to 6, each counted once. Ties sort by alias. All-time.</span></div></li>
    <li><span className="tick"><Icon name="shield" size={12}/></span><div><strong>Never counted</strong><span>Inspections, results, spending, monitoring, chat volume, page visits or speed.</span></div></li>
    <li><span className="tick"><Icon name="eye" size={12}/></span><div><strong>Shares only your alias</strong><span>No reports, mints or project names. Leaving or losing access removes your entry.</span></div></li>
   </ul><p><small>Learning progress shows familiarity with how reports work. It is not a measure of engineering skill or token quality.</small></p><Link className="link-arrow" href="/manual">Read the manual <Icon name="arrow" size={16}/></Link></section>
  </div>}
  </>}
 </div>;
}
function BoardCard({state,alias,setAlias,busy,onJoin,onLeave,full=false}:{state:CareerState;alias:string|null;setAlias:(v:string)=>void;busy:boolean;onJoin:()=>void;onLeave:()=>void;full?:boolean}){
 return <section className="dark-panel board-card" aria-labelledby={'board-title'+(full?'-full':'')}>
  <div className="section-title" style={{marginBottom:0}}><h2 id={'board-title'+(full?'-full':'')}><Icon name="users"/>Team leaderboard <small>Opt-in</small></h2></div>
  <p style={{margin:'.4rem 0 0',fontSize:'.88rem'}}>Free lessons completed by members who chose to be listed. Visible only to this workspace.</p>
  {state.leaderboard.length?<ol className="board-list">{state.leaderboard.map((entry,i)=><li key={i} className={entry.self?'self':''}><strong>{entry.alias}{entry.self?' (you)':''}</strong><span>{entry.completed}/6 lessons</span></li>)}</ol>
  :<div className="board-empty"><Icon name="users" size={44}/><strong>No members opted in yet</strong><p>Be the first to represent your crew. Opt in to appear on your workspace board.</p></div>}
  <form className="form" style={{marginTop:'1rem'}} onSubmit={e=>{e.preventDefault();onJoin();}}>
   {(full||!state.optIn)&&<label>Board alias<input value={alias??state.alias} onChange={e=>setAlias(e.target.value)} required maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9 _\-]{0,31}" autoComplete="nickname" spellCheck={false}/><small>Use a nickname, not personal information.</small></label>}
   <div className="row">{(full||!state.optIn)&&<button disabled={busy}>{state.optIn?'Save board alias':'Opt in to leaderboard'}</button>}{state.optIn&&<button type="button" className="secondary" disabled={busy} onClick={onLeave}>Leave leaderboard</button>}</div>
   <small>{state.optIn?`Listed as ${state.alias}.`:'You are not listed. Your progress stays private.'}</small>
  </form>
 </section>;
}
function Upgrade({title,copy,swatch,options,unlock,value,count,busy,onChange}:{title:string;copy:string;swatch:'livery'|'plate'|'light';options:[string,string][];unlock:Record<string,number>;value:string;count:number;busy:boolean;onChange:(v:string)=>void}){
 return <div className="upgrade">
  <div className={'swatch swatch-'+swatch} data-value={value} aria-hidden="true"/>
  <div className="upgrade-title"><strong>{title}</strong><p>{copy}</p></div>
  <fieldset><legend>{title}</legend>{options.map(([id,label])=>{const need=unlock[id]??0;const locked=count<need;return <label key={id} className="opt"><input type="radio" name={'upgrade-'+swatch} value={id} checked={value===id} disabled={busy||locked} onChange={()=>onChange(id)}/>{label}{locked&&<small><Icon name="lock" size={11}/>{need}<span className="sr-only"> lessons required</span></small>}</label>;})}</fieldset>
 </div>;
}
