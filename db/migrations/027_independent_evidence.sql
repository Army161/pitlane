CREATE TABLE IF NOT EXISTS pitlane.gateway_observations(
 intent_id uuid PRIMARY KEY REFERENCES pitlane.cost_intents(id),
 job_id uuid NOT NULL REFERENCES pitlane.jobs(id), lease_epoch bigint NOT NULL,
 provider_id text NOT NULL, upstream_id text NOT NULL, network text NOT NULL,
 method text NOT NULL, params jsonb NOT NULL, raw_body text NOT NULL,
 raw_hash text NOT NULL CHECK(length(raw_hash)=64), observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE pitlane.cost_intents ADD COLUMN IF NOT EXISTS dispatch_params jsonb;
CREATE OR REPLACE FUNCTION pitlane.rpc_json_source(source text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE bom text=convert_from(decode('efbbbf','hex'),'UTF8');
BEGIN RETURN (CASE WHEN starts_with(source,bom) THEN substr(source,length(bom)+1) ELSE source END)::jsonb;END $$;
CREATE OR REPLACE FUNCTION pitlane.gateway_dispatch_scoped(j uuid,w text,e bigint,intent uuid,p text,m text,params jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE v jsonb;anchor jsonb;
BEGIN
 v=pitlane.leased_job(j,w,e);
 IF m='getAccountInfo' THEN
  IF params->>0 IS DISTINCT FROM v->'input'->>'mint' THEN RAISE EXCEPTION 'WRONG_ACCOUNT_SUBJECT';END IF;
  SELECT pitlane.rpc_json_source(raw_body)->'result' INTO anchor FROM pitlane.gateway_observations WHERE job_id=j AND lease_epoch=e AND provider_id=p AND method='getSlot' ORDER BY observed_at DESC LIMIT 1;
  IF anchor IS NULL OR (params->1->>'minContextSlot')::bigint<>anchor::text::bigint THEN RAISE EXCEPTION 'MISSING_FINALIZED_ANCHOR';END IF;
 ELSIF m='getBlockTime' THEN
  IF NOT EXISTS(SELECT FROM pitlane.gateway_observations WHERE job_id=j AND lease_epoch=e AND provider_id=p AND method='getAccountInfo' AND pitlane.rpc_json_source(raw_body)->'result'->'context'->'slot'=params->0) THEN RAISE EXCEPTION 'WRONG_ACCOUNT_CONTEXT';END IF;
 END IF;
 PERFORM pitlane.gateway_dispatch(j,w,e,intent,p,m);
 UPDATE pitlane.cost_intents SET dispatch_params=params WHERE id=intent;
END $$;
CREATE OR REPLACE FUNCTION pitlane.gateway_record(j uuid,w text,e bigint,intent uuid,body text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE c pitlane.cost_intents;p pitlane.provider_profiles;stamp timestamptz;
BEGIN
 PERFORM pitlane.leased_job(j,w,e);
 SELECT * INTO c FROM pitlane.cost_intents WHERE id=intent AND job_id=j AND lease_epoch=e AND dispatched_at IS NOT NULL AND dispatch_params IS NOT NULL;
 IF NOT FOUND OR octet_length(body)>262144 THEN RAISE EXCEPTION 'INVALID_GATEWAY_SOURCE';END IF;
 SELECT * INTO p FROM pitlane.provider_profiles WHERE id=c.provider_id AND enabled;
 IF NOT FOUND THEN RAISE EXCEPTION 'UNKNOWN_PROVIDER';END IF;
 INSERT INTO pitlane.gateway_observations(intent_id,job_id,lease_epoch,provider_id,upstream_id,network,method,params,raw_body,raw_hash)
 VALUES(intent,j,e,c.provider_id,p.upstream_id,p.network,c.method,c.dispatch_params,body,encode(sha256(convert_to(body,'UTF8')),'hex')) RETURNING observed_at INTO stamp;
 UPDATE pitlane.cost_intents SET status='measured',response_bytes=octet_length(body) WHERE id=intent;
 RETURN stamp;
END $$;
CREATE TABLE IF NOT EXISTS pitlane.artifact_attestations(
 object_key text PRIMARY KEY,job_id uuid NOT NULL REFERENCES pitlane.jobs(id),lease_epoch bigint NOT NULL,
 digest text NOT NULL CHECK(length(digest)=64),bytes bigint NOT NULL CHECK(bytes BETWEEN 1 AND 1048576),
 payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),verified_at timestamptz
);
CREATE OR REPLACE FUNCTION pitlane.artifact_evidence_context(j uuid,w text,e bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE v jsonb;source jsonb;source_job uuid;
BEGIN
 v=pitlane.leased_job(j,w,e);source_job=j;
 IF v->>'correction_version_id' IS NOT NULL THEN
  SELECT payload,job_id INTO source,source_job FROM pitlane.receipt_versions WHERE id=(v->>'correction_version_id')::uuid;
 END IF;
 RETURN jsonb_build_object('job',v,'mode',(SELECT mode FROM pitlane.runtime),'original',source,
 'sources',(SELECT coalesce(jsonb_agg(to_jsonb(o)),'[]') FROM pitlane.gateway_observations o WHERE o.job_id=source_job));
END $$;
CREATE OR REPLACE FUNCTION pitlane.reserve_artifact_publication(j uuid,w text,e bigint,key text,body text,hash text,size bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE v jsonb;parsed jsonb=body::jsonb;
BEGIN
 PERFORM pitlane.lock_job_scope(j);
 v=pitlane.leased_job(j,w,e);
 IF key NOT LIKE format('%s/%s/%s/%s/%%',v->>'tenant_id',v->>'project_id',j,e)
 OR parsed->>'jobId'<>j::text OR parsed->'input' IS DISTINCT FROM v->'input' OR parsed->>'origin' IS DISTINCT FROM v->>'origin'
 OR hash<>encode(sha256(convert_to(body,'UTF8')),'hex') OR size<>octet_length(body) THEN RAISE EXCEPTION 'INVALID_ARTIFACT_ATTESTATION';END IF;
 IF EXISTS(SELECT FROM pitlane.artifact_attestations WHERE object_key=key AND job_id=j AND lease_epoch=e AND digest=hash AND bytes=size AND payload=parsed) THEN RETURN;END IF;
 IF EXISTS(SELECT FROM pitlane.artifact_attestations WHERE job_id=j AND lease_epoch=e) THEN RAISE EXCEPTION 'ARTIFACT_PUBLICATION_LIMIT';END IF;
 INSERT INTO pitlane.artifact_attestations(object_key,job_id,lease_epoch,digest,bytes,payload) VALUES(key,j,e,hash,size,parsed);
END $$;
CREATE OR REPLACE FUNCTION pitlane.attest_artifact(j uuid,w text,e bigint,key text,hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 PERFORM pitlane.leased_job(j,w,e);
 UPDATE pitlane.artifact_attestations SET verified_at=coalesce(verified_at,clock_timestamp()) WHERE object_key=key AND job_id=j AND lease_epoch=e AND digest=hash;
 IF NOT FOUND THEN RAISE EXCEPTION 'MISSING_ARTIFACT_RESERVATION';END IF;
END $$;
DO $$ BEGIN
 IF to_regprocedure('pitlane.register_artifact_unattested(uuid,text,bigint,jsonb)') IS NULL THEN ALTER FUNCTION pitlane.register_artifact(uuid,text,bigint,jsonb) RENAME TO register_artifact_unattested;END IF;
 IF to_regprocedure('pitlane.finalize_unattested(uuid,text,bigint,jsonb,uuid)') IS NULL THEN ALTER FUNCTION pitlane.finalize(uuid,text,bigint,jsonb,uuid) RENAME TO finalize_unattested;END IF;
END $$;
CREATE OR REPLACE FUNCTION pitlane.register_artifact(j uuid,w text,e bigint,m jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 PERFORM pitlane.leased_job(j,w,e);
 IF (SELECT mode FROM pitlane.runtime)<>'local' AND NOT EXISTS(SELECT FROM pitlane.artifact_attestations WHERE object_key=m->>'key' AND job_id=j AND lease_epoch=e AND digest=m->>'sha256' AND bytes=(m->>'bytes')::bigint AND verified_at IS NOT NULL) THEN RAISE EXCEPTION 'ARTIFACT_ATTESTATION_REQUIRED';END IF;
 PERFORM pitlane.register_artifact_unattested(j,w,e,m);
END $$;
CREATE OR REPLACE FUNCTION pitlane.finalize(j uuid,w text,e bigint,r jsonb,a uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 PERFORM pitlane.leased_job(j,w,e);
 IF (SELECT mode FROM pitlane.runtime)<>'local' AND NOT EXISTS(SELECT FROM pitlane.artifact_attestations t JOIN pitlane.artifacts f ON f.object_key=t.object_key WHERE f.id=a AND t.job_id=j AND t.lease_epoch=e AND t.digest=f.digest AND t.payload=r AND t.verified_at IS NOT NULL) THEN RAISE EXCEPTION 'ARTIFACT_PAYLOAD_MISMATCH';END IF;
 RETURN pitlane.finalize_unattested(j,w,e,r,a);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
REVOKE ALL ON FUNCTION pitlane.gateway_dispatch(uuid,text,bigint,uuid,text,text) FROM pitlane_gateway;
REVOKE ALL ON FUNCTION pitlane.register_artifact_unattested(uuid,text,bigint,jsonb),pitlane.finalize_unattested(uuid,text,bigint,jsonb,uuid) FROM pitlane_worker;
GRANT EXECUTE ON FUNCTION pitlane.gateway_dispatch_scoped(uuid,text,bigint,uuid,text,text,jsonb),pitlane.gateway_record(uuid,text,bigint,uuid,text) TO pitlane_gateway;
GRANT EXECUTE ON FUNCTION pitlane.artifact_evidence_context(uuid,text,bigint),pitlane.reserve_artifact_publication(uuid,text,bigint,text,text,text,bigint),pitlane.attest_artifact(uuid,text,bigint,text,text) TO pitlane_artifact;
GRANT EXECUTE ON FUNCTION pitlane.register_artifact(uuid,text,bigint,jsonb),pitlane.finalize(uuid,text,bigint,jsonb,uuid) TO pitlane_worker;
