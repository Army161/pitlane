import {describe,it,expect} from 'vitest';
const module = await import('../../packages/contracts/src/index.js').catch(()=>({}));
const contracts = module as Record<string,any>;
describe('job contracts',()=>{
 it('exports runtime validation, not unchecked TypeScript casts',()=>expect(typeof contracts.parseJobInput).toBe('function'));
 it('rejects unsupported networks and absent full mint',()=>{
  expect(contracts.parseJobInput({projectId:'p',templateId:'solana.mint_configuration',network:'ethereum',mint:'SOL'}).ok).toBe(false);
 });
 it('rejects more than 32 expectation predicates',()=>{
  expect(contracts.parseJobInput({projectId:'p',templateId:'solana.integration_expectations',network:'devnet',mint:'11111111111111111111111111111111',expectations:Array(33).fill({path:'decimals',op:'eq',value:9})}).ok).toBe(false);
 });
 it('refuses production fixture mode',()=>expect(contracts.parseRuntimeConfig({mode:'production',authMode:'fixture',storageMode:'local',rpcMode:'fixture'}).ok).toBe(false));
});
