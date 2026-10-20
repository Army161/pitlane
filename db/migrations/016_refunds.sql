CREATE TABLE IF NOT EXISTS pitlane.refund_requests(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,project_id uuid NOT NULL,order_id uuid NOT NULL,
 request_key text NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents>0),state text NOT NULL DEFAULT 'requested' CHECK(state IN('requested','pending_reconciliation','settled','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),settled_at timestamptz,
 FOREIGN KEY(order_id,tenant_id,project_id) REFERENCES pitlane.orders(id,tenant_id,project_id),UNIQUE(order_id,request_key)
);
ALTER TABLE pitlane.refund_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS refund_billing_read ON pitlane.refund_requests;
CREATE POLICY refund_billing_read ON pitlane.refund_requests FOR SELECT USING(pitlane.can_billing(tenant_id));
GRANT SELECT ON pitlane.refund_requests TO pitlane_web;
CREATE OR REPLACE FUNCTION pitlane.request_refund(target_id uuid,amount bigint,k text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE o pitlane.orders;r pitlane.refund_requests;pending bigint;
BEGIN
 SELECT * INTO o FROM pitlane.orders WHERE id=target_id FOR UPDATE;
 IF NOT FOUND OR NOT pitlane.can_billing(o.tenant_id) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF amount<=0 OR length(k)<16 OR length(k)>128 THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 SELECT * INTO r FROM pitlane.refund_requests WHERE order_id=target_id AND request_key=k;
 IF FOUND THEN IF r.amount_cents<>amount THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';END IF;RETURN to_jsonb(r);END IF;
 SELECT coalesce(sum(amount_cents),0) INTO pending FROM pitlane.refund_requests WHERE order_id=target_id AND state IN('requested','pending_reconciliation');
 IF o.state NOT IN('settled','refunded') OR amount+pending>o.settled_cents-o.refunded_cents THEN RAISE EXCEPTION 'REFUND_EXCEEDS_SETTLEMENT';END IF;
 INSERT INTO pitlane.refund_requests(tenant_id,project_id,order_id,request_key,amount_cents) VALUES(o.tenant_id,o.project_id,target_id,k,amount) RETURNING * INTO r;
 INSERT INTO pitlane.payment_outbox(tenant_id,order_id,business_key,operation,amount_cents) VALUES(o.tenant_id,target_id,target_id::text||'/refund/'||r.id::text,'refund',amount);
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(o.tenant_id,pitlane.actor_id(),'REFUND_REQUESTED',r.id);
 RETURN to_jsonb(r);
END $$;
CREATE OR REPLACE FUNCTION pitlane.refund_result(operation_id uuid,outcome text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE op pitlane.payment_outbox;r pitlane.refund_requests;o pitlane.orders;journal uuid;origin text;
BEGIN
 SELECT * INTO op FROM pitlane.payment_outbox WHERE id=operation_id AND operation='refund';
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 SELECT * INTO o FROM pitlane.orders WHERE id=op.order_id FOR UPDATE;
 SELECT * INTO r FROM pitlane.refund_requests WHERE id=split_part(op.business_key,'/',3)::uuid AND order_id=o.id FOR UPDATE;
 IF NOT FOUND OR op.amount_cents<>r.amount_cents THEN RAISE EXCEPTION 'INVALID_REFUND';END IF;
 IF r.state='settled' THEN RETURN;END IF;
 IF outcome='settled' THEN
  IF o.refunded_cents+r.amount_cents>o.settled_cents THEN RAISE EXCEPTION 'REFUND_EXCEEDS_SETTLEMENT';END IF;
  SELECT CASE WHEN runtime.mode='local' THEN 'fixture' ELSE billing_mode END INTO origin FROM pitlane.runtime;
  INSERT INTO pitlane.journals(tenant_id,source_key,origin) VALUES(o.tenant_id,op.business_key,origin) RETURNING id INTO journal;
  INSERT INTO pitlane.journal_lines VALUES(journal,'processor_receivable','USD',2,-r.amount_cents),(journal,'service_delivery','USD',2,r.amount_cents);
  UPDATE pitlane.refund_requests SET state='settled',settled_at=now() WHERE id=r.id;
  UPDATE pitlane.orders SET refunded_cents=refunded_cents+r.amount_cents,state=CASE WHEN refunded_cents+r.amount_cents=settled_cents THEN 'refunded' ELSE state END WHERE id=o.id;
  IF o.kind='pilot' AND o.refunded_cents+r.amount_cents=o.settled_cents THEN
   UPDATE pitlane.entitlement_lots SET granted=consumed+reserved WHERE source_key='pilot/'||o.id::text||'/retest';
  END IF;
 ELSIF outcome IN('pending_reconciliation','failed') THEN
  UPDATE pitlane.refund_requests SET state=outcome WHERE id=r.id;
 ELSE RAISE EXCEPTION 'INVALID_REFUND_STATE';END IF;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.request_refund(uuid,bigint,text) TO pitlane_web;
GRANT EXECUTE ON FUNCTION pitlane.refund_result(uuid,text) TO pitlane_billing;
