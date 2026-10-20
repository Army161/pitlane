import {it,expect} from 'vitest';
import type {ExecutionManifestContext} from '../../packages/contracts/src/manifest';
import {makeEvidenceManifest,verifyEvidenceManifest} from '../../packages/evidence/src/manifest';
const context:ExecutionManifestContext={tenantId:'tenant',projectId:'project',jobId:'job',workerId:'actual-worker',workerBuild:'a'.repeat(40),leaseEpoch:'2',templateId:'solana.mint_configuration',templateVersion:'1',quoteId:'quote',quoteInputsHash:'b'.repeat(64),priceCents:'400',pricePolicyVersion:'1',costCapMicro:'1000000',costReservedMicro:'250',costCalls:1,costIntents:[{id:'intent',providerId:'provider-a',method:'getSlot',maximumMicro:'250',status:'uncertain',responseBytes:null}]};
it('binds worker identity, accepted price and unresolved cost exposure without inventing settlement',()=>{
 const manifest=makeEvidenceManifest(context,'a'.repeat(40));
 expect(manifest.execution).toEqual({workerId:'actual-worker',verifierId:'actual-worker',leaseEpoch:'2',verification:'same_trusted_deployment'});
 expect(manifest.quote.priceCents).toBe('400');expect(manifest.costs.reservedMicro).toBe('250');expect(manifest.costs.intents[0].status).toBe('uncertain');
 expect(verifyEvidenceManifest(manifest,context)).toBe(true);
});
it('rejects forged worker build, price, lease and version claims',()=>{
 const manifest=makeEvidenceManifest(context,'a'.repeat(40));
 for(const altered of [{...manifest,build:'c'.repeat(40)},{...manifest,quote:{...manifest.quote,priceCents:'0'}},{...manifest,execution:{...manifest.execution,leaseEpoch:'3'}},{...manifest,versions:{...manifest.versions,parser:'invented'}}])expect(verifyEvidenceManifest(altered,context)).toBe(false);
 expect(()=>makeEvidenceManifest(context,'c'.repeat(40))).toThrow('BUILD_IDENTITY_MISMATCH');
});
