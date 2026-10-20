-- A private human-review upload must be durably tracked before any object write.
-- Pilot reservations use the existing exact-key orphan lifecycle. Receipt
-- reservation slots, artifact verification and worker privileges are unchanged.
ALTER TABLE pitlane.artifact_attestations ADD COLUMN publication_kind text NOT NULL DEFAULT 'receipt' CHECK(publication_kind IN('receipt','pilot_summary'));
ALTER TABLE pitlane.artifact_attestations ADD COLUMN pilot_order_id uuid REFERENCES pitlane.orders(id);
ALTER TABLE pitlane.artifact_attestations ADD COLUMN pilot_artifact_id uuid;
ALTER TABLE pitlane.artifact_attestations ADD COLUMN pilot_upload_until timestamptz;
ALTER TABLE pitlane.artifact_attestations ADD CONSTRAINT publication_kind_binding CHECK(
 (publication_kind='receipt' AND pilot_order_id IS NULL AND pilot_artifact_id IS NULL AND pilot_upload_until IS NULL) OR
 (publication_kind='pilot_summary' AND pilot_order_id IS NOT NULL AND pilot_artifact_id IS NOT NULL AND pilot_upload_until IS NOT NULL)
);
CREATE UNIQUE INDEX pilot_summary_publication_order ON pitlane.artifact_attestations(pilot_order_id) WHERE publication_kind='pilot_summary';

