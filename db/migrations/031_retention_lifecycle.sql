-- Evidence bodies and financial records have separate retention policies. This
-- migration never deletes ledger/payment/entitlement records.
ALTER TABLE pitlane.jobs ADD COLUMN body_expires_at timestamptz;
UPDATE pitlane.jobs j SET body_expires_at=coalesce((SELECT max(occurred_at) FROM pitlane.job_events WHERE job_id=j.id AND type IN('completed','failed','expired','cancelled')),j.created_at)+interval '90 days';
ALTER TABLE pitlane.jobs ALTER COLUMN body_expires_at SET DEFAULT now()+interval '90 days';
ALTER TABLE pitlane.jobs ALTER COLUMN body_expires_at SET NOT NULL;
ALTER TABLE pitlane.artifacts ADD COLUMN base_expires_at timestamptz;
UPDATE pitlane.artifacts SET base_expires_at=least(expires_at,created_at+interval '90 days');
ALTER TABLE pitlane.artifacts ALTER COLUMN base_expires_at SET NOT NULL;
ALTER TABLE pitlane.receipt_versions ADD COLUMN base_expires_at timestamptz;
UPDATE pitlane.receipt_versions SET base_expires_at=least(expires_at,issued_at+interval '90 days');
ALTER TABLE pitlane.receipt_versions ALTER COLUMN base_expires_at SET NOT NULL;
ALTER TABLE pitlane.atlas_cases ADD COLUMN confirmed_at timestamptz;
ALTER TABLE pitlane.atlas_cases ADD COLUMN permission_scope jsonb;
ALTER TABLE pitlane.atlas_cases ADD COLUMN redacted_at timestamptz;
UPDATE pitlane.atlas_cases SET confirmed_at=expires_at-interval '365 days',permission_scope=jsonb_build_object('failureVersionId',failure_version_id,'correctionVersionId',correction_version_id,'regressionArtifactId',regression_artifact_id,'retentionDays',365,'reuse','tenant') WHERE state='confirmed' AND permission;
ALTER TABLE pitlane.evidence_tombstones ADD COLUMN receipt_id uuid;
ALTER TABLE pitlane.evidence_tombstones ADD COLUMN entity_kind text NOT NULL DEFAULT 'receipt' CHECK(entity_kind IN('receipt','artifact'));
ALTER TABLE pitlane.evidence_tombstones ADD COLUMN expired_at timestamptz;
UPDATE pitlane.evidence_tombstones t SET receipt_id=v.receipt_id,expired_at=v.expires_at FROM pitlane.receipt_versions v WHERE v.id=t.id;
CREATE TABLE pitlane.orphan_object_purge(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),object_key text NOT NULL UNIQUE,
 tenant_id uuid NOT NULL,project_id uuid NOT NULL,job_id uuid NOT NULL,
 available_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,attempts integer NOT NULL DEFAULT 0,
 FOREIGN KEY(job_id,tenant_id,project_id) REFERENCES pitlane.jobs(id,tenant_id,project_id)
);
CREATE TABLE pitlane.deletion_requests(
 subject_id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES pitlane.tenants,
 project_id uuid,requested_at timestamptz NOT NULL DEFAULT now(),due_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','completed')),completed_at timestamptz,
 FOREIGN KEY(project_id,tenant_id) REFERENCES pitlane.projects(id,tenant_id)
);
ALTER TABLE pitlane.orphan_object_purge ENABLE ROW LEVEL SECURITY;
ALTER TABLE pitlane.deletion_requests ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION pitlane.set_evidence_base_expiry() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pitlane AS $$
BEGIN NEW.base_expires_at=NEW.expires_at;RETURN NEW;END $$;
CREATE TRIGGER artifact_base_expiry BEFORE INSERT ON pitlane.artifacts FOR EACH ROW EXECUTE FUNCTION pitlane.set_evidence_base_expiry();
CREATE TRIGGER receipt_base_expiry BEFORE INSERT ON pitlane.receipt_versions FOR EACH ROW EXECUTE FUNCTION pitlane.set_evidence_base_expiry();
CREATE FUNCTION pitlane.set_job_body_expiry() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pitlane AS $$
BEGIN IF OLD.state NOT IN('completed','unsupported','failed','expired','cancelled') AND NEW.state IN('completed','unsupported','failed','expired','cancelled') THEN NEW.body_expires_at=now()+interval '90 days';END IF;RETURN NEW;END $$;
CREATE TRIGGER job_body_expiry BEFORE UPDATE OF state ON pitlane.jobs FOR EACH ROW EXECUTE FUNCTION pitlane.set_job_body_expiry();

