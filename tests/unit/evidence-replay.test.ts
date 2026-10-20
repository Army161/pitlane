import {it,expect} from 'vitest';import {obs,input} from '../fixtures/observations';import {buildReceipt} from '../../packages/evidence/src/receipt';
const m=await import('../../packages/evidence/src/replay').catch(()=>({}));
it('exports deterministic receipt evidence replay',()=>expect(typeof (m as any).verifyReceiptEvidence).toBe('function'));
it('rejects live receipts without complete hashed source bodies',()=>{const receipt=buildReceipt(input,[obs(),obs('b')],[],{origin:'customer'});expect((m as any).verifyReceiptEvidence(receipt).ok).toBe(false)});
it('rejects a displayed projection that differs from the replayed configuration',()=>{const receipt=buildReceipt(input,[obs(),obs('b')],[],{origin:'fixture'});receipt.projection!.fields.decimals=8;expect((m as any).verifyReceiptEvidence(receipt).ok).toBe(false)});
