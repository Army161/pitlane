import {describe,it,expect} from 'vitest';
import {PROGRAMS} from '../../packages/contracts/src';
import {mintBytes,token2022,SUBJECT} from '../fixtures/mints';
const m=await import('../../packages/evidence/src/mint').catch(()=>({}));const decode=(m as any).decodeMint;
describe('mint decoding',()=>{
 it('exports a deterministic mint decoder',()=>expect(typeof decode).toBe('function'));
 it('preserves maximum u64 supply and authority null',()=>{const r=decode(mintBytes(18446744073709551615n),PROGRAMS.original,SUBJECT);expect(r.value.supply).toBe('18446744073709551615');expect(r.value.mintAuthority).toBe(null)});
 it('accepts all 32-byte addresses without curve filtering',()=>expect((m as any).validateMintAddress('11111111111111111111111111111111').ok).toBe(true));
 it('rejects wrong program and uninitialized mint',()=>{expect(decode(mintBytes(),'11111111111111111111111111111111',SUBJECT).code).toBe('UNSUPPORTED_OWNER');const b=mintBytes();b[45]=0;expect(decode(b,PROGRAMS.original,SUBJECT).ok).toBe(false)});
 it('rejects invalid option tags',()=>{const b=mintBytes();b.writeUInt32LE(2,0);expect(decode(b,PROGRAMS.original,SUBJECT).code).toBe('MALFORMED_MINT')});
 it('rejects unknown, duplicate and truncated TLV extensions',()=>{expect(decode(token2022([[9,Buffer.alloc(0)]]),PROGRAMS.token2022,SUBJECT).code).toBe('UNSUPPORTED_EXTENSION');expect(decode(token2022([[3,Buffer.alloc(32)],[3,Buffer.alloc(32)]]),PROGRAMS.token2022,SUBJECT).code).toBe('MALFORMED_MINT');expect(decode(token2022([[3,Buffer.alloc(32)]]).subarray(0,-1),PROGRAMS.token2022,SUBJECT).ok).toBe(false)});
 it('decodes both stored transfer-fee schedules exactly',()=>{const fee=Buffer.alloc(108);fee.writeBigUInt64LE(8n,64);fee.writeBigUInt64LE(2n,72);fee.writeBigUInt64LE(3n,80);fee.writeUInt16LE(100,88);fee.writeBigUInt64LE(4n,90);fee.writeBigUInt64LE(5n,98);fee.writeUInt16LE(200,106);const r=decode(token2022([[1,fee]]),PROGRAMS.token2022,SUBJECT);expect(r.value.transferFee.newer).toEqual({epoch:'4',maximumFee:'5',basisPoints:200});expect(r.value.transferFee.withheldAmount).toBe('8')});
});
