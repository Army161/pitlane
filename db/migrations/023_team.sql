CREATE TABLE IF NOT EXISTS pitlane.identity_registry(user_id uuid PRIMARY KEY,registered_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION pitlane.can_tenant_admin(t uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$ SELECT pitlane.can_tenant(t) AND EXISTS(SELECT FROM pitlane.tenant_memberships WHERE tenant_id=t AND user_id=pitlane.actor_id() AND active AND role IN('owner','admin')) $$;
CREATE OR REPLACE FUNCTION pitlane.create_project(label text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE t uuid=pitlane.actor_tenant();p pitlane.projects;
BEGIN
 IF NOT pitlane.can_tenant_admin(t) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||'/projects',0));
 IF length(label)<1 OR octet_length(label)>128 THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 IF (SELECT count(*) FROM pitlane.projects WHERE tenant_id=t AND deleted_at IS NULL)>=50 THEN RAISE EXCEPTION 'PROJECT_LIMIT';END IF;
 INSERT INTO pitlane.projects VALUES(gen_random_uuid(),t,label,NULL) RETURNING * INTO p;
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(t,pitlane.actor_id(),'PROJECT_CREATED',p.id);RETURN to_jsonb(p);
END $$;
CREATE OR REPLACE FUNCTION pitlane.set_tenant_member(target_user uuid,new_role text,is_active boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE t uuid=pitlane.actor_tenant();m pitlane.tenant_memberships;
BEGIN
 IF NOT pitlane.can_tenant_admin(t) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||'/members',0));
 IF new_role NOT IN('owner','admin','billing','member') OR is_active IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 IF NOT EXISTS(SELECT FROM pitlane.identity_registry WHERE user_id=target_user) THEN RAISE EXCEPTION 'REGISTERED_USER_REQUIRED';END IF;
 SELECT * INTO m FROM pitlane.tenant_memberships WHERE tenant_id=t AND user_id=target_user FOR UPDATE;
 IF m.active AND m.role='owner' AND (NOT is_active OR new_role<>'owner') AND NOT EXISTS(SELECT FROM pitlane.tenant_memberships WHERE tenant_id=t AND user_id<>target_user AND role='owner' AND active) THEN RAISE EXCEPTION 'LAST_OWNER';END IF;
 INSERT INTO pitlane.tenant_memberships VALUES(t,target_user,new_role,is_active) ON CONFLICT(tenant_id,user_id) DO UPDATE SET role=excluded.role,active=excluded.active;
 IF NOT is_active THEN UPDATE pitlane.project_memberships SET active=false WHERE tenant_id=t AND user_id=target_user;UPDATE pitlane.monitors SET enabled=false,paused_reason='MEMBERSHIP_REMOVED' WHERE tenant_id=t AND enabled_by=target_user;END IF;
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(t,pitlane.actor_id(),'TENANT_MEMBERSHIP_CHANGED',target_user);
END $$;
CREATE OR REPLACE FUNCTION pitlane.set_project_member(project uuid,target_user uuid,new_role text,is_active boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE t uuid=pitlane.actor_tenant();
BEGIN
 IF NOT pitlane.can_project_admin(t,project) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF new_role NOT IN('admin','developer','viewer') OR is_active IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 IF NOT EXISTS(SELECT FROM pitlane.tenant_memberships WHERE tenant_id=t AND user_id=target_user AND active) THEN RAISE EXCEPTION 'ACTIVE_TENANT_MEMBER_REQUIRED';END IF;
 INSERT INTO pitlane.project_memberships VALUES(t,project,target_user,new_role,is_active) ON CONFLICT(tenant_id,project_id,user_id) DO UPDATE SET role=excluded.role,active=excluded.active;
 IF NOT is_active THEN UPDATE pitlane.monitors SET enabled=false,paused_reason='MEMBERSHIP_REMOVED' WHERE tenant_id=t AND project_id=project AND enabled_by=target_user;END IF;
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(t,pitlane.actor_id(),'PROJECT_MEMBERSHIP_CHANGED',project);
END $$;
CREATE OR REPLACE FUNCTION pitlane.register_identity(u uuid,label text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN INSERT INTO pitlane.identity_registry(user_id) VALUES(u) ON CONFLICT DO NOTHING;END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.can_tenant_admin(uuid),pitlane.create_project(text),pitlane.set_tenant_member(uuid,text,boolean),pitlane.set_project_member(uuid,uuid,text,boolean) TO pitlane_web;
GRANT EXECUTE ON FUNCTION pitlane.register_identity(uuid,text) TO pitlane_auth;
