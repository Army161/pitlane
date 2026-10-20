import {afterEach,expect,it,vi} from 'vitest';
import {SupabaseStorage,boundedStorageFetch} from '../../packages/adapters/src/supabase-storage';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()});

it('aborts the actual upload fetch at the configured request deadline',async()=>{
 const timeout=new AbortController();const clock=vi.spyOn(AbortSignal,'timeout').mockReturnValue(timeout.signal);let signal:AbortSignal|undefined;
 vi.stubGlobal('fetch',vi.fn(async(_input:unknown,init?:RequestInit)=>{signal=init?.signal??undefined;if(!signal)throw new Error('MISSING_ABORT_SIGNAL');return new Promise<Response>((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true})})}));
 const storage=new SupabaseStorage('https://fixture.supabase.co','fixture-server-key','private','fixture');const pending=storage.put('tenant/project/job/private.json',new Uint8Array([1]),'application/json').catch(error=>error);
 await vi.waitFor(()=>expect(signal).toBeDefined());expect(clock).toHaveBeenCalledWith(30000);timeout.abort(new DOMException('fixture timeout','TimeoutError'));expect((await pending).message).toBe('STORAGE_UPLOAD_FAILED');expect(signal?.aborted).toBe(true);
});

it('preserves caller cancellation on the actual request signal',async()=>{
 const caller=new AbortController(),timeout=new AbortController();vi.spyOn(AbortSignal,'timeout').mockReturnValue(timeout.signal);let signal:AbortSignal|undefined;
 vi.stubGlobal('fetch',vi.fn(async(_input:unknown,init?:RequestInit)=>{signal=init?.signal??undefined;return new Promise<Response>((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true}))}));
 const pending=boundedStorageFetch(new Request('https://fixture.supabase.co/storage/v1/object/private/key',{signal:caller.signal})).catch(error=>error);await vi.waitFor(()=>expect(signal).toBeDefined());caller.abort();expect((await pending).name).toBe('AbortError');expect(signal?.aborted).toBe(true);expect(timeout.signal.aborted).toBe(false);
});

it('keeps the request deadline active while reading a delayed response body',async()=>{
 const timeout=new AbortController();vi.spyOn(AbortSignal,'timeout').mockReturnValue(timeout.signal);let signal:AbortSignal|undefined;
 vi.stubGlobal('fetch',vi.fn(async(_input:unknown,init?:RequestInit)=>{signal=init?.signal??undefined;return new Response(new ReadableStream({start(controller){signal!.addEventListener('abort',()=>controller.error(signal!.reason),{once:true})}}))}));
 const pending=boundedStorageFetch('https://fixture.supabase.co/storage/v1/object/private/key').catch(error=>error);await vi.waitFor(()=>expect(signal).toBeDefined());timeout.abort(new DOMException('fixture timeout','TimeoutError'));expect((await pending).message).toBe('RPC_TRANSPORT_ERROR');expect(signal?.aborted).toBe(true);
});

it('caps storage response bytes and prevents redirected requests',async()=>{
 const transport=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>new Response(new Uint8Array(1048577)));vi.stubGlobal('fetch',transport);await expect(boundedStorageFetch('https://fixture.supabase.co/storage/v1/object/private/key')).rejects.toThrow('RPC_RESPONSE_LIMIT');expect(transport.mock.calls[0][1]?.redirect).toBe('error');
});