CREATE FUNCTION pitlane.reserve_pilot_summary(target_id uuid,artifact uuid,key text,hash text,size bigint,minutes integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE context jsonb;o pitlane.orders;prior pitlane.artifact_attestations;published pitlane.artifacts;
BEGIN
 context=pitlane.pilot_summary_context(target_id);
 PERFORM pg_advisory_xact_lock(hashtextextended((context->>'tenant_id')||(context->>'project_id'),0));
 context=pitlane.pilot_summary_context(target_id);
 PERFORM 1 FROM pitlane.projects p JOIN pitlane.tenants t ON t.id=p.tenant_id WHERE p.id=(context->>'project_id')::uuid AND p.tenant_id=(context->>'tenant_id')::uuid AND p.deleted_at IS NULL AND t.deleted_at IS NULL FOR SHARE OF p;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 SELECT * INTO o FROM pitlane.orders WHERE id=target_id FOR UPDATE;
 IF artifact IS NULL OR key IS NULL OR hash IS NULL OR hash!~'^[a-f0-9]{64}$' OR size IS NULL OR size NOT BETWEEN 1 AND 65536 OR minutes IS NULL OR minutes NOT BETWEEN 1 AND 45
 OR key<>(context->>'tenant_id')||'/'||(context->>'project_id')||'/'||(context->>'job_id')||'/pilot-summary/'||target_id::text||'/'||hash||'.json' THEN RAISE EXCEPTION 'INVALID_ARTIFACT';END IF;
 IF o.summary_artifact_id IS NOT NULL THEN
  SELECT * INTO published FROM pitlane.artifacts WHERE id=o.summary_artifact_id;
  IF published.digest<>hash OR published.bytes<>size OR published.object_key<>key OR o.review_minutes<>minutes THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';END IF;
  IF published.state<>'published' OR published.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ARTIFACT_EXPIRED';END IF;
  RETURN jsonb_build_object('artifact_id',published.id,'registered',true);
 END IF;
 PERFORM pitlane.assert_delivery_authorization(target_id);
 SELECT * INTO prior FROM pitlane.artifact_attestations WHERE pilot_order_id=target_id AND publication_kind='pilot_summary' FOR UPDATE;
 -- Queue admission takes a SHARE lock on this same reservation. Recheck AFTER
 -- our row lock so a concurrent committed purge cannot be missed during a wait.
 IF EXISTS(SELECT FROM pitlane.orphan_object_purge WHERE object_key=key) THEN RAISE EXCEPTION 'ARTIFACT_EXPIRED';END IF;
 IF prior.object_key IS NOT NULL THEN
  IF prior.object_key<>key OR prior.digest<>hash OR prior.bytes<>size OR prior.payload->>'actorId' IS DISTINCT FROM pitlane.actor_id()::text OR (prior.payload->>'minutes')::integer<>minutes THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';END IF;
  IF prior.created_at<=clock_timestamp()-interval '24 hours' THEN RAISE EXCEPTION 'ARTIFACT_EXPIRED';END IF;
  UPDATE pitlane.artifact_attestations SET pilot_upload_until=clock_timestamp()+interval '5 minutes',verified_at=NULL WHERE object_key=key RETURNING * INTO prior;
  RETURN jsonb_build_object('artifact_id',prior.pilot_artifact_id,'registered',false,'upload_until',prior.pilot_upload_until);
 END IF;
 INSERT INTO pitlane.artifact_attestations(object_key,job_id,lease_epoch,digest,bytes,payload,publication_kind,pilot_order_id,pilot_artifact_id,pilot_upload_until)
 SELECT key,j.id,j.lease_epoch,hash,size,jsonb_build_object('schema','pitlane.pilot-summary-publication.v1','orderId',target_id,'actorId',pitlane.actor_id(),'minutes',minutes),'pilot_summary',target_id,artifact,clock_timestamp()+interval '5 minutes'
 FROM pitlane.jobs j WHERE j.id=(context->>'job_id')::uuid AND j.tenant_id=o.tenant_id AND j.project_id=o.project_id AND j.order_id=target_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 SELECT * INTO prior FROM pitlane.artifact_attestations WHERE object_key=key;
 RETURN jsonb_build_object('artifact_id',artifact,'registered',false,'upload_until',prior.pilot_upload_until);
END $$;

CREATE FUNCTION pitlane.attest_pilot_summary(target_id uuid,key text,hash text,size bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE context jsonb;reservation pitlane.artifact_attestations;
BEGIN
 context=pitlane.pilot_summary_context(target_id);
 PERFORM pg_advisory_xact_lock(hashtextextended((context->>'tenant_id')||(context->>'project_id'),0));
 context=pitlane.pilot_summary_context(target_id);
 SELECT * INTO reservation FROM pitlane.artifact_attestations WHERE pilot_order_id=target_id AND publication_kind='pilot_summary' AND object_key=key AND digest=hash AND bytes=size FOR UPDATE;
 IF NOT FOUND OR reservation.payload->>'actorId' IS DISTINCT FROM pitlane.actor_id()::text THEN RAISE EXCEPTION 'PILOT_PUBLICATION_REQUIRED';END IF;
 IF reservation.pilot_upload_until<=clock_timestamp() OR EXISTS(SELECT FROM pitlane.orphan_object_purge WHERE object_key=key) THEN RAISE EXCEPTION 'ARTIFACT_EXPIRED';END IF;
 UPDATE pitlane.artifact_attestations SET verified_at=coalesce(verified_at,clock_timestamp()) WHERE object_key=key;
END $$;

CREATE OR REPLACE FUNCTION pitlane.register_pilot_summary(target_id uuid,artifact uuid,object_key text,hash text,size bigint,minutes integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE context jsonb;o pitlane.orders;existing pitlane.artifacts;reservation pitlane.artifact_attestations;j pitlane.jobs;
BEGIN
 context=pitlane.pilot_summary_context(target_id);
 PERFORM pg_advisory_xact_lock(hashtextextended((context->>'tenant_id')||(context->>'project_id'),0));
 context=pitlane.pilot_summary_context(target_id);
 PERFORM 1 FROM pitlane.projects p JOIN pitlane.tenants t ON t.id=p.tenant_id WHERE p.id=(context->>'project_id')::uuid AND p.tenant_id=(context->>'tenant_id')::uuid AND p.deleted_at IS NULL AND t.deleted_at IS NULL FOR SHARE OF p;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 SELECT * INTO o FROM pitlane.orders WHERE id=target_id FOR UPDATE;
 IF minutes IS NULL OR minutes NOT BETWEEN 1 AND 45 OR size IS NULL OR size NOT BETWEEN 1 AND 65536 OR hash IS NULL OR hash!~'^[a-f0-9]{64}$' OR object_key IS NULL
 OR object_key<>(context->>'tenant_id')||'/'||(context->>'project_id')||'/'||(context->>'job_id')||'/pilot-summary/'||target_id::text||'/'||hash||'.json' THEN RAISE EXCEPTION 'INVALID_ARTIFACT';END IF;
 IF o.summary_artifact_id IS NOT NULL THEN
  SELECT * INTO existing FROM pitlane.artifacts WHERE id=o.summary_artifact_id;
  IF existing.digest<>hash OR existing.bytes<>size OR existing.object_key<>object_key OR o.review_minutes<>minutes THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';END IF;
  IF existing.state<>'published' OR existing.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ARTIFACT_EXPIRED';END IF;
  RETURN;
 END IF;
 SELECT * INTO reservation FROM pitlane.artifact_attestations a WHERE a.pilot_order_id=target_id AND a.publication_kind='pilot_summary' AND a.object_key=register_pilot_summary.object_key FOR UPDATE;
 IF NOT FOUND OR reservation.verified_at IS NULL OR reservation.pilot_artifact_id IS DISTINCT FROM artifact OR reservation.digest<>hash OR reservation.bytes<>size OR reservation.payload->>'actorId' IS DISTINCT FROM pitlane.actor_id()::text OR (reservation.payload->>'minutes')::integer<>minutes THEN RAISE EXCEPTION 'PILOT_PUBLICATION_REQUIRED';END IF;
 IF reservation.pilot_upload_until<=clock_timestamp() OR EXISTS(SELECT FROM pitlane.orphan_object_purge q WHERE q.object_key=register_pilot_summary.object_key) THEN RAISE EXCEPTION 'ARTIFACT_EXPIRED';END IF;
 PERFORM pitlane.assert_delivery_authorization(target_id);
 SELECT * INTO j FROM pitlane.jobs WHERE id=reservation.job_id AND tenant_id=o.tenant_id AND project_id=o.project_id AND order_id=target_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 INSERT INTO pitlane.artifacts(id,tenant_id,project_id,job_id,lease_epoch,object_key,digest,bytes,content_type,state,expires_at)
 VALUES(artifact,o.tenant_id,o.project_id,j.id,j.lease_epoch,object_key,hash,size,'application/vnd.pitlane.pilot-summary+json','published',clock_timestamp()+interval '90 days');
 PERFORM pitlane.pilot_summary(target_id,artifact,minutes);
END $$;

-- Do not remove a fresh or actively leased key while bounded storage upload can
-- still finish. Every permitted retry renews the 5-minute lease before PUT.
-- Crash reservations become eligible after 24 hours (within 30-day erasure).
-- The existing attestation check keeps deletion pending until exact-key removal.
CREATE FUNCTION pitlane.guard_pilot_orphan_purge() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE reservation pitlane.artifact_attestations;
BEGIN
 SELECT * INTO reservation FROM pitlane.artifact_attestations WHERE object_key=NEW.object_key AND publication_kind='pilot_summary' FOR SHARE;
 IF FOUND THEN
  IF reservation.pilot_upload_until>clock_timestamp() OR reservation.created_at>clock_timestamp()-interval '24 hours' OR EXISTS(SELECT FROM pitlane.artifacts a WHERE a.object_key=NEW.object_key) THEN RETURN NULL;END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_pilot_orphan_purge BEFORE INSERT ON pitlane.orphan_object_purge FOR EACH ROW EXECUTE FUNCTION pitlane.guard_pilot_orphan_purge();
REVOKE ALL ON FUNCTION pitlane.reserve_pilot_summary(uuid,uuid,text,text,bigint,integer),pitlane.attest_pilot_summary(uuid,text,text,bigint),pitlane.register_pilot_summary(uuid,uuid,text,text,bigint,integer),pitlane.guard_pilot_orphan_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.reserve_pilot_summary(uuid,uuid,text,text,bigint,integer),pitlane.attest_pilot_summary(uuid,text,text,bigint),pitlane.register_pilot_summary(uuid,uuid,text,text,bigint,integer) TO pitlane_web;
