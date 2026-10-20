/** Project collaboration contracts. Import this file directly; no shared port changes. */
export type AiRequestStatus = 'unavailable'|'capped'|'running'|'completed'|'failed'|'uncertain';
export type SprintState = 'planned'|'active'|'completed'|'cancelled';
export type WorkState = 'todo'|'in_progress'|'blocked'|'done';
export interface CollaborationPage {limit?:number;before?:string}
export interface EvidenceLinks {receiptVersionIds?:string[];workItemIds?:string[]}
export interface Conversation {id:string;tenantId:string;projectId:string;title:string;createdBy:string;createdAt:string;updatedAt:string;version:number}
export interface AiUsage {inputTokens:number;outputTokens:number;totalTokens:number}
export interface AiRequest {id:string;messageId:string;status:AiRequestStatus;provider:string|null;model:string|null;origin:'openai'|'fixture'|null;reason:string|null;providerResponseId:string|null;httpStatus:number|null;providerStatus:string|null;usage:AiUsage|null;costMicro:string|null;reservedTokens:number;reservedCostMicro:string;createdAt:string;finishedAt:string|null}
export interface CollaborationMessage {id:string;tenantId:string;projectId:string;conversationId:string;authorId:string|null;role:'user'|'assistant';origin:'user'|'openai'|'fixture';content:string;replyToMessageId:string|null;createdAt:string;receiptVersionIds:string[];workItemIds:string[];request:AiRequest|null}
export interface SendMessageInput extends EvidenceLinks {content:string}
export interface SendMessageResult {message:CollaborationMessage;reply:CollaborationMessage|null;request:AiRequest}
export interface SprintInput {title:string;goal?:string;startsAt?:string|null;endsAt?:string|null;state?:SprintState}
export interface Sprint extends Required<SprintInput> {id:string;tenantId:string;projectId:string;createdBy:string;updatedBy:string;createdAt:string;updatedAt:string;version:number}
export interface SprintUpdate extends Partial<SprintInput> {expectedVersion:number}
export interface WorkItemInput {title:string;description?:string;state?:WorkState;assigneeId?:string|null;sprintId?:string|null;receiptVersionIds?:string[]}
export interface WorkItem extends Required<WorkItemInput> {id:string;tenantId:string;projectId:string;createdBy:string;updatedBy:string;createdAt:string;updatedAt:string;version:number}
export interface WorkItemUpdate extends Partial<WorkItemInput> {expectedVersion:number}
export interface ProjectMember {userId:string;tenantRole:string;projectRole:string|null;canWrite:boolean}
export interface AiAllowance {dailyRequests:number;dailyTokens:number;dailyCostMicro:string;inputMicroPerMillion:string;outputMicroPerMillion:string}
export interface AiAvailability {available:boolean;provider:string|null;model:string|null;origin:'openai'|'fixture'|null;reason:string|null}
export interface AiChatInput {requestId:string;context:string;maxOutputTokens:number}
export interface AiChatOutput {responseId:string;content:string;usage:AiUsage;httpStatus?:number;providerStatus?:'completed'}
/** Fixture providers are accepted only under NODE_ENV=test and local DB runtime. */
export interface AiChatPort {readonly provider:'openai'|'fixture';readonly model:string;readonly origin:'openai'|'fixture';readonly maxOutputTokens:number;respond(input:AiChatInput):Promise<AiChatOutput>}
export const AI_LIMITS = Object.freeze({messageBytes:4000,responseBytes:8000,contextBytes:16000,contextMessages:8,maxOutputTokens:2048,pageSize:50,links:5,timeoutMs:20000,httpResponseBytes:131072});
/** No provider error text is exposed or persisted; only these safe status codes. */
export class AiProviderError extends Error {
 constructor(readonly code:'PROVIDER_REJECTED'|'PROVIDER_UNCERTAIN'|'INVALID_PROVIDER_RESPONSE'|'RESPONSE_LIMIT',readonly uncertain:boolean,readonly usage:AiUsage|null=null,readonly responseId:string|null=null,readonly httpStatus:number|null=null,readonly providerStatus:string|null=null){super(code);this.name='AiProviderError'}
}
