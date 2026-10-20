export interface ExecutionManifestContext {
 tenantId:string;projectId:string;jobId:string;workerId:string;workerBuild:string|null;leaseEpoch:string;
 templateId:string;templateVersion:string;quoteId:string;quoteInputsHash:string;priceCents:string;pricePolicyVersion:string;
 costCapMicro:string;costReservedMicro:string;costCalls:number;
 costIntents:{id:string;providerId:string;method:string;maximumMicro:string;status:string;responseBytes:number|null}[];
}
export interface EvidenceManifest {
 schema:'pitlane.evidence-manifest.v1';build:string;tenantId:string;projectId:string;
 execution:{workerId:string;verifierId:string;leaseEpoch:string;verification:'same_trusted_deployment'};
 versions:{receipt:string;parser:string;renderer:string;rules:string;evidence:string;pricing:string;refund:string;cost:string;codec:string};
 policyHash:string;quote:{id:string;inputsHash:string;priceCents:string;asset:'USD';scale:2;policyVersion:string};
 costs:{asset:'USD';scale:6;maximumMicro:string;reservedMicro:string;calls:number;intents:ExecutionManifestContext['costIntents'];classification:'estimated_or_uncertain'};
}
