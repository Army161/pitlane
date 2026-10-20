import {z} from 'zod';
import {AI_LIMITS,AiProviderError,type AiAvailability,type AiChatInput,type AiChatOutput,type AiChatPort,type AiUsage} from '../../contracts/src/collaboration';

const optionsSchema=z.object({mode:z.literal('openai'),apiKey:z.string().min(12).max(512).regex(/^[A-Za-z0-9._-]+$/),model:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),maxOutputTokens:z.number().int().min(16).max(AI_LIMITS.maxOutputTokens).default(1024),timeoutMs:z.number().int().min(25).max(AI_LIMITS.timeoutMs).default(AI_LIMITS.timeoutMs)}).strict();
export interface OpenAiChatConfiguration {mode:'openai';apiKey:string;model:string;maxOutputTokens?:number;timeoutMs?:number}
const inputSchema=z.object({requestId:z.string().uuid(),context:z.string().min(1).refine(v=>Buffer.byteLength(v)<=AI_LIMITS.contextBytes),maxOutputTokens:z.number().int().min(16).max(AI_LIMITS.maxOutputTokens)}).strict();
const usageSchema=z.object({input_tokens:z.number().int().min(0).max(100000000),output_tokens:z.number().int().min(0).max(100000000),total_tokens:z.number().int().min(0).max(100000000)}).refine(v=>v.total_tokens===v.input_tokens+v.output_tokens);
const responseSchema=z.object({id:z.string().min(1).max(200),status:z.string(),usage:usageSchema,output:z.array(z.record(z.string(),z.unknown())).max(32)});
const endpoint='https://api.openai.com/v1/responses';

/** Native HTTP only, fixed endpoint, no retries, tools, provider-side conversation, or error bodies. */
export class OpenAiChat implements AiChatPort {
 readonly provider='openai' as const;readonly origin='openai' as const;readonly model:string;readonly maxOutputTokens:number;
 #apiKey:string;#timeoutMs:number;#fetch:typeof fetch;
 constructor(configuration:OpenAiChatConfiguration,testFetch?:typeof fetch){
  const parsed=optionsSchema.safeParse(configuration);if(!parsed.success||testFetch&&process.env.NODE_ENV!=='test')throw new Error('INVALID_AI_CONFIGURATION');
  this.model=parsed.data.model;this.maxOutputTokens=parsed.data.maxOutputTokens;this.#apiKey=parsed.data.apiKey;this.#timeoutMs=parsed.data.timeoutMs;this.#fetch=testFetch??fetch;
 }
 async respond(input:AiChatInput):Promise<AiChatOutput>{
  const parsed=inputSchema.safeParse(input);if(!parsed.success||input.maxOutputTokens>this.maxOutputTokens)throw new Error('INVALID_INPUT');
  const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   return await Promise.race([this.request(parsed.data,abort.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new AiProviderError('PROVIDER_UNCERTAIN',true))},this.#timeoutMs);timer.unref()})]);
  }catch(error){if(error instanceof AiProviderError)throw error;throw new AiProviderError('PROVIDER_UNCERTAIN',true)}finally{clearTimeout(timer);abort.abort()}
 }
 private async request(input:AiChatInput,signal:AbortSignal):Promise<AiChatOutput>{
  const response=await this.#fetch(endpoint,{method:'POST',redirect:'error',cache:'no-store',credentials:'omit',signal,headers:{Authorization:'Bearer '+this.#apiKey,'Content-Type':'application/json','X-Client-Request-Id':input.requestId},body:JSON.stringify({model:this.model,input:[{role:'user',content:[{type:'input_text',text:input.context}]}],max_output_tokens:input.maxOutputTokens,store:false,background:false,stream:false})});
  if(!response.ok){await response.body?.cancel();throw new AiProviderError(response.status>=500||response.status===408?'PROVIDER_UNCERTAIN':'PROVIDER_REJECTED',response.status>=500||response.status===408,null,null,response.status)}
  const declared=response.headers.get('content-length');if(declared&&(!/^\d+$/.test(declared)||Number(declared)>AI_LIMITS.httpResponseBytes)){await response.body?.cancel();throw new AiProviderError('RESPONSE_LIMIT',true,null,null,response.status)}
  const reader=response.body?.getReader();if(!reader)throw new AiProviderError('INVALID_PROVIDER_RESPONSE',true,null,null,response.status);
  const chunks:Uint8Array[]=[];let bytes=0;
  try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>AI_LIMITS.httpResponseBytes){await reader.cancel();throw new AiProviderError('RESPONSE_LIMIT',true,null,null,response.status)}chunks.push(part.value)}}finally{reader.releaseLock()}
  let source:unknown;try{source=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new AiProviderError('INVALID_PROVIDER_RESPONSE',true,null,null,response.status)}
  const result=responseSchema.safeParse(source);if(!result.success)throw new AiProviderError('INVALID_PROVIDER_RESPONSE',true,null,null,response.status);
  const raw=result.data;const usage:AiUsage={inputTokens:raw.usage.input_tokens,outputTokens:raw.usage.output_tokens,totalTokens:raw.usage.total_tokens};
  const providerStatus=['completed','incomplete','failed','cancelled','queued','in_progress'].includes(raw.status)?raw.status:'unknown';
  if(raw.status!=='completed'||raw.output.some(item=>!['message','reasoning'].includes(String(item.type))))throw new AiProviderError('INVALID_PROVIDER_RESPONSE',true,usage,raw.id,response.status,providerStatus);
  let content='';
  for(const item of raw.output){
   if(item.type==='reasoning')continue;
   if(item.role!=='assistant'||item.status!=='completed'||!Array.isArray(item.content))throw new AiProviderError('INVALID_PROVIDER_RESPONSE',true,usage,raw.id,response.status,providerStatus);
   for(const part of item.content){
    if(!part||typeof part!=='object'||part.type!=='output_text'||typeof part.text!=='string')throw new AiProviderError('INVALID_PROVIDER_RESPONSE',false,usage,raw.id,response.status,providerStatus);
    content+=part.text;
   }
  }
  if(!content.trim()||Buffer.byteLength(content)>AI_LIMITS.responseBytes||usage.outputTokens>input.maxOutputTokens||usage.inputTokens>AI_LIMITS.contextBytes)throw new AiProviderError('RESPONSE_LIMIT',true,usage,raw.id,response.status,providerStatus);
  return {responseId:raw.id,content,usage,httpStatus:response.status,providerStatus:'completed'};
 }
}

/** Configuration is explicit. Invalid/absent configuration is an unavailable state, never a fixture fallback. */
export function createAiChat(configuration:unknown):{provider?:OpenAiChat;availability:AiAvailability}{
 const unavailable:AiAvailability={available:false,provider:null,model:null,origin:null,reason:'AI_UNAVAILABLE'};
 if(!configuration||typeof configuration!=='object'||!('mode' in configuration))return {availability:unavailable};
 const result=optionsSchema.safeParse(configuration);if(!result.success)return {availability:{...unavailable,reason:'INVALID_AI_CONFIGURATION'}};
 const provider=new OpenAiChat(result.data);return {provider,availability:{available:true,provider:'openai',model:provider.model,origin:'openai',reason:null}};
}
