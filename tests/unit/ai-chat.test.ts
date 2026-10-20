import {afterEach,expect,it,vi} from 'vitest';
import {AI_LIMITS,AiProviderError} from '../../packages/contracts/src/collaboration';
const m=await import('../../packages/adapters/src/ai-chat').catch(()=>({}));
const configuration={mode:'openai',apiKey:'test-key-no-provider-access',model:'explicit-test-model',maxOutputTokens:100,timeoutMs:100};
const input={requestId:'10000000-0000-4000-8000-000000000001',context:'Permitted bounded fixture context',maxOutputTokens:100};
const response=()=>({id:'resp_fixture_http',status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'An explanation from the HTTP fixture.'}]}],usage:{input_tokens:12,output_tokens:8,total_tokens:20}});
afterEach(()=>vi.restoreAllMocks());
it('requires explicit provider mode and valid credentials/model without returning sensitive configuration',()=>{
 expect((m as any).createAiChat({}).availability).toMatchObject({available:false,reason:'AI_UNAVAILABLE'});
 expect((m as any).createAiChat({mode:'fixture'}).availability.available).toBe(false);
 expect((m as any).createAiChat({...configuration,baseUrl:'https://attacker.example'}).availability.available).toBe(false);
 const configured=(m as any).createAiChat(configuration);expect(configured.availability).toMatchObject({available:true,provider:'openai',model:'explicit-test-model'});expect(JSON.stringify(configured.availability)).not.toContain(configuration.apiKey);
});
it('calls only the fixed official Responses endpoint, has no tools or stored conversation and parses measured usage',async()=>{
 const http=vi.fn(async(url:unknown,options:any)=>{expect(url).toBe('https://api.openai.com/v1/responses');expect(options.redirect).toBe('error');const body=JSON.parse(options.body);expect(body).toMatchObject({model:configuration.model,store:false,background:false,stream:false,max_output_tokens:100});expect(body.tools).toBeUndefined();expect(body.previous_response_id).toBeUndefined();return new Response(JSON.stringify(response()),{status:200})});
 const adapter=new (m as any).OpenAiChat(configuration,http);expect(await adapter.respond(input)).toMatchObject({responseId:'resp_fixture_http',content:'An explanation from the HTTP fixture.',usage:{inputTokens:12,outputTokens:8,totalTokens:20}});expect(http).toHaveBeenCalledOnce();
});
it('distinguishes rejected and uncertain provider calls without persisting raw errors or retrying',async()=>{
 const rejected=vi.fn(async()=>new Response('secret error detail test-key-no-provider-access',{status:401}));const adapter=new (m as any).OpenAiChat(configuration,rejected);await expect(adapter.respond(input)).rejects.toMatchObject({code:'PROVIDER_REJECTED',uncertain:false});expect(rejected).toHaveBeenCalledOnce();
 const lost=vi.fn(async()=>{throw new Error('sensitive network details')});await expect(new (m as any).OpenAiChat(configuration,lost).respond(input)).rejects.toMatchObject({code:'PROVIDER_UNCERTAIN',uncertain:true});expect(lost).toHaveBeenCalledOnce();
});
it('caps response bodies, input contexts and deadlines even when a fixture fetch ignores abort',async()=>{
 const tooLarge=vi.fn(async()=>new Response('x'.repeat(AI_LIMITS.httpResponseBytes+1)));await expect(new (m as any).OpenAiChat(configuration,tooLarge).respond(input)).rejects.toMatchObject({code:'RESPONSE_LIMIT'});
 const never=vi.fn(()=>new Promise<Response>(()=>{}));await expect(new (m as any).OpenAiChat({...configuration,timeoutMs:25},never).respond(input)).rejects.toMatchObject({code:'PROVIDER_UNCERTAIN'});
 await expect(new (m as any).OpenAiChat(configuration,tooLarge).respond({...input,context:'x'.repeat(AI_LIMITS.contextBytes+1)})).rejects.toThrow('INVALID_INPUT');expect(tooLarge).toHaveBeenCalledOnce();
});
it('does not accept tool output, malformed usage or incomplete content as an explanation',async()=>{
 const tool={...response(),output:[{type:'function_call',name:'transfer',arguments:'{}'}]};await expect(new (m as any).OpenAiChat(configuration,async()=>new Response(JSON.stringify(tool))).respond(input)).rejects.toBeInstanceOf(AiProviderError);
 const incomplete={...response(),status:'incomplete'};await expect(new (m as any).OpenAiChat(configuration,async()=>new Response(JSON.stringify(incomplete))).respond(input)).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE',usage:{inputTokens:12,outputTokens:8,totalTokens:20}});
 const malformed={...response(),usage:{input_tokens:1,output_tokens:1,total_tokens:9}};await expect(new (m as any).OpenAiChat(configuration,async()=>new Response(JSON.stringify(malformed))).respond(input)).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE'});
});