-- Direct application SELECT cannot expose expired bodies. The scoped lookup below
-- returns a digest-only tombstone while the maintenance purge is pending.
DROP POLICY scoped_read ON pitlane.artifacts;
CREATE POLICY scoped_read ON pitlane.artifacts FOR SELECT USING(pitlane.can_project(tenant_id,project_id) AND state='published' AND expires_at>now());
DROP POLICY scoped_read ON pitlane.receipt_versions;
CREATE POLICY scoped_read ON pitlane.receipt_versions FOR SELECT USING(pitlane.can_project(tenant_id,project_id) AND expires_at>now() AND payload<>'{"evidenceExpired":true}'::jsonb);
DROP POLICY scoped_read ON pitlane.atlas_cases;
CREATE POLICY scoped_read ON pitlane.atlas_cases FOR SELECT USING(pitlane.can_project(tenant_id,project_id) AND expires_at>now() AND redacted_at IS NULL);

CREATE FUNCTION pitlane.receipt_lookup(lineage uuid,version uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE v pitlane.receipt_versions;a pitlane.artifacts;
BEGIN
 IF version IS NULL THEN SELECT rv.* INTO v FROM pitlane.receipt_heads h JOIN pitlane.receipt_versions rv ON rv.id=h.version_id WHERE h.receipt_id=lineage;
 ELSE SELECT * INTO v FROM pitlane.receipt_versions WHERE id=version AND receipt_id=lineage;END IF;
 IF NOT FOUND OR NOT pitlane.can_project(v.tenant_id,v.project_id) THEN RETURN NULL;END IF;
 SELECT * INTO a FROM pitlane.artifacts WHERE id=v.artifact_id;
 IF v.expires_at<=now() OR a.expires_at<=now() OR a.state IN('purge_pending','purged') OR v.payload='{"evidenceExpired":true}'::jsonb THEN
  RETURN jsonb_build_object('kind','expired','evidenceExpired',true,'versionId',v.id,'receiptId',v.receipt_id,'digest',v.digest,'expiredAt',least(v.expires_at,a.expires_at));
 END IF;
 RETURN jsonb_build_object('kind','available','versionId',v.id,'receiptId',v.receipt_id,'artifactId',v.artifact_id,'expiresAt',least(v.expires_at,a.expires_at),'payload',v.payload);
END $$;
CREATE FUNCTION pitlane.receipt_version_lookup(version uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
 SELECT pitlane.receipt_lookup(receipt_id,id) FROM pitlane.receipt_versions WHERE id=version AND pitlane.can_project(tenant_id,project_id);
$$;
CREATE FUNCTION pitlane.artifact_lookup(target uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE a pitlane.artifacts;
BEGIN
 SELECT * INTO a FROM pitlane.artifacts WHERE id=target;
 IF NOT FOUND OR NOT pitlane.can_project(a.tenant_id,a.project_id) THEN RETURN NULL;END IF;
 IF a.state IN('purge_pending','purged') OR a.expires_at<=now() THEN RETURN jsonb_build_object('kind','expired','evidenceExpired',true,'artifactId',a.id,'digest',a.digest,'expiredAt',a.expires_at);END IF;
 IF a.state<>'published' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('kind','available','artifactId',a.id,'digest',a.digest,'expiresAt',a.expires_at);
END $$;

CREATE FUNCTION pitlane.refresh_atlas_holds(project uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 UPDATE pitlane.receipt_versions v SET expires_at=greatest(v.base_expires_at,coalesce((SELECT max(c.expires_at) FROM pitlane.atlas_cases c WHERE c.project_id=project AND c.state='confirmed' AND c.permission AND c.expires_at>now() AND v.id IN(c.failure_version_id,c.correction_version_id)),v.base_expires_at))
 WHERE v.project_id=project AND v.payload<>'{"evidenceExpired":true}'::jsonb;
 UPDATE pitlane.artifacts a SET expires_at=greatest(a.base_expires_at,coalesce((SELECT max(v.expires_at) FROM pitlane.receipt_versions v WHERE v.artifact_id=a.id),a.base_expires_at))
 WHERE a.project_id=project AND a.state IN('published','hash_verified');
END $$;
CREATE OR REPLACE FUNCTION pitlane.confirm_atlas(target_id uuid,fix uuid,regression uuid,consent boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE c pitlane.atlas_cases;f pitlane.receipt_versions;v pitlane.receipt_versions;
BEGIN
 SELECT * INTO c FROM pitlane.atlas_cases WHERE id=target_id FOR UPDATE;
 IF NOT FOUND OR NOT pitlane.can_project_admin(c.tenant_id,c.project_id) OR c.expires_at<=now() OR c.redacted_at IS NOT NULL THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF consent IS DISTINCT FROM true THEN RAISE EXCEPTION 'EXPLICIT_PERMISSION_REQUIRED';END IF;
 IF c.state='withdrawn' THEN RAISE EXCEPTION 'CASE_WITHDRAWN';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(c.tenant_id::text||c.project_id::text,0));
 SELECT * INTO f FROM pitlane.receipt_versions WHERE id=c.failure_version_id AND expires_at>now();
 SELECT * INTO v FROM pitlane.receipt_versions WHERE id=fix AND tenant_id=c.tenant_id AND project_id=c.project_id AND expires_at>now();
 IF f.id IS NULL OR v.id IS NULL OR f.payload->>'finding'<>'contradicted' OR v.payload->>'finding'<>'supported' OR v.payload->'input'<>f.payload->'input' OR v.issued_at<=f.issued_at OR v.artifact_id<>regression
 OR NOT EXISTS(SELECT FROM pitlane.artifacts WHERE id=regression AND state='published' AND expires_at>now())
 OR NOT EXISTS(SELECT FROM pitlane.artifacts WHERE id=f.artifact_id AND state='published' AND expires_at>now()) THEN RAISE EXCEPTION 'VERIFIED_FIX_AND_REGRESSION_REQUIRED';END IF;
 IF c.state='confirmed' THEN
  IF c.correction_version_id<>fix OR c.regression_artifact_id<>regression THEN RAISE EXCEPTION 'VERSION_CONFLICT';END IF;
  RETURN to_jsonb(c);
 END IF;
 UPDATE pitlane.atlas_cases SET state='confirmed',correction_version_id=fix,regression_artifact_id=regression,permission=true,confirmed_at=now(),expires_at=now()+interval '365 days',
 permission_scope=jsonb_build_object('failureVersionId',f.id,'correctionVersionId',v.id,'regressionArtifactId',regression,'retentionDays',365,'reuse','tenant') WHERE id=target_id RETURNING * INTO c;
 PERFORM pitlane.refresh_atlas_holds(c.project_id);
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(c.tenant_id,pitlane.actor_id(),'ATLAS_CONFIRMED_SCOPED_PERMISSION',target_id);RETURN to_jsonb(c);
END $$;
CREATE OR REPLACE FUNCTION pitlane.withdraw_atlas(target_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE c pitlane.atlas_cases;
BEGIN
 SELECT * INTO c FROM pitlane.atlas_cases WHERE id=target_id FOR UPDATE;
 IF NOT FOUND OR NOT pitlane.can_project_admin(c.tenant_id,c.project_id) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(c.tenant_id::text||c.project_id::text,0));
 IF c.state='withdrawn' THEN RETURN to_jsonb(c);END IF;
 UPDATE pitlane.atlas_cases SET state='withdrawn',permission=false,expires_at=least(expires_at,created_at+interval '90 days') WHERE id=target_id RETURNING * INTO c;
 PERFORM pitlane.refresh_atlas_holds(c.project_id);
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(c.tenant_id,pitlane.actor_id(),'ATLAS_RETRACTED',target_id);RETURN to_jsonb(c);
END $$;
CREATE FUNCTION pitlane.reuse_atlas(target uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE c pitlane.atlas_cases;
BEGIN
 SELECT * INTO c FROM pitlane.atlas_cases WHERE id=target AND state='confirmed' AND permission AND expires_at>now() AND redacted_at IS NULL;
 IF NOT FOUND OR NOT pitlane.can_project(c.tenant_id,c.project_id) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF EXISTS(SELECT FROM pitlane.receipt_versions v JOIN pitlane.artifacts a ON a.id=v.artifact_id WHERE v.id IN(c.failure_version_id,c.correction_version_id) AND (v.expires_at<=now() OR a.expires_at<=now() OR a.state<>'published' OR v.payload='{"evidenceExpired":true}'::jsonb)) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 RETURN to_jsonb(c);
END $$;

CREATE OR REPLACE FUNCTION pitlane.delete_project(project uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE t uuid=pitlane.actor_tenant();target_id uuid;
BEGIN
 IF NOT pitlane.can_project_admin(t,project) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||project::text,0));
 UPDATE pitlane.monitors SET enabled=false,paused_reason='PROJECT_DELETED' WHERE tenant_id=t AND project_id=project;
 FOR target_id IN SELECT id FROM pitlane.jobs WHERE tenant_id=t AND project_id=project AND state IN('awaiting_payment','queued','running','verifying','retry_wait') ORDER BY id LOOP PERFORM pitlane.cancel_job(target_id);END LOOP;
 UPDATE pitlane.atlas_cases SET permission=false,state='withdrawn',expires_at=least(expires_at,now()) WHERE tenant_id=t AND project_id=project;
 UPDATE pitlane.projects SET deleted_at=coalesce(deleted_at,now()) WHERE id=project AND tenant_id=t;
 INSERT INTO pitlane.deletion_requests(subject_id,tenant_id,project_id) VALUES(project,t,project) ON CONFLICT DO NOTHING;
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(t,pitlane.actor_id(),'PROJECT_DELETED',project);
END $$;
CREATE FUNCTION pitlane.delete_tenant() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE t uuid=pitlane.actor_tenant();project uuid;target uuid;
BEGIN
 IF NOT pitlane.can_tenant_admin(t) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||'/projects',0));
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||'/members',0));
 PERFORM 1 FROM pitlane.tenants WHERE id=t FOR UPDATE;
 FOR project IN SELECT id FROM pitlane.projects WHERE tenant_id=t ORDER BY id LOOP PERFORM pg_advisory_xact_lock(hashtextextended(t::text||project::text,0));END LOOP;
 UPDATE pitlane.monitors SET enabled=false,paused_reason='TENANT_DELETED' WHERE tenant_id=t;
 FOR target IN SELECT id FROM pitlane.jobs WHERE tenant_id=t AND state IN('awaiting_payment','queued','running','verifying','retry_wait') ORDER BY project_id,id LOOP PERFORM pitlane.cancel_job(target);END LOOP;
 -- Cancellation is an operational outbox action. Settled/dispute/ledger rows stay
 -- under their separately versioned financial policy.
 INSERT INTO pitlane.payment_outbox(tenant_id,order_id,business_key,operation) SELECT t,id,id::text||'/cancel','cancel' FROM pitlane.orders WHERE tenant_id=t AND state IN('awaiting_authorization','authorized') ON CONFLICT(business_key) DO NOTHING;
 UPDATE pitlane.atlas_cases SET permission=false,state='withdrawn',expires_at=least(expires_at,now()) WHERE tenant_id=t;
 UPDATE pitlane.projects SET deleted_at=coalesce(deleted_at,now()) WHERE tenant_id=t;
 UPDATE pitlane.tenants SET deleted_at=coalesce(deleted_at,now()) WHERE id=t;
 UPDATE pitlane.tenant_memberships SET active=false WHERE tenant_id=t;
 UPDATE pitlane.project_memberships SET active=false WHERE tenant_id=t;
 INSERT INTO pitlane.deletion_requests(subject_id,tenant_id) VALUES(t,t) ON CONFLICT DO NOTHING;
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(t,pitlane.actor_id(),'TENANT_DELETED',t);
END $$;

