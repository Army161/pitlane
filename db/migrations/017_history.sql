ALTER TABLE pitlane.jobs ADD COLUMN IF NOT EXISTS correction_version_id uuid;
ALTER TABLE pitlane.jobs ADD COLUMN IF NOT EXISTS correction_reason text;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_constraint WHERE conname='correction_source_scope') THEN ALTER TABLE pitlane.jobs ADD CONSTRAINT correction_source_scope FOREIGN KEY(correction_version_id,tenant_id,project_id) REFERENCES pitlane.receipt_versions(id,tenant_id,project_id);END IF;
 IF NOT EXISTS(SELECT FROM pg_constraint WHERE conname='supersedes_scope') THEN ALTER TABLE pitlane.receipt_versions ADD CONSTRAINT supersedes_scope FOREIGN KEY(supersedes_id,tenant_id,project_id) REFERENCES pitlane.receipt_versions(id,tenant_id,project_id);END IF;
END $$;
CREATE OR REPLACE FUNCTION pitlane.can_project_admin(t uuid,p uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
 SELECT pitlane.can_project(t,p,true) AND (EXISTS(SELECT FROM pitlane.tenant_memberships WHERE tenant_id=t AND user_id=pitlane.actor_id() AND active AND role IN('owner','admin')) OR EXISTS(SELECT FROM pitlane.project_memberships WHERE tenant_id=t AND project_id=p AND user_id=pitlane.actor_id() AND active AND role='admin'))
$$;
CREATE OR REPLACE FUNCTION pitlane.request_correction(source_id uuid,reason text,k text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE source pitlane.receipt_versions;original pitlane.jobs;j pitlane.jobs;prior pitlane.idempotency;cap bigint=1000000;mode text;
BEGIN
 IF NOT pitlane.is_operator(pitlane.actor_id()) THEN RAISE EXCEPTION 'OPERATOR_REVIEW_REQUIRED';END IF;
 SELECT * INTO source FROM pitlane.receipt_versions WHERE id=source_id AND expires_at>now();
 IF NOT FOUND OR NOT pitlane.can_project_admin(source.tenant_id,source.project_id) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF length(reason)<10 OR length(reason)>1000 OR length(k)<16 OR length(k)>128 THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(source.tenant_id::text||source.project_id::text,0));
 SELECT * INTO prior FROM pitlane.idempotency WHERE tenant_id=source.tenant_id AND project_id=source.project_id AND key=k;
 IF FOUND THEN IF prior.request_hash<>source_id::text||'/correction/'||reason THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';END IF;SELECT * INTO j FROM pitlane.jobs WHERE id=prior.job_id;RETURN to_jsonb(j);END IF;
 IF NOT EXISTS(SELECT FROM pitlane.receipt_heads WHERE receipt_id=source.receipt_id AND version_id=source_id) THEN RAISE EXCEPTION 'VERSION_CONFLICT';END IF;
 SELECT * INTO j FROM pitlane.jobs WHERE tenant_id=source.tenant_id AND project_id=source.project_id AND canonical_key='correction/'||source_id::text;
 IF FOUND THEN INSERT INTO pitlane.idempotency VALUES(source.tenant_id,source.project_id,k,source_id::text||'/correction/'||reason,j.id,now());RETURN to_jsonb(j);END IF;
 IF (SELECT count(*) FROM pitlane.jobs WHERE tenant_id=source.tenant_id AND project_id=source.project_id AND state IN('queued','running','verifying','retry_wait','awaiting_payment'))>=2 THEN RAISE EXCEPTION 'ACTIVE_LIMIT';END IF;
 PERFORM 1 FROM pitlane.budgets WHERE key IN('environment',source.tenant_id::text) ORDER BY key FOR UPDATE;
 IF (SELECT count(*) FROM pitlane.budgets WHERE key IN('environment',source.tenant_id::text))<>2 OR EXISTS(SELECT FROM pitlane.budgets WHERE key IN('environment',source.tenant_id::text) AND maximum-reserved-spent<cap) THEN RAISE EXCEPTION 'COST_BUDGET_EXHAUSTED';END IF;
 UPDATE pitlane.budgets SET reserved=reserved+cap WHERE key IN('environment',source.tenant_id::text);
 SELECT * INTO original FROM pitlane.jobs WHERE id=source.job_id;SELECT runtime.mode INTO mode FROM pitlane.runtime;
 INSERT INTO pitlane.jobs(tenant_id,project_id,quote_id,input,canonical_key,state,origin,deadline,correction_version_id,correction_reason)
 VALUES(source.tenant_id,source.project_id,original.quote_id,source.payload->'input','correction/'||source_id::text,'queued',CASE WHEN mode='local' THEN 'fixture' ELSE 'internal' END,now()+interval '180 seconds',source_id,reason) RETURNING * INTO j;
 INSERT INTO pitlane.idempotency VALUES(source.tenant_id,source.project_id,k,source_id::text||'/correction/'||reason,j.id,now());
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(source.tenant_id,pitlane.actor_id(),'PLATFORM_CORRECTION_REQUESTED',source_id);
 PERFORM pitlane.emit(j.id,'queued',jsonb_build_object('correctionOf',source_id,'unitsReserved',0));RETURN to_jsonb(j);
END $$;
CREATE OR REPLACE FUNCTION pitlane.correction_context(target_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
 SELECT jsonb_build_object('receiptId',v.receipt_id,'versionId',v.id,'reason',j.correction_reason,'observations',v.payload->'observations') FROM pitlane.jobs j JOIN pitlane.receipt_versions v ON v.id=j.correction_version_id WHERE j.id=target_id
$$;
CREATE OR REPLACE FUNCTION pitlane.publish_correction(target_id uuid,r jsonb,artifact uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE j pitlane.jobs;source pitlane.receipt_versions;f pitlane.artifacts;current_id uuid;
BEGIN
 SELECT * INTO j FROM pitlane.jobs WHERE id=target_id;
 SELECT * INTO source FROM pitlane.receipt_versions WHERE id=j.correction_version_id;
 SELECT version_id INTO current_id FROM pitlane.receipt_heads WHERE receipt_id=source.receipt_id FOR UPDATE;
 IF current_id<>source.id THEN RAISE EXCEPTION 'VERSION_CONFLICT';END IF;
 IF r->>'id'<>source.receipt_id::text OR r->>'supersedesReceiptId'<>source.receipt_id::text OR r->>'supersedesVersionId'<>source.id::text OR r->>'correctionReason'<>j.correction_reason THEN RAISE EXCEPTION 'INVALID_CORRECTION';END IF;
 SELECT * INTO f FROM pitlane.artifacts WHERE id=artifact AND job_id=target_id AND state='hash_verified';IF NOT FOUND THEN RAISE EXCEPTION 'MISSING_ARTIFACT';END IF;
 INSERT INTO pitlane.receipt_versions(id,receipt_id,tenant_id,project_id,job_id,payload,digest,artifact_id,supersedes_id,expires_at) VALUES((r->>'versionId')::uuid,source.receipt_id,j.tenant_id,j.project_id,target_id,r,f.digest,artifact,source.id,f.expires_at);
 UPDATE pitlane.receipt_heads SET version_id=(r->>'versionId')::uuid WHERE receipt_id=source.receipt_id AND version_id=source.id;
 INSERT INTO pitlane.audit(tenant_id,type,subject_id) VALUES(j.tenant_id,'RECEIPT_SUPERSEDED',source.id);
END $$;
CREATE OR REPLACE FUNCTION pitlane.propose_atlas(project uuid,title text,failure uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE c pitlane.atlas_cases;v pitlane.receipt_versions;
BEGIN
 IF NOT pitlane.can_project(pitlane.actor_tenant(),project,true) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 SELECT * INTO v FROM pitlane.receipt_versions WHERE id=failure AND tenant_id=pitlane.actor_tenant() AND project_id=project AND expires_at>now();
 IF NOT FOUND OR v.payload->>'finding'<>'contradicted' OR length(title)<3 OR length(title)>200 THEN RAISE EXCEPTION 'VERIFIED_FAILURE_REQUIRED';END IF;
 INSERT INTO pitlane.atlas_cases(tenant_id,project_id,title,failure_version_id) VALUES(v.tenant_id,project,title,failure) RETURNING * INTO c;
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(c.tenant_id,pitlane.actor_id(),'ATLAS_PROPOSED',c.id);RETURN to_jsonb(c);
END $$;
CREATE OR REPLACE FUNCTION pitlane.confirm_atlas(target_id uuid,fix uuid,regression uuid,consent boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE c pitlane.atlas_cases;f pitlane.receipt_versions;v pitlane.receipt_versions;
BEGIN
 SELECT * INTO c FROM pitlane.atlas_cases WHERE id=target_id FOR UPDATE;
 IF NOT FOUND OR NOT pitlane.can_project_admin(c.tenant_id,c.project_id) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF consent IS DISTINCT FROM true THEN RAISE EXCEPTION 'EXPLICIT_PERMISSION_REQUIRED';END IF;
 IF c.state='withdrawn' THEN RAISE EXCEPTION 'CASE_WITHDRAWN';END IF;
 SELECT * INTO f FROM pitlane.receipt_versions WHERE id=c.failure_version_id AND expires_at>now();
 SELECT * INTO v FROM pitlane.receipt_versions WHERE id=fix AND tenant_id=c.tenant_id AND project_id=c.project_id AND expires_at>now();
 IF f.id IS NULL OR v.id IS NULL OR f.payload->>'finding'<>'contradicted' OR v.payload->>'finding'<>'supported' OR v.payload->'input'<>f.payload->'input' OR v.issued_at<=f.issued_at OR v.artifact_id<>regression OR NOT EXISTS(SELECT FROM pitlane.artifacts WHERE id=regression AND state='published' AND expires_at>now()) THEN RAISE EXCEPTION 'VERIFIED_FIX_AND_REGRESSION_REQUIRED';END IF;
 UPDATE pitlane.atlas_cases SET state='confirmed',correction_version_id=fix,regression_artifact_id=regression,permission=true,expires_at=now()+interval '365 days' WHERE id=target_id RETURNING * INTO c;
 UPDATE pitlane.receipt_versions SET expires_at=greatest(expires_at,c.expires_at) WHERE id IN(f.id,v.id);
 UPDATE pitlane.artifacts SET expires_at=greatest(expires_at,c.expires_at) WHERE id IN(f.artifact_id,v.artifact_id);
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(c.tenant_id,pitlane.actor_id(),'ATLAS_CONFIRMED_SCOPED_PERMISSION',target_id);RETURN to_jsonb(c);
END $$;
CREATE OR REPLACE FUNCTION pitlane.withdraw_atlas(target_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE c pitlane.atlas_cases;
BEGIN
 SELECT * INTO c FROM pitlane.atlas_cases WHERE id=target_id FOR UPDATE;
 IF NOT FOUND OR NOT pitlane.can_project_admin(c.tenant_id,c.project_id) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 UPDATE pitlane.atlas_cases SET state='withdrawn',permission=false WHERE id=target_id RETURNING * INTO c;
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(c.tenant_id,pitlane.actor_id(),'ATLAS_RETRACTED',target_id);RETURN to_jsonb(c);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.can_project_admin(uuid,uuid),pitlane.request_correction(uuid,text,text),pitlane.propose_atlas(uuid,text,uuid),pitlane.confirm_atlas(uuid,uuid,uuid,boolean),pitlane.withdraw_atlas(uuid) TO pitlane_web;
GRANT EXECUTE ON FUNCTION pitlane.correction_context(uuid) TO pitlane_worker;
