import {describe,it,expect} from 'vitest';
import {metadataBytes,SUBJECT} from '../fixtures/mints';
const m=await import('../../packages/evidence/src/metadata').catch(()=>({}));const decode=(m as any).decodeTokenMetadata;
describe('bounded inert TokenMetadata',()=>{
 it('exports the bounded metadata decoder',()=>expect(typeof decode).toBe('function'));
 it('rejects huge prefix before allocation',()=>{const b=metadataBytes();b.writeUInt32LE(0xffffffff,64);expect(decode(b,SUBJECT).code).toBe('MALFORMED_METADATA')});
 it('measures UTF-8 bytes and keeps URI inert',()=>{expect(decode(metadataBytes('é'.repeat(64)),SUBJECT).ok).toBe(true);expect(decode(metadataBytes('é'.repeat(65)),SUBJECT).code).toBe('UNSUPPORTED_METADATA');expect(decode(metadataBytes(),SUBJECT).value.uri).toBe('javascript:alert(1)')});
 it('rejects invalid UTF-8, duplicate keys and mint mismatch',()=>{const b=metadataBytes();b[68]=0xff;expect(decode(b,SUBJECT).ok).toBe(false);expect(decode(metadataBytes('x','x',[['a','1'],['a','2']]),SUBJECT).ok).toBe(false);expect(decode(metadataBytes(),'11111111111111111111111111111111').ok).toBe(false)});
 it('rejects trailing data and keeps original pair order',()=>{expect(decode(Buffer.concat([metadataBytes(),Buffer.from([1])]),SUBJECT).ok).toBe(false);expect(decode(metadataBytes('x','x',[['z','1'],['a','2']]),SUBJECT).value.additional[0][0]).toBe('z')});
});
