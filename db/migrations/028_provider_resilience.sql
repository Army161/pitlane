ALTER TABLE pitlane.cost_intents ADD COLUMN IF NOT EXISTS dispatch_profile jsonb;
ALTER TABLE pitlane.cost_intents ADD COLUMN IF NOT EXISTS outcome_at timestamptz;
ALTER TABLE pitlane.cost_intents ADD COLUMN IF NOT EXISTS failure_code text;
ALTER TABLE pitlane.gateway_observations ADD COLUMN IF NOT EXISTS profile_snapshot jsonb;
CREATE TABLE IF NOT EXISTS pitlane.provider_health(
 provider_id text NOT NULL REFERENCES pitlane.provider_profiles(id),profile_version text NOT NULL,
 failures integer NOT NULL DEFAULT 0 CHECK(failures>=0),open_until timestamptz,
 blocked boolean NOT NULL DEFAULT false,last_outcome_at timestamptz,
 PRIMARY KEY(provider_id,profile_version)
);
CREATE OR REPLACE FUNCTION pitlane.provider_snapshot(p pitlane.provider_profiles) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',p.id,'upstreamId',p.upstream_id,'network',p.network,'genesis',p.genesis,'maximumMicro',p.maximum_micro::text,
 'profileVersion',encode(sha256(convert_to(jsonb_build_array(p.id,p.upstream_id,p.network,p.genesis,p.maximum_micro::text,p.calls_per_minute)::text,'UTF8')),'hex'));
$$;
DO $$ BEGIN
 IF to_regprocedure('pitlane.gateway_dispatch_scoped_legacy(uuid,text,bigint,uuid,text,text,jsonb)') IS NULL THEN ALTER FUNCTION pitlane.gateway_dispatch_scoped(uuid,text,bigint,uuid,text,text,jsonb) RENAME TO gateway_dispatch_scoped_legacy;END IF;
