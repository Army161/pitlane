ALTER TABLE pitlane.monitors ADD COLUMN IF NOT EXISTS inputs_hash text;
CREATE INDEX IF NOT EXISTS monitor_due ON pitlane.monitors(next_due) WHERE enabled;
CREATE OR REPLACE FUNCTION pitlane.create_monitor(v jsonb,h text,settings jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE m pitlane.monitors;t uuid=pitlane.actor_tenant();p uuid=(v->>'projectId')::uuid;expiry timestamptz=(settings->>'expiresAt')::timestamptz;
BEGIN
 IF NOT pitlane.can_project(t,p,true) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF expiry<=now() OR expiry>now()+interval '366 days' OR (settings->>'monthlyUnits')::integer NOT BETWEEN 1 AND 1000 OR (settings->>'intervalSeconds')::integer NOT BETWEEN 3600 AND 2592000 THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 INSERT INTO pitlane.monitors(tenant_id,project_id,input,inputs_hash,next_due,expires_at,interval_seconds,unit_cap,price_cap_cents,cost_cap_micro)
 VALUES(t,p,v,h,now(),expiry,(settings->>'intervalSeconds')::integer,(settings->>'monthlyUnits')::integer,(settings->>'maximumUnitPrice')::bigint,(settings->>'monthlyCostMicro')::bigint) RETURNING * INTO m;
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(t,pitlane.actor_id(),'MONITOR_CREATED_DISABLED',m.id);
 RETURN to_jsonb(m);
END $$;

CREATE OR REPLACE FUNCTION pitlane.set_monitor_enabled(target_id uuid,on_state boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE m pitlane.monitors;job_id uuid;
BEGIN
 SELECT * INTO m FROM pitlane.monitors WHERE id=target_id FOR UPDATE;
 IF NOT FOUND OR NOT pitlane.can_project(m.tenant_id,m.project_id,true) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF on_state THEN
  IF m.expires_at<=now() THEN RAISE EXCEPTION 'CONSENT_EXPIRED';END IF;
  IF m.policy_version<>'1' OR m.price_cap_cents<400 THEN RAISE EXCEPTION 'POLICY_REACCEPTANCE_REQUIRED';END IF;
  IF NOT EXISTS(SELECT FROM pitlane.entitlement_lots WHERE tenant_id=m.tenant_id AND starts_at<=now() AND ends_at>now() AND granted-consumed-reserved>0 AND (scope_hashes IS NULL OR m.inputs_hash=ANY(scope_hashes))) THEN RAISE EXCEPTION 'QUOTA_EXHAUSTED';END IF;
 END IF;
 UPDATE pitlane.monitors SET enabled=on_state,enabled_by=CASE WHEN on_state THEN pitlane.actor_id() ELSE enabled_by END,paused_reason=NULL,next_due=CASE WHEN on_state AND NOT m.enabled THEN now() ELSE next_due END WHERE id=target_id RETURNING * INTO m;
 IF NOT on_state THEN
  FOR job_id IN SELECT j.id FROM pitlane.jobs j JOIN pitlane.monitor_runs r ON r.job_id=j.id WHERE r.monitor_id=target_id AND j.state IN('queued','running','verifying','retry_wait') LOOP PERFORM pitlane.cancel_job(job_id);END LOOP;
 END IF;
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(m.tenant_id,pitlane.actor_id(),CASE WHEN on_state THEN 'MONITOR_ENABLED' ELSE 'MONITOR_DISABLED' END,target_id);
 RETURN to_jsonb(m);
END $$;

CREATE OR REPLACE FUNCTION pitlane.schedule_monitors(maximum integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE m pitlane.monitors;quote jsonb;job jsonb;n integer=0;reason text;reserved_units integer;estimated_cost numeric;old_actor text;old_tenant text;
BEGIN
 old_actor=current_setting('pitlane.actor_id',true);old_tenant=current_setting('pitlane.tenant_id',true);
 FOR m IN SELECT * FROM pitlane.monitors WHERE enabled AND next_due<=now() ORDER BY next_due,id FOR UPDATE SKIP LOCKED LIMIT greatest(0,least(maximum,100)) LOOP
  PERFORM set_config('pitlane.actor_id',m.enabled_by::text,true);PERFORM set_config('pitlane.tenant_id',m.tenant_id::text,true);
  reason=NULL;
  IF NOT pitlane.can_project(m.tenant_id,m.project_id,true) THEN reason='MEMBERSHIP_REMOVED';
  ELSIF m.expires_at<=now() THEN reason='CONSENT_EXPIRED';
  ELSIF m.policy_version<>'1' OR m.price_cap_cents<400 THEN reason='POLICY_REACCEPTANCE_REQUIRED';
  ELSIF NOT EXISTS(SELECT FROM pitlane.entitlement_lots WHERE tenant_id=m.tenant_id AND starts_at<=now() AND ends_at>now() AND granted-consumed-reserved>0 AND (scope_hashes IS NULL OR m.inputs_hash=ANY(scope_hashes))) THEN reason='QUOTA_EXHAUSTED';END IF;
  SELECT count(*) FILTER(WHERE j.state IN('queued','running','verifying','retry_wait') OR (j.state='completed' AND rv.payload->>'finding' IN('supported','contradicted'))),
   coalesce(sum(CASE WHEN j.state IN('queued','running','verifying','retry_wait') THEN j.cost_cap ELSE j.cost_used END),0)
   INTO reserved_units,estimated_cost FROM pitlane.monitor_runs r JOIN pitlane.jobs j ON j.id=r.job_id LEFT JOIN pitlane.receipt_versions rv ON rv.job_id=j.id
   WHERE r.monitor_id=m.id AND r.scheduled_for>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  IF reason IS NULL AND reserved_units>=m.unit_cap THEN reason='MONTHLY_UNIT_CAP';END IF;
  IF reason IS NULL AND estimated_cost+1000000>m.cost_cap_micro THEN reason='MONTHLY_COST_CAP';END IF;
  IF reason IS NULL THEN
   BEGIN
    quote=pitlane.create_quote(m.input,m.inputs_hash);
    job=pitlane.admit((quote->>'id')::uuid,'monitor/'||m.id::text||'/'||extract(epoch FROM m.next_due)::text);
    INSERT INTO pitlane.monitor_runs VALUES(m.id,m.next_due,m.tenant_id,m.project_id,(job->>'id')::uuid);
    UPDATE pitlane.monitors SET next_due=now()+make_interval(secs=>m.interval_seconds),used_units=least(unit_cap,reserved_units+1) WHERE id=m.id;
    n=n+1;
   EXCEPTION WHEN OTHERS THEN
    reason=CASE WHEN SQLERRM IN('QUOTA_EXHAUSTED','COST_BUDGET_EXHAUSTED','ACTIVE_LIMIT','PROVIDERS_UNAVAILABLE','UNSUPPORTED_SCOPE') THEN SQLERRM ELSE 'SCHEDULER_UNAVAILABLE' END;
   END;
  END IF;
  IF reason IS NOT NULL THEN
   UPDATE pitlane.monitors SET enabled=false,paused_reason=reason WHERE id=m.id;
   INSERT INTO pitlane.audit(tenant_id,type,subject_id) VALUES(m.tenant_id,'MONITOR_PAUSED_'||reason,m.id);
  END IF;
 END LOOP;
 PERFORM set_config('pitlane.actor_id',coalesce(old_actor,''),true);PERFORM set_config('pitlane.tenant_id',coalesce(old_tenant,''),true);
 RETURN n;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.create_monitor(jsonb,text,jsonb),pitlane.set_monitor_enabled(uuid,boolean) TO pitlane_web;
GRANT EXECUTE ON FUNCTION pitlane.schedule_monitors(integer) TO pitlane_worker;
