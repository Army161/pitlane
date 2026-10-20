-- Cosmetic learning progress is independent of jobs, evidence, quotas and billing.
CREATE TABLE pitlane.career_profiles (
 tenant_id uuid NOT NULL REFERENCES pitlane.tenants(id) ON DELETE CASCADE,
 user_id uuid NOT NULL,
 alias text NOT NULL DEFAULT 'Crew member' CHECK(length(alias) BETWEEN 1 AND 32),
 leaderboard_opt_in boolean NOT NULL DEFAULT false,
 livery text NOT NULL DEFAULT 'factory' CHECK(livery IN('factory','ivory','night')),
 number_style text NOT NULL DEFAULT 'classic' CHECK(number_style IN('classic','block','outline')),
 lighting text NOT NULL DEFAULT 'workshop' CHECK(lighting IN('workshop','dusk','floodlight')),
 PRIMARY KEY(tenant_id,user_id)
);
CREATE TABLE pitlane.career_milestones (
 tenant_id uuid NOT NULL REFERENCES pitlane.tenants(id) ON DELETE CASCADE,
 user_id uuid NOT NULL,
 milestone text NOT NULL CHECK(milestone IN('purpose','outcomes','coverage','evidence','privacy','cosmetics')),
 completed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id,milestone)
);
ALTER TABLE pitlane.career_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE pitlane.career_milestones ENABLE ROW LEVEL SECURITY;
-- No direct table access: all reads and writes validate current tenant membership.
REVOKE ALL ON pitlane.career_profiles,pitlane.career_milestones FROM PUBLIC,pitlane_web,pitlane_worker;

CREATE FUNCTION pitlane.assert_career_member() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 PERFORM 1 FROM pitlane.tenants WHERE id=pitlane.actor_tenant() AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 PERFORM 1 FROM pitlane.tenant_memberships WHERE tenant_id=pitlane.actor_tenant() AND user_id=pitlane.actor_id() AND active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
END $$;

CREATE FUNCTION pitlane.career_state() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE t uuid:=pitlane.actor_tenant();u uuid:=pitlane.actor_id();p pitlane.career_profiles;completed jsonb;board jsonb;
BEGIN
 PERFORM pitlane.assert_career_member();
 SELECT * INTO p FROM pitlane.career_profiles WHERE tenant_id=t AND user_id=u;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',milestone,'completedAt',completed_at) ORDER BY completed_at,milestone),'[]'::jsonb) INTO completed FROM pitlane.career_milestones WHERE tenant_id=t AND user_id=u;
 SELECT coalesce(jsonb_agg(row_data ORDER BY score DESC,alias,sort_id),'[]'::jsonb) INTO board FROM (
  SELECT p2.alias,p2.user_id AS sort_id,count(m.milestone) AS score,
   jsonb_build_object('alias',p2.alias,'completed',count(m.milestone),'self',p2.user_id=u) AS row_data
  FROM pitlane.career_profiles p2
  JOIN pitlane.tenant_memberships tm ON tm.tenant_id=p2.tenant_id AND tm.user_id=p2.user_id AND tm.active
  LEFT JOIN pitlane.career_milestones m ON m.tenant_id=p2.tenant_id AND m.user_id=p2.user_id
  WHERE p2.tenant_id=t AND p2.leaderboard_opt_in GROUP BY p2.alias,p2.user_id
  ORDER BY count(m.milestone) DESC,p2.alias,p2.user_id LIMIT 50
 ) members;
 RETURN jsonb_build_object('alias',coalesce(p.alias,'Crew member'),'optIn',coalesce(p.leaderboard_opt_in,false),'livery',coalesce(p.livery,'factory'),'numberStyle',coalesce(p.number_style,'classic'),'lighting',coalesce(p.lighting,'workshop'),'milestones',completed,'leaderboard',board);
END $$;

