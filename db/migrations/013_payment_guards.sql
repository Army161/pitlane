CREATE OR REPLACE FUNCTION pitlane.assert_delivery_authorization(order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE o pitlane.orders;
BEGIN
 SELECT * INTO o FROM pitlane.orders WHERE id=order_id FOR UPDATE;
 IF NOT FOUND OR o.state<>'authorized' OR o.capture_before IS NULL OR o.capture_before<=clock_timestamp() THEN
   RAISE EXCEPTION 'AUTHORIZATION_EXPIRED';
 END IF;
END $$;

CREATE OR REPLACE FUNCTION pitlane.reap() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE target_id uuid;j pitlane.jobs;n integer=0;hold_expired boolean;
BEGIN
 FOR target_id IN
  SELECT jobs.id FROM pitlane.jobs LEFT JOIN pitlane.orders o ON o.id=jobs.order_id
  WHERE jobs.state IN('queued','retry_wait','running','verifying','awaiting_payment')
   AND (jobs.deadline<=now() OR jobs.lease_until<=now() OR o.capture_before<=now())
  ORDER BY jobs.tenant_id,jobs.project_id,jobs.id
 LOOP
  PERFORM pitlane.lock_job_scope(target_id);
  SELECT * INTO j FROM pitlane.jobs WHERE id=target_id FOR UPDATE;
  hold_expired=EXISTS(SELECT FROM pitlane.orders WHERE id=j.order_id AND capture_before<=now());
  IF j.state NOT IN('queued','retry_wait','running','verifying','awaiting_payment') OR
    (NOT hold_expired AND j.deadline>now() AND (j.lease_until IS NULL OR j.lease_until>now())) THEN CONTINUE; END IF;
  IF hold_expired OR j.deadline<=now() OR j.attempts>=3 OR j.cancel_requested THEN
   UPDATE pitlane.jobs SET state=CASE WHEN j.cancel_requested THEN 'cancelled' ELSE 'expired' END,
    lease_epoch=lease_epoch+1,lease_owner=NULL,lease_until=NULL WHERE id=target_id;
   PERFORM pitlane.release_reservation(target_id,false);
   PERFORM pitlane.emit(target_id,CASE WHEN j.cancel_requested THEN 'cancelled' ELSE 'expired' END);
   IF j.order_id IS NOT NULL THEN
    INSERT INTO pitlane.payment_outbox(tenant_id,order_id,business_key,operation)
     VALUES(j.tenant_id,j.order_id,j.order_id::text||'/cancel','cancel') ON CONFLICT DO NOTHING;
   END IF;
  ELSE
   UPDATE pitlane.jobs SET state='retry_wait',ready_at=now(),lease_owner=NULL,lease_until=NULL WHERE id=target_id;
   PERFORM pitlane.emit(target_id,'retry_wait',jsonb_build_object('reason','LEASE_EXPIRED'));
  END IF;
  n=n+1;
 END LOOP;
 RETURN n;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
