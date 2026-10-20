import {z} from 'zod';
import bs58 from 'bs58';
import {EXTENSIONS,PROGRAMS} from './limits';
import type {JobInput,Result,RuntimeConfig,Predicate} from './domain';
const address=z.string().max(44).refine(v=>{try{return bs58.decode(v).length===32}catch{return false}},'Full base58 address required');
const integer=z.number().int().refine(Number.isSafeInteger);
const amount=z.string().regex(/^(0|[1-9][0-9]*)$/).refine(v=>BigInt(v)<=18446744073709551615n);
const extension=z.enum(EXTENSIONS);
const predicate=z.object({id:z.string().min(1).max(64),path:z.string().min(1).max(128),op:z.enum(['eq','absent','fee_caps','extensions']),value:z.union([z.string().max(2048),integer,z.null(),z.array(z.string().max(64)).max(4),z.object({basisPoints:integer.min(0).max(10000),maximumFee:amount}).strict(),z.object({required:z.array(extension).max(4),forbidden:z.array(extension).max(4),accepted:z.array(extension).min(0).max(4)}).strict()])}).strict();
const inputSchema=z.object({projectId:z.string().uuid(),templateId:z.enum(['solana.mint_configuration','solana.integration_expectations']),templateVersion:z.literal('1').default('1'),network:z.enum(['devnet','mainnet-beta']),mint:address,expectations:z.array(predicate).max(32).default([])}).strict();
function validPredicate(p:Predicate):boolean {
 if(p.op==='extensions'){if(p.path!=='extensions'||typeof p.value!=='object'||p.value===null||!('required' in p.value))return false; const v=p.value;return v.required.every(x=>v.accepted.includes(x)&&!v.forbidden.includes(x))&&new Set(v.accepted).size===v.accepted.length;}
 if(p.op==='fee_caps')return p.path==='transferFee'&&typeof p.value==='object'&&p.value!==null&&'basisPoints' in p.value;
 if(p.op==='absent')return p.path==='transferFee'&&p.value===null;
 if(p.path==='decimals')return typeof p.value==='number'&&p.value>=0&&p.value<=255;
 if(['mint','mintAuthority','freezeAuthority','closeAuthority','metadataPointer.authority','metadataPointer.address','metadata.updateAuthority'].includes(p.path))return p.value===null&&p.path!=='mint'||typeof p.value==='string'&&address.safeParse(p.value).success;
 if(p.path==='network')return p.value==='devnet'||p.value==='mainnet-beta';
 if(p.path==='program')return Object.values(PROGRAMS).includes(p.value as never);
 if(/^metadata\.(name|symbol|uri)$/.test(p.path))return typeof p.value==='string'&&Buffer.byteLength(p.value)<=({name:128,symbol:32,uri:2048} as Record<string,number>)[p.path.split('.')[1]];
 if(p.path.startsWith('metadata.additional.'))return typeof p.value==='string'&&Buffer.byteLength(p.path.slice(20))<=64&&Buffer.byteLength(p.value)<=1024;
 return false;
}
export function parseJobInput(value:unknown):Result<JobInput>{
 const r=inputSchema.safeParse(value);if(!r.success)return {ok:false,code:'INVALID_INPUT',message:r.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')};
 const v=r.data as JobInput;if(v.templateId==='solana.integration_expectations'&&v.expectations.length===0)return {ok:false,code:'INVALID_INPUT',message:'At least one expectation required'};
 if(v.templateId==='solana.mint_configuration'&&v.expectations.length)return {ok:false,code:'INVALID_INPUT',message:'Configuration template does not accept predicates'};
 const seen=new Map<string,string>();const ids=new Set<string>();for(const p of v.expectations){if(!validPredicate(p)||ids.has(p.id))return {ok:false,code:'UNSUPPORTED_SCOPE',message:'Invalid, duplicate or unsupported predicate'};ids.add(p.id);const k=`${p.path}:${p.op}`;const s=JSON.stringify(p.value);if(seen.has(k)&&seen.get(k)!==s)return {ok:false,code:'CONTRADICTORY_INPUT',message:'Contradictory predicates'};seen.set(k,s);}
 v.mint=bs58.encode(bs58.decode(v.mint));return {ok:true,value:v};
}
const configSchema=z.object({mode:z.enum(['local','staging','production']),authMode:z.enum(['fixture','supabase']),storageMode:z.enum(['local','supabase']),rpcMode:z.enum(['fixture','gateway']),billingMode:z.enum(['disabled','sandbox','live']).default('disabled'),environmentId:z.string().min(1),expectedProjectId:z.string().optional(),egressVerified:z.boolean().default(false)}).strict();
export function parseRuntimeConfig(value:unknown):Result<RuntimeConfig>{const r=configSchema.safeParse(value);if(!r.success)return {ok:false,code:'INVALID_CONFIG',message:'Invalid environment configuration'};const c=r.data;if(c.mode!=='local'&&(c.authMode!=='supabase'||c.storageMode!=='supabase'||c.rpcMode!=='gateway'||!c.expectedProjectId))return {ok:false,code:'UNSAFE_CONFIG',message:'Hosted modes require real isolated adapters'};if(c.mode==='production'&&!c.egressVerified)return {ok:false,code:'EGRESS_UNVERIFIED',message:'Production requires verified worker egress enforcement'};if(c.mode==='local'&&c.billingMode==='live')return {ok:false,code:'UNSAFE_CONFIG',message:'Live billing prohibited locally'};return {ok:true,value:c};}
