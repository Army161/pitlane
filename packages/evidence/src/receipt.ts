import {randomUUID} from 'node:crypto';
import type {JobInput,Observation,Assertion,Receipt} from '../../contracts/src';
import {corroborate} from './projections';
import {aggregate} from './expectations';
export {canonical,digest,rawDigest} from './canonical';
export const visibleText=(value:string)=>value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
export function buildReceipt(input:JobInput,observations:Observation[],assertions:Assertion[],context:Partial<Pick<Receipt,'jobId'|'origin'|'limitations'>>={}):Receipt {const p=corroborate(observations,input);return {schema:'pitlane.receipt.v1',executionState:'completed',id:randomUUID(),versionId:randomUUID(),jobId:context.jobId??randomUUID(),input,finding:p.ok?aggregate(assertions):'insufficient_evidence',assertions,observations,projection:p.ok?p.value:null,limitations:[...(context.limitations??[]),...(p.ok?p.value.limitations:[p.message])],issuedAt:new Date().toISOString(),ruleVersion:'1',origin:context.origin??'fixture'}}
export function renderReceipt(r:Receipt):string {return visibleText(JSON.stringify(r,null,2))}
