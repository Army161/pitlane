ALTER TABLE pitlane.runtime ADD COLUMN IF NOT EXISTS environment_id text NOT NULL DEFAULT 'local-fixture';
ALTER TABLE pitlane.runtime ADD COLUMN IF NOT EXISTS auth_project_id text;
CREATE OR REPLACE FUNCTION pitlane.runtime_info() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$ SELECT to_jsonb(r)||jsonb_build_object('contract','1','schema_version','025') FROM pitlane.runtime r $$;
CREATE OR REPLACE FUNCTION pitlane.tenant_cost_usage(t uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN IF NOT pitlane.can_billing(t) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;RETURN (SELECT jsonb_build_object('asset','USD','scale',6,'maximum',maximum::text,'reserved',reserved::text,'worst_case_spent',spent::text,'classification','conservative_estimate','uncertain_attempts',(SELECT count(*) FROM pitlane.cost_intents WHERE tenant_id=t AND status='uncertain')) FROM pitlane.budgets WHERE key=t::text);END $$;
CREATE OR REPLACE FUNCTION pitlane.create_tenant(u uuid,label text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE t pitlane.tenants;
BEGIN
 IF NOT EXISTS(SELECT FROM pitlane.identity_registry WHERE user_id=u) OR length(label)<1 OR octet_length(label)>128 THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(u::text||'/tenants',0));
 IF (SELECT count(*) FROM pitlane.tenant_memberships WHERE user_id=u AND role='owner' AND active)>=5 THEN RAISE EXCEPTION 'TENANT_LIMIT';END IF;
 INSERT INTO pitlane.tenants VALUES(gen_random_uuid(),label,NULL) RETURNING * INTO t;
 INSERT INTO pitlane.tenant_memberships VALUES(t.id,u,'owner',true);
 INSERT INTO pitlane.budgets(key,maximum) VALUES(t.id::text,0);
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(t.id,u,'TENANT_CREATED',t.id);
 RETURN to_jsonb(t);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.runtime_info() TO pitlane_web,pitlane_worker,pitlane_billing,pitlane_auth,pitlane_gateway,pitlane_artifact,pitlane_maintenance;
GRANT EXECUTE ON FUNCTION pitlane.tenant_cost_usage(uuid) TO pitlane_web;
GRANT EXECUTE ON FUNCTION pitlane.create_tenant(uuid,text) TO pitlane_auth;
