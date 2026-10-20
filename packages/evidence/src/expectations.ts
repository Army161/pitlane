import type {Projection,JobInput,Assertion,Finding} from '../../contracts/src';
import {digest} from './canonical';
export function evaluateExpectations(p:Projection,input:JobInput):Assertion[]{
 const evidence=p.observations?.map(o=>o.rawHash)??[];
 if(input.templateId==='solana.mint_configuration')return p.paths.map(path=>({id:path,path,state:'supported',reason:'CORROBORATED_CONFIGURATION',expected:null,observed:p.fields[path],evidence}));
 return input.expectations.map(q=>{const observed=p.fields[q.path];let state:Finding='insufficient_evidence';let reason='MISSING_REQUIRED_FIELD';if(observed!==undefined){let match=false;
 if(q.op==='eq')match=digest(observed)===digest(q.value);
 if(q.op==='absent')match=observed===null;
 if(q.op==='fee_caps'&&observed&&typeof observed==='object'&&q.value&&typeof q.value==='object'&&'basisPoints' in q.value){const cap=q.value;const f=observed as {older:{basisPoints:number;maximumFee:string};newer:{basisPoints:number;maximumFee:string}};match=[f.older,f.newer].every(s=>s&&s.basisPoints<=cap.basisPoints&&BigInt(s.maximumFee)<=BigInt(cap.maximumFee))}
 if(q.op==='extensions'&&Array.isArray(observed)&&q.value&&typeof q.value==='object'&&'required' in q.value){const v=q.value;match=v.required.every(x=>observed.includes(x))&&v.forbidden.every(x=>!observed.includes(x))&&observed.every(x=>v.accepted.includes(x))}
 state=match?'supported':'contradicted';reason=match?'REQUIREMENT_SUPPORTED':'REQUIREMENT_CONTRADICTED'}return {id:q.id,path:q.path,state,reason,expected:q.value,observed:observed??null,evidence}});
}
export function aggregate(assertions:Assertion[]):Finding {if(!assertions.length||assertions.some(a=>a.state==='insufficient_evidence'))return 'insufficient_evidence';return assertions.some(a=>a.state==='contradicted')?'contradicted':'supported'}