-- Only maintenance can scrub retained bodies. A live Atlas hold protects source
-- gateway/attestation/job bodies; an expired case or deletion never does.
CREATE FUNCTION pitlane.scrub_expired_bodies() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 UPDATE pitlane.atlas_cases c SET title='[evidence expired]',permission=false,state='withdrawn',redacted_at=now(),permission_scope=NULL
 FROM pitlane.projects p,pitlane.tenants t WHERE c.project_id=p.id AND c.tenant_id=t.id AND c.redacted_at IS NULL AND (c.expires_at<=now() OR p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL);
 UPDATE pitlane.receipt_versions v SET payload='{"evidenceExpired":true}',expires_at=least(v.expires_at,now()) FROM pitlane.artifacts a,pitlane.projects p,pitlane.tenants t
 WHERE v.artifact_id=a.id AND v.project_id=p.id AND v.tenant_id=t.id AND (v.expires_at<=now() OR a.expires_at<=now() OR a.state IN('purge_pending','purged') OR p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL);
 DELETE FROM pitlane.gateway_observations o USING pitlane.jobs j,pitlane.projects p,pitlane.tenants t WHERE o.job_id=j.id AND j.project_id=p.id AND j.tenant_id=t.id AND
 (p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL OR j.state IN('completed','unsupported','failed','expired','cancelled') AND
 (j.body_expires_at<=now() OR EXISTS(SELECT FROM pitlane.receipt_versions v WHERE v.job_id=j.id AND v.payload='{"evidenceExpired":true}'::jsonb)) AND
 NOT EXISTS(SELECT FROM pitlane.receipt_versions v WHERE v.job_id=j.id AND v.expires_at>now() AND v.payload<>'{"evidenceExpired":true}'::jsonb));
 DELETE FROM pitlane.artifact_attestations x USING pitlane.artifacts a WHERE x.object_key=a.object_key AND (a.state IN('purge_pending','purged') OR a.expires_at<=now());
 UPDATE pitlane.cost_intents c SET dispatch_params=NULL FROM pitlane.jobs j,pitlane.projects p,pitlane.tenants t WHERE c.job_id=j.id AND j.project_id=p.id AND j.tenant_id=t.id AND
 (p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL OR j.state IN('completed','unsupported','failed','expired','cancelled') AND
 (j.body_expires_at<=now() OR EXISTS(SELECT FROM pitlane.receipt_versions v WHERE v.job_id=j.id AND v.payload='{"evidenceExpired":true}'::jsonb)) AND
 NOT EXISTS(SELECT FROM pitlane.receipt_versions v WHERE v.job_id=j.id AND v.expires_at>now() AND v.payload<>'{"evidenceExpired":true}'::jsonb));
 UPDATE pitlane.jobs j SET input='{"evidenceExpired":true}',correction_reason=NULL FROM pitlane.projects p,pitlane.tenants t WHERE j.project_id=p.id AND j.tenant_id=t.id AND
 (p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL OR j.state IN('completed','unsupported','failed','expired','cancelled') AND
 (j.body_expires_at<=now() OR EXISTS(SELECT FROM pitlane.receipt_versions v WHERE v.job_id=j.id AND v.payload='{"evidenceExpired":true}'::jsonb)) AND
 NOT EXISTS(SELECT FROM pitlane.receipt_versions v WHERE v.job_id=j.id AND v.expires_at>now() AND v.payload<>'{"evidenceExpired":true}'::jsonb));
 UPDATE pitlane.job_events e SET payload='{}' FROM pitlane.jobs j WHERE e.job_id=j.id AND (e.occurred_at<=now()-interval '90 days' OR j.input='{"evidenceExpired":true}'::jsonb);
 UPDATE pitlane.quotes q SET input='{"evidenceExpired":true}' FROM pitlane.projects p,pitlane.tenants t WHERE q.project_id=p.id AND q.tenant_id=t.id AND
 (p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL OR q.consumed_job_id IS NULL AND q.expires_at<=now() OR EXISTS(SELECT FROM pitlane.jobs j WHERE j.id=q.consumed_job_id AND j.input='{"evidenceExpired":true}'::jsonb));
 UPDATE pitlane.idempotency i SET request_hash=encode(sha256(convert_to(request_hash,'UTF8')),'hex') FROM pitlane.jobs j WHERE i.job_id=j.id AND j.input='{"evidenceExpired":true}'::jsonb AND position('/correction/' IN i.request_hash)>0;
 UPDATE pitlane.monitors m SET enabled=false,input='{"evidenceExpired":true}',inputs_hash=NULL,enabled_by=NULL FROM pitlane.projects p,pitlane.tenants t WHERE m.project_id=p.id AND m.tenant_id=t.id AND (p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL OR m.expires_at<=now());
