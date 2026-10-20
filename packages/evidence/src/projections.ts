import {GENESIS,LIMITS,type DecodedMint,type JobInput,type Observation,type Projection,type Result} from '../../contracts/src';
import {digest} from './canonical';
export function valueAt(m:DecodedMint,input:JobInput,path:string):unknown {
 if(path==='network')return input.network;
 if(path==='transferFee')return m.transferFee?{authority:m.transferFee.authority,withdrawAuthority:m.transferFee.withdrawAuthority,older:m.transferFee.older,newer:m.transferFee.newer}:null;
 if(path==='metadata')return m.metadata?{...m.metadata,additional:[...m.metadata.additional].sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b)))}:null;
 if(path.startsWith('metadata.additional.'))return m.metadata?.additional.find(([k])=>k===path.slice('metadata.additional.'.length))?.[1];
 let v:unknown=m;for(const k of path.split('.'))v=v&&typeof v==='object'?(v as Record<string,unknown>)[k]:undefined;
 if(v===undefined&&['closeAuthority','metadataPointer','metadataPointer.authority','metadataPointer.address','metadata.updateAuthority'].includes(path))return null;
 return v;
}
export function projectRequired(mint:DecodedMint,input:JobInput):Projection {
 const paths=input.templateId==='solana.mint_configuration'?['mint','program','initialized','decimals','mintAuthority','freezeAuthority','extensions','transferFee','closeAuthority','metadataPointer','metadata']:['mint','program','initialized','extensions',...input.expectations.map(p=>p.path)];
 const fields=Object.fromEntries([...new Set(paths)].sort().map(p=>[p,valueAt(mint,input,p)]));return {fields,paths:Object.keys(fields),hash:digest(fields),informational:{},observations:[],limitations:[]};
}
export function corroborate(observations:Observation[],input:JobInput):Result<Projection>{
 const fail=(message:string):Result<Projection>=>({ok:false,code:'INSUFFICIENT_EVIDENCE',message});if(observations.length!==2)return fail('Exactly two provider observations required');const [a,b]=observations;
 if(a.providerId===b.providerId||!a.upstreamId||!b.upstreamId||a.upstreamId===b.upstreamId)return fail('Independent upstreams required');
 for(const o of observations){if(o.network!==input.network||o.genesis!==GENESIS[input.network]||o.commitment!=='finalized'||o.mint.mint!==input.mint||!o.mint.initialized||!/^\d+$/.test(o.slot)||!Number.isFinite(Date.parse(o.acquiredAt)))return fail('Invalid network, subject or finalized context')}
 if(Math.abs(Date.parse(a.acquiredAt)-Date.parse(b.acquiredAt))>LIMITS.pairMs)return fail('Observation pair too old');const skew=BigInt(a.slot)-BigInt(b.slot);if(skew>LIMITS.slotSkew||skew< -LIMITS.slotSkew)return fail('Context slot skew exceeds policy');
 const x=projectRequired(a.mint,input),y=projectRequired(b.mint,input);if(x.hash!==y.hash)return fail('Required configuration fields disagree');
 for(const path of ['supply','transferFee.withheldAmount','lamports']){const values=observations.map(o=>({providerId:o.providerId,value:path==='lamports'?o.lamports:valueAt(o.mint,input,path)??null}));x.informational[path]={status:digest(values[0].value)===digest(values[1].value)?'agreed':'varied',values};}
 if(input.templateId==='solana.integration_expectations'&&projectRequired(a.mint,{...input,templateId:'solana.mint_configuration'}).hash!==projectRequired(b.mint,{...input,templateId:'solana.mint_configuration'}).hash)x.limitations.push('Unrequested configuration differs between observations; no claim is made about those fields');
 if(observations.some(o=>o.mint.metadataPointer?.address&&o.mint.metadataPointer.address!==input.mint))x.limitations.push('External metadata pointer contents were not inspected');
 x.observations=observations;x.limitations.push('Provider reports at differing contexts are not an atomic chain snapshot');return {ok:true,value:x};
}
