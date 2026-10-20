import {it,expect} from 'vitest';
const m=await import('../../packages/evidence/src/receipt').catch(()=>({}));
it('exports canonical hashing',()=>expect(typeof (m as any).digest).toBe('function'));
it('hashes object keys deterministically and keeps array order',()=>{const d=(m as any).digest;expect(d({a:1,b:2})).toBe(d({b:2,a:1}));expect(d([1,2])).not.toBe(d([2,1]))});
it('renders metadata as visible inert text',()=>{const r=(m as any).visibleText;expect(r('<img>\u202E')).toBe('<img>\\u202e')});
