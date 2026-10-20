-- Erase collaboration bodies through the existing durable deletion lifecycle.
-- Keep conservative AI usage/cost provenance; it is not an inspection unit or a
-- financial ledger entry. Hash arbitrary request headers when access is deleted.
ALTER TABLE pitlane.collaboration_mutations ADD COLUMN retention_redacted_at timestamptz;
ALTER TABLE pitlane.collaboration_ai_requests ADD COLUMN retention_redacted_at timestamptz;

ALTER FUNCTION pitlane.scrub_expired_bodies() RENAME TO scrub_evidence_bodies_internal;
CREATE FUNCTION pitlane.scrub_expired_bodies() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 PERFORM pitlane.scrub_evidence_bodies_internal();
 UPDATE pitlane.collaboration_conversations c SET title='[deleted]' FROM pitlane.projects p,pitlane.tenants t
 WHERE c.project_id=p.id AND c.tenant_id=t.id AND (p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL) AND c.title<>'[deleted]';
 UPDATE pitlane.collaboration_sprints c SET title='[deleted]',goal='' FROM pitlane.projects p,pitlane.tenants t
 WHERE c.project_id=p.id AND c.tenant_id=t.id AND (p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL) AND (c.title<>'[deleted]' OR c.goal<>'');
 UPDATE pitlane.collaboration_work_items c SET title='[deleted]',description='' FROM pitlane.projects p,pitlane.tenants t
 WHERE c.project_id=p.id AND c.tenant_id=t.id AND (p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL) AND (c.title<>'[deleted]' OR c.description<>'');
 UPDATE pitlane.collaboration_messages c SET content='[deleted]' FROM pitlane.projects p,pitlane.tenants t
 WHERE c.project_id=p.id AND c.tenant_id=t.id AND (p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL) AND c.content<>'[deleted]';
 UPDATE pitlane.collaboration_mutations c SET result='{}',key=encode(sha256(convert_to(c.key,'UTF8')),'hex'),retention_redacted_at=now() FROM pitlane.projects p,pitlane.tenants t
 WHERE c.project_id=p.id AND c.tenant_id=t.id AND (p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL) AND c.retention_redacted_at IS NULL;
 UPDATE pitlane.collaboration_ai_requests c SET key=encode(sha256(convert_to(c.key,'UTF8')),'hex'),retention_redacted_at=now() FROM pitlane.projects p,pitlane.tenants t
 WHERE c.project_id=p.id AND c.tenant_id=t.id AND (p.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL) AND c.retention_redacted_at IS NULL;
END $$;

-- Authorization may have been checked before a domain function waited on a lock.
-- Recheck the live scope at the actual write. The project row lock makes deletion
-- wait for a live write to commit without reversing collaboration budget locks.
CREATE FUNCTION pitlane.guard_live_project_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 IF TG_OP='UPDATE' AND current_setting('role',true)='pitlane_maintenance' THEN RETURN NEW;END IF;
 PERFORM 1 FROM pitlane.projects p JOIN pitlane.tenants t ON t.id=p.tenant_id WHERE p.id=NEW.project_id AND p.tenant_id=NEW.tenant_id AND p.deleted_at IS NULL AND t.deleted_at IS NULL FOR SHARE OF p;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_job_live_scope BEFORE INSERT ON pitlane.jobs FOR EACH ROW EXECUTE FUNCTION pitlane.guard_live_project_write();
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['collaboration_conversations','collaboration_sprints','collaboration_work_items','collaboration_messages','collaboration_mutations','collaboration_ai_days','collaboration_ai_requests'] LOOP
  EXECUTE format('CREATE TRIGGER guard_live_scope BEFORE INSERT OR UPDATE ON pitlane.%I FOR EACH ROW EXECUTE FUNCTION pitlane.guard_live_project_write()',table_name);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION pitlane.scrub_expired_bodies(),pitlane.scrub_evidence_bodies_internal(),pitlane.guard_live_project_write() FROM PUBLIC;
