import {pathToFileURL} from 'node:url';
import {once} from 'node:events';
import {serveHttp} from './http-server';

interface ServiceOptions {
 name:string;port:number;host:string;tick?:()=>Promise<unknown>;intervalMs?:number;
 heartbeat?:()=>Promise<unknown>;handler?:(request:Request)=>Promise<Response>;
 close:()=>Promise<void>;details?:()=>Record<string,unknown>;
}
export async function startService(options:ServiceOptions){
 if(!Number.isInteger(options.port)||options.port<0||options.port>65535)throw new Error('INVALID_SERVICE_PORT');
 let draining=false,taskHealthy=true,heartbeatHealthy=true,active:Promise<void>|undefined,pulse:Promise<void>|undefined,stopping:Promise<void>|undefined,lastSuccessAt:string|undefined;
 const requests=new Set<Promise<void>>();
 const status=()=>{const details=options.details?.()??{};return {...details,service:options.name,ready:taskHealthy&&heartbeatHealthy&&!draining&&details.ready!==false,draining,active:active?1:0,lastSuccessAt};};
 const server=serveHttp(async request=>{
  if(new URL(request.url).pathname==='/health'&&request.method==='GET'){const health=status();return new Response(JSON.stringify(health),{status:health.ready?200:503,headers:{'content-type':'application/json','cache-control':'no-store'}});}
  if(draining)return new Response(null,{status:503});
  if(!options.handler)return new Response(null,{status:404});
  const response=Promise.resolve().then(()=>options.handler!(request));
  const finished=response.then(()=>{},()=>{});requests.add(finished);
  try{return await response;}finally{requests.delete(finished);}
 },options.port,options.host);
 await once(server,'listening');
 const run=()=>{
  if(draining||active||!options.tick)return;
  active=(async()=>{try{await options.tick!();taskHealthy=true;lastSuccessAt=new Date().toISOString();}catch{taskHealthy=false;process.stderr.write(`PITLANE ${options.name} task interrupted; durable recovery applies.\n`);}finally{active=undefined;}})();
 };
 const beat=()=>{
  if(draining||pulse||!options.heartbeat)return;
  pulse=(async()=>{try{await options.heartbeat!();heartbeatHealthy=true;}catch{heartbeatHealthy=false;}finally{pulse=undefined;}})();
 };
 const timer=options.tick?setInterval(run,options.intervalMs??1000):undefined;
 const heartbeat=options.heartbeat?setInterval(beat,15000):undefined;
 const first=options.tick?setTimeout(run,0):undefined;
 const stop=()=>stopping??=(async()=>{
  draining=true;clearInterval(timer);clearInterval(heartbeat);clearTimeout(first);
  const closed=new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  server.closeIdleConnections();
  const force=setTimeout(()=>server.closeAllConnections(),15000);force.unref();
  try{await Promise.all([active,pulse,closed,...requests]);await options.close();}finally{clearTimeout(force);}
 })();
 return {server,stop,get status(){return status();}};
}
export function isEntrypoint(url:string){return !!process.argv[1]&&url===pathToFileURL(process.argv[1]).href;}
export function installShutdown(service:Awaited<ReturnType<typeof startService>>,mode:string){
 let stopping=false;
 const stop=()=>{if(stopping)return;stopping=true;void service.stop().then(()=>{process.exitCode=0;if(process.connected)process.disconnect?.();}).catch(()=>{process.exitCode=1;if(process.connected)process.disconnect?.();});};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 // Isolated local process tests use private parent/child IPC. No HTTP control route exists.
 if(mode==='local'&&process.send&&process.env.PITLANE_TEST_CONTROL_TOKEN)process.on('message',message=>{
  if(message&&typeof message==='object'&&'type' in message&&message.type==='drain'&&'token' in message&&message.token===process.env.PITLANE_TEST_CONTROL_TOKEN)stop();
 });
 process.stdout.write(JSON.stringify({event:'listening',service:service.status.service,port:(service.server.address() as {port:number}).port,mode})+'\n');
}
