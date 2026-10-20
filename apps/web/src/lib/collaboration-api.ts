import {z} from 'zod';
import type {Actor} from '../../../../packages/contracts/src';
import type {Collaboration} from '../../../../packages/core/src/collaboration';

const uuid=z.string().uuid();
const page=(url:URL)=>({limit:z.coerce.number().int().min(1).max(50).parse(url.searchParams.get('limit')??25),before:url.searchParams.get('before')??undefined});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
export async function collaborationRoute(request:Request,actor:Actor,service:Collaboration,body:()=>Promise<unknown>):Promise<Response|null>{
 const url=new URL(request.url),method=request.method;
 const match=/^\/v1\/projects\/([0-9a-f-]{36})\/(conversations|sprints|work-items|collaboration)(?:\/([0-9a-f-]{36}))?(?:\/(messages|members))?$/.exec(url.pathname);
 if(!match)return null;
 const projectId=uuid.parse(match[1]),area=match[2],id=match[3]?uuid.parse(match[3]):undefined,sub=match[4];
 const key=()=>z.string().min(16).max(128).parse(request.headers.get('idempotency-key'));
 if(area==='collaboration'&&method==='GET'&&!id){const members=await service.listMembers(actor,projectId);return json({availability:service.availability(),members});}
 if(area==='conversations'){
  if(!id&&method==='GET')return json(await service.listConversations(actor,projectId,page(url)));
  if(!id&&method==='POST'){const v=z.object({title:z.string().trim().min(1).max(128)}).strict().parse(await body());return json(await service.createConversation(actor,projectId,v.title),201);}
  if(id&&sub==='messages'&&method==='GET')return json(await service.listMessages(actor,projectId,id,page(url)));
  if(id&&sub==='messages'&&method==='POST'){const v=z.object({content:z.string().min(1).max(4000),receiptVersionIds:z.array(uuid).max(5).optional(),workItemIds:z.array(uuid).max(5).optional()}).strict().parse(await body());return json(await service.sendMessage(actor,projectId,id,v,key()),201);}
  if(id&&!sub&&method==='POST'){const v=z.object({title:z.string().trim().min(1).max(128),expectedVersion:z.number().int().positive()}).strict().parse(await body());return json(await service.updateConversation(actor,projectId,id,v));}
 }
 const sprint=z.object({title:z.string().trim().min(1).max(128),goal:z.string().max(2000).optional(),startsAt:z.iso.datetime().nullable().optional(),endsAt:z.iso.datetime().nullable().optional(),state:z.enum(['planned','active','completed','cancelled']).optional()});
 if(area==='sprints'){
  if(!id&&method==='GET')return json(await service.listSprints(actor,projectId,page(url)));
  if(!id&&method==='POST')return json(await service.createSprint(actor,projectId,sprint.strict().parse(await body()),key()),201);
  if(id&&!sub&&method==='POST')return json(await service.updateSprint(actor,projectId,id,sprint.partial().extend({expectedVersion:z.number().int().positive()}).strict().parse(await body()),key()));
 }
 const work=z.object({title:z.string().trim().min(1).max(128),description:z.string().max(4000).optional(),state:z.enum(['todo','in_progress','blocked','done']).optional(),assigneeId:uuid.nullable().optional(),sprintId:uuid.nullable().optional(),receiptVersionIds:z.array(uuid).max(5).optional()});
 if(area==='work-items'){
  if(!id&&method==='GET')return json(await service.listWorkItems(actor,projectId,page(url)));
  if(!id&&method==='POST')return json(await service.createWorkItem(actor,projectId,work.strict().parse(await body()),key()),201);
  if(id&&!sub&&method==='POST')return json(await service.updateWorkItem(actor,projectId,id,work.partial().extend({expectedVersion:z.number().int().positive()}).strict().parse(await body()),key()));
 }
 return json({code:'NOT_FOUND'},404);
}
