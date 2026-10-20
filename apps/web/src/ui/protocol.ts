import type {Receipt,JobInput} from '../../../../packages/contracts/src/domain';
export type {Receipt,JobInput};
export interface Account {user_id:string;tenant_id:string|null;tenants:{id:string;name:string;role:string}[];csrf:string;mode:string;origin:string;billing:string;can_admin:boolean;can_billing:boolean;is_operator:boolean}
export interface Project {id:string;name:string;can_write:boolean;can_admin:boolean}
export type DataRow=Record<string,any>;
export type Call=<T=DataRow>(path:string,body?:unknown,options?:{method?:string;key?:string})=>Promise<T>;
export interface ScreenProps {account:Account;project:Project;call:Call;act:(task:()=>Promise<void>)=>Promise<void>;busy:boolean;notify:(message:string)=>void}
export const text=(value:unknown):string=>(typeof value==='string'?value:JSON.stringify(value,null,2)??'null').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
export const date=(value:unknown)=>value?new Date(String(value)).toLocaleString():'Not recorded';
export function usd(base:string|number,scale=2){const value=BigInt(base);const factor=10n**BigInt(scale);return '$'+(value/factor).toString()+'.'+(value%factor).toString().padStart(scale,'0');}
export const messages:Record<string,string>={
 EVIDENCE_EXPIRED:'This evidence has expired. Its scoped digest remains as an audit record; the original content is no longer available.',VERSION_CONFLICT:'This record changed. Refresh it before applying your update.',INVALID_PAGE:'This history cursor is invalid. Reload the list.',
 UNAUTHENTICATED:'Your session ended. Sign in again.',NOT_FOUND:'This record is unavailable in the current workspace.',
 QUOTA_EXHAUSTED:'No active units are available. Check Treasury or ask your workspace owner.',
 ACTIVE_LIMIT:'Two inspections are already active in this project. Wait for a bay to finish.',
 QUOTE_EXPIRED:'This quote expired. Get a new quote before submitting.',INVALID_ADDRESS:'Enter a complete base58 mint address that decodes to 32 bytes.',
 UNSUPPORTED_SCOPE:'This input is outside the published template coverage. No unit was consumed.',
 INVALID_INPUT:'Check the declared inputs. A field is missing or outside its allowed range.',
 COST_BUDGET_EXHAUSTED:'The configured cost budget is exhausted. Ask your workspace owner.',
 BILLING_DISABLED:'Payments are disabled in this environment.',LAST_OWNER:'Keep at least one active workspace owner.',
 REGISTERED_USER_REQUIRED:'The user must sign in before you add their ID.',CSRF_REQUIRED:'Refresh this page and retry from the same site.',
 SERVICE_UNAVAILABLE:'The service is unavailable. Retry shortly; retain your submission key.',
 REFUND_EXCEEDS_SETTLEMENT:'The refund exceeds the amount available after confirmed and pending refunds.'
};
