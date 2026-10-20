import {digest} from './canonical';
import type {EvidenceManifest,ExecutionManifestContext} from '../../contracts/src/manifest';
export const EVIDENCE_VERSIONS=Object.freeze({receipt:'pitlane.receipt.v1',parser:'mint-parser.1',renderer:'readable-json.1',rules:'1',evidence:'two-finalized.1',pricing:'1',refund:'non-delivery-free.1',cost:'reserved-micro-usd.1',codec:'@solana/spl-token@0.4.15'});
const policy=Object.freeze({versions:EVIDENCE_VERSIONS,extensions:['TransferFeeConfig','MintCloseAuthority','MetadataPointer','TokenMetadata'],requiredProviders:2,commitment:'finalized',maximumObservationWindowSeconds:30,maximumSlotSkew:150,nonbillable:['unsupported','insufficient_evidence','failed','expired','cancelled'],maximumExecutionSeconds:180,maximumAttempts:3,maximumCalls:16});
export function makeEvidenceManifest(c:ExecutionManifestContext,build:string):EvidenceManifest{
 if(c.workerBuild!==null&&c.workerBuild!==build)throw new Error('BUILD_IDENTITY_MISMATCH');
 if(!build||build.length>128||c.templateVersion!=='1'||c.pricePolicyVersion!=='1')throw new Error('INCOMPATIBLE_EVIDENCE_MANIFEST');
 return {schema:'pitlane.evidence-manifest.v1',build,tenantId:c.tenantId,projectId:c.projectId,execution:{workerId:c.workerId,verifierId:c.workerId,leaseEpoch:c.leaseEpoch,verification:'same_trusted_deployment'},versions:{...EVIDENCE_VERSIONS},policyHash:digest(policy),quote:{id:c.quoteId,inputsHash:c.quoteInputsHash,priceCents:c.priceCents,asset:'USD',scale:2,policyVersion:c.pricePolicyVersion},costs:{asset:'USD',scale:6,maximumMicro:c.costCapMicro,reservedMicro:c.costReservedMicro,calls:c.costCalls,intents:c.costIntents,classification:'estimated_or_uncertain'}};
}
export function verifyEvidenceManifest(value:unknown,c:ExecutionManifestContext):boolean{
 try{const build=c.workerBuild??(value as EvidenceManifest)?.build;if(typeof build!=='string')return false;return digest(value)===digest(makeEvidenceManifest(c,build));}catch{return false;}
}