CREATE FUNCTION pitlane.complete_career_milestone(target text,answer text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE t uuid:=pitlane.actor_tenant();u uuid:=pitlane.actor_id();expected text;
BEGIN
 PERFORM pitlane.assert_career_member();
 expected:=CASE target WHEN 'purpose' THEN 'technical-fit' WHEN 'outcomes' THEN 'not-enough-evidence' WHEN 'coverage' THEN 'four-listed-extensions' WHEN 'evidence' THEN 'point-in-time' WHEN 'privacy' THEN 'private-workspace' WHEN 'cosmetics' THEN 'appearance-only' END;
 IF expected IS NULL OR answer IS DISTINCT FROM expected THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 INSERT INTO pitlane.career_milestones(tenant_id,user_id,milestone) VALUES(t,u,target) ON CONFLICT DO NOTHING;
 RETURN pitlane.career_state();
END $$;

CREATE FUNCTION pitlane.update_career_profile(new_alias text,opt_in boolean,new_livery text,new_number_style text,new_lighting text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE t uuid:=pitlane.actor_tenant();u uuid:=pitlane.actor_id();n integer;
BEGIN
 PERFORM pitlane.assert_career_member();
 IF new_alias IS NULL OR new_alias!~'^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$' OR opt_in IS NULL
  OR new_livery IS NULL OR new_livery NOT IN('factory','ivory','night')
  OR new_number_style IS NULL OR new_number_style NOT IN('classic','block','outline')
  OR new_lighting IS NULL OR new_lighting NOT IN('workshop','dusk','floodlight') THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 -- Unlocks depend only on free, deduplicated learning milestones; never on jobs, findings, spend or rank.
 SELECT count(*) INTO n FROM pitlane.career_milestones WHERE tenant_id=t AND user_id=u;
 IF (new_livery='ivory' AND n<3) OR (new_livery='night' AND n<6)
  OR (new_number_style='block' AND n<2) OR (new_number_style='outline' AND n<4)
  OR (new_lighting='dusk' AND n<1) OR (new_lighting='floodlight' AND n<5) THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 INSERT INTO pitlane.career_profiles(tenant_id,user_id,alias,leaderboard_opt_in,livery,number_style,lighting) VALUES(t,u,new_alias,opt_in,new_livery,new_number_style,new_lighting)
 ON CONFLICT(tenant_id,user_id) DO UPDATE SET alias=excluded.alias,leaderboard_opt_in=excluded.leaderboard_opt_in,livery=excluded.livery,number_style=excluded.number_style,lighting=excluded.lighting;
 RETURN pitlane.career_state();
END $$;
CREATE FUNCTION pitlane.erase_career_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 IF TG_TABLE_NAME='tenants' THEN
  IF NEW.deleted_at IS NOT NULL THEN
   DELETE FROM pitlane.career_profiles WHERE tenant_id=NEW.id;
   DELETE FROM pitlane.career_milestones WHERE tenant_id=NEW.id;
  END IF;
 ELSIF NOT NEW.active THEN
  DELETE FROM pitlane.career_profiles WHERE tenant_id=NEW.tenant_id AND user_id=NEW.user_id;
  DELETE FROM pitlane.career_milestones WHERE tenant_id=NEW.tenant_id AND user_id=NEW.user_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER erase_career_tenant AFTER UPDATE OF deleted_at ON pitlane.tenants FOR EACH ROW EXECUTE FUNCTION pitlane.erase_career_scope();
CREATE TRIGGER erase_career_member AFTER UPDATE OF active ON pitlane.tenant_memberships FOR EACH ROW EXECUTE FUNCTION pitlane.erase_career_scope();
REVOKE ALL ON FUNCTION pitlane.assert_career_member(),pitlane.erase_career_scope(),pitlane.career_state(),pitlane.complete_career_milestone(text,text),pitlane.update_career_profile(text,boolean,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.career_state(),pitlane.complete_career_milestone(text,text),pitlane.update_career_profile(text,boolean,text,text,text) TO pitlane_web;