END $$;
CREATE OR REPLACE FUNCTION pitlane.gateway_dispatch_scoped(j uuid,w text,e bigint,intent uuid,p text,m text,params jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE profile pitlane.provider_profiles;snapshot jsonb;health pitlane.provider_health;
BEGIN
 PERFORM pitlane.leased_job(j,w,e);
 SELECT * INTO profile FROM pitlane.provider_profiles WHERE id=p AND enabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'UNPRICED_PROVIDER';END IF;
 snapshot=pitlane.provider_snapshot(profile);
 INSERT INTO pitlane.provider_health(provider_id,profile_version) VALUES(p,snapshot->>'profileVersion') ON CONFLICT DO NOTHING;
 SELECT * INTO health FROM pitlane.provider_health WHERE provider_id=p AND profile_version=snapshot->>'profileVersion' FOR UPDATE;
 IF health.blocked THEN RAISE EXCEPTION 'PROVIDER_AUTH_BLOCKED';END IF;
 IF health.open_until>clock_timestamp() THEN RAISE EXCEPTION 'PROVIDER_CIRCUIT_OPEN';END IF;
 PERFORM pitlane.gateway_dispatch_scoped_legacy(j,w,e,intent,p,m,params);
 UPDATE pitlane.cost_intents SET dispatch_profile=snapshot WHERE id=intent;
 RETURN snapshot;
END $$;
CREATE OR REPLACE FUNCTION pitlane.gateway_outcome(intent uuid,code text,delay_ms integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE c pitlane.cost_intents;h pitlane.provider_health;
BEGIN
 SELECT * INTO c FROM pitlane.cost_intents WHERE id=intent AND dispatched_at IS NOT NULL AND dispatch_profile IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_DISPATCH_INTENT';END IF;
 IF c.outcome_at IS NOT NULL THEN RETURN;END IF;
 IF code NOT IN('success','transient','rate_limit','auth','invalid') OR delay_ms<0 THEN RAISE EXCEPTION 'INVALID_PROVIDER_OUTCOME';END IF;
 UPDATE pitlane.cost_intents SET outcome_at=clock_timestamp(),failure_code=CASE WHEN code='success' THEN NULL ELSE code END WHERE id=intent;
 SELECT * INTO h FROM pitlane.provider_health WHERE provider_id=c.provider_id AND profile_version=c.dispatch_profile->>'profileVersion' FOR UPDATE;
 IF h.last_outcome_at IS NOT NULL AND h.last_outcome_at>c.dispatched_at THEN RETURN;END IF;
 UPDATE pitlane.provider_health SET
 failures=CASE WHEN code='success' THEN 0 ELSE failures+1 END,
 blocked=CASE WHEN code='auth' THEN true ELSE blocked END,
 open_until=CASE WHEN code='success' THEN NULL WHEN code='rate_limit' THEN clock_timestamp()+greatest(delay_ms,1000)*interval '1 millisecond' WHEN failures+1>=3 THEN clock_timestamp()+greatest(delay_ms,30000)*interval '1 millisecond' ELSE open_until END,
 last_outcome_at=c.dispatched_at
 WHERE provider_id=c.provider_id AND profile_version=c.dispatch_profile->>'profileVersion';
END $$;
CREATE OR REPLACE FUNCTION pitlane.gateway_failure(j uuid,w text,e bigint,intent uuid,code text,delay_ms integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM pitlane.cost_intents WHERE id=intent AND job_id=j AND lease_epoch=e AND dispatched_at IS NOT NULL) THEN RAISE EXCEPTION 'INVALID_DISPATCH_INTENT';END IF;
 PERFORM pitlane.gateway_outcome(intent,code,delay_ms);
END $$;
CREATE OR REPLACE FUNCTION pitlane.gateway_record(j uuid,w text,e bigint,intent uuid,body text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE c pitlane.cost_intents;stamp timestamptz;
BEGIN
 PERFORM pitlane.leased_job(j,w,e);
 SELECT * INTO c FROM pitlane.cost_intents WHERE id=intent AND job_id=j AND lease_epoch=e AND dispatched_at IS NOT NULL AND dispatch_params IS NOT NULL AND dispatch_profile IS NOT NULL FOR UPDATE;
 IF NOT FOUND OR c.outcome_at IS NOT NULL OR octet_length(body)>262144 THEN RAISE EXCEPTION 'INVALID_GATEWAY_SOURCE';END IF;
 INSERT INTO pitlane.gateway_observations(intent_id,job_id,lease_epoch,provider_id,upstream_id,network,method,params,raw_body,raw_hash,profile_snapshot)
 VALUES(intent,j,e,c.provider_id,c.dispatch_profile->>'upstreamId',c.dispatch_profile->>'network',c.method,c.dispatch_params,body,encode(sha256(convert_to(body,'UTF8')),'hex'),c.dispatch_profile) RETURNING observed_at INTO stamp;
 UPDATE pitlane.cost_intents SET status='measured',response_bytes=octet_length(body) WHERE id=intent;
 PERFORM pitlane.gateway_outcome(intent,'success',0);
 RETURN stamp;
END $$;
CREATE OR REPLACE FUNCTION pitlane.assert_provider_coverage(network_name text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 IF (SELECT mode FROM pitlane.runtime)='local' THEN RETURN;END IF;
 IF (SELECT count(DISTINCT p.upstream_id) FROM pitlane.provider_profiles p LEFT JOIN pitlane.provider_health h ON h.provider_id=p.id AND h.profile_version=pitlane.provider_snapshot(p)->>'profileVersion'
 WHERE p.enabled AND p.network=network_name AND p.genesis=CASE WHEN network_name='devnet' THEN 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1' WHEN network_name='mainnet-beta' THEN '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' END
 AND NOT coalesce(h.blocked,false) AND (h.open_until IS NULL OR h.open_until<=clock_timestamp()))<2 THEN RAISE EXCEPTION 'PROVIDER_COVERAGE_UNAVAILABLE';END IF;
END $$;
DO $$ BEGIN
 IF to_regprocedure('pitlane.create_quote_unchecked_providers(jsonb,text)') IS NULL THEN ALTER FUNCTION pitlane.create_quote(jsonb,text) RENAME TO create_quote_unchecked_providers;END IF;
 IF to_regprocedure('pitlane.admit_unchecked_providers(uuid,text)') IS NULL THEN ALTER FUNCTION pitlane.admit(uuid,text) RENAME TO admit_unchecked_providers;END IF;
END $$;
CREATE OR REPLACE FUNCTION pitlane.create_quote(v jsonb,h text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE q jsonb;
BEGIN q=pitlane.create_quote_unchecked_providers(v,h);PERFORM pitlane.assert_provider_coverage(v->>'network');RETURN q;END $$;
CREATE OR REPLACE FUNCTION pitlane.admit(qid uuid,k text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE q pitlane.quotes;
BEGIN
 SELECT * INTO q FROM pitlane.quotes WHERE id=qid;
 IF NOT FOUND OR NOT pitlane.can_project(q.tenant_id,q.project_id,true) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF q.consumed_job_id IS NULL AND NOT EXISTS(SELECT FROM pitlane.idempotency WHERE tenant_id=q.tenant_id AND project_id=q.project_id AND key=k) THEN PERFORM pitlane.assert_provider_coverage(q.input->>'network');END IF;
 RETURN pitlane.admit_unchecked_providers(qid,k);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
REVOKE ALL ON FUNCTION pitlane.gateway_dispatch_scoped_legacy(uuid,text,bigint,uuid,text,text,jsonb) FROM pitlane_gateway;
REVOKE ALL ON FUNCTION pitlane.create_quote_unchecked_providers(jsonb,text),pitlane.admit_unchecked_providers(uuid,text) FROM pitlane_web;
GRANT EXECUTE ON FUNCTION pitlane.gateway_dispatch_scoped(uuid,text,bigint,uuid,text,text,jsonb),pitlane.gateway_failure(uuid,text,bigint,uuid,text,integer),pitlane.gateway_record(uuid,text,bigint,uuid,text) TO pitlane_gateway;
GRANT EXECUTE ON FUNCTION pitlane.create_quote(jsonb,text),pitlane.admit(uuid,text) TO pitlane_web;
