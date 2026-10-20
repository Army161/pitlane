import {it,expect} from 'vitest';
import {GENESIS,PROGRAMS,type JobInput,type Observation} from '../../packages/contracts/src';
import {SUBJECT} from '../fixtures/mints';
const m=await import('../../packages/evidence/src/projections').catch(()=>({}));const c=(m as any).corroborate;
export const input:JobInput={projectId:'00000000-0000-4000-8000-000000000001',templateId:'solana.mint_configuration',templateVersion:'1',network:'devnet',mint:SUBJECT,expectations:[]};
export function obs(providerId='a',supply='100'):Observation{return {providerId,upstreamId:providerId,network:'devnet',genesis:GENESIS.devnet,slot:'100',acquiredAt:'2026-10-05T12:00:00.000Z',commitment:'finalized',rawHash:'abc',lamports:'10',mint:{mint:SUBJECT,program:PROGRAMS.original,initialized:true,decimals:9,supply,mintAuthority:null,freezeAuthority:null,extensions:[]}}}
it('exports scoped provider corroboration',()=>expect(typeof c).toBe('function'));
it('keeps differing supply without inventing required-field conflict',()=>{const r=c([obs(),obs('b','101')],input);expect(r.ok).toBe(true);expect(r.value.informational.supply.status).toBe('varied');expect(r.value.fields.supply).toBeUndefined()});
it('rejects authority conflict and missing/non-independent source',()=>{const b=obs('b');b.mint.mintAuthority=SUBJECT;expect(c([obs(),b],input).ok).toBe(false);expect(c([obs()],input).ok).toBe(false);b.upstreamId='a';expect(c([obs(),b],input).ok).toBe(false)});
it('rejects wrong genesis, stale pair and excess slot skew',()=>{const b=obs('b');b.genesis='wrong';expect(c([obs(),b],input).ok).toBe(false);b.genesis=GENESIS.devnet;b.acquiredAt='2026-10-05T12:00:31Z';expect(c([obs(),b],input).ok).toBe(false);b.acquiredAt=obs().acquiredAt;b.slot='251';expect(c([obs(),b],input).ok).toBe(false)});
it('discloses unrequested configuration variation without asserting it',()=>{const q={...input,templateId:'solana.integration_expectations',expectations:[{id:'d',path:'decimals',op:'eq',value:9}]} as JobInput;const b=obs('b');b.mint.freezeAuthority=SUBJECT;const r=c([obs(),b],q);expect(r.ok).toBe(true);expect(r.value.limitations.length).toBeGreaterThan(0)});
