import type {SVGProps} from 'react';
import Link from 'next/link';
/** Inline stroke icons drawn for PITLANE. Decorative by default; pass a `title` to label one. */
const paths:Record<string,string>={
 flag:'M4 21V4m0 0h11l-1.5 3.5L15 11H4',
 calendar:'M4 6h16v14H4zM4 10h16M8 3v4m8-4v4m-6 7 2 2 4-4',
 report:'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5',
 car:'M3 15v-3l2-5h11l3 5h2v3M5 15h14M7 18a2 2 0 1 0 0-.01M17 18a2 2 0 1 0 0-.01M9 7l-1 5h9',
 crew:'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7 0a2.5 2.5 0 1 0 0-5M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5m2-5c2.4.3 4 1.9 4 4.5',
 radio:'M6 10h12a2 2 0 0 1 2 2v7H4v-7a2 2 0 0 1 2-2zm3 0 7-6M9 15h.01M15 15h3',
 sprint:'M4 6h4v4H4zM4 14h4v4H4zM11 8h9M11 16h9',
 treasury:'M3 10l9-6 9 6M5 10v8m4-8v8m6-8v8m4-8v8M3 20h18',
 manual:'M4 5c3-1.5 5.5-1.5 8 0v15c-2.5-1.5-5-1.5-8 0zm8 0c2.5-1.5 5-1.5 8 0v15c-3-1.5-5.5-1.5-8 0',
 check:'M5 12.5 10 17l9-10',
 alert:'M12 3 2 20h20zM12 10v4m0 3h.01',
 question:'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14m0 3h.01',
 lock:'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
 doc:'M6 3h9l4 4v14H6zM14 3v5h5',
 clock:'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
 shield:'M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6zm-3 9 2 2 4-4',
 arrow:'M5 12h14m-5-5 5 5-5 5',
 download:'M12 4v11m-4-4 4 4 4-4M5 20h14',
 swap:'M4 8h14l-3-3M20 16H6l3 3',
 key:'M15 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 12l-8 8m3-3 2 2m1-5 2 2',
 trophy:'M8 4h8v5a4 4 0 0 1-8 0zM8 6H4c0 3 1.5 4.5 4 5m8-5h4c0 3-1.5 4.5-4 5M12 13v4m-4 3h8l-1-3H9z',
 map:'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2zm0 0v14m6-12v14',
 wrench:'M14.5 5.5a4 4 0 0 0 5 5L21 9a5 5 0 0 1-6.6 4.8L7 21l-4-4 7.2-7.4A5 5 0 0 1 15 3z',
 code:'M8 7 3 12l5 5m8-10 5 5-5 5M14 4l-4 16',
 users:'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3 2.7-5 6-5s6 2 6 5m0-4.6c.6-.3 1.3-.4 2-.4 3.3 0 6 2 6 5',
 chart:'M4 20V10m6 10V4m6 16v-7m4 7H3',
 palette:'M12 3a9 9 0 0 0 0 18c1.5 0 2-1 2-2s-1-1.5-1-2.5S14 15 15 15h2a4 4 0 0 0 4-4c0-4.4-4-8-9-8zM7.5 12h.01M10 7.5h.01M15 7.5h.01',
 bulb:'M9 18h6m-5 3h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z',
 hash:'M5 9h14M5 15h14M10 4 8 20m8-16-2 16',
 eye:'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
 database:'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
 info:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-10v6m0-9h.01',
 copy:'M9 9h11v11H9zM5 15V4h11',
};
export type IconName=keyof typeof paths;
export function Icon({name,title,size=20,...rest}:{name:IconName;title?:string;size?:number}&SVGProps<SVGSVGElement>){
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title?undefined:true} role={title?'img':undefined} focusable="false" {...rest}>{title&&<title>{title}</title>}<path d={paths[name]}/></svg>;
}
/** The PITLANE wordmark slash: three slanted bars echoing a pit-board stripe. Original artwork. */
export function Mark({size=26}:{size?:number}){
 return <svg width={size*1.5} height={size} viewBox="0 0 36 24" aria-hidden="true" focusable="false"><path d="M10 2h8l-8 20H2z" fill="#ff6a1a"/><path d="M22 2h6l-8 20h-6z" fill="#ff6a1a" opacity=".75"/><path d="M31 2h4l-8 20h-4z" fill="#ff6a1a" opacity=".5"/></svg>;
}
export function Brand({href='/',small=false}:{href?:string;small?:boolean}){
 return <Link className={'brand'+(small?' small':'')} href={href} aria-label="PITLANE home"><span>PITLANE</span><Mark size={small?18:24}/></Link>;
}
