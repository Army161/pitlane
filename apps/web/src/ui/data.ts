'use client';
import {useEffect,useState,useRef} from 'react';
import type {DependencyList} from 'react';
import type {Call} from './protocol';
export function usePagedData<T extends {id:string}>(call:Call,path:string|undefined,ascending=false){
 const generation=useRef(0);
 const [value,setValue]=useState<T[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0),[hasMore,setHasMore]=useState(false);
 useEffect(()=>{let active=true;generation.current++;setLoading(true);setError('');setValue([]);setHasMore(false);
  if(!path){setLoading(false);return;}
  void call<T[]>(path+'?limit=25').then(rows=>{if(active){setValue(rows);setHasMore(rows.length===25);}}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[call,path,revision]);
 async function more(){if(!path||loading||!value.length)return;const token=generation.current;setLoading(true);setError('');try{const before=ascending?value[0].id:value[value.length-1].id;const rows=await call<T[]>(path+'?limit=25&before='+before);if(token!==generation.current)return;setValue(old=>{const fresh=rows.filter(row=>!old.some(v=>v.id===row.id));return ascending?[...fresh,...old]:[...old,...fresh];});setHasMore(rows.length===25);}catch(e){if(token===generation.current)setError(e instanceof Error?e.message:'History unavailable');}finally{if(token===generation.current)setLoading(false);}}
 return {value,error,loading,hasMore,more,refresh:()=>setRevision(r=>r+1)};
}
export function useData<T>(load:()=>Promise<T>,initial:T,deps:DependencyList,poll=0){
 const [value,setValue]=useState(initial),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
 useEffect(()=>{let active=true;setLoading(true);setError('');
  const refresh=async()=>{try{const result=await load();if(active){setValue(result);setError('');}}catch(e){if(active)setError(e instanceof Error?e.message:'Service unavailable');}finally{if(active)setLoading(false);}};
  void refresh();const timer=poll?setInterval(()=>void refresh(),poll):undefined;
  return()=>{active=false;clearInterval(timer);};
 },[...deps,revision]);
 return {value,error,loading,refresh:()=>setRevision(r=>r+1)};
}
