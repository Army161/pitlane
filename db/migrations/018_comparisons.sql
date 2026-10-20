ALTER TABLE pitlane.quotes ADD COLUMN IF NOT EXISTS comparison_version_id uuid;
DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_constraint WHERE conname='comparison_quote_scope') THEN ALTER TABLE pitlane.quotes ADD CONSTRAINT comparison_quote_scope FOREIGN KEY(comparison_version_id,tenant_id,project_id) REFERENCES pitlane.receipt_versions(id,tenant_id,project_id);END IF;END $$;
CREATE TABLE IF NOT EXISTS pitlane.receipt_comparisons(job_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,project_id uuid NOT NULL,source_version_id uuid NOT NULL,
 FOREIGN KEY(job_id,tenant_id,project_id) REFERENCES pitlane.jobs(id,tenant_id,project_id),FOREIGN KEY(source_version_id,tenant_id,project_id) REFERENCES pitlane.receipt_versions(id,tenant_id,project_id));
ALTER TABLE pitlane.receipt_comparisons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS comparison_read ON pitlane.receipt_comparisons;
CREATE POLICY comparison_read ON pitlane.receipt_comparisons FOR SELECT USING(pitlane.can_project(tenant_id,project_id));
GRANT SELECT ON pitlane.receipt_comparisons TO pitlane_web;
CREATE OR REPLACE FUNCTION pitlane.request_comparison(source_id uuid,qid uuid,k text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE source pitlane.receipt_versions;q pitlane.quotes;j jsonb;
BEGIN
 SELECT * INTO source FROM pitlane.receipt_versions WHERE id=source_id AND expires_at>now();
 IF NOT FOUND OR NOT pitlane.can_project(source.tenant_id,source.project_id,true) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(source.tenant_id::text||source.project_id::text,0));
 SELECT * INTO q FROM pitlane.quotes WHERE id=qid AND tenant_id=source.tenant_id AND project_id=source.project_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF q.comparison_version_id IS NOT NULL AND q.comparison_version_id<>source_id OR q.comparison_version_id IS NULL AND q.consumed_job_id IS NOT NULL THEN RAISE EXCEPTION 'QUOTE_CONSUMED';END IF;
 UPDATE pitlane.quotes SET comparison_version_id=source_id WHERE id=qid;
 j=pitlane.admit(qid,k);
 INSERT INTO pitlane.receipt_comparisons VALUES((j->>'id')::uuid,source.tenant_id,source.project_id,source_id) ON CONFLICT DO NOTHING;
 RETURN j;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.request_comparison(uuid,uuid,text) TO pitlane_web;
