import bs58 from 'bs58';
export const SUBJECT=bs58.encode(Buffer.alloc(32,7));
export function mintBytes(supply=100n){const b=Buffer.alloc(82);b.writeBigUInt64LE(supply,36);b[44]=9;b[45]=1;return b;}
export function token2022(entries:[number,Buffer][]){const head=Buffer.alloc(166);mintBytes().copy(head);head[165]=1;return Buffer.concat([head,...entries.map(([id,data])=>{const h=Buffer.alloc(4);h.writeUInt16LE(id);h.writeUInt16LE(data.length,2);return Buffer.concat([h,data])})]);}
const str=(s:string)=>{const b=Buffer.from(s);const n=Buffer.alloc(4);n.writeUInt32LE(b.length);return Buffer.concat([n,b])};
export function metadataBytes(name='Pitlane',uri='javascript:alert(1)',pairs:[string,string][]=[]){const count=Buffer.alloc(4);count.writeUInt32LE(pairs.length);return Buffer.concat([Buffer.alloc(32),Buffer.from(bs58.decode(SUBJECT)),str(name),str('PIT'),str(uri),count,...pairs.flatMap(([k,v])=>[str(k),str(v)])]);}
