'use client';
import {useState,useRef} from 'react';
import type {ScreenProps,DataRow} from './protocol';
import {date,text,usd} from './protocol';
import type {Conversation,CollaborationMessage,AiAvailability,SendMessageResult} from '../../../../packages/contracts/src/collaboration';
import {useData,usePagedData} from './data';
import {PageHead,Load,Status} from './work';

export function Agents({project,call,act,busy,notify}:ScreenProps){
 const root=`/v1/projects/${project.id}`;
 const conversations=usePagedData<Conversation>(call,root+'/conversations');
 const availability=useData(()=>call<{availability:AiAvailability;members:unknown[]}>(root+'/collaboration'),{availability:{available:false,provider:null,model:null,origin:null,reason:'Checking connection'},members:[]},[call,project.id]);
 const [selected,setSelected]=useState(''),[title,setTitle]=useState(''),[content,setContent]=useState(''),[evidence,setEvidence]=useState('');
 const current=conversations.value.find(c=>c.id===selected)??conversations.value[0];
 const history=usePagedData<CollaborationMessage>(call,current?root+`/conversations/${current.id}/messages`:undefined,true);
 const records=useData(()=>call<DataRow[]>(root+'/receipts'),[],[call,project.id]);
 const pending=useRef<{content:string;evidence:string;key:string}|null>(null);
 const send=()=>act(async()=>{
  if(!current)return;
  if(!pending.current||pending.current.content!==content||pending.current.evidence!==evidence)pending.current={content,evidence,key:crypto.randomUUID()};
  const result=await call<SendMessageResult>(root+`/conversations/${current.id}/messages`,{content,...(evidence?{receiptVersionIds:[evidence]}:{})},{key:pending.current.key});
  setContent('');pending.current=null;history.refresh();
  notify(result.reply?'Agent explanation saved with usage.':`Your message is saved. Agent status: ${result.request.status.replaceAll('_',' ')}.`);
 });
 return <><PageHead title="Agent workspace" description="Private conversations about your integration evidence. Agent explanations are separate from deterministic findings."/>
 <div className="agent-layout"><aside className="panel conversation-list"><p className="eyebrow">Project conversations</p><Load {...conversations}/>
 {conversations.value.length?<ul className="list">{conversations.value.map(c=><li key={c.id}><button className={'conversation-button '+(current?.id===c.id?'selected':'')} aria-pressed={current?.id===c.id} onClick={()=>{setSelected(c.id);pending.current=null;setContent('');}}>{text(c.title)}<small>{date(c.updatedAt)}</small></button></li>)}</ul>:!conversations.loading&&<p className="muted">No conversations yet.</p>}
 {conversations.hasMore&&<button className="secondary" disabled={conversations.loading} onClick={()=>void conversations.more()}>Load older conversations</button>}
 {project.can_write&&<form className="form" onSubmit={e=>{e.preventDefault();void act(async()=>{const created=await call<Conversation>(root+'/conversations',{title});setSelected(created.id);setTitle('');conversations.refresh();});}}><label>Conversation title<input required maxLength={128} value={title} onChange={e=>setTitle(e.target.value)}/></label><button disabled={busy}>New conversation</button></form>}</aside>
 <section className="panel agent-thread"><header className="row spread"><div><p className="eyebrow">Evidence assistant</p><h2>{current?text(current.title):'Start a project conversation'}</h2></div><span className={'badge '+(availability.value.availability.available?'running':'unsupported')}>{availability.value.availability.available?'Provider connected':'Provider unavailable'}</span></header>
 <Load {...availability}/><p className="muted">{availability.value.availability.available?`${availability.value.availability.provider} · ${availability.value.availability.model}`:'Configure a real provider to receive AI replies. Messages remain saved; no substitute replies are generated.'}</p>
 <Load {...history}/>{history.hasMore&&<button className="secondary" disabled={history.loading} onClick={()=>void history.more()}>Load earlier messages</button>}<ol className="message-timeline" aria-label="Conversation messages">{history.value.map(m=><li key={m.id} className={'message '+m.role}><header className="row spread"><strong>{m.role==='assistant'?'Agent explanation':'Project member'}</strong><small>{date(m.createdAt)}</small></header><p className="message-body">{text(m.content)}</p>{m.receiptVersionIds.length>0&&<small>Linked receipt versions: {m.receiptVersionIds.map(v=><code key={v}>{v} </code>)}</small>}{m.request&&<div className="message-status"><Status value={m.request.status}/><small>{m.request.usage?` ${m.request.usage.totalTokens} tokens`:' Usage not confirmed'}{m.request.costMicro!==null?` · ${usd(m.request.costMicro,6)} estimated provider cost`:''}</small></div>}{m.role==='assistant'&&<small>{m.origin} · An explanation cannot change the recorded finding.</small>}</li>)}</ol>
 {!current&&<div className="empty">Create a conversation to organize your team's questions and link evidence.</div>}
 {current&&project.can_write&&<form className="form composer" onSubmit={e=>{e.preventDefault();void send();}}><label>Message<textarea required maxLength={4000} value={content} onChange={e=>setContent(e.target.value)} placeholder="Ask about a declared requirement or record a follow-up question."/></label><label>Attach receipt evidence<select value={evidence} onChange={e=>setEvidence(e.target.value)}><option value="">No receipt attached</option>{records.value.map(r=><option value={r.id} key={r.id}>{r.finding} · {date(r.issued_at)}</option>)}</select></label><div className="row spread"><small>Only selected authorized context is sent to the configured provider. No transaction or code execution tools.</small><button disabled={busy||!content.trim()}>{availability.value.availability.available?'Send to agent':'Save message'}</button></div></form>}
 {!project.can_write&&<p className="notice">You can read conversations. A project developer can send messages.</p>}
 </section></div></>;
}