END $$;
CREATE OR REPLACE FUNCTION pitlane.prepare_purge(maximum integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE result jsonb;orphans jsonb;remaining integer;
BEGIN
 IF maximum IS NULL OR maximum<1 OR maximum>500 THEN RAISE EXCEPTION 'INVALID_PURGE_LIMIT';END IF;
 INSERT INTO pitlane.artifact_purge(artifact_id)
 SELECT a.id FROM pitlane.artifacts a JOIN pitlane.projects p ON p.id=a.project_id JOIN pitlane.tenants t ON t.id=a.tenant_id JOIN pitlane.jobs j ON j.id=a.job_id
 WHERE a.state IN('published','hash_verified') AND (a.expires_at<=now() OR p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL OR a.state='hash_verified' AND a.created_at<now()-interval '24 hours' AND (j.state NOT IN('running','verifying') OR j.lease_epoch<>a.lease_epoch)) ON CONFLICT DO NOTHING;
 UPDATE pitlane.artifacts a SET state='purge_pending',expires_at=least(expires_at,now()) FROM pitlane.artifact_purge q WHERE q.artifact_id=a.id AND a.state<>'purged';
 -- Keys come from independent publication reservations, never a derived job path.
 INSERT INTO pitlane.orphan_object_purge(object_key,tenant_id,project_id,job_id)
 SELECT x.object_key,j.tenant_id,j.project_id,j.id FROM pitlane.artifact_attestations x JOIN pitlane.jobs j ON j.id=x.job_id JOIN pitlane.projects p ON p.id=j.project_id JOIN pitlane.tenants t ON t.id=j.tenant_id
 WHERE NOT EXISTS(SELECT FROM pitlane.artifacts a WHERE a.object_key=x.object_key) AND (x.created_at<now()-interval '24 hours' OR p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL) ON CONFLICT DO NOTHING;
 WITH claimed AS (SELECT artifact_id FROM pitlane.artifact_purge WHERE available_at<=now() AND (lease_until IS NULL OR lease_until<=now()) ORDER BY available_at,artifact_id FOR UPDATE SKIP LOCKED LIMIT maximum),
 updated AS (UPDATE pitlane.artifact_purge SET lease_until=now()+interval '30 seconds',attempts=attempts+1 WHERE artifact_id IN(SELECT artifact_id FROM claimed) RETURNING artifact_id)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'object_key',a.object_key,'kind','artifact')),'[]') INTO result FROM updated u JOIN pitlane.artifacts a ON a.id=u.artifact_id;
 remaining=maximum-jsonb_array_length(result);
 WITH claimed AS (SELECT id FROM pitlane.orphan_object_purge WHERE available_at<=now() AND (lease_until IS NULL OR lease_until<=now()) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT remaining),
 updated AS (UPDATE pitlane.orphan_object_purge SET lease_until=now()+interval '30 seconds',attempts=attempts+1 WHERE id IN(SELECT id FROM claimed) RETURNING id,object_key)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'object_key',object_key,'kind','orphan')),'[]') INTO orphans FROM updated;
 PERFORM pitlane.scrub_expired_bodies();
 DELETE FROM pitlane.auth_sessions WHERE expires_at<=now() OR revoked;
 DELETE FROM pitlane.request_windows WHERE window_start<now()-interval '1 day';
 DELETE FROM pitlane.audit WHERE occurred_at<now()-interval '365 days';
 DELETE FROM pitlane.idempotency WHERE created_at<now()-interval '365 days';
 UPDATE pitlane.projects p SET name='[deleted project]' WHERE deleted_at IS NOT NULL;
 UPDATE pitlane.tenants t SET name='[deleted tenant]' WHERE deleted_at IS NOT NULL;
 UPDATE pitlane.deletion_requests d SET status='completed',completed_at=now() WHERE status='pending'
 AND NOT EXISTS(SELECT FROM pitlane.artifacts a WHERE a.tenant_id=d.tenant_id AND (d.project_id IS NULL OR a.project_id=d.project_id) AND a.state<>'purged')
 AND NOT EXISTS(SELECT FROM pitlane.artifact_attestations x JOIN pitlane.jobs j ON j.id=x.job_id WHERE j.tenant_id=d.tenant_id AND (d.project_id IS NULL OR j.project_id=d.project_id));
 RETURN result||orphans;
