CREATE OR REPLACE FUNCTION pitlane.order_for_checkout(checkout text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$ SELECT to_jsonb(o) FROM pitlane.orders o WHERE checkout_id=checkout $$;
CREATE OR REPLACE FUNCTION pitlane.order_for_payment(payment text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$ SELECT to_jsonb(o) FROM pitlane.orders o WHERE provider_id=payment $$;
CREATE OR REPLACE FUNCTION pitlane.stop_order(target_id uuid,outcome text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE o pitlane.orders;j pitlane.jobs;
BEGIN
 SELECT * INTO o FROM pitlane.orders WHERE id=target_id;
 IF NOT FOUND OR outcome NOT IN('authorization_expired','cancelled') THEN RAISE EXCEPTION 'INVALID_ORDER_STATE';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(o.tenant_id::text||o.project_id::text,0));
 SELECT * INTO o FROM pitlane.orders WHERE id=target_id FOR UPDATE;
 IF o.state IN('settled','refunded','delivered_pending_capture','pending_reconciliation') THEN RETURN;END IF;
 FOR j IN SELECT * FROM pitlane.jobs WHERE order_id=target_id AND state IN('awaiting_payment','queued','running','verifying','retry_wait') FOR UPDATE LOOP
  UPDATE pitlane.jobs SET state='cancelled',cancel_requested=true,lease_epoch=lease_epoch+1,lease_owner=NULL,lease_until=NULL WHERE id=j.id;
  PERFORM pitlane.release_reservation(j.id,false);PERFORM pitlane.emit(j.id,'cancelled');
 END LOOP;
 UPDATE pitlane.orders SET state=outcome WHERE id=target_id;
 INSERT INTO pitlane.payment_outbox(tenant_id,order_id,business_key,operation) VALUES(o.tenant_id,target_id,target_id::text||'/cancel','cancel') ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.order_for_checkout(text),pitlane.order_for_payment(text),pitlane.stop_order(uuid,text) TO pitlane_billing;
