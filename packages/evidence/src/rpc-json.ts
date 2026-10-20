/** Node 24's reviver source context preserves integers before Number rounding. */
export function parseRpc(rawBody:string):{result:unknown;rawBody:string} {
 let value:Record<string,unknown>;
 try {
  value=JSON.parse(rawBody.startsWith('\uFEFF')?rawBody.slice(1):rawBody,
   (_key:string,x:unknown,context?:{source?:string})=>{
    if(typeof x!=='number')return x;
    const source=context?.source;
    if(!source||!/^(-?)(0|[1-9][0-9]*)$/.test(source)||source.replace('-','').length>20)throw new Error('UNSAFE_RPC_NUMBER');
    return Number.isSafeInteger(x)?x:BigInt(source);
   });
 }catch(e){if(e instanceof Error&&e.message==='UNSAFE_RPC_NUMBER')throw e;throw new Error('INVALID_RPC_JSON');}
 if(!value||typeof value!=='object'||Array.isArray(value)||value.error||!Object.hasOwn(value,'result'))throw new Error('RPC_PROTOCOL_ERROR');
 return {result:value.result,rawBody};
}
export function rpcInteger(value:unknown):string {
 if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return String(value);
 if(typeof value==='bigint'&&value>=0n&&value<=18446744073709551615n)return String(value);
 throw new Error('INVALID_RPC_INTEGER');
}
