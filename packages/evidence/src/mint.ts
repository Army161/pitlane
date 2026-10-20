import bs58 from 'bs58';
import {PROGRAMS,type Result,type DecodedMint} from '../../contracts/src';
import {decodeTokenMetadata} from './metadata';
export function validateMintAddress(text:string):Result<string>{try{const a=bs58.decode(text);if(a.length!==32)throw new Error();return {ok:true,value:bs58.encode(a)}}catch{return {ok:false,code:'INVALID_ADDRESS',message:'Full 32-byte base58 address required'}}}
const names:Record<number,string>={1:'TransferFeeConfig',3:'MintCloseAuthority',18:'MetadataPointer',19:'TokenMetadata'};
export function decodeMint(bytes:Uint8Array,owner:string,subject:string):Result<DecodedMint>{
 if(!Object.values(PROGRAMS).includes(owner as never))return {ok:false,code:'UNSUPPORTED_OWNER',message:'Unsupported token program'};
 if(!validateMintAddress(subject).ok)return {ok:false,code:'INVALID_ADDRESS',message:'Invalid mint address'};
 const b=Buffer.from(bytes);const malformed=(message:string):Result<DecodedMint>=>({ok:false,code:'MALFORMED_MINT',message});
 try{if(b.length<82||b.length===355||owner===PROGRAMS.original&&b.length!==82)return malformed('Invalid mint length');if(![0,1].includes(b.readUInt32LE(0))||![0,1].includes(b.readUInt32LE(46))||b[45]!==1)return malformed('Invalid option tag or initialization');
 const key=(offset:number)=>{const a=b.subarray(offset,offset+32);return a.every(x=>x===0)?null:bs58.encode(a)};
 const value:DecodedMint={mint:subject,program:owner,initialized:true,decimals:b[44],supply:b.readBigUInt64LE(36).toString(),mintAuthority:b.readUInt32LE(0)===0?null:bs58.encode(b.subarray(4,36)),freezeAuthority:b.readUInt32LE(46)===0?null:bs58.encode(b.subarray(50,82)),extensions:[]};
 if(b.length===82)return {ok:true,value};if(b.length<166||b[165]!==1||b.subarray(82,165).some(x=>x!==0))return malformed('Invalid Token-2022 mint envelope');
 const seen=new Set<number>();let p=166;while(p<b.length){if(b.subarray(p).every(x=>x===0))break;if(p+4>b.length)return malformed('Truncated extension header');const id=b.readUInt16LE(p),n=b.readUInt16LE(p+2);p+=4;if(seen.has(id)||p+n>b.length)return malformed('Duplicate or truncated extension');seen.add(id);if(!names[id])return {ok:false,code:'UNSUPPORTED_EXTENSION',message:`Unsupported extension ${id}`};value.extensions.push(names[id]);const at=p;p+=n;
 if(id===1){if(n!==108)return malformed('Invalid fee layout');const schedule=(o:number)=>({epoch:b.readBigUInt64LE(o).toString(),maximumFee:b.readBigUInt64LE(o+8).toString(),basisPoints:b.readUInt16LE(o+16)});value.transferFee={authority:key(at),withdrawAuthority:key(at+32),withheldAmount:b.readBigUInt64LE(at+64).toString(),older:schedule(at+72),newer:schedule(at+90)};if(value.transferFee.older.basisPoints>10000||value.transferFee.newer.basisPoints>10000)return malformed('Invalid fee basis points')}
 if(id===3){if(n!==32)return malformed('Invalid close-authority layout');value.closeAuthority=key(at)}
 if(id===18){if(n!==64)return malformed('Invalid pointer layout');value.metadataPointer={authority:key(at),address:key(at+32)}}
 if(id===19){const r=decodeTokenMetadata(b.subarray(at,at+n),subject);if(!r.ok)return r;value.metadata=r.value}
 }value.extensions.sort();return {ok:true,value};
 }catch{return malformed('Invalid account encoding')}
}
