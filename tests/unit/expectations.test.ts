import {it,expect} from 'vitest';
import {input,obs} from '../fixtures/observations';
import type {JobInput} from '../../packages/contracts/src';
const m=await import('../../packages/evidence/src/expectations').catch(()=>({}));const e=(m as any).evaluateExpectations;
it('exports deterministic assertion evaluation',()=>expect(typeof e).toBe('function'));
it('reports contradiction and never passes missing required evidence',()=>{const q={...input,templateId:'solana.integration_expectations',expectations:[{id:'d',path:'decimals',op:'eq',value:6}]} as JobInput;expect(e({fields:{decimals:9},paths:['decimals'],observations:[]},q)[0].state).toBe('contradicted');expect(e({fields:{},paths:[],observations:[]},q)[0].state).toBe('insufficient_evidence')});
it('enforces caps on both stored schedules',()=>{const q={...input,templateId:'solana.integration_expectations',expectations:[{id:'fee',path:'transferFee',op:'fee_caps',value:{basisPoints:100,maximumFee:'10'}}]} as JobInput;const f={older:{basisPoints:90,maximumFee:'1'},newer:{basisPoints:200,maximumFee:'1'}};expect(e({fields:{transferFee:f},paths:['transferFee'],observations:[obs()]},q)[0].state).toBe('contradicted')});
