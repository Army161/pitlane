import bs58 from 'bs58';
import type {Result,TokenMetadata} from '../../contracts/src';
import {LIMITS} from '../../contracts/src';
export function decodeTokenMetadata(bytes:Uint8Array,subject:string):Result<TokenMetadata>{
 const b=Buffer.from(bytes);let p=0;let oversized=b.length>LIMITS.metadataBytes;
 const need=(n:number)=>{if(n<0||p+n>b.length)throw new Error('Truncated metadata')};
 const key=()=>{need(32);const a=b.subarray(p,p+32);p+=32;return a.every(x=>x===0)?null:bs58.encode(a)};
 const u32=()=>{need(4);const n=b.readUInt32LE(p);p+=4;return n};
 const text=(bound:number)=>{const n=u32();need(n);if(n>bound)oversized=true;const s=new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(p,p+n));p+=n;return s};
 try{const updateAuthority=key();need(32);const mint=bs58.encode(b.subarray(p,p+32));p+=32;if(mint!==subject)throw new Error('Embedded mint differs from subject');const name=text(LIMITS.nameBytes),symbol=text(LIMITS.symbolBytes),uri=text(LIMITS.uriBytes);const count=u32();if(count>Math.floor((b.length-p)/8))throw new Error('Impossible pair count');if(count>LIMITS.pairs)oversized=true;const additional:[string,string][]=[];const seen=new Set<string>();for(let i=0;i<count;i++){const k=text(LIMITS.keyBytes),v=text(LIMITS.valueBytes);if(seen.has(k))throw new Error('Duplicate key');seen.add(k);additional.push([k,v])}if(p!==b.length)throw new Error('Trailing metadata bytes');if(oversized)return {ok:false,code:'UNSUPPORTED_METADATA',message:'Metadata exceeds published byte/count bounds'};return {ok:true,value:{updateAuthority,mint,name,symbol,uri,additional}}}catch(e){return {ok:false,code:'MALFORMED_METADATA',message:e instanceof Error?e.message:'Malformed metadata'}}
}
