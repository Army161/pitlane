import type {EvidenceManifest} from './manifest';
export type Result<T> = {ok:true;value:T}|{ok:false;code:string;message:string};
export type Network = 'devnet'|'mainnet-beta';
export type Finding = 'supported'|'contradicted'|'insufficient_evidence';
export type ExecutionState = 'awaiting_payment'|'queued'|'running'|'verifying'|'retry_wait'|'completed'|'unsupported'|'failed'|'expired'|'cancelled';
export interface Actor {userId:string;tenantId:string}
export interface Scope {tenantId:string;projectId:string}
export interface Money {asset:'USD';scale:2|6;baseUnits:string}
export interface Predicate {id:string;path:string;op:'eq'|'absent'|'fee_caps'|'extensions';value:string|number|null|string[]|{basisPoints:number;maximumFee:string}|{required:string[];forbidden:string[];accepted:string[]}}
export interface JobInput {projectId:string;templateId:'solana.mint_configuration'|'solana.integration_expectations';templateVersion:string;network:Network;mint:string;expectations:Predicate[]}
export interface Quote {id:string;scope:Scope;input:JobInput;inputsHash:string;expiresAt:string;units:number;price:Money;policyVersion:string}
export interface Job {id:string;tenantId:string;projectId:string;input:JobInput;state:ExecutionState;origin:'fixture'|'internal'|'customer';deadline:string;leaseEpoch:number;attempts:number;receiptId:string|null;createdAt:string;correction?:{receiptId:string;versionId:string;reason:string;observations:Observation[]}}
export interface Lease {jobId:string;workerId:string;epoch:number;expiresAt:string}
export interface TokenMetadata {mint:string;updateAuthority:string|null;name:string;symbol:string;uri:string;additional:[string,string][]}
export interface FeeSchedule {epoch:string;basisPoints:number;maximumFee:string}
export interface DecodedMint {mint:string;program:string;initialized:true;decimals:number;supply:string;mintAuthority:string|null;freezeAuthority:string|null;extensions:string[];closeAuthority?:string|null;metadataPointer?:{authority:string|null;address:string|null};metadata?:TokenMetadata;transferFee?:{authority:string|null;withdrawAuthority:string|null;withheldAmount:string;older:FeeSchedule;newer:FeeSchedule}}
export interface Observation {providerId:string;upstreamId:string;network:Network;genesis:string;slot:string;acquiredAt:string;commitment:'finalized';rawHash:string;rawBody?:string;reads?:{method:RpcMethod;rawBody:string;sha256:string}[];mint:DecodedMint;lamports:string}
export interface Projection {fields:Record<string,unknown>;paths:string[];hash:string;informational:Record<string,{status:'agreed'|'varied';values:{providerId:string;value:unknown}[]}>;observations:Observation[];limitations:string[]}
export interface Assertion {id:string;path:string;state:Finding;reason:string;expected:unknown;observed:unknown;evidence:string[]}
export interface ArtifactManifest {id:string;key:string;sha256:string;bytes:number;contentType:string;state:'published';expiresAt:string}
export interface Receipt {schema:'pitlane.receipt.v1';id:string;versionId:string;jobId:string;executionState:'completed'|'unsupported';input:JobInput;finding:Finding;assertions:Assertion[];observations:Observation[];projection:Projection|null;limitations:string[];issuedAt:string;ruleVersion:string;origin:'fixture'|'internal'|'customer';supersedesReceiptId?:string;supersedesVersionId?:string;correctionReason?:string;evidenceManifest?:EvidenceManifest}
export type PaymentState = 'awaiting_authorization'|'authorized'|'delivered_pending_capture'|'pending_reconciliation'|'settled'|'cancelled'|'authorization_expired'|'collection_failed'|'refunded';
export interface Order {id:string;tenantId:string;projectId:string;kind:'unit'|'pilot';state:PaymentState;amount:Money;providerId:string|null;captureBefore:string|null;deliveredVersionId:string|null}
export interface Clock {now():Date}
export interface Tx {query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[];rowCount:number|null}>}
export interface Db {transaction<T>(fn:(tx:Tx)=>Promise<T>,actor?:Actor):Promise<T>;query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[];rowCount:number|null}>}
export type RpcMethod = 'getGenesisHash'|'getAccountInfo'|'getSlot'|'getBlockTime';
export interface RpcPort {read(providerId:string,method:RpcMethod,params:unknown[],signal?:AbortSignal):Promise<unknown>}
export interface StoragePort {put(key:string,bytes:Uint8Array,contentType:string):Promise<void>;get(key:string):Promise<Uint8Array>;remove(key:string):Promise<void>}
export interface AuthPort {verify(token:string):Promise<{userId:string}>}
export interface BillingPort {authorize(order:Order,key:string):Promise<{state:'authorized';providerId:string;captureBefore:string;amount:string}|{state:'requires_customer_action';checkoutId:string;url:string}>;capture(providerId:string,amount:string,key:string):Promise<PaymentState>;cancel(providerId:string,key:string):Promise<void>;cancelCheckout?(checkoutId:string,key:string):Promise<void>;retrieve(providerId:string):Promise<{state:PaymentState;amount:string;captureBefore:string|null}>;refund(providerId:string,amount:string,key:string):Promise<'settled'|'pending_reconciliation'|'failed'>}
export interface RuntimeConfig {mode:'local'|'staging'|'production';authMode:'fixture'|'supabase';storageMode:'local'|'supabase';rpcMode:'fixture'|'gateway';billingMode:'disabled'|'sandbox'|'live';environmentId:string;expectedProjectId?:string;egressVerified:boolean}