END $$;
CREATE OR REPLACE FUNCTION pitlane.complete_purge(target_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE a pitlane.artifacts;o pitlane.orphan_object_purge;
BEGIN
 SELECT * INTO o FROM pitlane.orphan_object_purge WHERE id=target_id FOR UPDATE;
 IF FOUND THEN
  DELETE FROM pitlane.artifact_attestations WHERE object_key=o.object_key;
  DELETE FROM pitlane.orphan_object_purge WHERE id=target_id;
 ELSE
  SELECT * INTO a FROM pitlane.artifacts WHERE id=target_id AND state='purge_pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN;END IF;
  INSERT INTO pitlane.evidence_tombstones(id,tenant_id,project_id,digest,entity_kind,expired_at) VALUES(a.id,a.tenant_id,a.project_id,a.digest,'artifact',a.expires_at) ON CONFLICT DO NOTHING;
  INSERT INTO pitlane.evidence_tombstones(id,tenant_id,project_id,digest,receipt_id,entity_kind,expired_at) SELECT id,tenant_id,project_id,digest,receipt_id,'receipt',expires_at FROM pitlane.receipt_versions WHERE artifact_id=a.id ON CONFLICT DO NOTHING;
  DELETE FROM pitlane.artifact_attestations WHERE object_key=a.object_key;
  UPDATE pitlane.artifacts SET state='purged',object_key='purged/'||id::text||'/'||digest WHERE id=target_id;
  DELETE FROM pitlane.artifact_purge WHERE artifact_id=target_id;
  INSERT INTO pitlane.audit(tenant_id,type,subject_id) VALUES(a.tenant_id,'EVIDENCE_PURGED',target_id);
 END IF;
 PERFORM pitlane.scrub_expired_bodies();
 UPDATE pitlane.deletion_requests d SET status='completed',completed_at=now() WHERE status='pending'
 AND NOT EXISTS(SELECT FROM pitlane.artifacts f WHERE f.tenant_id=d.tenant_id AND (d.project_id IS NULL OR f.project_id=d.project_id) AND f.state<>'purged')
 AND NOT EXISTS(SELECT FROM pitlane.artifact_attestations x JOIN pitlane.jobs j ON j.id=x.job_id WHERE j.tenant_id=d.tenant_id AND (d.project_id IS NULL OR j.project_id=d.project_id));
END $$;
CREATE OR REPLACE FUNCTION pitlane.retry_purge(target_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 UPDATE pitlane.artifact_purge SET lease_until=NULL,available_at=now()+interval '30 seconds' WHERE artifact_id=target_id;
 UPDATE pitlane.orphan_object_purge SET lease_until=NULL,available_at=now()+interval '30 seconds' WHERE id=target_id;
END $$;

-- A reservation already selected for orphan purge cannot race back into publication.
ALTER FUNCTION pitlane.register_artifact(uuid,text,bigint,jsonb) RENAME TO register_artifact_retention_internal;
CREATE FUNCTION pitlane.register_artifact(j uuid,w text,e bigint,m jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 PERFORM pitlane.lock_job_scope(j);
 IF EXISTS(SELECT FROM pitlane.orphan_object_purge WHERE object_key=m->>'key') THEN RAISE EXCEPTION 'ARTIFACT_EXPIRED';END IF;
 PERFORM pitlane.register_artifact_retention_internal(j,w,e,m);
END $$;

CREATE FUNCTION pitlane.reserve_local_publication(j uuid,w text,e bigint,key text,body text,hash text,size bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 IF (SELECT mode FROM pitlane.runtime)<>'local' THEN RAISE EXCEPTION 'LOCAL_PUBLICATION_PROHIBITED';END IF;
 PERFORM pitlane.reserve_artifact_publication(j,w,e,key,body,hash,size);
END $$;
CREATE FUNCTION pitlane.check_retention_page(project uuid,maximum integer,at_cursor timestamptz,id_cursor uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 IF maximum IS NULL OR maximum NOT BETWEEN 1 AND 100 OR (at_cursor IS NULL)<>(id_cursor IS NULL) THEN RAISE EXCEPTION 'INVALID_PAGE';END IF;
 IF NOT pitlane.can_project(pitlane.actor_tenant(),project) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
END $$;
CREATE FUNCTION pitlane.receipt_page(project uuid,maximum integer,at_cursor timestamptz DEFAULT NULL,id_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE result jsonb;
BEGIN
 PERFORM pitlane.check_retention_page(project,maximum,at_cursor,id_cursor);
 SELECT coalesce(jsonb_agg(value ORDER BY issued_at DESC,id DESC),'[]') INTO result FROM
 (SELECT v.id,v.issued_at,jsonb_build_object('versionId',v.id,'receiptId',v.receipt_id,'artifactId',v.artifact_id,'digest',v.digest,'issuedAt',v.issued_at,'expiresAt',least(v.expires_at,a.expires_at),'finding',CASE WHEN v.expires_at>now() AND a.expires_at>now() AND a.state='published' THEN v.payload->>'finding' ELSE NULL END,'origin',j.origin,'evidenceExpired',v.expires_at<=now() OR a.expires_at<=now() OR a.state IN('purge_pending','purged'),'cursor',jsonb_build_object('at',to_char(v.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'id',v.id)) AS value
 FROM pitlane.receipt_versions v JOIN pitlane.artifacts a ON a.id=v.artifact_id JOIN pitlane.jobs j ON j.id=v.job_id WHERE v.tenant_id=pitlane.actor_tenant() AND v.project_id=project AND (at_cursor IS NULL OR (v.issued_at,v.id)<(at_cursor,id_cursor)) ORDER BY v.issued_at DESC,v.id DESC LIMIT maximum+1) page;
 RETURN result;
END $$;
CREATE FUNCTION pitlane.job_page(project uuid,maximum integer,at_cursor timestamptz DEFAULT NULL,id_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE result jsonb;
BEGIN
 PERFORM pitlane.check_retention_page(project,maximum,at_cursor,id_cursor);
 SELECT coalesce(jsonb_agg(value ORDER BY created_at DESC,id DESC),'[]') INTO result FROM
 (SELECT j.id,j.created_at,jsonb_build_object('id',j.id,'tenantId',j.tenant_id,'projectId',j.project_id,'state',j.state,'origin',j.origin,'receiptId',j.receipt_id,'createdAt',j.created_at,'expiresAt',j.body_expires_at,'evidenceExpired',j.input='{"evidenceExpired":true}'::jsonb,'cursor',jsonb_build_object('at',to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'id',j.id)) AS value
 FROM pitlane.jobs j WHERE j.tenant_id=pitlane.actor_tenant() AND j.project_id=project AND (at_cursor IS NULL OR (j.created_at,j.id)<(at_cursor,id_cursor)) ORDER BY j.created_at DESC,j.id DESC LIMIT maximum+1) page;
 RETURN result;
END $$;
CREATE FUNCTION pitlane.atlas_page(project uuid,maximum integer,at_cursor timestamptz DEFAULT NULL,id_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE result jsonb;
BEGIN
 PERFORM pitlane.check_retention_page(project,maximum,at_cursor,id_cursor);
 SELECT coalesce(jsonb_agg(value ORDER BY created_at DESC,id DESC),'[]') INTO result FROM
 (SELECT c.id,c.created_at,to_jsonb(c)||jsonb_build_object('cursor',jsonb_build_object('at',to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'id',c.id)) AS value
 FROM pitlane.atlas_cases c WHERE c.tenant_id=pitlane.actor_tenant() AND c.project_id=project AND c.expires_at>now() AND c.redacted_at IS NULL AND (at_cursor IS NULL OR (c.created_at,c.id)<(at_cursor,id_cursor)) ORDER BY c.created_at DESC,c.id DESC LIMIT maximum+1) page;
 RETURN result;
END $$;
CREATE FUNCTION pitlane.event_page(job uuid,maximum integer,after_seq bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE j pitlane.jobs;result jsonb;
BEGIN
 IF maximum IS NULL OR maximum NOT BETWEEN 1 AND 100 OR after_seq<0 THEN RAISE EXCEPTION 'INVALID_PAGE';END IF;
 SELECT * INTO j FROM pitlane.jobs WHERE id=job;
 IF NOT FOUND OR NOT pitlane.can_project(j.tenant_id,j.project_id) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 SELECT coalesce(jsonb_agg(value ORDER BY seq),'[]') INTO result FROM
 (SELECT e.seq,jsonb_build_object('jobId',job,'seq',e.seq::text,'type',e.type,'occurredAt',e.occurred_at,'payload',CASE WHEN e.occurred_at<=now()-interval '90 days' OR j.input='{"evidenceExpired":true}'::jsonb THEN '{}'::jsonb ELSE e.payload END,'evidenceExpired',e.occurred_at<=now()-interval '90 days' OR j.input='{"evidenceExpired":true}'::jsonb) AS value
 FROM pitlane.job_events e WHERE e.job_id=job AND (after_seq IS NULL OR e.seq>after_seq) ORDER BY e.seq LIMIT maximum+1) page;
 RETURN result;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
REVOKE ALL ON FUNCTION pitlane.register_artifact_retention_internal(uuid,text,bigint,jsonb) FROM pitlane_worker;
GRANT EXECUTE ON FUNCTION pitlane.register_artifact(uuid,text,bigint,jsonb) TO pitlane_worker;
GRANT EXECUTE ON FUNCTION pitlane.reserve_local_publication(uuid,text,bigint,text,text,text,bigint) TO pitlane_worker;
GRANT EXECUTE ON FUNCTION pitlane.receipt_lookup(uuid,uuid),pitlane.receipt_version_lookup(uuid),pitlane.artifact_lookup(uuid),pitlane.reuse_atlas(uuid),pitlane.delete_tenant(),pitlane.confirm_atlas(uuid,uuid,uuid,boolean),pitlane.withdraw_atlas(uuid),pitlane.delete_project(uuid) TO pitlane_web;
GRANT EXECUTE ON FUNCTION pitlane.prepare_purge(integer),pitlane.complete_purge(uuid),pitlane.retry_purge(uuid) TO pitlane_maintenance;
GRANT EXECUTE ON FUNCTION pitlane.receipt_page(uuid,integer,timestamptz,uuid),pitlane.job_page(uuid,integer,timestamptz,uuid),pitlane.atlas_page(uuid,integer,timestamptz,uuid),pitlane.event_page(uuid,integer,bigint) TO pitlane_web;
