DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='pitlane_maintenance') THEN CREATE ROLE pitlane_maintenance NOLOGIN NOBYPASSRLS;END IF;END $$;
GRANT USAGE ON SCHEMA pitlane TO pitlane_maintenance;
ALTER TABLE pitlane.artifacts DROP CONSTRAINT IF EXISTS artifacts_state_check;
ALTER TABLE pitlane.artifacts ADD CONSTRAINT artifacts_state_check CHECK(state IN('hash_verified','published','purge_pending','purged'));
CREATE TABLE IF NOT EXISTS pitlane.artifact_purge(artifact_id uuid PRIMARY KEY REFERENCES pitlane.artifacts(id),lease_until timestamptz,available_at timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS pitlane.evidence_tombstones(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,project_id uuid NOT NULL,digest text NOT NULL,purged_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(project_id,tenant_id) REFERENCES pitlane.projects(id,tenant_id));
ALTER TABLE pitlane.evidence_tombstones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tombstone_read ON pitlane.evidence_tombstones;
CREATE POLICY tombstone_read ON pitlane.evidence_tombstones FOR SELECT USING(pitlane.can_project(tenant_id,project_id));
GRANT SELECT ON pitlane.evidence_tombstones TO pitlane_web;
CREATE OR REPLACE FUNCTION pitlane.delete_project(project uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE t uuid=pitlane.actor_tenant();target_id uuid;
BEGIN
 IF NOT pitlane.can_project_admin(t,project) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||project::text,0));
 UPDATE pitlane.monitors SET enabled=false,paused_reason='PROJECT_DELETED' WHERE tenant_id=t AND project_id=project;
 FOR target_id IN SELECT id FROM pitlane.jobs WHERE tenant_id=t AND project_id=project AND state IN('awaiting_payment','queued','running','verifying','retry_wait') LOOP PERFORM pitlane.cancel_job(target_id);END LOOP;
 UPDATE pitlane.atlas_cases SET permission=false,state='withdrawn' WHERE tenant_id=t AND project_id=project;
 UPDATE pitlane.projects SET deleted_at=coalesce(deleted_at,now()) WHERE id=project AND tenant_id=t;
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(t,pitlane.actor_id(),'PROJECT_DELETED',project);
END $$;
CREATE OR REPLACE FUNCTION pitlane.prepare_purge(maximum integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE result jsonb;
BEGIN
 INSERT INTO pitlane.artifact_purge(artifact_id)
 SELECT a.id FROM pitlane.artifacts a JOIN pitlane.projects p ON p.id=a.project_id JOIN pitlane.tenants t ON t.id=a.tenant_id JOIN pitlane.jobs j ON j.id=a.job_id
 WHERE a.state IN('published','hash_verified') AND (a.expires_at<=now() OR p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL OR a.state='hash_verified' AND a.created_at<now()-interval '24 hours' AND (j.state NOT IN('running','verifying') OR j.lease_epoch<>a.lease_epoch))
 ON CONFLICT DO NOTHING;
 UPDATE pitlane.artifacts a SET state='purge_pending',expires_at=least(expires_at,now()) FROM pitlane.artifact_purge q WHERE q.artifact_id=a.id AND a.state<>'purged';
 WITH claimed AS (SELECT artifact_id FROM pitlane.artifact_purge WHERE available_at<=now() AND (lease_until IS NULL OR lease_until<=now()) ORDER BY available_at,artifact_id FOR UPDATE SKIP LOCKED LIMIT greatest(0,least(maximum,500))),
 updated AS (UPDATE pitlane.artifact_purge SET lease_until=now()+interval '30 seconds',attempts=attempts+1 WHERE artifact_id IN(SELECT artifact_id FROM claimed) RETURNING artifact_id)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'object_key',a.object_key)),'[]') INTO result FROM updated u JOIN pitlane.artifacts a ON a.id=u.artifact_id;
 DELETE FROM pitlane.auth_sessions WHERE expires_at<=now() OR revoked;
 DELETE FROM pitlane.request_windows WHERE window_start<now()-interval '1 day';
 DELETE FROM pitlane.audit WHERE occurred_at<now()-interval '365 days';
 DELETE FROM pitlane.idempotency WHERE created_at<now()-interval '365 days';
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION pitlane.complete_purge(target_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE a pitlane.artifacts;v pitlane.receipt_versions;
BEGIN
 SELECT * INTO a FROM pitlane.artifacts WHERE id=target_id AND state='purge_pending' FOR UPDATE;
 IF NOT FOUND THEN RETURN;END IF;
 FOR v IN SELECT * FROM pitlane.receipt_versions WHERE artifact_id=target_id LOOP
  INSERT INTO pitlane.evidence_tombstones(id,tenant_id,project_id,digest) VALUES(v.id,v.tenant_id,v.project_id,v.digest) ON CONFLICT DO NOTHING;
  UPDATE pitlane.receipt_versions SET payload='{"evidenceExpired":true}',expires_at=least(expires_at,now()) WHERE id=v.id;
 END LOOP;
 UPDATE pitlane.artifacts SET state='purged',object_key='purged/'||id::text||'/'||digest WHERE id=target_id;
 IF NOT EXISTS(SELECT FROM pitlane.artifacts WHERE job_id=a.job_id AND state IN('published','hash_verified','purge_pending')) THEN
  UPDATE pitlane.jobs SET input='{"evidenceExpired":true}',correction_reason=NULL WHERE id=a.job_id AND state IN('completed','unsupported','cancelled','expired','failed');
  UPDATE pitlane.job_events SET payload='{}' WHERE job_id=a.job_id;
  UPDATE pitlane.quotes SET input='{"evidenceExpired":true}' WHERE consumed_job_id=a.job_id;
 END IF;
 DELETE FROM pitlane.artifact_purge WHERE artifact_id=target_id;
 INSERT INTO pitlane.audit(tenant_id,type,subject_id) VALUES(a.tenant_id,'EVIDENCE_PURGED',target_id);
END $$;
CREATE OR REPLACE FUNCTION pitlane.retry_purge(target_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$ UPDATE pitlane.artifact_purge SET lease_until=NULL,available_at=now()+interval '30 seconds' WHERE artifact_id=target_id $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.delete_project(uuid) TO pitlane_web;
GRANT EXECUTE ON FUNCTION pitlane.prepare_purge(integer),pitlane.complete_purge(uuid),pitlane.retry_purge(uuid) TO pitlane_maintenance;
