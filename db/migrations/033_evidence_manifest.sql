CREATE OR REPLACE FUNCTION pitlane.execution_manifest_context(j uuid,w text,e bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE job jsonb;quote pitlane.quotes;crew pitlane.workers;mode text;
BEGIN
 job=pitlane.leased_job(j,w,e);
 SELECT * INTO quote FROM pitlane.quotes WHERE id=(job->>'quote_id')::uuid;
 SELECT * INTO crew FROM pitlane.workers WHERE id=w;
 SELECT runtime.mode INTO mode FROM pitlane.runtime;
 IF mode<>'local' AND (crew.id IS NULL OR crew.build IS NULL OR crew.build!~'^(?:[0-9a-f]{40}|[0-9a-f]{64})$') THEN RAISE EXCEPTION 'HOSTED_BUILD_REQUIRED';END IF;
 RETURN jsonb_build_object('tenantId',job->>'tenant_id','projectId',job->>'project_id','jobId',j,'workerId',w,'workerBuild',crew.build,'leaseEpoch',e::text,
 'templateId',job->'input'->>'templateId','templateVersion',job->'input'->>'templateVersion','quoteId',quote.id,'quoteInputsHash',quote.inputs_hash,'priceCents',quote.price_cents::text,'pricePolicyVersion',quote.policy_version,
 'costCapMicro',job->>'cost_cap','costReservedMicro',job->>'cost_used','costCalls',(job->>'calls')::integer,
 'costIntents',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'providerId',provider_id,'method',method,'maximumMicro',maximum_micro::text,'status',status,'responseBytes',response_bytes) ORDER BY created_at,id),'[]') FROM pitlane.cost_intents WHERE job_id=j));
END $$;
CREATE OR REPLACE FUNCTION pitlane.artifact_evidence_context(j uuid,w text,e bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE v jsonb;source jsonb;source_job uuid;
BEGIN
 v=pitlane.leased_job(j,w,e);source_job=j;
 IF v->>'correction_version_id' IS NOT NULL THEN
  SELECT payload,job_id INTO source,source_job FROM pitlane.receipt_versions WHERE id=(v->>'correction_version_id')::uuid;
 END IF;
 RETURN jsonb_build_object('job',v,'mode',(SELECT mode FROM pitlane.runtime),'original',source,
 'manifestContext',pitlane.execution_manifest_context(j,w,e),
 'sources',(SELECT coalesce(jsonb_agg(to_jsonb(o)),'[]') FROM pitlane.gateway_observations o WHERE o.job_id=source_job));
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.execution_manifest_context(uuid,text,bigint) TO pitlane_worker,pitlane_artifact;
GRANT EXECUTE ON FUNCTION pitlane.artifact_evidence_context(uuid,text,bigint) TO pitlane_artifact;
