DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='pitlane_artifact') THEN CREATE ROLE pitlane_artifact NOLOGIN NOBYPASSRLS;END IF;END $$;
GRANT USAGE ON SCHEMA pitlane TO pitlane_artifact;
CREATE OR REPLACE FUNCTION pitlane.artifact_access(j uuid,w text,e bigint) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$ SELECT pitlane.leased_job(j,w,e) $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.artifact_access(uuid,text,bigint) TO pitlane_artifact;
