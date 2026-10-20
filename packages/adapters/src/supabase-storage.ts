import {createClient,type SupabaseClient} from '@supabase/supabase-js';import type {StoragePort} from '../../contracts/src';
import {boundedBytes} from './solana-rpc';

export const boundedStorageFetch:typeof fetch=async(input,init)=>{
 const caller=init?.signal??(input instanceof Request?input.signal:undefined);caller?.throwIfAborted();
 const deadline=AbortSignal.timeout(30000);const signal=caller?AbortSignal.any([caller,deadline]):deadline;
 // Abort reaches the actual HTTP request and stays active through body reading.
 const response=await fetch(input,{...init,signal,redirect:'error'});
 const bytes=response.body?await boundedBytes(response,1048576):null;
 return new Response(bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
};
export class SupabaseStorage implements StoragePort {readonly client:SupabaseClient;constructor(url:string,serverKey:string,readonly bucket:string,expectedProjectId:string){const u=new URL(url);if(u.protocol!=='https:'||u.hostname!==`${expectedProjectId}.supabase.co`)throw new Error('FOREIGN_STORAGE_PROJECT');this.client=createClient(url,serverKey,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:boundedStorageFetch}})}async verifyPrivate(){const {data,error}=await this.client.storage.getBucket(this.bucket);if(error||!data||data.public)throw new Error('PRIVATE_BUCKET_REQUIRED')}async put(key:string,bytes:Uint8Array,contentType:string){const {error}=await this.client.storage.from(this.bucket).upload(key,bytes,{contentType,upsert:false});if(error)throw new Error('STORAGE_UPLOAD_FAILED')}async get(key:string){const {data,error}=await this.client.storage.from(this.bucket).download(key);if(error||!data)throw new Error('STORAGE_DOWNLOAD_FAILED');return new Uint8Array(await data.arrayBuffer())}async remove(key:string){const {error}=await this.client.storage.from(this.bucket).remove([key]);if(error)throw new Error('STORAGE_DELETE_FAILED')}}
