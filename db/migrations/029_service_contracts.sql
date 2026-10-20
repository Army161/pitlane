CREATE OR REPLACE FUNCTION pitlane.runtime_info() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
 SELECT to_jsonb(r)||jsonb_build_object('contract','1','schema_version',(SELECT max(left(name,3)) FROM pitlane.schema_migrations)) FROM pitlane.runtime r;
$$;
CREATE OR REPLACE FUNCTION pitlane.provider_registry() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
 SELECT coalesce(jsonb_agg(pitlane.provider_snapshot(p) ORDER BY p.id),'[]') FROM pitlane.provider_profiles p WHERE p.enabled;
$$;
CREATE OR REPLACE FUNCTION pitlane.claim(w text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE j pitlane.jobs;crew pitlane.workers;hosted boolean=(SELECT mode FROM pitlane.runtime)<>'local';
BEGIN
 IF length(w)<1 OR length(w)>128 THEN RAISE EXCEPTION 'INVALID_WORKER';END IF;
 SELECT * INTO crew FROM pitlane.workers WHERE id=w;
 IF hosted AND (NOT FOUND OR crew.heartbeat_at<clock_timestamp()-interval '45 seconds' OR crew.capabilities->>'contract' IS DISTINCT FROM '1' OR crew.capabilities->>'draining' IS DISTINCT FROM 'false' OR crew.capabilities->>'origin' IS DISTINCT FROM 'internal' OR jsonb_typeof(crew.capabilities->'networks') IS DISTINCT FROM 'array') THEN RETURN NULL;END IF;
 SELECT * INTO j FROM pitlane.jobs WHERE state IN('queued','retry_wait') AND ready_at<=now() AND deadline>now() AND attempts<3 AND NOT cancel_requested
 AND input->>'templateVersion'='1' AND input->>'templateId' IN('solana.mint_configuration','solana.integration_expectations')
 AND (NOT hosted OR origin<>'fixture')
 AND (crew.id IS NULL OR crew.capabilities->'networks' IS NULL OR crew.capabilities->'networks' ? (input->>'network'))
 AND (crew.id IS NULL OR correction_version_id IS NULL OR crew.capabilities->>'corrections'='true')
 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL;END IF;
 UPDATE pitlane.jobs SET state='running',lease_owner=w,lease_until=least(deadline,clock_timestamp()+interval '60 seconds'),lease_epoch=lease_epoch+1,attempts=attempts+1 WHERE id=j.id RETURNING * INTO j;
 PERFORM pitlane.emit(j.id,'running',jsonb_build_object('attempt',j.attempts,'workerId',w));RETURN to_jsonb(j);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.runtime_info() TO pitlane_web,pitlane_worker,pitlane_billing,pitlane_auth,pitlane_gateway,pitlane_artifact,pitlane_maintenance;
GRANT EXECUTE ON FUNCTION pitlane.provider_registry() TO pitlane_worker,pitlane_gateway;
GRANT EXECUTE ON FUNCTION pitlane.claim(text) TO pitlane_worker;
