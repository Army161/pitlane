ALTER TABLE pitlane.jobs ADD COLUMN IF NOT EXISTS finished_at timestamptz;
CREATE OR REPLACE FUNCTION pitlane.worker_heartbeat(worker text,build text,active_count integer,capability jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 IF length(worker)<1 OR length(worker)>128 OR length(build)<1 OR length(build)>128 OR active_count NOT BETWEEN 0 AND 2 OR capability->>'contract'<>'1' THEN RAISE EXCEPTION 'INVALID_WORKER';END IF;
 INSERT INTO pitlane.workers(id,build,active,capabilities) VALUES(worker,build,active_count,capability) ON CONFLICT(id) DO UPDATE SET build=excluded.build,active=excluded.active,capabilities=excluded.capabilities,heartbeat_at=now();
END $$;
CREATE OR REPLACE FUNCTION pitlane.crew_status(project uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 IF NOT pitlane.can_project(pitlane.actor_tenant(),project) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'build',w.build,'heartbeatAt',w.heartbeat_at,'healthy',w.heartbeat_at>now()-interval '45 seconds','activeProjectJobs',(SELECT count(*) FROM pitlane.jobs WHERE tenant_id=pitlane.actor_tenant() AND project_id=project AND lease_owner=w.id AND state IN('running','verifying')),'logicalStages',w.capabilities->'logicalStages','origin',w.capabilities->>'origin','draining',w.capabilities->'draining')),'[]') FROM pitlane.workers w WHERE EXISTS(SELECT FROM pitlane.job_events e WHERE e.tenant_id=pitlane.actor_tenant() AND e.project_id=project AND e.payload->>'workerId'=w.id));
END $$;
CREATE OR REPLACE FUNCTION pitlane.verifying(j uuid,w text,e bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 PERFORM pitlane.leased_job(j,w,e);
 UPDATE pitlane.jobs SET state='verifying' WHERE id=j AND lease_owner=w AND lease_epoch=e AND state='running';
 IF FOUND THEN PERFORM pitlane.emit(j,'verifying',jsonb_build_object('workerId',w,'logicalStage','verification'));END IF;
END $$;
CREATE OR REPLACE FUNCTION pitlane.emit(j uuid,k text,p jsonb DEFAULT '{}') RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE v pitlane.jobs;
BEGIN
 UPDATE pitlane.jobs SET event_seq=event_seq+1,finished_at=CASE WHEN k IN('completed','unsupported','failed','expired','cancelled') THEN coalesce(finished_at,now()) ELSE finished_at END WHERE id=j RETURNING * INTO v;
 INSERT INTO pitlane.job_events(tenant_id,project_id,job_id,seq,type,payload) VALUES(v.tenant_id,v.project_id,j,v.event_seq,k,p);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.worker_heartbeat(text,text,integer,jsonb),pitlane.verifying(uuid,text,bigint) TO pitlane_worker;
GRANT EXECUTE ON FUNCTION pitlane.crew_status(uuid) TO pitlane_web;
