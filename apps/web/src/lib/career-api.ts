import type {Actor,Db} from '../../../../packages/contracts/src';
import {Career} from '../../../../packages/core/src/career';
export async function careerRoute(request:Request,actor:Actor,db:Db,body:()=>Promise<unknown>):Promise<Response|null>{
 const path=new URL(request.url).pathname;if(!/^\/v1\/career(?:\/(?:milestones|profile))?$/.test(path))return null;
 const service=new Career(db);let value:unknown;
 if(path==='/v1/career'&&request.method==='GET')value=await service.state(actor);
 else if(path==='/v1/career/milestones'&&request.method==='POST')value=await service.complete(actor,await body());
 else if(path==='/v1/career/profile'&&request.method==='POST')value=await service.profile(actor,await body());
 else return new Response(JSON.stringify({code:'NOT_FOUND'}),{status:404,headers:{'content-type':'application/json','cache-control':'no-store'}});
 return new Response(JSON.stringify(value),{headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
}
