import {it,expect,vi} from 'vitest';
import {once} from 'node:events';
const host=await import('../../packages/adapters/src/service-host').catch(()=>({})) as any;
it('stops claims, waits for an accepted task, and closes resources once',async()=>{
 let start:()=>void=()=>{},release:()=>void=()=>{};const begun=new Promise<void>(r=>start=r),held=new Promise<void>(r=>release=r);let calls=0,closed=0;
 const service=await host.startService({name:'controlled-fixture',port:0,host:'127.0.0.1',details:()=>({ready:true}),tick:async()=>{calls++;start();await held;},intervalMs:5,close:async()=>{closed++;}});
 await begun;const stopping=service.stop();try{await new Promise(r=>setTimeout(r,20));expect(calls).toBe(1);expect(closed).toBe(0);expect(service.status.ready).toBe(false);}finally{release();await stopping;}await service.stop();expect(closed).toBe(1);expect(service.status.draining).toBe(true);
});
it('keeps mandatory health final and respects caller readiness false',async()=>{
 let ready=false,calls=0;
 const service=await host.startService({name:'controlled-fixture',port:0,host:'127.0.0.1',details:()=>({service:'forged',ready,draining:true,active:99}),close:async()=>{calls++;}});
 try{const port=(service.server.address() as any).port;const response=await fetch(`http://127.0.0.1:${port}/health`);expect(response.status).toBe(503);expect(await response.json()).toMatchObject({service:'controlled-fixture',ready:false,draining:false,active:0});ready=true;expect(service.status.ready).toBe(true);}finally{await service.stop();}expect(calls).toBe(1);
});
it('keeps a failed heartbeat unhealthy after a successful task until the heartbeat recovers',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval']});let fail=true,service:any;
 try{service=await host.startService({name:'controlled-fixture',port:0,host:'127.0.0.1',details:()=>({ready:true}),tick:async()=>{},intervalMs:10000,heartbeat:async()=>{if(fail)throw new Error('controlled');},close:async()=>{}});await vi.advanceTimersByTimeAsync(15000);expect(service.status.ready).toBe(false);await vi.advanceTimersByTimeAsync(5000);expect(service.status.ready).toBe(false);fail=false;await vi.advanceTimersByTimeAsync(10000);expect(service.status.ready).toBe(true);}finally{if(service)await service.stop();vi.useRealTimers();}
});
it('does not let caller details hide a failed task and recovers on the next successful task',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval']});let fail=true,service:any;
 try{service=await host.startService({name:'controlled-fixture',port:0,host:'127.0.0.1',details:()=>({ready:true}),tick:async()=>{if(fail)throw new Error('controlled');},intervalMs:100,close:async()=>{}});await vi.advanceTimersByTimeAsync(1);expect(service.status.ready).toBe(false);fail=false;await vi.advanceTimersByTimeAsync(100);expect(service.status.ready).toBe(true);}finally{if(service)await service.stop();vi.useRealTimers();}
});
it('exposes no private endpoints and waits for an active HTTP request before closing its database',async()=>{
 let release:()=>void=()=>{},begin:()=>void=()=>{};const held=new Promise<void>(r=>release=r),begun=new Promise<void>(r=>begin=r);let closed=false;
 const service=await host.startService({name:'controlled-fixture',port:0,host:'127.0.0.1',handler:async(r:Request)=>{if(new URL(r.url).pathname==='/controlled'){begin();await held;return new Response(closed?'closed-too-early':'completed');}return new Response(null,{status:404});},close:async()=>{closed=true;}});
 const port=(service.server.address() as any).port;const response=fetch(`http://127.0.0.1:${port}/controlled`);await begun;const stopping=service.stop();expect(closed).toBe(false);release();expect(await (await response).text()).toBe('completed');await stopping;expect(closed).toBe(true);
});
it('waits for an accepted HTTP handler even after its client disconnects',async()=>{
 let release:()=>void=()=>{},begin:()=>void=()=>{};const held=new Promise<void>(r=>release=r),begun=new Promise<void>(r=>begin=r);let closed=false;
 const service=await host.startService({name:'controlled-fixture',port:0,host:'127.0.0.1',handler:async()=>{begin();await held;return new Response(closed?'closed-too-early':'completed');},close:async()=>{closed=true;}});
 const port=(service.server.address() as any).port,controller=new AbortController();const response=fetch(`http://127.0.0.1:${port}/controlled`,{signal:controller.signal}).catch(()=>undefined);await begun;controller.abort();await response;const stopping=service.stop();try{await new Promise(r=>setTimeout(r,20));expect(closed).toBe(false);}finally{release();await stopping;}expect(closed).toBe(true);
});

