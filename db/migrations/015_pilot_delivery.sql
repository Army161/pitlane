CREATE OR REPLACE FUNCTION pitlane.pilot_add_quote(target_id uuid,qid uuid,k text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE o pitlane.orders;q pitlane.quotes;j pitlane.jobs;prior pitlane.idempotency;cap bigint=1000000;mode text;
BEGIN
 SELECT * INTO o FROM pitlane.orders WHERE id=target_id;
 IF NOT FOUND OR NOT pitlane.can_billing(o.tenant_id) OR NOT pitlane.can_project(o.tenant_id,o.project_id,true) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(o.tenant_id::text||o.project_id::text,0));
 SELECT * INTO o FROM pitlane.orders WHERE id=target_id FOR UPDATE;
 SELECT * INTO q FROM pitlane.quotes WHERE id=qid AND tenant_id=o.tenant_id AND project_id=o.project_id FOR UPDATE;
 IF NOT FOUND OR length(k)<16 OR length(k)>128 THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 SELECT * INTO prior FROM pitlane.idempotency WHERE tenant_id=o.tenant_id AND project_id=o.project_id AND key=k;
 IF FOUND THEN
  IF prior.request_hash<>q.inputs_hash||'/pilot/'||target_id::text THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';END IF;
  SELECT * INTO j FROM pitlane.jobs WHERE id=prior.job_id;RETURN to_jsonb(j);
 END IF;
 IF o.kind<>'pilot' OR o.state<>'authorized' OR o.capture_before<=now()+interval '180 seconds' THEN RAISE EXCEPTION 'INVALID_ORDER_STATE';END IF;
 IF (SELECT count(*) FROM pitlane.jobs WHERE order_id=target_id)>=o.initial_units THEN RAISE EXCEPTION 'PILOT_INITIAL_LIMIT';END IF;
 IF q.expires_at<=now() OR q.consumed_job_id IS NOT NULL THEN RAISE EXCEPTION 'QUOTE_EXPIRED';END IF;
 IF (SELECT count(*) FROM pitlane.jobs WHERE tenant_id=o.tenant_id AND project_id=o.project_id AND state IN('queued','running','verifying','retry_wait','awaiting_payment'))>=2 THEN RAISE EXCEPTION 'ACTIVE_LIMIT';END IF;
 PERFORM 1 FROM pitlane.budgets WHERE key IN('environment',o.tenant_id::text) ORDER BY key FOR UPDATE;
 IF (SELECT count(*) FROM pitlane.budgets WHERE key IN('environment',o.tenant_id::text))<>2 OR EXISTS(SELECT FROM pitlane.budgets WHERE key IN('environment',o.tenant_id::text) AND maximum-reserved-spent<cap) THEN RAISE EXCEPTION 'COST_BUDGET_EXHAUSTED';END IF;
 UPDATE pitlane.budgets SET reserved=reserved+cap WHERE key IN('environment',o.tenant_id::text);
 SELECT runtime.mode INTO mode FROM pitlane.runtime;
 INSERT INTO pitlane.jobs(tenant_id,project_id,quote_id,input,canonical_key,state,origin,order_id,deadline)
 VALUES(o.tenant_id,o.project_id,qid,q.input,'pilot/'||target_id::text||'/'||qid::text,'queued',CASE WHEN mode='local' THEN 'fixture' ELSE 'customer' END,target_id,now()+interval '180 seconds') RETURNING * INTO j;
 UPDATE pitlane.quotes SET consumed_job_id=j.id WHERE id=qid;
 INSERT INTO pitlane.idempotency VALUES(o.tenant_id,o.project_id,k,q.inputs_hash||'/pilot/'||target_id::text,j.id,now());
 PERFORM pitlane.emit(j.id,'queued');RETURN to_jsonb(j);
END $$;

CREATE OR REPLACE FUNCTION pitlane.pilot_summary_context(target_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE o pitlane.orders;j pitlane.jobs;
BEGIN
 IF NOT pitlane.is_operator(pitlane.actor_id()) THEN RAISE EXCEPTION 'OPERATOR_REVIEW_REQUIRED';END IF;
 SELECT * INTO o FROM pitlane.orders WHERE id=target_id;
 IF NOT FOUND OR NOT pitlane.can_project(o.tenant_id,o.project_id,true) OR o.kind<>'pilot' THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF o.state NOT IN('authorized','delivered_pending_capture','settled') THEN RAISE EXCEPTION 'INVALID_ORDER_STATE';END IF;
 IF (SELECT count(*) FROM pitlane.jobs jobs JOIN pitlane.receipt_versions rv ON rv.job_id=jobs.id WHERE jobs.order_id=target_id AND jobs.state='completed' AND rv.payload->>'finding' IN('supported','contradicted'))<>o.initial_units THEN RAISE EXCEPTION 'INITIAL_DELIVERY_INCOMPLETE';END IF;
 SELECT * INTO j FROM pitlane.jobs WHERE order_id=target_id ORDER BY created_at DESC LIMIT 1;
 RETURN jsonb_build_object('tenant_id',o.tenant_id,'project_id',o.project_id,'job_id',j.id,'origin',j.origin);
END $$;

CREATE OR REPLACE FUNCTION pitlane.register_pilot_summary(target_id uuid,artifact uuid,object_key text,hash text,size bigint,minutes integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE context jsonb;o pitlane.orders;existing pitlane.artifacts;j pitlane.jobs;
BEGIN
 context=pitlane.pilot_summary_context(target_id);
 SELECT * INTO o FROM pitlane.orders WHERE id=target_id FOR UPDATE;
 IF minutes NOT BETWEEN 1 AND 45 OR size NOT BETWEEN 1 AND 65536 OR length(hash)<>64 OR object_key<>(context->>'tenant_id')||'/'||(context->>'project_id')||'/'||(context->>'job_id')||'/pilot-summary/'||target_id::text||'/'||hash||'.json' THEN RAISE EXCEPTION 'INVALID_ARTIFACT';END IF;
 IF o.summary_artifact_id IS NOT NULL THEN
  SELECT * INTO existing FROM pitlane.artifacts WHERE id=o.summary_artifact_id;
  IF existing.digest<>hash OR o.review_minutes<>minutes THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';END IF;
  RETURN;
 END IF;
 PERFORM pitlane.assert_delivery_authorization(target_id);
 SELECT * INTO j FROM pitlane.jobs WHERE id=(context->>'job_id')::uuid;
 INSERT INTO pitlane.artifacts VALUES(artifact,o.tenant_id,o.project_id,j.id,j.lease_epoch,object_key,hash,size,'application/vnd.pitlane.pilot-summary+json','published',now()+interval '90 days',now());
 PERFORM pitlane.pilot_summary(target_id,artifact,minutes);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.pilot_add_quote(uuid,uuid,text),pitlane.pilot_summary_context(uuid),pitlane.register_pilot_summary(uuid,uuid,text,text,bigint,integer) TO pitlane_web;
